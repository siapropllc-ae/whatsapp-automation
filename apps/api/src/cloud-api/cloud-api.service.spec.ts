import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CloudApiService } from './cloud-api.service';

function makeConfig(dryRun: boolean) {
  return {
    getOrThrow: jest.fn().mockImplementation((key: string) => {
      if (key === 'META_ACCESS_TOKEN') return 'test-token';
      if (key === 'META_PHONE_NUMBER_ID') return 'test-phone-id';
      throw new Error(`Unexpected config key: ${key}`);
    }),
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'DRY_RUN') return dryRun ? 'true' : 'false';
      if (key === 'META_ACCESS_TOKEN') return 'test-token';
      if (key === 'META_PHONE_NUMBER_ID') return 'test-phone-id';
      return undefined;
    }),
  };
}

describe('CloudApiService', () => {
  describe('DRY_RUN=true', () => {
    let service: CloudApiService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CloudApiService,
          { provide: ConfigService, useValue: makeConfig(true) },
        ],
      }).compile();
      service = module.get<CloudApiService>(CloudApiService);
    });

    it('returns a dry_run wamid without calling fetch', async () => {
      const spy = jest.spyOn(global, 'fetch' as never);
      const result = await service.sendTemplate({
        to: '+15551234567',
        templateName: 'hello_world',
      });
      expect(result.dryRun).toBe(true);
      expect(result.wamid).toMatch(/^dry_wamid_/);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('uses the provided phoneNumberId in the log', async () => {
      jest.spyOn(global, 'fetch' as never);
      const result = await service.sendTemplate({
        to: '+15551234567',
        templateName: 'hello_world',
        phoneNumberId: 'custom-phone-id',
      });
      expect(result.dryRun).toBe(true);
    });
  });

  describe('DRY_RUN=false', () => {
    let service: CloudApiService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CloudApiService,
          { provide: ConfigService, useValue: makeConfig(false) },
        ],
      }).compile();
      service = module.get<CloudApiService>(CloudApiService);
    });

    it('calls the Graph API and returns the wamid', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          messaging_product: 'whatsapp',
          contacts: [{ input: '15551234567', wa_id: '15551234567' }],
          messages: [{ id: 'wamid.abc123' }],
        }),
      };
      const fetchSpy = jest
        .spyOn(global, 'fetch' as never)
        .mockResolvedValue(mockResponse as unknown as never);

      const result = await service.sendTemplate({
        to: '+15551234567',
        templateName: 'hello_world',
        languageCode: 'en_US',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
      expect(result.wamid).toBe('wamid.abc123');
      expect(result.dryRun).toBe(false);
      fetchSpy.mockRestore();
    });

    it('includes template components in the payload', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.xyz' }] }),
      };
      const fetchSpy = jest
        .spyOn(global, 'fetch' as never)
        .mockResolvedValue(mockResponse as unknown as never);

      await service.sendTemplate({
        to: '+15551234567',
        templateName: 'order_update',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'World' }] }],
      });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        type: 'template',
        template: expect.objectContaining({ name: 'order_update' }),
      });
      fetchSpy.mockRestore();
    });

    it('throws when the Graph API returns an error', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        text: jest.fn().mockResolvedValue('{"error":{"message":"Invalid phone"}}'),
      };
      jest
        .spyOn(global, 'fetch' as never)
        .mockResolvedValue(mockResponse as unknown as never);

      await expect(
        service.sendTemplate({ to: 'bad', templateName: 'hello_world' }),
      ).rejects.toThrow('Meta Graph API 400');
    });

    it('throws when the response contains no message id', async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({ messages: [] }),
      };
      jest
        .spyOn(global, 'fetch' as never)
        .mockResolvedValue(mockResponse as unknown as never);

      await expect(
        service.sendTemplate({ to: '+15551234567', templateName: 'hello_world' }),
      ).rejects.toThrow('returned no message id');
    });

    describe('button components', () => {
      async function sendAndCapturePayload(
        buttons: Parameters<CloudApiService['sendTemplate']>[0]['buttons'],
        headerMedia?: Parameters<CloudApiService['sendTemplate']>[0]['headerMedia'],
      ): Promise<Record<string, unknown>> {
        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.btn' }] }),
        };
        const fetchSpy = jest
          .spyOn(global, 'fetch' as never)
          .mockResolvedValue(mockResponse as unknown as never);

        await service.sendTemplate({ to: '+15551234567', templateName: 'hello_world', buttons, headerMedia });

        // Some earlier tests in this suite don't restore their fetch spy, so `jest.spyOn`
        // can return an already-mocked persistent spy with prior calls still recorded —
        // grab the LAST call (this invocation), not the first.
        const [, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
        fetchSpy.mockRestore();
        return JSON.parse(init.body as string) as Record<string, unknown>;
      }

      it('emits a quick_reply component with a payload parameter carrying the button id', async () => {
        const body = await sendAndCapturePayload([{ id: 'yes-1', type: 'QUICK_REPLY', label: 'Yes' }]);
        const template = body.template as { components?: unknown[] };
        expect(template.components).toEqual([
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'yes-1' }] },
        ]);
      });

      it('emits no components entry for URL buttons (static, nothing dynamic to send)', async () => {
        const body = await sendAndCapturePayload([{ id: 'u1', type: 'URL', label: 'Visit', url: 'https://example.com' }]);
        const template = body.template as { components?: unknown[] };
        expect(template.components).toBeUndefined();
      });

      it('emits no components entry for CALL buttons', async () => {
        const body = await sendAndCapturePayload([{ id: 'c1', type: 'CALL', label: 'Call us', phoneNumber: '+14155552671' }]);
        const template = body.template as { components?: unknown[] };
        expect(template.components).toBeUndefined();
      });

      it('concatenates header-media and button components', async () => {
        const body = await sendAndCapturePayload(
          [{ id: 'yes-1', type: 'QUICK_REPLY', label: 'Yes' }],
          { type: 'IMAGE', url: 'https://example.com/pic.jpg' },
        );
        const template = body.template as { components?: Array<{ type: string }> };
        expect(template.components).toHaveLength(2);
        expect(template.components?.[0]?.type).toBe('header');
        expect(template.components?.[1]?.type).toBe('button');
      });

      it('omits components entirely when neither header media nor buttons are present', async () => {
        const body = await sendAndCapturePayload(undefined);
        const template = body.template as { components?: unknown[] };
        expect(template.components).toBeUndefined();
      });
    });
  });
});

import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CloudApiService } from './cloud-api.service';
import { MediaService } from '../media/media.service';
import { SettingsService } from '../settings/settings.service';

function makeMedia() {
  return {
    readFile: jest.fn().mockResolvedValue(Buffer.from('fake-image-bytes')),
    mimeTypeForStoredName: jest.fn().mockReturnValue('image/jpeg'),
  };
}

function makeConfig() {
  return {
    getOrThrow: jest.fn().mockImplementation((key: string) => {
      if (key === 'META_ACCESS_TOKEN') return 'test-token';
      if (key === 'META_PHONE_NUMBER_ID') return 'test-phone-id';
      throw new Error(`Unexpected config key: ${key}`);
    }),
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'META_ACCESS_TOKEN') return 'test-token';
      if (key === 'META_PHONE_NUMBER_ID') return 'test-phone-id';
      return undefined;
    }),
  };
}

// DRY_RUN is DB-backed (SettingsService) and read live on every check — see the
// isDryRun getter on CloudApiService. Mock it the same way the real settings module
// resolves it (DB value with an env fallback), so a test can flip it mid-test to
// verify the check isn't cached from construction time (Gap 13 regression).
function makeSettings(dryRun: boolean) {
  return {
    getWithEnvFallback: jest.fn().mockReturnValue(dryRun ? 'true' : 'false'),
  };
}

describe('CloudApiService', () => {
  describe('DRY_RUN=true', () => {
    let service: CloudApiService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CloudApiService,
          { provide: ConfigService, useValue: makeConfig() },
          { provide: MediaService, useValue: makeMedia() },
          { provide: SettingsService, useValue: makeSettings(true) },
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

    it('uploadMediaAsset returns a dry asset id without calling fetch', async () => {
      const spy = jest.spyOn(global, 'fetch' as never);
      const assetId = await service.uploadMediaAsset('a.jpg');
      expect(assetId).toMatch(/^dry_asset_/);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('DRY_RUN=false', () => {
    let service: CloudApiService;
    let media: ReturnType<typeof makeMedia>;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(async () => {
      media = makeMedia();
      settings = makeSettings(false);
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CloudApiService,
          { provide: ConfigService, useValue: makeConfig() },
          { provide: MediaService, useValue: media },
          { provide: SettingsService, useValue: settings },
        ],
      }).compile();
      service = module.get<CloudApiService>(CloudApiService);
    });

    // Regression test for Gap 13: DRY_RUN must be read live from SettingsService on
    // every send, not cached once at construction — an operator flipping the toggle
    // mid-run must stop the very next send, without a process restart.
    it('stops sending real messages the moment DRY_RUN flips to true, without restarting the service', async () => {
      const mockResponse = { ok: true, json: jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.1' }] }) };
      const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(mockResponse as unknown as never);

      const first = await service.sendTemplate({ to: '+15551234567', templateName: 'hello_world' });
      expect(first.dryRun).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      settings.getWithEnvFallback.mockReturnValue('true');

      const second = await service.sendTemplate({ to: '+15551234567', templateName: 'hello_world' });
      expect(second.dryRun).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // unchanged — second call short-circuited

      fetchSpy.mockRestore();
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

    describe('uploadMediaAsset', () => {
      it('POSTs the file to Meta\'s /media endpoint and returns the asset id', async () => {
        const mockResponse = { ok: true, json: jest.fn().mockResolvedValue({ id: 'meta-asset-123' }) };
        const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(mockResponse as unknown as never);

        const assetId = await service.uploadMediaAsset('a.jpg');

        expect(assetId).toBe('meta-asset-123');
        expect(media.readFile).toHaveBeenCalledWith('a.jpg');
        const [url, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
        expect(url).toContain('/media');
        expect(init.method).toBe('POST');
        fetchSpy.mockRestore();
      });

      it('throws when Meta returns no asset id', async () => {
        const mockResponse = { ok: true, json: jest.fn().mockResolvedValue({}) };
        jest.spyOn(global, 'fetch' as never).mockResolvedValue(mockResponse as unknown as never);

        await expect(service.uploadMediaAsset('a.jpg')).rejects.toThrow('returned no asset id');
      });
    });

    describe('carousel components', () => {
      it('builds a carousel component with asset-id-based headers and per-card buttons', async () => {
        const mockResponse = { ok: true, json: jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.carousel' }] }) };
        const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(mockResponse as unknown as never);

        await service.sendTemplate({
          to: '+15551234567',
          templateName: 'carousel_template',
          carousel: {
            cards: [
              { id: 'c1', mediaUrl: 'http://x/a.jpg', body: 'A', buttons: [{ id: 'yes-1', type: 'QUICK_REPLY', label: 'Yes' }] },
              { id: 'c2', mediaUrl: 'http://x/b.jpg', mediaType: 'VIDEO', body: 'B', buttons: [] },
            ],
            assetIds: ['asset-a', 'asset-b'],
          },
        });

        const [, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { template: { components: Array<Record<string, unknown>> } };
        fetchSpy.mockRestore();

        expect(body.template.components).toEqual([
          {
            type: 'carousel',
            cards: [
              {
                card_index: 0,
                components: [
                  { type: 'header', parameters: [{ type: 'image', image: { id: 'asset-a' } }] },
                  { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'yes-1' }] },
                ],
              },
              {
                card_index: 1,
                components: [{ type: 'header', parameters: [{ type: 'video', video: { id: 'asset-b' } }] }],
              },
            ],
          },
        ]);
      });
    });
  });
});

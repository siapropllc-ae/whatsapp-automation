import { createHmac } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import type { FastifyRequest } from 'fastify';
import type { MetaWebhookPayload } from './types/cloud-api-webhook.types';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    META_VERIFY_TOKEN: VERIFY_TOKEN,
    META_APP_SECRET: APP_SECRET,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) };
}

const mockWebhooksService = {
  processCloudApiPayload: jest.fn().mockResolvedValue(undefined),
};

function signBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function fakeRequest(rawBody: string, signature?: string): FastifyRequest & { rawBody?: string } {
  return {
    rawBody,
    headers: signature ? { 'x-hub-signature-256': signature } : {},
  } as unknown as FastifyRequest & { rawBody?: string };
}

describe('WebhooksController', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
    jest.clearAllMocks();
  });

  describe('constructor — HMAC fail-open/fail-closed (Gap 7)', () => {
    it('boots fine in non-production when META_APP_SECRET is unset (Baileys-only deployments never hit this route)', async () => {
      process.env['NODE_ENV'] = 'development';
      await expect(
        Test.createTestingModule({
          controllers: [WebhooksController],
          providers: [
            { provide: WebhooksService, useValue: mockWebhooksService },
            { provide: ConfigService, useValue: makeConfig({ META_APP_SECRET: undefined }) },
          ],
        }).compile(),
      ).resolves.toBeDefined();
    });

    it('throws at construction in production when META_APP_SECRET is unset — a silent gap must not reach prod', async () => {
      process.env['NODE_ENV'] = 'production';
      await expect(
        Test.createTestingModule({
          controllers: [WebhooksController],
          providers: [
            { provide: WebhooksService, useValue: mockWebhooksService },
            { provide: ConfigService, useValue: makeConfig({ META_APP_SECRET: undefined }) },
          ],
        }).compile(),
      ).rejects.toThrow(/META_APP_SECRET must be set in production/);
    });

    it('boots fine in production when META_APP_SECRET is set', async () => {
      process.env['NODE_ENV'] = 'production';
      await expect(
        Test.createTestingModule({
          controllers: [WebhooksController],
          providers: [
            { provide: WebhooksService, useValue: mockWebhooksService },
            { provide: ConfigService, useValue: makeConfig() },
          ],
        }).compile(),
      ).resolves.toBeDefined();
    });
  });

  describe('verify (GET challenge)', () => {
    let controller: WebhooksController;

    beforeEach(async () => {
      process.env['NODE_ENV'] = 'test';
      const module: TestingModule = await Test.createTestingModule({
        controllers: [WebhooksController],
        providers: [
          { provide: WebhooksService, useValue: mockWebhooksService },
          { provide: ConfigService, useValue: makeConfig() },
        ],
      }).compile();
      controller = module.get(WebhooksController);
    });

    it('returns the challenge when mode=subscribe and the token matches', () => {
      expect(controller.verify('subscribe', VERIFY_TOKEN, 'challenge-123')).toBe('challenge-123');
    });

    it('throws when the token does not match', () => {
      expect(() => controller.verify('subscribe', 'wrong-token', 'challenge-123')).toThrow(ForbiddenException);
    });
  });

  describe('receive (POST) — HMAC validation', () => {
    let controller: WebhooksController;
    const payload: MetaWebhookPayload = { object: 'whatsapp_business_account', entry: [] };
    const rawBody = JSON.stringify(payload);

    beforeEach(async () => {
      process.env['NODE_ENV'] = 'test';
      const module: TestingModule = await Test.createTestingModule({
        controllers: [WebhooksController],
        providers: [
          { provide: WebhooksService, useValue: mockWebhooksService },
          { provide: ConfigService, useValue: makeConfig() },
        ],
      }).compile();
      controller = module.get(WebhooksController);
    });

    it('accepts a request with a valid signature', () => {
      const signature = signBody(rawBody, APP_SECRET);
      expect(controller.receive(fakeRequest(rawBody, signature), payload)).toEqual({ status: 'ok' });
      expect(mockWebhooksService.processCloudApiPayload).toHaveBeenCalledWith(payload);
    });

    it('rejects a request with a mismatched signature (403)', () => {
      const wrongSignature = signBody(rawBody, 'wrong-secret');
      expect(() => controller.receive(fakeRequest(rawBody, wrongSignature), payload)).toThrow(ForbiddenException);
      expect(mockWebhooksService.processCloudApiPayload).not.toHaveBeenCalled();
    });

    it('rejects a request with no signature header when a secret is configured', () => {
      expect(() => controller.receive(fakeRequest(rawBody), payload)).toThrow(ForbiddenException);
    });

    it('rejects a tampered body even with a signature computed for the original body', () => {
      const signature = signBody(rawBody, APP_SECRET);
      const tamperedBody = JSON.stringify({ ...payload, entry: [{ id: 'injected' }] });
      expect(() => controller.receive(fakeRequest(tamperedBody, signature), payload)).toThrow(ForbiddenException);
    });
  });

  describe('receive (POST) — HMAC disabled in dev when secret unset', () => {
    it('accepts any payload with no signature check when META_APP_SECRET is unset outside production', async () => {
      process.env['NODE_ENV'] = 'development';
      const module: TestingModule = await Test.createTestingModule({
        controllers: [WebhooksController],
        providers: [
          { provide: WebhooksService, useValue: mockWebhooksService },
          { provide: ConfigService, useValue: makeConfig({ META_APP_SECRET: undefined }) },
        ],
      }).compile();
      const controller = module.get(WebhooksController);
      const payload: MetaWebhookPayload = { object: 'whatsapp_business_account', entry: [] };

      expect(controller.receive(fakeRequest('anything', undefined), payload)).toEqual({ status: 'ok' });
    });
  });
});

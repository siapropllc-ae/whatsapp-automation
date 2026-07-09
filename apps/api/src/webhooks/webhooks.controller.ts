import { createHmac, timingSafeEqual } from 'crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { WebhooksService } from './webhooks.service';
import type { MetaWebhookPayload } from './types/cloud-api-webhook.types';
import { Public } from '../common/decorators/public.decorator';

@Public()
@Controller('webhooks/cloud-api')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);
  private readonly verifyToken: string;
  private readonly appSecret: string | undefined;

  constructor(
    private readonly webhooks: WebhooksService,
    config: ConfigService,
  ) {
    this.verifyToken = config.get<string>('META_VERIFY_TOKEN') ?? '';
    this.appSecret = config.get<string>('META_APP_SECRET');
    if (!this.verifyToken) {
      this.log.warn('META_VERIFY_TOKEN not set — Cloud API webhook verification will always fail');
    }
    if (!this.appSecret) {
      // This endpoint is @Public() with no other auth — an unset secret means anyone can
      // POST forged delivery-status/inbound-reply/ban-signal payloads. Mirrors ApiKeyGuard's
      // pattern: fine to boot without it in dev (Baileys-only deployments never hit this
      // route), but a silent gap in production is unacceptable.
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error(
          'META_APP_SECRET must be set in production if the Cloud API webhook route is reachable — ' +
            'without it, forged webhook payloads are accepted with no signature check. ' +
            'Set META_APP_SECRET in .env, or remove the webhook URL from the Meta app config if unused.',
        );
      }
      this.log.warn('META_APP_SECRET not set — webhook HMAC validation is DISABLED');
    }
  }

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    if (mode === 'subscribe' && token === this.verifyToken) {
      return challenge;
    }
    this.log.warn(`Webhook verification failed: mode=${mode} token=${token}`);
    throw new ForbiddenException('Webhook verification failed');
  }

  @Post()
  @HttpCode(200)
  receive(
    @Req() req: FastifyRequest & { rawBody?: string },
    @Body() payload: MetaWebhookPayload,
  ): { status: 'ok' } {
    this.validateHmac(
      req.rawBody ?? '',
      req.headers['x-hub-signature-256'] as string | undefined,
    );
    void this.webhooks
      .processCloudApiPayload(payload)
      .catch((err: unknown) =>
        this.log.error(`Webhook processing error: ${String(err)}`),
      );
    return { status: 'ok' };
  }

  private validateHmac(rawBody: string, signature: string | undefined): void {
    if (!this.appSecret) return; // skip if secret not configured
    if (!signature) throw new ForbiddenException('Missing X-Hub-Signature-256 header');
    const expected = 'sha256=' + createHmac('sha256', this.appSecret).update(rawBody, 'utf8').digest('hex');
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      this.log.warn('Webhook HMAC mismatch — possible forged payload');
      throw new ForbiddenException('Webhook signature mismatch');
    }
  }
}

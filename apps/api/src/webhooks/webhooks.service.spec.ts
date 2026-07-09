import { Test, type TestingModule } from '@nestjs/testing';
import { MsgStatus, SessionMode } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionsGateway } from '../sessions/sessions.gateway';
import { SessionsService } from '../sessions/sessions.service';
import type { MetaWebhookPayload } from './types/cloud-api-webhook.types';

const mockPrisma = {
  campaignMessage: {
    updateMany: jest.fn(),
    findFirst: jest.fn().mockResolvedValue({ campaignId: 'campaign-1' }),
    update: jest.fn().mockResolvedValue({}),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  contact: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  reply: {
    create: jest.fn(),
    findUnique: jest.fn().mockResolvedValue(null), // not a duplicate by default
  },
  session: {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
  },
};

const mockGateway = {
  emitCampaignStats: jest.fn(),
  emitReply: jest.fn(),
  emitStatus: jest.fn(),
};

const mockSessions = {
  pauseCampaignsForSession: jest.fn().mockResolvedValue(0),
};

function makeStatusPayload(
  status: string,
  wamid = 'wamid.test123',
): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15556783007',
                phone_number_id: '123456',
              },
              statuses: [
                {
                  id: wamid,
                  status: status as 'sent' | 'delivered' | 'read' | 'failed',
                  timestamp: '1690000000',
                  recipient_id: '15551234567',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function makeInboundPayload(from: string, body: string): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15556783007',
                phone_number_id: '123456',
              },
              contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: 'wamid.inbound123',
                  timestamp: '1690000000',
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('WebhooksService', () => {
  let service: WebhooksService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SessionsGateway, useValue: mockGateway },
        { provide: SessionsService, useValue: mockSessions },
      ],
    }).compile();
    service = module.get<WebhooksService>(WebhooksService);
  });

  describe('Status updates', () => {
    it.each([
      ['delivered', MsgStatus.DELIVERED],
      ['read', MsgStatus.READ],
      ['sent', MsgStatus.SENT],
      ['failed', MsgStatus.FAILED],
    ])('maps "%s" → MsgStatus.%s and only promotes (rank guard)', async (rawStatus, expected) => {
      mockPrisma.campaignMessage.updateMany.mockResolvedValue({ count: 1 });
      await service.processCloudApiPayload(makeStatusPayload(rawStatus));
      // The where clause now includes a rank guard (status: { in: [...lower statuses] })
      // to prevent out-of-order Meta events from downgrading message status.
      expect(mockPrisma.campaignMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ wamid: 'wamid.test123', status: expect.objectContaining({ in: expect.any(Array) }) }),
          data: { status: expected },
        }),
      );
    });

    it('warns when wamid is unknown (count 0)', async () => {
      mockPrisma.campaignMessage.updateMany.mockResolvedValue({ count: 0 });
      const warnSpy = jest.spyOn(service['log'], 'warn');
      await service.processCloudApiPayload(
        makeStatusPayload('delivered', 'wamid.unknown999'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('wamid.unknown999'),
      );
    });
  });

  describe('Inbound messages', () => {
    it('creates a Reply for a known contact', async () => {
      const contact = { id: 'contact-1', phone: '15551234567' };
      mockPrisma.contact.findUnique.mockResolvedValue(contact);
      mockPrisma.campaignMessage.findFirst.mockResolvedValue({
        id: 'msg-1',
        campaignId: 'campaign-1',
        status: MsgStatus.DELIVERED,
        sentAt: new Date(),
      });
      mockPrisma.reply.create.mockResolvedValue({});

      await service.processCloudApiPayload(
        makeInboundPayload('15551234567', 'Hello!'),
      );

      expect(mockPrisma.reply.create).toHaveBeenCalledWith({
        data: {
          contactId: 'contact-1',
          campaignId: 'campaign-1',
          text: 'Hello!',
          waMessageId: 'wamid.inbound123',
        },
      });
    });

    it('creates a Reply with null campaignId when no prior message exists', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({ id: 'c-2', phone: '15551111111' });
      mockPrisma.campaignMessage.findFirst.mockResolvedValue(null);
      mockPrisma.reply.create.mockResolvedValue({});

      await service.processCloudApiPayload(
        makeInboundPayload('15551111111', 'Interested!'),
      );

      expect(mockPrisma.reply.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ campaignId: null }),
      });
    });

    it('skips Reply creation for unknown phone', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(null);
      const warnSpy = jest.spyOn(service['log'], 'warn');

      await service.processCloudApiPayload(
        makeInboundPayload('99999999999', 'Hi'),
      );

      expect(mockPrisma.reply.create).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown phone'),
      );
    });

    it('creates a Reply with buttonId/buttonLabel for a quick-reply button tap', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({ id: 'contact-1', phone: '15551234567' });
      mockPrisma.campaignMessage.findFirst.mockResolvedValue({
        id: 'msg-1',
        campaignId: 'campaign-1',
        status: MsgStatus.DELIVERED,
        sentAt: new Date(),
      });
      mockPrisma.reply.create.mockResolvedValue({});

      const payload: MetaWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15556783007', phone_number_id: '123456' },
                  messages: [
                    {
                      from: '15551234567',
                      id: 'wamid.btn1',
                      timestamp: '1690000000',
                      type: 'button',
                      button: { payload: 'yes-1', text: 'Yes' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await service.processCloudApiPayload(payload);

      expect(mockPrisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'campaign-1', text: 'Yes', buttonId: 'yes-1', buttonLabel: 'Yes', waMessageId: 'wamid.btn1' },
      });
    });

    it('creates a Reply with buttonId/buttonLabel for a session-interactive button tap', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({ id: 'contact-1', phone: '15551234567' });
      mockPrisma.campaignMessage.findFirst.mockResolvedValue({
        id: 'msg-1',
        campaignId: 'campaign-1',
        status: MsgStatus.DELIVERED,
        sentAt: new Date(),
      });
      mockPrisma.reply.create.mockResolvedValue({});

      const payload: MetaWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15556783007', phone_number_id: '123456' },
                  messages: [
                    {
                      from: '15551234567',
                      id: 'wamid.interactive1',
                      timestamp: '1690000000',
                      type: 'interactive',
                      interactive: { type: 'button_reply', button_reply: { id: 'no-1', title: 'No' } },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await service.processCloudApiPayload(payload);

      expect(mockPrisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'campaign-1', text: 'No', buttonId: 'no-1', buttonLabel: 'No', waMessageId: 'wamid.interactive1' },
      });
    });

    it('resolves a carousel card\'s button tap identically to a single-card button (no template lookup involved)', async () => {
      // Locks in the claim that carousel support needed zero webhook-side code changes:
      // resolveInboundContent reads button/interactive fields straight off the inbound
      // message — it never looks at which template (single-card or carousel) produced
      // the tap, so a carousel card's button_reply arrives in the exact same shape.
      mockPrisma.contact.findUnique.mockResolvedValue({ id: 'contact-1', phone: '15551234567' });
      mockPrisma.campaignMessage.findFirst.mockResolvedValue({
        id: 'msg-1',
        campaignId: 'campaign-1',
        status: MsgStatus.DELIVERED,
        sentAt: new Date(),
      });
      mockPrisma.reply.create.mockResolvedValue({});

      const payload: MetaWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15556783007', phone_number_id: '123456' },
                  messages: [
                    {
                      from: '15551234567',
                      id: 'wamid.carousel-card2-btn',
                      timestamp: '1690000000',
                      type: 'interactive',
                      interactive: { type: 'button_reply', button_reply: { id: 'card2-btn-1', title: 'Book Now' } },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await service.processCloudApiPayload(payload);

      expect(mockPrisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'campaign-1', text: 'Book Now', buttonId: 'card2-btn-1', buttonLabel: 'Book Now', waMessageId: 'wamid.carousel-card2-btn' },
      });
    });

    it('skips non-text messages silently', async () => {
      const payload: MetaWebhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15556783007',
                    phone_number_id: '123456',
                  },
                  messages: [
                    {
                      from: '15551234567',
                      id: 'wamid.img',
                      timestamp: '1690000000',
                      type: 'image',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      await service.processCloudApiPayload(payload);
      expect(mockPrisma.reply.create).not.toHaveBeenCalled();
    });
  });

  it('ignores payloads not from whatsapp_business_account', async () => {
    await service.processCloudApiPayload({
      object: 'page',
      entry: [],
    });
    expect(mockPrisma.campaignMessage.updateMany).not.toHaveBeenCalled();
  });

  describe('Opt-out detection', () => {
    beforeEach(() => {
      mockPrisma.contact.findUnique.mockResolvedValue({ id: 'contact-1', phone: '15551234567' });
      mockPrisma.campaignMessage.findFirst.mockResolvedValue(null);
      mockPrisma.reply.create.mockResolvedValue({});
    });

    it.each(['STOP', 'stop', 'unsubscribe', 'optout'])(
      'marks contact invalid on standalone keyword "%s"',
      async (word) => {
        await service.processCloudApiPayload(makeInboundPayload('15551234567', word));
        expect(mockPrisma.contact.update).toHaveBeenCalledWith({
          where: { id: 'contact-1' },
          data: { valid: false },
        });
      },
    );

    it.each(['remove me', 'opt out', "don't message", 'stop messaging', 'no more messages'])(
      'marks contact invalid on phrase "%s"',
      async (phrase) => {
        await service.processCloudApiPayload(
          makeInboundPayload('15551234567', `please ${phrase}`),
        );
        expect(mockPrisma.contact.update).toHaveBeenCalledWith({
          where: { id: 'contact-1' },
          data: { valid: false },
        });
      },
    );

    it.each([
      'non-stop flight to Dubai',
      'the bus stop is closer now',
      "I won't stop using your product",
    ])('does NOT opt out on false-positive substring "%s"', async (text) => {
      await service.processCloudApiPayload(makeInboundPayload('15551234567', text));
      expect(mockPrisma.contact.update).not.toHaveBeenCalled();
    });

    it('does not opt out on an unrelated reply', async () => {
      await service.processCloudApiPayload(
        makeInboundPayload('15551234567', "Sounds great, let's talk tomorrow"),
      );
      expect(mockPrisma.contact.update).not.toHaveBeenCalled();
    });
  });

  // Regression test for: Meta's webhook delivery is documented at-least-once — a
  // redelivered notification for a message already processed must not create a second
  // Reply row (inflates reply counts, duplicates rows in the Replies UI).
  describe('Inbound message idempotency', () => {
    beforeEach(() => {
      mockPrisma.contact.findUnique.mockResolvedValue({ id: 'contact-1', phone: '15551234567' });
      mockPrisma.campaignMessage.findFirst.mockResolvedValue(null);
      mockPrisma.reply.create.mockResolvedValue({});
    });

    it('skips creating a second Reply when the same wamid is redelivered', async () => {
      mockPrisma.reply.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'reply-1' });

      const payload = makeInboundPayload('15551234567', 'Hello!');
      await service.processCloudApiPayload(payload);
      await service.processCloudApiPayload(payload); // redelivery of the exact same webhook

      expect(mockPrisma.reply.create).toHaveBeenCalledTimes(1);
    });

    it('swallows a P2002 unique-constraint race as an already-processed duplicate', async () => {
      mockPrisma.reply.create.mockRejectedValueOnce({ code: 'P2002' });

      await expect(
        service.processCloudApiPayload(makeInboundPayload('15551234567', 'Hello!')),
      ).resolves.not.toThrow();
    });
  });

  // Cloud API's only ban/restriction signal — there's no persistent connection to drop
  // the way Baileys detects a ban via disconnect codes.
  describe('account_update (Gap 1: Cloud API ban detection)', () => {
    function makeAccountUpdatePayload(value: Record<string, unknown>): MetaWebhookPayload {
      return {
        object: 'whatsapp_business_account',
        entry: [{ id: 'WABA_ID', changes: [{ field: 'account_update', value } as never] }],
      };
    }

    it('marks the session BANNED and pauses its campaigns on DISABLED_UPDATE', async () => {
      mockPrisma.session.findMany.mockResolvedValueOnce([
        { id: 'sess-1', mode: SessionMode.CLOUD_API, cloudApi: { wabaId: 'WABA_ID', phoneNumberId: '123' } },
      ]);

      await service.processCloudApiPayload(
        makeAccountUpdatePayload({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } }),
      );

      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { status: 'BANNED' },
      });
      expect(mockSessions.pauseCampaignsForSession).toHaveBeenCalledWith('sess-1');
    });

    it('pauses campaigns (without marking BANNED) on ACCOUNT_RESTRICTION', async () => {
      mockPrisma.session.findMany.mockResolvedValueOnce([
        { id: 'sess-1', mode: SessionMode.CLOUD_API, cloudApi: { wabaId: 'WABA_ID', phoneNumberId: '123' } },
      ]);

      await service.processCloudApiPayload(
        makeAccountUpdatePayload({ event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING' }] }),
      );

      expect(mockPrisma.session.update).not.toHaveBeenCalled();
      expect(mockSessions.pauseCampaignsForSession).toHaveBeenCalledWith('sess-1');
    });

    it('ignores account_update events that are not a ban/restriction signal', async () => {
      mockPrisma.session.findMany.mockResolvedValueOnce([
        { id: 'sess-1', mode: SessionMode.CLOUD_API, cloudApi: { wabaId: 'WABA_ID', phoneNumberId: '123' } },
      ]);

      await service.processCloudApiPayload(makeAccountUpdatePayload({ event: 'SOME_OTHER_EVENT' }));

      expect(mockSessions.pauseCampaignsForSession).not.toHaveBeenCalled();
    });

    it('only pauses sessions matching the WABA id in cloudApi JSON, not other CLOUD_API sessions', async () => {
      mockPrisma.session.findMany.mockResolvedValueOnce([
        { id: 'sess-other-waba', mode: SessionMode.CLOUD_API, cloudApi: { wabaId: 'DIFFERENT_WABA' } },
      ]);

      await service.processCloudApiPayload(
        makeAccountUpdatePayload({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'DISABLE' } }),
      );

      expect(mockSessions.pauseCampaignsForSession).not.toHaveBeenCalled();
    });
  });

  describe('account_review_update', () => {
    it('pauses campaigns for a REJECTED WABA review', async () => {
      mockPrisma.session.findMany.mockResolvedValueOnce([
        { id: 'sess-1', mode: SessionMode.CLOUD_API, cloudApi: { wabaId: 'WABA_ID' } },
      ]);

      await service.processCloudApiPayload({
        object: 'whatsapp_business_account',
        entry: [{ id: 'WABA_ID', changes: [{ field: 'account_review_update', value: { decision: 'REJECTED' } } as never] }],
      });

      expect(mockSessions.pauseCampaignsForSession).toHaveBeenCalledWith('sess-1');
    });

    it('takes no action for APPROVED', async () => {
      await service.processCloudApiPayload({
        object: 'whatsapp_business_account',
        entry: [{ id: 'WABA_ID', changes: [{ field: 'account_review_update', value: { decision: 'APPROVED' } } as never] }],
      });

      expect(mockSessions.pauseCampaignsForSession).not.toHaveBeenCalled();
      expect(mockPrisma.session.findMany).not.toHaveBeenCalled();
    });
  });

  describe('phone_number_quality_update', () => {
    it('logs a warning on a tier demotion (does not pause — sending still works, just slower)', async () => {
      const service_ = service as unknown as { log: { warn: jest.Mock } };
      const warnSpy = jest.spyOn(service_.log, 'warn');

      await service.processCloudApiPayload({
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_ID',
          changes: [{
            field: 'phone_number_quality_update',
            value: { display_phone_number: '15551234567', event: 'DOWNGRADE', old_limit: 'TIER_10K', current_limit: 'TIER_250' },
          } as never],
        }],
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DEMOTION'));
      expect(mockSessions.pauseCampaignsForSession).not.toHaveBeenCalled();
    });

    it('does not warn on a tier upgrade', async () => {
      const service_ = service as unknown as { log: { warn: jest.Mock } };
      const warnSpy = jest.spyOn(service_.log, 'warn');

      await service.processCloudApiPayload({
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_ID',
          changes: [{
            field: 'phone_number_quality_update',
            value: { display_phone_number: '15551234567', event: 'UPGRADE', old_limit: 'TIER_250', current_limit: 'TIER_10K' },
          } as never],
        }],
      });

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('DEMOTION'));
    });
  });

  it('logs unhandled webhook fields instead of silently dropping them', async () => {
    const debugSpy = jest.spyOn(service['log'], 'debug');
    await service.processCloudApiPayload({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_ID', changes: [{ field: 'message_template_status_update', value: {} } as never] }],
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('message_template_status_update'));
  });
});

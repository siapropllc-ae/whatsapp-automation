import { Test, type TestingModule } from '@nestjs/testing';
import { MsgStatus } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionsGateway } from '../sessions/sessions.gateway';
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
  },
};

const mockGateway = {
  emitCampaignStats: jest.fn(),
  emitReply: jest.fn(),
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
        data: { contactId: 'contact-1', campaignId: 'campaign-1', text: 'Yes', buttonId: 'yes-1', buttonLabel: 'Yes' },
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
        data: { contactId: 'contact-1', campaignId: 'campaign-1', text: 'No', buttonId: 'no-1', buttonLabel: 'No' },
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
});

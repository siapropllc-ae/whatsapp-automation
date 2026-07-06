import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CampaignStatus, MediaType, MsgStatus, SessionMode, SessionStatus } from '@prisma/client';
import { CampaignsService } from './campaigns.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { DelayService } from '../antiban/delay.service';
import { WarmupService } from '../antiban/warmup.service';
import { OutboxProducer } from '../queue/outbox.producer';
import { SmartListsService } from '../smart-lists/smart-lists.service';
import { MediaService } from '../media/media.service';
import { CloudApiService } from '../cloud-api/cloud-api.service';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeSession(id: string, dailySent = 0, warmupDay = 15) {
  return {
    id,
    dailySent,
    warmupDay,
    status: SessionStatus.ONLINE,
    mode: SessionMode.BAILEYS,
    createdAt: new Date(),
    label: id,
    phoneNumber: null,
    authState: null,
    cloudApi: null,
    fingerprint: null,
    proxyId: null,
  };
}

function makeContact(id: string) {
  return {
    id,
    phone: `+1555000${id}`,
    name: `User ${id}`,
    city: null,
    interest: null,
    vars: null,
    tags: [],
    valid: true,
    createdAt: new Date(),
  };
}

function makeTemplate() {
  return { id: 'tpl-1', name: 'Test Template', body: 'Hi {name}!', createdAt: new Date() };
}

function makeCampaign(status: CampaignStatus = CampaignStatus.DRAFT) {
  return {
    id: 'camp-1',
    name: 'Test',
    mode: SessionMode.BAILEYS,
    templateId: 'tpl-1',
    status,
    activeFrom: 8,
    activeTo: 22,
    createdAt: new Date(),
  };
}

// ── mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  campaign: {
    findUniqueOrThrow: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  template: { findUnique: jest.fn().mockResolvedValue(makeTemplate()) },
  contact: { findMany: jest.fn() },
  session: { findMany: jest.fn() },
  campaignMessage: {
    create: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn(),
  },
};

const mockDelay = {
  computeDelayMs: jest.fn().mockReturnValue(10_000),
  isWithinActiveHours: jest.fn().mockReturnValue(true),
  msUntilNextWindow: jest.fn().mockReturnValue(3_600_000),
  meanMs: 10_000,
  stdDevMs: 4_000,
  floorMs: 5_000,
  ceilingMs: 45_000,
  typingMs: 1_500,
};

// WarmupService mock: defaults to env limit (200) — matches warmupDay=15 sessions
const mockWarmup = {
  getEffectiveDailyLimit: jest.fn().mockReturnValue(200),
  dailyLimit: 200,
};

const mockProducer = {
  enqueue: jest.fn().mockResolvedValue(undefined),
};

const mockSmartLists = {
  resolveContactIds: jest.fn().mockResolvedValue([]),
};

const mockMedia = {
  storedNameFromUrl: jest.fn((url: string) => url.split('/').pop() ?? null),
};

const mockCloudApi = {
  uploadMediaAsset: jest.fn().mockImplementation((storedName: string) => Promise.resolve(`asset-${storedName}`)),
};

// ── suite ────────────────────────────────────────────────────────────────────

describe('CampaignsService', () => {
  let service: CampaignsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);

    // Default campaign update/updateMany to succeed
    mockPrisma.campaign.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...makeCampaign(), ...data }),
    );
    mockPrisma.campaign.updateMany.mockResolvedValue({ count: 1 });

    // Default message create
    mockPrisma.campaignMessage.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: `msg-${String(data['contactId'])}`, ...data }),
    );

    const module = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: DelayService, useValue: mockDelay },
        { provide: WarmupService, useValue: mockWarmup },
        { provide: OutboxProducer, useValue: mockProducer },
        { provide: SmartListsService, useValue: mockSmartLists },
        { provide: MediaService, useValue: mockMedia },
        { provide: CloudApiService, useValue: mockCloudApi },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(CampaignsService);
  });

  // ── create ───────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('persists media attachment fields when provided', async () => {
      mockPrisma.campaign.create.mockResolvedValue(makeCampaign());

      await service.create({
        name: 'Promo',
        mode: SessionMode.BAILEYS,
        mediaUrl: 'http://localhost:3001/api/media/a.jpg',
        mediaType: MediaType.IMAGE,
        mediaMimeType: 'image/jpeg',
        mediaFilename: 'a.jpg',
      });

      expect(mockPrisma.campaign.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaUrl: 'http://localhost:3001/api/media/a.jpg',
          mediaType: MediaType.IMAGE,
          mediaMimeType: 'image/jpeg',
          mediaFilename: 'a.jpg',
        }),
      });
    });

    it('passes media fields through as undefined when no attachment is given', async () => {
      mockPrisma.campaign.create.mockResolvedValue(makeCampaign());

      await service.create({ name: 'No Attachment', mode: SessionMode.BAILEYS });

      expect(mockPrisma.campaign.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaUrl: undefined,
          mediaType: undefined,
          mediaMimeType: undefined,
          mediaFilename: undefined,
        }),
      });
    });
  });

  // ── round-robin routing ────────────────────────────────────────────────────

  describe('round-robin session routing', () => {
    it('distributes contacts evenly across sessions in cyclic order', async () => {
      const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')];
      const contacts = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      const dto = { contactIds: contacts.map((c) => c.id) };
      await service.launch('camp-1', dto);

      const calls = mockProducer.enqueue.mock.calls as Array<[{ sessionId: string }, unknown]>;
      const assignedSessions = calls.map(([job]) => job.sessionId);

      // 6 contacts, 3 sessions → s1,s2,s3,s1,s2,s3
      expect(assignedSessions).toEqual(['s1', 's2', 's3', 's1', 's2', 's3']);
    });

    it('skips sessions that have reached the daily limit', async () => {
      // s1 is at limit per warmup cap, s2 has capacity
      // warmupDay=15 → limit=200; dailySent=200 means at limit
      const sessions = [makeSession('s1', 200), makeSession('s2', 0)];
      const contacts = ['c1', 'c2', 'c3'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      // s1 → limit 200, dailySent=200 → filtered; s2 → limit 200, dailySent=0 → kept
      mockWarmup.getEffectiveDailyLimit.mockImplementation(
        (s: { dailySent: number }) => (s.dailySent >= 200 ? 200 : 200),
      );

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      const calls = mockProducer.enqueue.mock.calls as Array<[{ sessionId: string }, unknown]>;
      const usedSessions = calls.map(([job]) => job.sessionId);

      expect(usedSessions).toEqual(['s2', 's2', 's2']);
    });

    it('assigns staggered delays with 2.5× stranger multiplier for first-time contacts', async () => {
      mockDelay.computeDelayMs
        .mockReturnValueOnce(10_000)
        .mockReturnValueOnce(8_000)
        .mockReturnValueOnce(12_000);

      const sessions = [makeSession('s1')];
      const contacts = ['c1', 'c2', 'c3'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);
      // findMany returns [] for alreadyQueued AND previouslySentToIds → all contacts are strangers

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      const delays = (mockProducer.enqueue.mock.calls as Array<[unknown, { delay: number }]>).map(
        ([, opts]) => opts.delay,
      );
      // Each gap × 2.5 (stranger penalty); cumulative: 25 000, 45 000, 75 000
      expect(delays).toEqual([25_000, 45_000, 75_000]);
    });

    it('assigns base delays (no multiplier) for contacts with previous messages', async () => {
      mockDelay.computeDelayMs
        .mockReturnValueOnce(10_000)
        .mockReturnValueOnce(8_000)
        .mockReturnValueOnce(12_000);

      const sessions = [makeSession('s1')];
      const contacts = ['c1', 'c2', 'c3'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);
      // All contacts already have previous sent messages → 1.0× multiplier
      mockPrisma.campaignMessage.findMany
        .mockResolvedValueOnce([])  // first call = alreadyQueued (empty → proceed)
        .mockResolvedValueOnce(contacts.map((c) => ({ contactId: c.id })));  // second = previouslySent

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      const delays = (mockProducer.enqueue.mock.calls as Array<[unknown, { delay: number }]>).map(
        ([, opts]) => opts.delay,
      );
      // No stranger penalty; cumulative: 10 000, 18 000, 30 000
      expect(delays).toEqual([10_000, 18_000, 30_000]);
    });
  });

  // ── warmup cap enforcement ─────────────────────────────────────────────────

  describe('warmup cap enforcement (Layer 2)', () => {
    it('filters session with dailySent >= warmup cap (day 0 → cap 30)', async () => {
      const sessions = [makeSession('s1', 31, 0), makeSession('s2', 0, 0)];
      const contacts = ['c1'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      // Configure warmup mock to return cap=30 for day-0 sessions
      mockWarmup.getEffectiveDailyLimit.mockImplementation(
        (s: { warmupDay: number }) => (s.warmupDay < 4 ? 30 : 200),
      );

      await service.launch('camp-1', { contactIds: ['c1'] });

      const calls = mockProducer.enqueue.mock.calls as Array<[{ sessionId: string }, unknown]>;
      // Only s2 (dailySent=0 < cap=30) should be used
      expect(calls[0]?.[0].sessionId).toBe('s2');
    });
  });

  // ── daily limit auto-pause ─────────────────────────────────────────────────

  describe('daily limit auto-pause', () => {
    it('pauses campaign and enqueues nothing when all sessions are at limit', async () => {
      const sessions = [makeSession('s1', 200), makeSession('s2', 200)];
      const contacts = ['c1', 'c2'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      expect(mockPrisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'camp-1' },
        data: { status: CampaignStatus.PAUSED },
      });
      expect(mockProducer.enqueue).not.toHaveBeenCalled();
    });

    it('does NOT pause when at least one session has capacity', async () => {
      const sessions = [makeSession('s1', 199), makeSession('s2', 200)];
      const contacts = ['c1'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      expect(mockPrisma.campaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'camp-1', status: { not: CampaignStatus.RUNNING } },
        data: { status: CampaignStatus.RUNNING },
      });
      expect(mockProducer.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // ── media attachment threading ────────────────────────────────────────────

  describe('media attachment threading into enqueued jobs', () => {
    it('threads campaign media fields into every OutboxJob when an attachment is set', async () => {
      const sessions = [makeSession('s1')];
      const contacts = ['c1', 'c2'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue({
        ...makeCampaign(),
        mediaUrl: 'http://localhost:3001/api/media/a.jpg',
        mediaType: MediaType.IMAGE,
        mediaMimeType: 'image/jpeg',
        mediaFilename: 'a.jpg',
      });
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      const jobs = (mockProducer.enqueue.mock.calls as Array<[Record<string, unknown>, unknown]>).map(
        ([job]) => job,
      );
      for (const job of jobs) {
        expect(job['mediaUrl']).toBe('http://localhost:3001/api/media/a.jpg');
        expect(job['mediaType']).toBe(MediaType.IMAGE);
        expect(job['mediaMimeType']).toBe('image/jpeg');
        expect(job['mediaFilename']).toBe('a.jpg');
      }
    });

    it('passes media fields as undefined (not null) when the campaign has no attachment', async () => {
      const sessions = [makeSession('s1')];
      const contacts = ['c1'].map(makeContact);

      // makeCampaign() has no media fields, mirroring a real Campaign row with null columns —
      // service code uses `campaign.mediaUrl ?? undefined` etc. at the enqueue call site.
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue({
        ...makeCampaign(),
        mediaUrl: null,
        mediaType: null,
        mediaMimeType: null,
        mediaFilename: null,
      });
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      await service.launch('camp-1', { contactIds: ['c1'] });

      const [job] = mockProducer.enqueue.mock.calls[0] as [Record<string, unknown>, unknown];
      expect(job['mediaUrl']).toBeUndefined();
      expect(job['mediaType']).toBeUndefined();
      expect(job['mediaMimeType']).toBeUndefined();
      expect(job['mediaFilename']).toBeUndefined();
    });
  });

  // ── button validation + pass-through ──────────────────────────────────────

  describe('launch() button handling', () => {
    it('throws BadRequestException for a Cloud-API-invalid button combo on a CLOUD_API campaign', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue({
        ...makeCampaign(),
        mode: SessionMode.CLOUD_API,
      });
      mockPrisma.template.findUnique.mockResolvedValue({
        ...makeTemplate(),
        // Mixing QUICK_REPLY with URL is invalid for Cloud API (never mixed)
        buttons: [
          { id: 'yes-1', type: 'QUICK_REPLY', label: 'Yes' },
          { id: 'u1', type: 'URL', label: 'Visit', url: 'https://example.com' },
        ],
      });
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await expect(service.launch('camp-1', { contactIds: ['c1'] })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockProducer.enqueue).not.toHaveBeenCalled();
    });

    it('passes valid buttons through to the enqueued job', async () => {
      const buttons = [{ id: 'yes-1', type: 'QUICK_REPLY', label: 'Yes' }];
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign()); // BAILEYS mode
      mockPrisma.template.findUnique.mockResolvedValue({ ...makeTemplate(), buttons });
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await service.launch('camp-1', { contactIds: ['c1'] });

      const [job] = mockProducer.enqueue.mock.calls[0] as [Record<string, unknown>, unknown];
      expect(job['buttons']).toEqual(buttons);
    });

    it('applies the lenient BAILEYS cap correctly — allows a mixed combo that would fail Cloud API', async () => {
      const buttons = [
        { id: 'yes-1', type: 'QUICK_REPLY', label: 'Yes' },
        { id: 'u1', type: 'URL', label: 'Visit', url: 'https://example.com' },
      ];
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign()); // BAILEYS mode
      mockPrisma.template.findUnique.mockResolvedValue({ ...makeTemplate(), buttons });
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await service.launch('camp-1', { contactIds: ['c1'] });

      expect(mockProducer.enqueue).toHaveBeenCalledTimes(1);
      const [job] = mockProducer.enqueue.mock.calls[0] as [Record<string, unknown>, unknown];
      expect(job['buttons']).toEqual(buttons);
    });

    it('passes buttons as undefined when the template has none', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.template.findUnique.mockResolvedValue(makeTemplate());
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await service.launch('camp-1', { contactIds: ['c1'] });

      const [job] = mockProducer.enqueue.mock.calls[0] as [Record<string, unknown>, unknown];
      expect(job['buttons']).toBeUndefined();
    });
  });

  // ── carousel launch handling ───────────────────────────────────────────────

  describe('launch() carousel handling', () => {
    const carouselCards = [
      { id: 'card1', mediaUrl: 'http://localhost:3001/api/media/a.jpg', body: 'Card A', buttons: [] },
      { id: 'card2', mediaUrl: 'http://localhost:3001/api/media/b.jpg', body: 'Card B', buttons: [] },
    ];

    it('uploads each card asset exactly once per launch (not per contact) in CLOUD_API mode', async () => {
      const contacts = ['c1', 'c2', 'c3'].map(makeContact);
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue({
        ...makeCampaign(),
        mode: SessionMode.CLOUD_API,
      });
      mockPrisma.template.findUnique.mockResolvedValue({ ...makeTemplate(), carouselCards });
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      expect(mockCloudApi.uploadMediaAsset).toHaveBeenCalledTimes(2); // once per card, not per contact
      expect(mockProducer.enqueue).toHaveBeenCalledTimes(3); // once per contact

      const jobs = (mockProducer.enqueue.mock.calls as Array<[Record<string, unknown>, unknown]>).map(([job]) => job);
      for (const job of jobs) {
        expect(job['carouselCardAssetIds']).toEqual(['asset-a.jpg', 'asset-b.jpg']);
        expect(job['carouselCards']).toEqual(carouselCards);
      }
    });

    it('never calls uploadMediaAsset in BAILEYS mode', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign()); // BAILEYS
      mockPrisma.template.findUnique.mockResolvedValue({ ...makeTemplate(), carouselCards });
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await service.launch('camp-1', { contactIds: ['c1'] });

      expect(mockCloudApi.uploadMediaAsset).not.toHaveBeenCalled();
      const [job] = mockProducer.enqueue.mock.calls[0] as [Record<string, unknown>, unknown];
      expect(job['carouselCards']).toEqual(carouselCards);
      expect(job['carouselCardAssetIds']).toBeUndefined();
    });

    it('throws BadRequestException for an invalid carousel (fewer than 2 cards)', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.template.findUnique.mockResolvedValue({ ...makeTemplate(), carouselCards: [carouselCards[0]] });
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await expect(service.launch('camp-1', { contactIds: ['c1'] })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockProducer.enqueue).not.toHaveBeenCalled();
    });
  });

  // ── guard rails ───────────────────────────────────────────────────────────

  describe('launch guard rails', () => {
    it('throws if campaign is DONE', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(
        makeCampaign(CampaignStatus.DONE),
      );
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await expect(
        service.launch('camp-1', { contactIds: ['c1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws if campaign has no template', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.template.findUnique.mockResolvedValue(null);

      await expect(
        service.launch('camp-1', { contactIds: ['c1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws if no valid contacts found', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue([]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await expect(
        service.launch('camp-1', { contactIds: ['c1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── resume ────────────────────────────────────────────────────────────────

  describe('resume', () => {
    it('sets campaign status to RUNNING when PAUSED', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(
        makeCampaign(CampaignStatus.PAUSED),
      );

      await service.resume('camp-1');

      expect(mockPrisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'camp-1' },
        data: { status: CampaignStatus.RUNNING },
      });
    });

    it('throws BadRequestException when campaign is not PAUSED', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(
        makeCampaign(CampaignStatus.RUNNING),
      );

      await expect(service.resume('camp-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── getStats ──────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('aggregates status counts correctly', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(
        makeCampaign(CampaignStatus.RUNNING),
      );
      mockPrisma.campaignMessage.groupBy.mockResolvedValue([
        { status: MsgStatus.QUEUED, _count: { status: 5 } },
        { status: MsgStatus.SENT, _count: { status: 10 } },
        { status: MsgStatus.FAILED, _count: { status: 2 } },
      ]);

      const stats = await service.getStats('camp-1');

      expect(stats.total).toBe(17);
      expect(stats.queued).toBe(5);
      expect(stats.sent).toBe(10);
      expect(stats.failed).toBe(2);
      expect(stats.delivered).toBe(0);
      expect(stats.status).toBe(CampaignStatus.RUNNING);
    });
  });
});

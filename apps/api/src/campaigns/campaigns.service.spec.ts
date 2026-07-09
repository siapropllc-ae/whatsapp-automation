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
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn().mockResolvedValue([]),
    // Default: no contact has any prior sent message — [] means prevSentCounts.get()
    // falls through to `?? 0` for everyone (all strangers), matching the old findMany
    // default this replaced (empty presence-check result).
    groupBy: jest.fn().mockResolvedValue([]),
  },
};

const mockDelay = {
  computeDelayMs: jest.fn().mockReturnValue(10_000),
  isWithinActiveHours: jest.fn().mockReturnValue(true),
  msUntilNextWindow: jest.fn().mockReturnValue(3_600_000),
  // Real DelayService.contactMultiplier tiering, reimplemented here since DelayService
  // itself is fully mocked in this suite — must stay in sync with delay.service.ts.
  contactMultiplier: jest.fn((prevSentCount: number) => (prevSentCount === 0 ? 2.5 : prevSentCount === 1 ? 1.8 : 1.0)),
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
  enqueueBulk: jest.fn().mockResolvedValue({ failedCampaignMessageIds: [] }),
};

/** launch() now flushes jobs via one enqueueBulk() call — unwrap the batch for assertions. */
function enqueuedJobs(): Array<{ data: Record<string, unknown>; delay: number }> {
  return (mockProducer.enqueueBulk.mock.calls[0]?.[0] ?? []) as Array<{
    data: Record<string, unknown>;
    delay: number;
  }>;
}

function firstJobData(): Record<string, unknown> {
  return enqueuedJobs()[0]?.data ?? {};
}

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

      const assignedSessions = enqueuedJobs().map((j) => j.data['sessionId']);

      // 6 contacts, 3 sessions → s1,s2,s3,s1,s2,s3
      expect(assignedSessions).toEqual(['s1', 's2', 's3', 's1', 's2', 's3']);
    });

    // Regression test for Gap 4: plain `i % sessions.length` cycling ignored each
    // session's remaining headroom, so a session close to its daily cap could absorb a
    // disproportionate share of a large batch (worst case observed: ~167 messages dumped
    // on one near-capacity session), skewing the split and creating a next-day thundering
    // herd once the worker gate deferred the overflow all at once.
    it('skips a near-capacity session once its headroom is exhausted, favoring sessions with more room', async () => {
      // s1 has room for exactly 2 more sends today; s2 has ample room (200)
      const s1 = makeSession('s1', 198);
      const s2 = makeSession('s2', 0);
      mockWarmup.getEffectiveDailyLimit.mockReturnValue(200); // both sessions share the same cap
      const contacts = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue([s1, s2]);

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      const assignedSessions = enqueuedJobs().map((j) => j.data['sessionId']);
      // s1 gets its 2 headroom slots (round-robin positions 0 and 2), then every
      // remaining contact — not just every-other — goes to s2 once s1 is exhausted.
      expect(assignedSessions).toEqual(['s1', 's2', 's1', 's2', 's2', 's2']);
      expect(assignedSessions.filter((id) => id === 's1')).toHaveLength(2);
    });

    it('falls back to unrestricted round-robin once every session has exhausted its tracked headroom', async () => {
      // Both sessions have exactly 1 slot of headroom, but the batch has 4 contacts —
      // the overflow must still be assigned (the worker's per-message gate is the real
      // enforcement point), just via plain round-robin once headroom tracking is spent.
      const s1 = makeSession('s1', 199);
      const s2 = makeSession('s2', 199);
      mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);
      const contacts = ['c1', 'c2', 'c3', 'c4'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue([s1, s2]);

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      const assignedSessions = enqueuedJobs().map((j) => j.data['sessionId']);
      expect(assignedSessions).toEqual(['s1', 's2', 's1', 's2']);
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

      const usedSessions = enqueuedJobs().map((j) => j.data['sessionId']);

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

      const delays = enqueuedJobs().map((j) => j.delay);
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
      // All contacts already have 3 prior sent messages each → past the 1.8× tier, so 1.0× (no penalty)
      mockPrisma.campaignMessage.groupBy.mockResolvedValue(
        contacts.map((c) => ({ contactId: c.id, _count: { _all: 3 } })),
      );

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      const delays = enqueuedJobs().map((j) => j.delay);
      // No stranger penalty; cumulative: 10 000, 18 000, 30 000
      expect(delays).toEqual([10_000, 18_000, 30_000]);
    });

    it('assigns the 1.8× second-message multiplier for a contact with exactly one prior sent message', async () => {
      mockDelay.computeDelayMs.mockReturnValueOnce(10_000);

      const sessions = [makeSession('s1')];
      const contacts = [makeContact('c1')];

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);
      mockPrisma.campaignMessage.groupBy.mockResolvedValue([{ contactId: 'c1', _count: { _all: 1 } }]);

      await service.launch('camp-1', { contactIds: ['c1'] });

      const delays = enqueuedJobs().map((j) => j.delay);
      expect(delays).toEqual([18_000]); // 10 000 × 1.8
    });
  });

  // ── enqueue reconciliation (Gap 3 regression) ──────────────────────────────
  // Without this, a Redis blip mid-launch (enqueueBulk throwing/partially failing after
  // createMany already persisted the rows as QUEUED) leaves those rows stuck forever —
  // AND invisible to a retried launch() call, since its dedup check only re-queues
  // contacts whose message status is FAILED.
  describe('enqueue reconciliation (Gap 3)', () => {
    it('marks messages FAILED when enqueueBulk reports they failed to reach Redis', async () => {
      const sessions = [makeSession('s1')];
      const contacts = ['c1', 'c2'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      let failedId = '';
      mockProducer.enqueueBulk.mockImplementationOnce(async (jobs: Array<{ data: { campaignMessageId: string } }>) => {
        failedId = jobs[0]!.data.campaignMessageId; // simulate only the first job failing to enqueue
        return { failedCampaignMessageIds: [failedId] };
      });

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      expect(mockPrisma.campaignMessage.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [failedId] } },
        data: { status: 'FAILED' },
      });
    });

    it('does not touch campaignMessage.updateMany when enqueueBulk reports no failures', async () => {
      const sessions = [makeSession('s1')];
      const contacts = ['c1'].map(makeContact);

      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.contact.findMany.mockResolvedValue(contacts);
      mockPrisma.session.findMany.mockResolvedValue(sessions);

      await service.launch('camp-1', { contactIds: contacts.map((c) => c.id) });

      expect(mockPrisma.campaignMessage.updateMany).not.toHaveBeenCalled();
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

      // Only s2 (dailySent=0 < cap=30) should be used
      expect(enqueuedJobs()[0]?.data['sessionId']).toBe('s2');
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
      expect(mockProducer.enqueueBulk).not.toHaveBeenCalled();
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
      expect(enqueuedJobs()).toHaveLength(1);
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

      const jobs = enqueuedJobs().map((j) => j.data);
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

      const job = firstJobData();
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
      expect(mockProducer.enqueueBulk).not.toHaveBeenCalled();
    });

    it('passes valid buttons through to the enqueued job', async () => {
      const buttons = [{ id: 'yes-1', type: 'QUICK_REPLY', label: 'Yes' }];
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign()); // BAILEYS mode
      mockPrisma.template.findUnique.mockResolvedValue({ ...makeTemplate(), buttons });
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await service.launch('camp-1', { contactIds: ['c1'] });

      expect(firstJobData()['buttons']).toEqual(buttons);
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

      expect(enqueuedJobs()).toHaveLength(1);
      expect(firstJobData()['buttons']).toEqual(buttons);
    });

    it('passes buttons as undefined when the template has none', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.template.findUnique.mockResolvedValue(makeTemplate());
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await service.launch('camp-1', { contactIds: ['c1'] });

      expect(firstJobData()['buttons']).toBeUndefined();
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

      const jobs = enqueuedJobs().map((j) => j.data);
      expect(jobs).toHaveLength(3); // once per contact
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
      const job = firstJobData();
      expect(job['carouselCards']).toEqual(carouselCards);
      expect(job['carouselCardAssetIds']).toBeUndefined();
    });

    it('throws BadRequestException for an invalid carousel (fewer than 2 cards)', async () => {
      mockPrisma.campaign.findUniqueOrThrow.mockResolvedValue(makeCampaign());
      mockPrisma.template.findUnique.mockResolvedValue({ ...makeTemplate(), carouselCards: [carouselCards[0]] });
      mockPrisma.contact.findMany.mockResolvedValue([makeContact('c1')]);
      mockPrisma.session.findMany.mockResolvedValue([makeSession('s1')]);

      await expect(service.launch('camp-1', { contactIds: ['c1'] })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockProducer.enqueueBulk).not.toHaveBeenCalled();
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

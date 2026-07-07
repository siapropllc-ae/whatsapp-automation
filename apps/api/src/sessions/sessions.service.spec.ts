import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma, SessionMode, SessionStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';
import { SessionsGateway } from './sessions.gateway';
import { PrismaService } from '../common/prisma/prisma.service';
import { FingerprintService } from '../antiban/fingerprint.service';
import { ProxyService } from '../antiban/proxy.service';
import { ContactsService } from '../contacts/contacts.service';
import { MediaService } from '../media/media.service';

import makeWASocket from '@whiskeysockets/baileys';

// Mock Baileys to prevent real WebSocket connections
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({
    ev: { on: jest.fn() },
    user: { id: '15551234567:0@s.whatsapp.net' },
    logout: jest.fn().mockResolvedValue(undefined),
    requestPairingCode: jest.fn().mockResolvedValue('ABCD-1234'),
    sendPresenceUpdate: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    relayMessage: jest.fn().mockResolvedValue(undefined),
    onWhatsApp: jest.fn().mockResolvedValue([]),
  }),
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
  generateWAMessageFromContent: jest.fn().mockReturnValue({ key: { id: 'wa-msg-1' }, message: {} }),
  DisconnectReason: { loggedOut: 401 },
  Browsers: { macOS: jest.fn().mockReturnValue(['Mac OS X', 'Safari', '16.4']) },
}));

// Stub build-fetch-agent so we can assert on it without real proxy libraries
jest.mock('./baileys/build-fetch-agent', () => ({
  buildFetchAgent: jest.fn(),
}));

import { buildFetchAgent } from './baileys/build-fetch-agent';

jest.mock('./baileys/db-auth-state', () => ({
  makeDbAuthState: jest.fn().mockResolvedValue({
    state: { creds: {}, keys: { get: jest.fn(), set: jest.fn() } },
    saveCreds: jest.fn().mockResolvedValue(undefined),
  }),
}));

const mockSession = {
  id: 'sess-1',
  label: 'Test',
  mode: SessionMode.BAILEYS,
  phoneNumber: null,
  status: SessionStatus.OFFLINE,
  authState: null,
  cloudApi: null,
  fingerprint: null,
  proxyId: null,
  warmupDay: 0,
  dailySent: 0,
  createdAt: new Date(),
  messages: [],
};

const mockFingerprint = {
  assignFingerprint: jest.fn().mockResolvedValue({
    userAgent: 'WhatsApp/2.24.6.77 A',
    deviceModel: 'Pixel 7',
    osVersion: 'Android 13',
    screenWidth: 1080,
    screenHeight: 2400,
  }),
  getFingerprint: jest.fn().mockResolvedValue(undefined),
  rotateFingerprints: jest.fn().mockResolvedValue(undefined),
};

const mockProxy = {
  assignProxy: jest.fn().mockResolvedValue(null), // no proxy by default
  releaseProxy: jest.fn().mockResolvedValue(undefined),
  rotateStalledProxies: jest.fn().mockResolvedValue(undefined),
};

describe('SessionsService', () => {
  let service: SessionsService;
  let prisma: jest.Mocked<PrismaService>;
  let gateway: jest.Mocked<SessionsGateway>;
  let media: { storedNameFromUrl: jest.Mock; readFile: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockPrisma = {
      session: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(mockSession),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue(mockSession),
        delete: jest.fn().mockResolvedValue(mockSession),
      },
      contact: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      reply: {
        create: jest.fn().mockResolvedValue({}),
      },
      campaignMessage: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      campaign: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const mockGateway = {
      emitQr: jest.fn(),
      emitStatus: jest.fn(),
      emitReply: jest.fn(),
    };
    const mockConfig = {
      getOrThrow: jest.fn().mockReturnValue('test-session-encryption-key'),
      get: jest.fn().mockReturnValue(undefined), // DRY_RUN / ACTIVE_HOURS_TIMEZONE etc.
    };
    const mockContactsService = {
      upsertFromWhatsApp: jest.fn().mockResolvedValue({ imported: 0 }),
    };
    const mockMedia = {
      storedNameFromUrl: jest.fn(),
      readFile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SessionsGateway, useValue: mockGateway },
        { provide: FingerprintService, useValue: mockFingerprint },
        { provide: ProxyService, useValue: mockProxy },
        { provide: ContactsService, useValue: mockContactsService },
        { provide: MediaService, useValue: mockMedia },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<SessionsService>(SessionsService);
    prisma = module.get(PrismaService);
    gateway = module.get(SessionsGateway);
    media = module.get(MediaService);
  });

  describe('onModuleInit', () => {
    it('reconnects sessions that were ONLINE at shutdown', async () => {
      const onlineSession = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findMany as jest.Mock).mockResolvedValue([onlineSession]);

      await service.onModuleInit();

      expect(prisma.session.findMany).toHaveBeenCalledWith({
        where: {
          mode: SessionMode.BAILEYS,
          status: { in: [SessionStatus.ONLINE, SessionStatus.CONNECTING] },
        },
      });
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: onlineSession.id },
        data: { status: SessionStatus.CONNECTING },
      });
    });

    it('does nothing when no sessions need reconnect', async () => {
      (prisma.session.findMany as jest.Mock).mockResolvedValue([]);
      await service.onModuleInit();
      expect(prisma.session.update).not.toHaveBeenCalled();
    });
  });

  describe('createSession', () => {
    it('creates a session via Prisma', async () => {
      const dto = { label: 'My Phone', mode: 'BAILEYS' as const };
      (prisma.session.create as jest.Mock).mockResolvedValue({ ...mockSession, label: dto.label });

      const result = await service.createSession(dto);

      expect(prisma.session.create).toHaveBeenCalledWith({
        data: { label: 'My Phone', mode: 'BAILEYS', phoneNumber: undefined },
      });
      expect(result.label).toBe('My Phone');
    });

    it('passes phoneNumber when provided and auto-sets ONLINE for CLOUD_API', async () => {
      const dto = { label: 'Work', mode: 'CLOUD_API' as const, phoneNumber: '+15551234567' };
      (prisma.session.create as jest.Mock).mockResolvedValue(mockSession);

      await service.createSession(dto);

      expect(prisma.session.create).toHaveBeenCalledWith({
        data: {
          label: 'Work',
          mode: 'CLOUD_API',
          phoneNumber: '+15551234567',
          status: SessionStatus.ONLINE,
        },
      });
    });
  });

  describe('listSessions', () => {
    it('returns sessions ordered by createdAt desc', async () => {
      (prisma.session.findMany as jest.Mock).mockResolvedValue([mockSession]);

      const result = await service.listSessions();

      expect(prisma.session.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
      expect(result).toHaveLength(1);
    });
  });

  describe('getHealth', () => {
    it('returns status and phoneNumber', async () => {
      const session = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findUniqueOrThrow as jest.Mock).mockResolvedValue(session);

      const result = await service.getHealth('sess-1');

      expect(result).toEqual({ status: SessionStatus.ONLINE, phoneNumber: '+15551234567' });
    });

    it('returns null phoneNumber when not set', async () => {
      (prisma.session.findUniqueOrThrow as jest.Mock).mockResolvedValue(mockSession);

      const result = await service.getHealth('sess-1');

      expect(result.phoneNumber).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('releases proxy then deletes the session from Prisma', async () => {
      (prisma.session.delete as jest.Mock).mockResolvedValue(mockSession);

      await service.deleteSession('sess-1');

      expect(mockProxy.releaseProxy).toHaveBeenCalledWith('sess-1');
      expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 'sess-1' } });
    });

    it('decrements socket count when active socket exists', async () => {
      expect(service.getSocketCount()).toBe(0);
      await service.deleteSession('nonexistent');
      expect(service.getSocketCount()).toBe(0);
    });
  });

  describe('onModuleDestroy', () => {
    it('does not throw when sockets map is empty', async () => {
      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });
  });

  // ── Proxy fetch-agent injection ──────────────────────────────────────────────

  describe('startSocket (proxy integration)', () => {
    it('passes fetchAgent to makeWASocket when proxy is assigned', async () => {
      const fakeAgent = { fake: 'agent' };
      (buildFetchAgent as jest.Mock).mockReturnValue(fakeAgent);

      const proxyConfig = {
        host: '10.0.0.1',
        port: 1080,
        protocol: 'socks5' as const,
      };
      mockProxy.assignProxy.mockResolvedValue(proxyConfig);

      const onlineSession = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findMany as jest.Mock).mockResolvedValue([onlineSession]);

      await service.onModuleInit();
      // Allow startSocket microtasks to settle
      await new Promise<void>((r) => setTimeout(r, 10));

      expect(buildFetchAgent).toHaveBeenCalledWith(proxyConfig);
      const makeWASocketMock = makeWASocket as jest.Mock;
      const callArgs = makeWASocketMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(callArgs?.fetchAgent).toBe(fakeAgent);
    });

    it('does not set fetchAgent when no proxy is assigned', async () => {
      (buildFetchAgent as jest.Mock).mockReturnValue(undefined);
      mockProxy.assignProxy.mockResolvedValue(null);

      const onlineSession = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findMany as jest.Mock).mockResolvedValue([onlineSession]);

      await service.onModuleInit();
      await new Promise<void>((r) => setTimeout(r, 10));

      const makeWASocketMock = makeWASocket as jest.Mock;
      const callArgs = makeWASocketMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(callArgs?.fetchAgent).toBeUndefined();
    });
  });

  // ── loggedOut (401) self-healing ──────────────────────────────────────────────
  // Regression test for: "Reconnect" hanging forever on a session whose stored
  // credentials WhatsApp has permanently invalidated — see handleConnectionUpdate's
  // loggedOut branch. Without clearing authState, every reconnect attempt reloads the
  // same dead creds, gets the same 401, and never reaches the "needs QR" state.
  describe('handleConnectionUpdate loggedOut', () => {
    it('clears the stale authState and immediately starts a fresh pairing attempt', async () => {
      const onlineSession = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findMany as jest.Mock).mockResolvedValue([onlineSession]);
      (prisma.session.update as jest.Mock).mockResolvedValue(mockSession);

      await service.onModuleInit();
      await new Promise<void>((r) => setTimeout(r, 10));

      const makeWASocketMock = makeWASocket as jest.Mock;
      const sock = makeWASocketMock.mock.results[makeWASocketMock.mock.results.length - 1]!.value;
      const onCalls = (sock.ev.on as jest.Mock).mock.calls as Array<[string, (update: unknown) => void]>;
      const connectionUpdateHandler = onCalls.find(([event]) => event === 'connection.update')?.[1];
      expect(connectionUpdateHandler).toBeDefined();

      (prisma.session.update as jest.Mock).mockClear();
      makeWASocketMock.mockClear();

      connectionUpdateHandler!({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
      await new Promise<void>((r) => setTimeout(r, 10));

      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { authState: Prisma.JsonNull },
      });
      // A brand-new connection attempt (fresh, unregistered creds) was kicked off
      // immediately — an operator watching the Reconnect modal gets a QR without
      // needing to click again.
      expect(makeWASocketMock).toHaveBeenCalledTimes(1);
    });

    it('marks the session OFFLINE and pauses its campaigns', async () => {
      const onlineSession = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findMany as jest.Mock).mockResolvedValue([onlineSession]);
      (prisma.session.update as jest.Mock).mockResolvedValue(mockSession);
      (prisma.campaignMessage.findMany as jest.Mock).mockResolvedValue([{ campaignId: 'camp-1' }]);
      (prisma.campaign.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.onModuleInit();
      await new Promise<void>((r) => setTimeout(r, 10));

      const makeWASocketMock = makeWASocket as jest.Mock;
      const sock = makeWASocketMock.mock.results[makeWASocketMock.mock.results.length - 1]!.value;
      const onCalls = (sock.ev.on as jest.Mock).mock.calls as Array<[string, (update: unknown) => void]>;
      const connectionUpdateHandler = onCalls.find(([event]) => event === 'connection.update')?.[1];

      connectionUpdateHandler!({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
      await new Promise<void>((r) => setTimeout(r, 10));

      expect(gateway.emitStatus).toHaveBeenCalledWith('sess-1', SessionStatus.OFFLINE);
      expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['camp-1'] }, status: 'RUNNING' },
        data: { status: 'PAUSED' },
      });
    });
  });

  describe('handleInboundMessage opt-out detection', () => {
    beforeEach(() => {
      (prisma.contact.findUnique as jest.Mock).mockResolvedValue({ id: 'contact-1', phone: '+15551234567' });
      (prisma.campaignMessage.findFirst as jest.Mock).mockResolvedValue(null);
    });

    it.each(['STOP', 'stop', 'unsubscribe', 'optout', 'Stop.', 'STOP!!'])(
      'marks contact invalid on standalone keyword "%s"',
      async (word) => {
        await (service as unknown as { handleInboundMessage: (s: string, p: string, t: string) => Promise<void> })
          .handleInboundMessage('sess-1', '+15551234567', word);
        expect(prisma.contact.update).toHaveBeenCalledWith({
          where: { id: 'contact-1' },
          data: { valid: false },
        });
      },
    );

    it.each(['remove me', 'opt out', "don't message", 'stop messaging', 'no more messages'])(
      'marks contact invalid on phrase "%s"',
      async (phrase) => {
        await (service as unknown as { handleInboundMessage: (s: string, p: string, t: string) => Promise<void> })
          .handleInboundMessage('sess-1', '+15551234567', `please ${phrase}`);
        expect(prisma.contact.update).toHaveBeenCalledWith({
          where: { id: 'contact-1' },
          data: { valid: false },
        });
      },
    );

    it.each([
      'non-stop flight to Dubai',
      'the bus stop is closer now',
      "I won't stop using your product",
      "Sounds great, let's talk tomorrow",
    ])('does NOT opt out on "%s"', async (text) => {
      await (service as unknown as { handleInboundMessage: (s: string, p: string, t: string) => Promise<void> })
        .handleInboundMessage('sess-1', '+15551234567', text);
      expect(prisma.contact.update).not.toHaveBeenCalled();
    });
  });

  describe('pauseCampaignsForSession', () => {
    it('pauses the RUNNING campaigns that still have queued work on the session', async () => {
      (prisma.campaignMessage.findMany as jest.Mock).mockResolvedValue([
        { campaignId: 'camp-1' },
        { campaignId: 'camp-2' },
      ]);
      (prisma.campaign.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      const paused = await service.pauseCampaignsForSession('sess-1');

      expect(paused).toBe(2);
      expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['camp-1', 'camp-2'] }, status: 'RUNNING' },
        data: { status: 'PAUSED' },
      });
    });

    it('does nothing when the session has no queued campaign messages', async () => {
      (prisma.campaignMessage.findMany as jest.Mock).mockResolvedValue([]);

      const paused = await service.pauseCampaignsForSession('sess-1');

      expect(paused).toBe(0);
      expect(prisma.campaign.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('tripCircuitBreaker', () => {
    it('pauses the session campaigns when the failure threshold is hit', async () => {
      (prisma.campaignMessage.findMany as jest.Mock).mockResolvedValue([{ campaignId: 'camp-1' }]);
      (prisma.campaign.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.tripCircuitBreaker('sess-1', 5);

      expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['camp-1'] }, status: 'RUNNING' },
        data: { status: 'PAUSED' },
      });
    });
  });

  describe('sendBaileyMessage buttons', () => {
    let sock: { sendMessage: jest.Mock; relayMessage: jest.Mock; sendPresenceUpdate: jest.Mock };

    beforeEach(async () => {
      const onlineSession = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findMany as jest.Mock).mockResolvedValue([onlineSession]);
      await service.onModuleInit();
      await new Promise<void>((r) => setTimeout(r, 10));
      const makeWASocketMock = makeWASocket as jest.Mock;
      sock = makeWASocketMock.mock.results[makeWASocketMock.mock.results.length - 1]!.value;
    });

    it('sends a native interactive message via relayMessage and does not fall back to plain text', async () => {
      const buttons = [
        { id: 'yes-1', type: 'QUICK_REPLY' as const, label: 'Yes' },
        { id: 'no-1', type: 'QUICK_REPLY' as const, label: 'No' },
      ];

      await service.sendBaileyMessage('sess-1', '+15551234567', 'Are you interested?', 1, undefined, buttons);

      expect(sock.relayMessage).toHaveBeenCalledWith('15551234567@s.whatsapp.net', {}, { messageId: 'wa-msg-1' });
      expect(sock.sendMessage).not.toHaveBeenCalled();
    });

    it('falls back to a plain-text send with the numbered listing when the native send throws', async () => {
      sock.relayMessage.mockRejectedValueOnce(new Error('relay failed'));
      const buttons = [{ id: 'yes-1', type: 'QUICK_REPLY' as const, label: 'Yes' }];

      await service.sendBaileyMessage('sess-1', '+15551234567', 'Are you interested?', 1, undefined, buttons);

      expect(sock.sendMessage).toHaveBeenCalledWith('15551234567@s.whatsapp.net', {
        text: 'Are you interested?\n\n1. Yes',
      });
    });

    it('prioritizes the button listing over the body when truncating a long message', async () => {
      sock.relayMessage.mockRejectedValueOnce(new Error('force fallback for assertion'));
      const longText = 'x'.repeat(5000);
      const buttons = [{ id: 'yes-1', type: 'QUICK_REPLY' as const, label: 'Yes' }];

      await service.sendBaileyMessage('sess-1', '+15551234567', longText, 1, undefined, buttons);

      const [, payload] = sock.sendMessage.mock.calls[sock.sendMessage.mock.calls.length - 1] as [string, { text: string }];
      expect(payload.text.length).toBeLessThanOrEqual(4096);
      expect(payload.text.endsWith('1. Yes')).toBe(true);
    });

    it('sends plain text with no listing when no buttons are provided', async () => {
      await service.sendBaileyMessage('sess-1', '+15551234567', 'Hello', 1);

      expect(sock.sendMessage).toHaveBeenCalledWith('15551234567@s.whatsapp.net', { text: 'Hello' });
      expect(sock.relayMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendBaileyCarousel', () => {
    let sock: { sendMessage: jest.Mock; relayMessage: jest.Mock; sendPresenceUpdate: jest.Mock };

    const cards = [
      {
        id: 'card1',
        mediaUrl: 'http://localhost:3001/api/media/a.jpg',
        mediaType: 'IMAGE' as const,
        body: 'Card A',
        buttons: [
          { id: 'b1', type: 'QUICK_REPLY' as const, label: 'Yes' },
          { id: 'b2', type: 'QUICK_REPLY' as const, label: 'No' },
        ],
      },
      {
        id: 'card2',
        mediaUrl: 'http://localhost:3001/api/media/b.jpg',
        mediaType: 'IMAGE' as const,
        body: 'Card B',
        buttons: [{ id: 'b3', type: 'QUICK_REPLY' as const, label: 'Maybe' }],
      },
    ];

    beforeEach(async () => {
      const onlineSession = { ...mockSession, status: SessionStatus.ONLINE, phoneNumber: '+15551234567' };
      (prisma.session.findMany as jest.Mock).mockResolvedValue([onlineSession]);
      await service.onModuleInit();
      await new Promise<void>((r) => setTimeout(r, 10));
      const makeWASocketMock = makeWASocket as jest.Mock;
      sock = makeWASocketMock.mock.results[makeWASocketMock.mock.results.length - 1]!.value;

      media.storedNameFromUrl.mockImplementation((url: string) => url.split('/').pop() ?? null);
      media.readFile.mockResolvedValue(Buffer.from('fake-bytes'));
    });

    it('sends a standalone intro message, then each card as its own image with a globally-numbered button listing', async () => {
      // interCardDelayMs=0 keeps the test fast — production default (1200ms) is unrelated to this behavior
      await service.sendBaileyCarousel('sess-1', '+15551234567', 'Check these out!', 1, cards, 0);

      const jid = '15551234567@s.whatsapp.net';
      expect(sock.sendMessage).toHaveBeenNthCalledWith(1, jid, { text: 'Check these out!' });
      expect(sock.sendMessage).toHaveBeenNthCalledWith(2, jid, {
        image: Buffer.from('fake-bytes'),
        caption: 'Card A\n\n1. Yes\n2. No',
      });
      // Card 2's button numeral continues from card 1's count (3), not restarting at 1
      expect(sock.sendMessage).toHaveBeenNthCalledWith(3, jid, {
        image: Buffer.from('fake-bytes'),
        caption: 'Card B\n\n3. Maybe',
      });
    });

    it('sends video cards with the video field instead of image', async () => {
      const videoCards = [{ ...cards[0]!, mediaType: 'VIDEO' as const, buttons: [] }, { ...cards[1]!, buttons: [] }];

      await service.sendBaileyCarousel('sess-1', '+15551234567', 'Intro', 1, videoCards, 0);

      const jid = '15551234567@s.whatsapp.net';
      expect(sock.sendMessage).toHaveBeenNthCalledWith(2, jid, { video: Buffer.from('fake-bytes'), caption: 'Card A' });
    });

    it('does nothing (no socket calls) in DRY_RUN mode', async () => {
      (service as unknown as { dryRun: boolean }).dryRun = true;
      await service.sendBaileyCarousel('sess-1', '+15551234567', 'Intro', 1, cards, 0);
      expect(sock.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleInboundMessage button matching', () => {
    const buttons = [
      { id: 'yes-1', type: 'QUICK_REPLY' as const, label: 'Yes' },
      { id: 'no-1', type: 'QUICK_REPLY' as const, label: 'No' },
    ];

    beforeEach(() => {
      (prisma.contact.findUnique as jest.Mock).mockResolvedValue({ id: 'contact-1', phone: '+15551234567' });
      (prisma.campaignMessage.findFirst as jest.Mock).mockResolvedValue({
        id: 'msg-1',
        campaignId: 'camp-1',
        campaign: { template: { buttons } },
      });
    });

    const callHandleInbound = (text: string, nativeButtonId?: string) =>
      (service as unknown as { handleInboundMessage: (s: string, p: string, t: string, n?: string) => Promise<void> })
        .handleInboundMessage('sess-1', '+15551234567', text, nativeButtonId);

    it('matches a bare numeral to the button at that 1-based position', async () => {
      await callHandleInbound('1');

      expect(prisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'camp-1', text: 'Yes', buttonId: 'yes-1', buttonLabel: 'Yes' },
      });
    });

    it('matches a case-insensitive label', async () => {
      await callHandleInbound('no');

      expect(prisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'camp-1', text: 'No', buttonId: 'no-1', buttonLabel: 'No' },
      });
    });

    it('matches a native button-response id over any text heuristic', async () => {
      await callHandleInbound('ignored raw text', 'yes-1');

      expect(prisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'camp-1', text: 'Yes', buttonId: 'yes-1', buttonLabel: 'Yes' },
      });
    });

    it('falls back to plain text with no buttonId when nothing matches', async () => {
      await callHandleInbound('sounds good, thanks');

      expect(prisma.reply.create).toHaveBeenCalledWith({
        data: {
          contactId: 'contact-1',
          campaignId: 'camp-1',
          text: 'sounds good, thanks',
          buttonId: undefined,
          buttonLabel: undefined,
        },
      });
    });
  });

  describe('handleInboundMessage carousel button matching', () => {
    // Carousel-mode templates store buttons per-card (Template.buttons is null) — matching
    // must flatten across cards. ButtonDef.id is globally unique, so no card-scoping needed.
    const carouselCards = [
      { id: 'card1', mediaUrl: 'http://x/a.jpg', body: 'Card A', buttons: [{ id: 'yes-1', type: 'QUICK_REPLY' as const, label: 'Yes' }] },
      { id: 'card2', mediaUrl: 'http://x/b.jpg', body: 'Card B', buttons: [{ id: 'no-1', type: 'QUICK_REPLY' as const, label: 'No' }] },
    ];

    beforeEach(() => {
      (prisma.contact.findUnique as jest.Mock).mockResolvedValue({ id: 'contact-1', phone: '+15551234567' });
      (prisma.campaignMessage.findFirst as jest.Mock).mockResolvedValue({
        id: 'msg-1',
        campaignId: 'camp-1',
        campaign: { template: { buttons: null, carouselCards } },
      });
    });

    const callHandleInbound = (text: string, nativeButtonId?: string) =>
      (service as unknown as { handleInboundMessage: (s: string, p: string, t: string, n?: string) => Promise<void> })
        .handleInboundMessage('sess-1', '+15551234567', text, nativeButtonId);

    it('matches a numeral against the flattened card2 button (global position 2)', async () => {
      await callHandleInbound('2');

      expect(prisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'camp-1', text: 'No', buttonId: 'no-1', buttonLabel: 'No' },
      });
    });

    it('matches a native button-response id from a non-first card', async () => {
      await callHandleInbound('ignored raw text', 'no-1');

      expect(prisma.reply.create).toHaveBeenCalledWith({
        data: { contactId: 'contact-1', campaignId: 'camp-1', text: 'No', buttonId: 'no-1', buttonLabel: 'No' },
      });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
});

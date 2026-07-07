import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Session, CampaignStatus, MediaType, MsgStatus, SessionMode, SessionStatus } from '@prisma/client';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  type ConnectionState,
  type WAMessageContent,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { parseButtonDefs, parseCarouselCards, type ButtonDef, type CarouselCardDef } from '@wa-engine/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { FingerprintService } from '../antiban/fingerprint.service';
import { ProxyService } from '../antiban/proxy.service';
import { ContactsService } from '../contacts/contacts.service';
import { MediaService } from '../media/media.service';
import { makeDbAuthState } from './baileys/db-auth-state';
import { deriveKey } from './baileys/auth-cipher';
import { buildFetchAgent } from './baileys/build-fetch-agent';
import { type ConnectSessionDto } from './dto/connect-session.dto';
import { type CreateSessionDto } from './dto/create-session.dto';
import { SessionsGateway } from './sessions.gateway';

@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly sockets = new Map<string, ReturnType<typeof makeWASocket>>();
  private readonly intentionalDisconnects = new Set<string>();
  private readonly startingSocket = new Set<string>(); // guard against concurrent startSocket calls
  private readonly reconnectDelays = new Map<string, number>(); // tracks per-session backoff delay (ms)
  // WhatsApp's LID privacy namespace routes some chats under an anonymized @lid JID
  // instead of the real @s.whatsapp.net phone JID. contacts.upsert carries both
  // identities together when it fires, and sendBaileyMessage proactively resolves
  // via onWhatsApp() too, so we cache lid-number -> E.164 phone here for
  // messages.upsert/messages.update to resolve against.
  private readonly lidToPhone = new Map<string, string>();
  private readonly lidResolvedPhones = new Set<string>(); // avoids re-querying onWhatsApp per phone
  private readonly log = new Logger(SessionsService.name);
  private readonly encKey: Buffer;
  private readonly dryRun: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: SessionsGateway,
    private readonly fingerprint: FingerprintService,
    private readonly proxy: ProxyService,
    private readonly contactsService: ContactsService,
    private readonly media: MediaService,
    config: ConfigService,
  ) {
    this.encKey = deriveKey(config.getOrThrow<string>('SESSION_ENCRYPTION_KEY'));
    this.dryRun = config.get<string>('DRY_RUN') === 'true';
  }

  async onModuleInit(): Promise<void> {
    const sessions = await this.prisma.session.findMany({
      where: {
        mode: SessionMode.BAILEYS,
        status: { in: [SessionStatus.ONLINE, SessionStatus.CONNECTING] },
      },
    });
    for (const session of sessions) {
      // Only restore sessions that have a phone number — meaning they previously
      // completed the QR scan and connected. Sessions without a phone number were
      // never authenticated; restoring them would cause an infinite reconnect loop.
      if (!session.phoneNumber) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { status: SessionStatus.OFFLINE },
        });
        this.log.log(`Session ${session.id} reset to OFFLINE (never authenticated)`);
        continue;
      }
      await this.prisma.session.update({
        where: { id: session.id },
        data: { status: SessionStatus.CONNECTING },
      });
      void this.startSocket(session.id).catch((err: unknown) =>
        this.log.error(`Failed to restore session ${session.id}: ${String(err)}`),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [id, sock] of this.sockets.entries()) {
      this.intentionalDisconnects.add(id);
      try { sock.end(undefined); } catch { /* ignore */ }
    }
    this.sockets.clear();
  }

  async createSession(dto: CreateSessionDto): Promise<Omit<Session, 'authState'>> {
    const session = await this.prisma.session.create({
      data: {
        label: dto.label,
        mode: dto.mode,
        phoneNumber: dto.phoneNumber,
        ...(dto.cloudApi !== undefined
          ? { cloudApi: dto.cloudApi as Prisma.InputJsonValue }
          : {}),
        // Cloud API sessions need no WebSocket handshake — credentials are in env vars.
        // Set ONLINE immediately so campaigns can be launched against them right away.
        ...(dto.mode === SessionMode.CLOUD_API && { status: SessionStatus.ONLINE }),
      },
    });
    const { authState: _auth, ...safe } = session;
    return safe;
  }

  async listSessions(): Promise<Omit<Session, 'authState'>[]> {
    const sessions = await this.prisma.session.findMany({ orderBy: { createdAt: 'desc' } });
    return sessions.map(({ authState: _auth, ...safe }) => safe);
  }

  async deleteSession(id: string): Promise<void> {
    const exists = await this.prisma.session.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException(`Session ${id} not found`);
    const sock = this.sockets.get(id);
    if (sock) {
      this.intentionalDisconnects.add(id);
      this.sockets.delete(id);
      this.reconnectDelays.delete(id);
      this.startingSocket.delete(id);
      void sock.logout().catch(() => undefined);
    } else {
      // Socket may never have been started; still clear any pending reconnect state
      this.reconnectDelays.delete(id);
      this.startingSocket.delete(id);
    }
    // Layer 4: release proxy before removing the session record
    await this.proxy.releaseProxy(id);
    try {
      await this.prisma.session.delete({ where: { id } });
    } catch (e: unknown) {
      // P2025 = record not found; concurrent delete is idempotent
      if ((e as { code?: string }).code === 'P2025') return;
      throw e;
    }
  }

  async disconnectSession(id: string): Promise<void> {
    const sock = this.sockets.get(id);
    if (sock) {
      this.intentionalDisconnects.add(id);
      this.sockets.delete(id);
      try { sock.end(undefined); } catch { /* ignore */ }
    }
    await this.setStatus(id, SessionStatus.OFFLINE);
  }

  async getHealth(id: string): Promise<{ status: string; phoneNumber: string | null }> {
    const session = await this.prisma.session.findUniqueOrThrow({ where: { id } });
    return { status: session.status, phoneNumber: session.phoneNumber };
  }

  async connect(
    id: string,
    dto: ConnectSessionDto,
  ): Promise<{ method: string; code?: string }> {
    const session = await this.prisma.session.findUniqueOrThrow({ where: { id } });
    if (session.mode !== SessionMode.BAILEYS) {
      throw new BadRequestException('Only BAILEYS sessions support this endpoint');
    }

    if (!this.sockets.has(id) && !this.startingSocket.has(id)) {
      this.startingSocket.add(id);
      void this.startSocket(id)
        .catch((err: unknown) =>
          this.log.error(`startSocket error [${id}]: ${String(err)}`),
        )
        .finally(() => this.startingSocket.delete(id));
      // Give the socket time to establish before requesting pairing code
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }

    if (dto.method === 'pairing') {
      if (!dto.phone) {
        throw new BadRequestException('phone is required for pairing code method');
      }
      const sock = this.sockets.get(id);
      if (!sock) throw new BadRequestException('Socket not yet initialized; retry in a moment');
      const phone = dto.phone.replace(/\D/g, '');
      const code = await sock.requestPairingCode(phone);
      return { method: 'pairing', code };
    }

    return { method: 'qr' };
  }

  private async startSocket(sessionId: string): Promise<void> {
    const { state, saveCreds } = await makeDbAuthState(this.prisma, sessionId, this.encKey);
    const pinoLogger = pino({ level: 'silent' });

    await this.setStatus(sessionId, SessionStatus.CONNECTING);

    // Fetch current WA Web version — avoids 405 rejection from stale hardcoded version
    // 5-second timeout + fallback guards against network blips on server restart
    const FALLBACK_VERSION: [number, number, number] = [2, 3000, 1018547872];
    let version: [number, number, number];
    try {
      const fetched = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5_000),
        ),
      ]);
      version = fetched.version;
    } catch (err) {
      this.log.warn(
        `[${sessionId}] fetchLatestBaileysVersion failed (${String(err)}) — using fallback ${FALLBACK_VERSION.join('.')}`,
      );
      version = FALLBACK_VERSION;
    }
    this.log.log(`[${sessionId}] WA version: ${version.join('.')}`);

    // Layer 3: assign (or re-use existing) device fingerprint
    const fp = await this.fingerprint.assignFingerprint(sessionId);

    // Layer 4: assign proxy from pool (null → connect without proxy)
    const proxyConfig = await this.proxy.assignProxy(sessionId);
    if (proxyConfig) {
      this.log.debug(`[${sessionId}] proxy: ${proxyConfig.host}:${proxyConfig.port}`);
    }

    const rawAgent = buildFetchAgent(proxyConfig);
    // Cast is safe: HttpsProxyAgent / SocksProxyAgent extend http.Agent at runtime;
    // Baileys declares the option as https.Agent which is a strict TypeScript supertype.
    const proxyAgent = rawAgent as unknown as import('https').Agent | undefined;

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      // browser tuple: [platform, browserName, browserVersion]
      // iOS devices must use Safari — iOS prohibits non-WebKit browsers, so Chrome would be a detection signal.
      browser: [fp.deviceModel, fp.osVersion.startsWith('iOS') ? 'Safari' : 'Chrome', fp.osVersion.startsWith('iOS') ? '17.4.1' : '136.0.0'] as [string, string, string],
      logger: pinoLogger,
      getMessage: async () => undefined,
      // Suppress automatic "online" broadcast on connect — real phones only show online
      // when the user actively opens the app, not on every background reconnect.
      // NOTE: this also means WhatsApp won't push delivered/read receipts (messages.update)
      // for outbound messages to this connection — a deliberate anti-ban trade-off.
      // Inbound replies are unaffected; message delivery isn't gated by presence the same way.
      markOnlineOnConnect: false,
      // Route all Baileys WebSocket + HTTP traffic through the assigned proxy (Layer 4)
      ...(proxyAgent ? { agent: proxyAgent, fetchAgent: proxyAgent } : {}),
    });

    this.sockets.set(sessionId, sock);

    sock.ev.on('creds.update', () => {
      void saveCreds().catch((err: unknown) =>
        this.log.error(`creds save failed [${sessionId}]: ${String(err)}`),
      );
    });

    sock.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(sessionId, sock, update).catch((err: unknown) =>
        this.log.error(`connection.update error [${sessionId}]: ${String(err)}`),
      );
    });

    sock.ev.on('contacts.upsert', (baileysContacts) => {
      const toSync = baileysContacts
        .filter((c) => c.id && c.id.endsWith('@s.whatsapp.net'))
        .map((c) => ({
          // Strip device suffix (:15) before stripping non-digits — same as messages.upsert handler
          phone: '+' + c.id.replace('@s.whatsapp.net', '').split(':')[0]!.replace(/\D/g, ''),
          name: c.name ?? c.notify ?? undefined,
        }));
      if (toSync.length > 0) {
        void this.contactsService.upsertFromWhatsApp(toSync).then(({ imported }) => {
          this.log.log(`[${sessionId}] synced ${imported} WA contacts`);
        }).catch((err: unknown) =>
          this.log.error(`contacts sync error [${sessionId}]: ${String(err)}`),
        );
      }
      for (const c of baileysContacts) {
        if (c.lid && c.id?.endsWith('@s.whatsapp.net')) {
          const lidNumber = c.lid.replace('@lid', '').split(':')[0]!;
          const phone = '+' + c.id.replace('@s.whatsapp.net', '').split(':')[0]!.replace(/\D/g, '');
          this.lidToPhone.set(lidNumber, phone);
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages: inbound, type }) => {
      if (type !== 'notify') return;
      for (const msg of inbound) {
        // Skip messages we sent ourselves
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        const nativeButton = this.extractNativeButtonResponse(msg.message);
        const text =
          nativeButton?.text ??
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          null;
        if (!text) continue;
        void this.resolveOrInferPhone(sessionId, jid)
          .then((phone) => {
            if (!phone) {
              this.log.debug(`[${sessionId}] inbound from unresolvable jid=${jid} — skipping`);
              return;
            }
            return this.handleInboundMessage(sessionId, phone, text, nativeButton?.buttonId);
          })
          .catch((err: unknown) => this.log.error(`inbound message error [${sessionId}]: ${String(err)}`));
      }
    });

    // Track delivery and read receipts for our outbound messages
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (!key.fromMe) continue;
        const status = (update as { status?: number }).status;
        if (status !== 3 && status !== 4) continue; // 3=DELIVERED, 4=READ
        void this.resolveOrInferPhone(sessionId, key.remoteJid)
          .then((phone) => {
            if (!phone) return;
            return status === 3
              ? this.handleMessageDelivered(sessionId, phone)
              : this.handleMessageRead(sessionId, phone);
          })
          .catch((err: unknown) => this.log.error(`receipt error [${sessionId}]: ${String(err)}`));
      }
    });
  }

  /**
   * Looks up the JID WhatsApp actually routes this phone under, once per phone, so a
   * reply arriving on an @lid JID can be mapped back to the contact later. Best-effort —
   * a failed lookup must never block the send itself.
   */
  private async ensureLidResolved(
    sock: ReturnType<typeof makeWASocket>,
    phone: string,
  ): Promise<void> {
    if (this.lidResolvedPhones.has(phone)) return;
    this.lidResolvedPhones.add(phone);
    try {
      const results = await sock.onWhatsApp(phone);
      const jid = results?.[0]?.jid;
      if (jid?.endsWith('@lid')) {
        const lidNumber = jid.replace('@lid', '').split(':')[0]!;
        this.lidToPhone.set(lidNumber, phone);
      }
    } catch (err: unknown) {
      this.log.debug(`onWhatsApp lookup failed for ${phone}: ${String(err)}`);
    }
  }

  /**
   * Resolves an inbound JID to a phone, falling back to the most recently sent
   * message on this session when the JID is an @lid we have no mapping for yet
   * (onWhatsApp's USync lookup resolves a different identity than the one some
   * accounts actually message under — same best-effort heuristic already used
   * for delivery/read receipts). Learns the mapping for next time on success.
   */
  private async resolveOrInferPhone(
    sessionId: string,
    jid: string | null | undefined,
  ): Promise<string | null> {
    const direct = this.resolvePhoneFromJid(jid);
    if (direct) return direct;
    if (!jid?.endsWith('@lid')) return null;

    const lastSent = await this.prisma.campaignMessage.findFirst({
      where: { sessionId, status: { in: [MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ] } },
      orderBy: { sentAt: 'desc' },
      include: { contact: true },
    });
    if (!lastSent) return null;

    const lidNumber = jid.replace('@lid', '').split(':')[0]!;
    this.lidToPhone.set(lidNumber, lastSent.contact.phone);
    return lastSent.contact.phone;
  }

  /** Resolves an @s.whatsapp.net or @lid JID to an E.164 phone, or null if unresolvable. */
  private resolvePhoneFromJid(jid: string | null | undefined): string | null {
    if (!jid) return null;
    if (jid.endsWith('@s.whatsapp.net')) {
      const rawPhone = jid.replace('@s.whatsapp.net', '').split(':')[0]!;
      return rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
    }
    if (jid.endsWith('@lid')) {
      const lidNumber = jid.replace('@lid', '').split(':')[0]!;
      return this.lidToPhone.get(lidNumber) ?? null;
    }
    return null;
  }

  /**
   * Recognizes a tapped button reply, if any: the legacy `buttonsResponseMessage` shape
   * (in case a recipient's client somehow replies via the old deprecated protocol), or the
   * modern `interactiveResponseMessage.nativeFlowResponseMessage` shape — the counterpart to
   * the buttons we send in `sendNativeFlowButtons`. `text` here is a placeholder (the real
   * display label is resolved in `resolveButtonMatch` once we know which template sent it).
   */
  private extractNativeButtonResponse(
    message: { buttonsResponseMessage?: { selectedButtonId?: string | null; selectedDisplayText?: string | null } | null; interactiveResponseMessage?: { nativeFlowResponseMessage?: { paramsJson?: string | null } | null } | null } | null | undefined,
  ): { buttonId: string; text: string } | null {
    const legacy = message?.buttonsResponseMessage;
    if (legacy?.selectedButtonId) {
      return { buttonId: legacy.selectedButtonId, text: legacy.selectedDisplayText ?? legacy.selectedButtonId };
    }
    const nativeFlow = message?.interactiveResponseMessage?.nativeFlowResponseMessage;
    if (nativeFlow?.paramsJson) {
      try {
        const parsed = JSON.parse(nativeFlow.paramsJson) as { id?: string };
        if (parsed.id) return { buttonId: parsed.id, text: parsed.id };
      } catch {
        // malformed JSON from the client — ignore, fall through to plain text
      }
    }
    return null;
  }

  /**
   * Resolves a possible button match for an inbound reply against the buttons of the
   * template that produced the contact's last sent message. Priority: (1) a native
   * button-response id, matched against the template's ButtonDef.id; (2) a bare numeral
   * matching the button's 1-based position; (3) a case-insensitive label match; (4) no
   * match — ordinary free text. On a match, `text` is replaced with the button's real
   * label (nicer than a raw native-flow id or a numeral the contact typed).
   */
  private resolveButtonMatch(
    buttons: ButtonDef[] | undefined,
    nativeButtonId: string | undefined,
    incomingText: string,
  ): { buttonId?: string; buttonLabel?: string; text: string } {
    if (!buttons?.length) return { text: incomingText };

    if (nativeButtonId) {
      const match = buttons.find((b) => b.id === nativeButtonId);
      if (match) return { buttonId: match.id, buttonLabel: match.label, text: match.label };
      return { buttonId: nativeButtonId, text: incomingText };
    }

    const trimmed = incomingText.trim();
    const asPosition = Number(trimmed);
    if (Number.isInteger(asPosition) && asPosition >= 1 && asPosition <= buttons.length) {
      const match = buttons[asPosition - 1]!;
      return { buttonId: match.id, buttonLabel: match.label, text: match.label };
    }
    const byLabel = buttons.find((b) => b.label.toLowerCase() === trimmed.toLowerCase());
    if (byLabel) return { buttonId: byLabel.id, buttonLabel: byLabel.label, text: byLabel.label };

    return { text: incomingText };
  }

  private async handleInboundMessage(
    sessionId: string,
    phone: string,
    text: string,
    nativeButtonId?: string,
  ): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { phone } });
    if (!contact) {
      this.log.warn(`[${sessionId}] inbound from unknown phone=${phone} — skipping`);
      return;
    }

    const lastMsg = await this.prisma.campaignMessage.findFirst({
      where: {
        contactId: contact.id,
        sessionId,
        status: { in: [MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ] },
      },
      orderBy: { sentAt: 'desc' },
      include: { campaign: { include: { template: true } } },
    });

    // Carousel-mode templates store buttons per-card (Template.buttons is null then) —
    // flatten across cards so matching works the same as single-card mode. ButtonDef.id
    // is globally unique (crypto.randomUUID()), so no card-scoping is needed here.
    const template = lastMsg?.campaign?.template;
    const templateButtons =
      parseCarouselCards(template?.carouselCards)?.flatMap((c) => c.buttons) ??
      parseButtonDefs(template?.buttons);

    const { buttonId, buttonLabel, text: resolvedText } = this.resolveButtonMatch(
      templateButtons,
      nativeButtonId,
      text,
    );

    await this.prisma.reply.create({
      data: {
        contactId: contact.id,
        campaignId: lastMsg?.campaignId ?? null,
        text: resolvedText,
        buttonId,
        buttonLabel,
      },
    });

    if (lastMsg) {
      await this.prisma.campaignMessage.update({
        where: { id: lastMsg.id },
        data: { status: MsgStatus.REPLIED },
      });
    }

    // Auto-invalidate contacts who signal opt-out — prevents continued sending after STOP.
    // Runs against resolvedText, so a button labeled "Stop"/"Unsubscribe" is honoured for free.
    const lowerText = resolvedText.toLowerCase();
    // Short keywords must match the WHOLE message — tokenising on word boundaries still
    // false-positives on "non-stop" (hyphen) and "bus stop" / "won't stop" (legit standalone word)
    const OPT_OUT_KEYWORDS = new Set(['stop', 'unsubscribe', 'optout']);
    // Multi-word phrases are unambiguous enough to match anywhere in the message
    const OPT_OUT_PHRASES = ['remove me', 'opt out', "don't message", 'dont message', 'stop messaging', 'no more messages'];
    const cleanedText = lowerText.trim().replace(/^[.,!?;:]+/, '').replace(/[.,!?;:]+$/, '');
    const isOptOut =
      OPT_OUT_KEYWORDS.has(cleanedText) ||
      OPT_OUT_PHRASES.some((p) => lowerText.includes(p));
    if (isOptOut) {
      await this.prisma.contact.update({ where: { id: contact.id }, data: { valid: false } });
      this.log.log(`[${sessionId}] OPT_OUT from ${phone} — contact marked invalid`);
    }

    this.gateway.emitReply(contact.id, phone, resolvedText, lastMsg?.campaignId ?? null);
    this.log.log(`[${sessionId}] reply from ${phone}: "${resolvedText.slice(0, 60)}"${buttonId ? ` [button=${buttonId}]` : ''}`);
  }

  private async handleMessageDelivered(sessionId: string, phone: string): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { phone } });
    if (!contact) return;
    const lastSent = await this.prisma.campaignMessage.findFirst({
      where: { contactId: contact.id, sessionId, status: MsgStatus.SENT },
      orderBy: { sentAt: 'desc' },
    });
    if (!lastSent) return;
    await this.prisma.campaignMessage.update({
      where: { id: lastSent.id },
      data: { status: MsgStatus.DELIVERED },
    });
    this.log.log(`[${sessionId}] delivered receipt from ${phone}`);
  }

  private async handleMessageRead(sessionId: string, phone: string): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { phone } });
    if (!contact) return;

    const lastSent = await this.prisma.campaignMessage.findFirst({
      where: { contactId: contact.id, sessionId, status: { in: [MsgStatus.SENT, MsgStatus.DELIVERED] } },
      orderBy: { sentAt: 'desc' },
    });
    if (!lastSent) return;

    await this.prisma.campaignMessage.update({
      where: { id: lastSent.id },
      data: { status: MsgStatus.READ },
    });
    this.log.log(`[${sessionId}] read receipt from ${phone}`);
  }

  private async handleConnectionUpdate(
    sessionId: string,
    sock: ReturnType<typeof makeWASocket>,
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.log.log(`[${sessionId}] QR received — emitting session:qr (length=${qr.length})`);
      this.gateway.emitQr(sessionId, qr);
    }

    if (connection === 'open') {
      this.reconnectDelays.delete(sessionId); // reset backoff on successful connect
      await this.setStatus(sessionId, SessionStatus.ONLINE);
      const rawId = sock.user?.id;
      if (rawId) {
        const digits = rawId.split(':')[0] ?? '';
        const phone = digits.startsWith('+') ? digits : `+${digits}`;
        await this.prisma.session.update({
          where: { id: sessionId },
          data: { phoneNumber: phone },
        });
      }
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
      const statusCode = err?.output?.statusCode;
      this.log.warn(`[${sessionId}] connection closed — statusCode=${statusCode ?? 'none'} err=${String(lastDisconnect?.error ?? 'none')}`);

      if (statusCode === DisconnectReason.forbidden) {
        // 403 forbidden is WhatsApp's explicit ban signal. Mark BANNED, stop reconnecting
        // (hammering a banned number worsens its standing), and pause any campaigns using it.
        this.log.error(
          `[${sessionId}] connection forbidden (403) — treating as BAN. Marking BANNED and pausing its campaigns.`,
        );
        await this.setStatus(sessionId, SessionStatus.BANNED);
        await this.proxy.releaseProxy(sessionId);
        this.sockets.delete(sessionId);
        this.reconnectDelays.delete(sessionId);
        await this.pauseCampaignsForSession(sessionId);
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        // loggedOut fires for both manual phone-side logout AND WhatsApp bans.
        // The two are indistinguishable from the disconnect code alone. Either way the
        // session can no longer send, so mark OFFLINE and pause its campaigns so queued
        // work doesn't grind out failures; the operator re-links (or investigates a ban).
        this.log.warn(
          `[${sessionId}] loggedOut — could be manual logout or a ban. Marking OFFLINE and pausing its campaigns. ` +
          `Re-connect to verify; WA rejects the QR with a ban notice if the number is banned.`,
        );
        await this.setStatus(sessionId, SessionStatus.OFFLINE);
        await this.proxy.releaseProxy(sessionId);
        this.sockets.delete(sessionId);
        this.reconnectDelays.delete(sessionId);
        // A loggedOut/401 means WhatsApp has permanently invalidated these credentials —
        // resuming with them will always fail the same way. Clear them so the stored auth
        // state resets to unregistered; without this, every future "Reconnect" click would
        // keep loading the same dead creds, hit this exact branch again, and never reach
        // the "needs pairing" state that actually emits a QR code.
        await this.prisma.session
          .update({ where: { id: sessionId }, data: { authState: Prisma.JsonNull } })
          .catch((err: unknown) => this.log.error(`clearing stale authState failed [${sessionId}]: ${String(err)}`));
        await this.pauseCampaignsForSession(sessionId);
        // Immediately start a fresh pairing attempt with the now-cleared credentials, so an
        // operator who clicked "Reconnect" (and is watching for a QR right now) gets one
        // without needing to click again — this is a genuinely new, unregistered connection
        // attempt, not a retry of the one that just failed.
        void this.startSocket(sessionId).catch((err: unknown) =>
          this.log.error(`fresh-pairing startSocket failed [${sessionId}]: ${String(err)}`),
        );
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        // 440 means the session was opened on another device — reconnecting here just
        // fights that device in a replace loop. Go OFFLINE and stop; operator must re-link.
        this.log.warn(`[${sessionId}] connection replaced (440) — another device took over. Marking OFFLINE, not reconnecting.`);
        await this.setStatus(sessionId, SessionStatus.OFFLINE);
        this.sockets.delete(sessionId);
        this.reconnectDelays.delete(sessionId);
        return;
      }

      if (this.intentionalDisconnects.has(sessionId)) {
        this.intentionalDisconnects.delete(sessionId);
        await this.setStatus(sessionId, SessionStatus.OFFLINE);
        this.sockets.delete(sessionId);
        return;
      }

      // Unintentional disconnect — reconnect with exponential backoff.
      // Accumulate delay across repeated flaps so a flapping session doesn't hammer
      // WA servers at 3s intervals indefinitely.
      await this.setStatus(sessionId, SessionStatus.CONNECTING);
      this.sockets.delete(sessionId);
      const currentDelay = this.reconnectDelays.get(sessionId) ?? 3_000;
      const nextDelay = Math.min(currentDelay * 2, 60_000);
      this.reconnectDelays.set(sessionId, nextDelay);
      this.scheduleReconnect(sessionId, currentDelay);
    }
  }

  private scheduleReconnect(sessionId: string, delayMs: number): void {
    this.log.log(`[${sessionId}] reconnect in ${delayMs}ms`);
    setTimeout(() => {
      // Abort if the session was deleted while we were waiting
      void this.prisma.session
        .findUnique({ where: { id: sessionId }, select: { id: true } })
        .then((exists) => {
          if (!exists) {
            this.log.log(`[${sessionId}] session deleted — aborting reconnect`);
            this.reconnectDelays.delete(sessionId);
            return;
          }
          return this.startSocket(sessionId);
        })
        .catch((err: unknown) => {
          this.log.error(`Reconnect failed [${sessionId}]: ${String(err)}`);
          // startSocket threw — apply backoff and retry
          const lastDelay = this.reconnectDelays.get(sessionId) ?? delayMs;
          const nextDelay = Math.min(lastDelay * 2, 60_000);
          this.reconnectDelays.set(sessionId, nextDelay);
          this.scheduleReconnect(sessionId, nextDelay);
        });
    }, delayMs);
  }

  private async setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    try {
      await this.prisma.session.update({ where: { id: sessionId }, data: { status } });
      this.gateway.emitStatus(sessionId, status);
    } catch {
      // Session may have been deleted; skip silently
    }
  }

  /**
   * Pauses every RUNNING campaign that still has queued messages assigned to this session.
   * Called when a session is banned/logged-out/circuit-broken so queued work stops instead
   * of grinding out failures against a dead session. Returns the number of campaigns paused.
   */
  async pauseCampaignsForSession(sessionId: string): Promise<number> {
    try {
      const rows = await this.prisma.campaignMessage.findMany({
        where: {
          sessionId,
          status: MsgStatus.QUEUED,
          campaign: { status: CampaignStatus.RUNNING },
        },
        select: { campaignId: true },
        distinct: ['campaignId'],
      });
      const ids = rows.map((r) => r.campaignId);
      if (!ids.length) return 0;
      const res = await this.prisma.campaign.updateMany({
        where: { id: { in: ids }, status: CampaignStatus.RUNNING },
        data: { status: CampaignStatus.PAUSED },
      });
      if (res.count > 0) {
        this.log.warn(`Paused ${res.count} campaign(s) that were sending through session ${sessionId}`);
      }
      return res.count;
    } catch (err) {
      this.log.error(`pauseCampaignsForSession failed [${sessionId}]: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Circuit breaker: called by the send workers after too many consecutive send failures
   * on a session. Pauses the session's campaigns so a broken/banned session stops bleeding
   * failures. Session status is left to the connection lifecycle to avoid contradicting a
   * still-open socket; the loud log + paused campaign is the safety action.
   */
  async tripCircuitBreaker(sessionId: string, failureCount: number): Promise<void> {
    this.log.error(
      `[${sessionId}] circuit breaker tripped after ${failureCount} consecutive send failures — pausing its campaigns`,
    );
    await this.pauseCampaignsForSession(sessionId);
  }

  /**
   * Builds the plain-text numbered listing appended to every buttoned message — the
   * safety net that keeps replies matchable even when the interactive render fails or
   * isn't supported by the recipient's client. URL/Call buttons inline their raw
   * url/phone number since a plain-text render has no tappable button.
   */
  private buildButtonListing(buttons: ButtonDef[], numeralOffset = 0): string {
    return buttons
      .map((b, i) => {
        const n = numeralOffset + i + 1;
        if (b.type === 'URL') return `${n}. ${b.label}: ${b.url}`;
        if (b.type === 'CALL') return `${n}. ${b.label}: ${b.phoneNumber}`;
        return `${n}. ${b.label}`;
      })
      .join('\n');
  }

  /**
   * Attempts a real interactive button send using Baileys' raw NativeFlowMessage proto —
   * the same wire shape the official WhatsApp Business App uses, but reached here via
   * Baileys' documented "raw content" escape hatch (generateWAMessageFromContent +
   * relayMessage), since there is no high-level sendMessage() shape for it. Throws on
   * any failure — the caller is expected to fall back to a plain-text send.
   */
  private async sendNativeFlowButtons(
    sock: ReturnType<typeof makeWASocket>,
    jid: string,
    bodyText: string,
    buttons: ButtonDef[],
  ): Promise<void> {
    const nativeButtons = buttons.map((b) => ({
      name: b.type === 'URL' ? 'cta_url' : b.type === 'CALL' ? 'cta_call' : 'quick_reply',
      buttonParamsJson: JSON.stringify(
        b.type === 'URL'
          ? { display_text: b.label, url: b.url }
          : b.type === 'CALL'
            ? { display_text: b.label, phone_number: b.phoneNumber }
            : { display_text: b.label, id: b.id },
      ),
    }));

    const content = {
      interactiveMessage: {
        body: { text: bodyText },
        nativeFlowMessage: { buttons: nativeButtons },
      },
    } as unknown as WAMessageContent;

    const userJid = sock.user?.id;
    if (!userJid) throw new Error('socket has no authenticated user — cannot build message');

    const generated = generateWAMessageFromContent(jid, content, { userJid });
    if (!generated.key?.id || !generated.message) {
      throw new Error('generateWAMessageFromContent produced no message id/content');
    }
    await sock.relayMessage(jid, generated.message, { messageId: generated.key.id });
  }

  /**
   * Sends a text or media message via Baileys, preceded by a typing-presence signal.
   * Called exclusively by BaileysWorker — never call from a controller.
   */
  async sendBaileyMessage(
    sessionId: string,
    phone: string,
    text: string,
    typingMs: number,
    media?: { url: string; type: MediaType; mimeType?: string; filename?: string },
    buttons?: ButtonDef[],
  ): Promise<void> {
    if (this.dryRun) {
      this.log.log(
        `[DRY_RUN] skipping Baileys send to ${phone}: "${text.slice(0, 80)}"${media ? ` [+${media.type}]` : ''}${buttons?.length ? ` [+${buttons.length} buttons]` : ''}`,
      );
      return;
    }
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error(`Session ${sessionId} socket is not active`);
    }
    await this.ensureLidResolved(sock, phone);
    const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

    // WhatsApp hard limits — silently truncate rather than throw and lose the message.
    // Media captions are capped tighter (1024) than standalone text messages (4096).
    // The button listing is load-bearing for reply-matching, so it's protected from
    // truncation — the original body loses characters first, not the listing.
    const MAX_WA_CHARS = media ? 1024 : 4096;
    const listing = buttons?.length ? this.buildButtonListing(buttons) : '';
    const listingBlock = listing ? `\n\n${listing}` : '';
    const availableForBody = Math.max(0, MAX_WA_CHARS - listingBlock.length);
    const truncatedBody = text.length > availableForBody ? text.slice(0, availableForBody) : text;
    const safeText = `${truncatedBody}${listingBlock}`;
    if (text.length > availableForBody) {
      this.log.warn(`[${sessionId}] message truncated ${text.length}→${availableForBody} chars for ${phone} (button listing preserved)`);
    }

    await sock.sendPresenceUpdate('composing', jid);
    await new Promise<void>((resolve) => setTimeout(resolve, typingMs));
    await sock.sendPresenceUpdate('paused', jid);

    if (!media) {
      if (buttons?.length) {
        try {
          await this.sendNativeFlowButtons(sock, jid, safeText, buttons);
          return;
        } catch (err) {
          this.log.warn(`[${sessionId}] native button send failed for ${phone}, falling back to plain text: ${String(err)}`);
        }
      }
      await sock.sendMessage(jid, { text: safeText });
      return;
    }

    // Media + buttons: keep the (simpler, well-supported) media send and rely on the
    // listing embedded in safeText/caption above — combining media with a native
    // interactive send is not attempted, to avoid an unverified proto combination.
    const storedName = this.media.storedNameFromUrl(media.url);
    if (!storedName) {
      throw new Error(`Cannot resolve local path for media URL ${media.url}`);
    }
    const buffer = await this.media.readFile(storedName);

    if (media.type === MediaType.IMAGE) {
      await sock.sendMessage(jid, { image: buffer, caption: safeText });
    } else if (media.type === MediaType.VIDEO) {
      await sock.sendMessage(jid, { video: buffer, caption: safeText });
    } else {
      await sock.sendMessage(jid, {
        document: buffer,
        mimetype: media.mimeType ?? 'application/octet-stream',
        fileName: media.filename ?? 'file',
        caption: safeText,
      });
    }
  }

  /**
   * Sends a carousel as a sequence of real WhatsApp messages: a standalone intro text
   * (the template's shared body), then each card as its own image/video + caption +
   * button listing, reusing the same media/truncation machinery as sendBaileyMessage.
   *
   * There is no attempt at Baileys' raw CarouselMessage proto (nested InteractiveMessage
   * cards with encrypted media inside each header) — it has zero precedent anywhere in
   * the library, and even a correctly-built proto might never render as a swipeable
   * carousel from a non-Cloud-API sender. This decomposition reuses 100% already-shipped
   * code with zero new protocol risk, at the cost of "N separate bubbles" instead of one
   * swipeable carousel. Card buttons are listing-only (never natively tappable) — the
   * same policy sendBaileyMessage already applies whenever media is attached.
   *
   * Button numerals run as a GLOBAL offset across cards (card 1's buttons are 1..N, card
   * 2's continue from N+1, etc.) rather than restarting at 1 per card, so a contact
   * replying with a bare number is unambiguous regardless of which card it refers to.
   */
  async sendBaileyCarousel(
    sessionId: string,
    phone: string,
    sharedBodyText: string,
    typingMs: number,
    cards: CarouselCardDef[],
    interCardDelayMs = 1200,
  ): Promise<void> {
    if (this.dryRun) {
      this.log.log(
        `[DRY_RUN] skipping Baileys carousel send to ${phone}: intro="${sharedBodyText.slice(0, 80)}" cards=${cards.length}`,
      );
      return;
    }
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error(`Session ${sessionId} socket is not active`);
    }
    await this.ensureLidResolved(sock, phone);
    const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

    await sock.sendPresenceUpdate('composing', jid);
    await new Promise<void>((resolve) => setTimeout(resolve, typingMs));
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, { text: sharedBodyText.slice(0, 4096) });

    const MAX_CAPTION_CHARS = 1024;
    let numeralOffset = 0;

    for (const card of cards) {
      await new Promise<void>((resolve) => setTimeout(resolve, interCardDelayMs));

      const storedName = this.media.storedNameFromUrl(card.mediaUrl);
      if (!storedName) {
        throw new Error(`Cannot resolve local path for card media URL ${card.mediaUrl}`);
      }
      const buffer = await this.media.readFile(storedName);

      const listing = card.buttons.length ? this.buildButtonListing(card.buttons, numeralOffset) : '';
      const listingBlock = listing ? `\n\n${listing}` : '';
      const availableForBody = Math.max(0, MAX_CAPTION_CHARS - listingBlock.length);
      const truncatedBody = card.body.length > availableForBody ? card.body.slice(0, availableForBody) : card.body;
      const caption = `${truncatedBody}${listingBlock}`;

      if (card.mediaType === 'VIDEO') {
        await sock.sendMessage(jid, { video: buffer, caption });
      } else {
        await sock.sendMessage(jid, { image: buffer, caption });
      }

      numeralOffset += card.buttons.length;
    }
  }

  /** Exposed for testing purposes only. */
  getSocketCount(): number {
    return this.sockets.size;
  }
}

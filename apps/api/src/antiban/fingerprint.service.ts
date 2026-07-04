import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { type Prisma, SessionStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

export interface DeviceFingerprint {
  userAgent: string;
  deviceModel: string;
  osVersion: string;
  screenWidth: number;
  screenHeight: number;
}

/**
 * Pool of 20 realistic Android + iOS device profiles (updated June 2026).
 * Android 14/15 and iOS 17/18 reflect current real-world device distribution.
 * userAgent strings match current WhatsApp app versions (Android 2.26.x, iOS 26.x).
 */
const FINGERPRINT_POOL: DeviceFingerprint[] = [
  // ── Android 15 (4) ────────────────────────────────────────────────────────
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Pixel 9 Pro',
    osVersion: 'Android 15',
    screenWidth: 1080,
    screenHeight: 2424,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Samsung Galaxy S25 Ultra',
    osVersion: 'Android 15',
    screenWidth: 1440,
    screenHeight: 3088,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'OnePlus 13',
    osVersion: 'Android 15',
    screenWidth: 1264,
    screenHeight: 2780,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Xiaomi 15 Pro',
    osVersion: 'Android 15',
    screenWidth: 1440,
    screenHeight: 3200,
  },
  // ── Android 14 (8) ────────────────────────────────────────────────────────
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Pixel 8 Pro',
    osVersion: 'Android 14',
    screenWidth: 1344,
    screenHeight: 2992,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Samsung Galaxy S24',
    osVersion: 'Android 14',
    screenWidth: 1080,
    screenHeight: 2340,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Samsung Galaxy A55',
    osVersion: 'Android 14',
    screenWidth: 1080,
    screenHeight: 2340,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'OnePlus 12',
    osVersion: 'Android 14',
    screenWidth: 1440,
    screenHeight: 3168,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Xiaomi 14',
    osVersion: 'Android 14',
    screenWidth: 1200,
    screenHeight: 2670,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'OPPO Find X7 Pro',
    osVersion: 'Android 14',
    screenWidth: 1440,
    screenHeight: 3168,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Motorola Edge 50 Pro',
    osVersion: 'Android 14',
    screenWidth: 1220,
    screenHeight: 2712,
  },
  {
    userAgent: 'WhatsApp/2.26.23.71 A',
    deviceModel: 'Sony Xperia 1 VI',
    osVersion: 'Android 14',
    screenWidth: 1080,
    screenHeight: 2340,
  },
  // ── iOS 18 (4) ────────────────────────────────────────────────────────────
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 16 Pro Max',
    osVersion: 'iOS 18.3',
    screenWidth: 1320,
    screenHeight: 2868,
  },
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 16 Pro',
    osVersion: 'iOS 18.3',
    screenWidth: 1206,
    screenHeight: 2622,
  },
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 16',
    osVersion: 'iOS 18.2',
    screenWidth: 1179,
    screenHeight: 2556,
  },
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 16 Plus',
    osVersion: 'iOS 18.2',
    screenWidth: 1284,
    screenHeight: 2778,
  },
  // ── iOS 17 (4) ────────────────────────────────────────────────────────────
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 15 Pro Max',
    osVersion: 'iOS 17.7',
    screenWidth: 1290,
    screenHeight: 2796,
  },
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 15 Pro',
    osVersion: 'iOS 17.7',
    screenWidth: 1179,
    screenHeight: 2556,
  },
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 15',
    osVersion: 'iOS 17.6',
    screenWidth: 1179,
    screenHeight: 2556,
  },
  {
    userAgent: 'WhatsApp/26.10.74 I',
    deviceModel: 'iPhone 14 Pro Max',
    osVersion: 'iOS 17.5',
    screenWidth: 1290,
    screenHeight: 2796,
  },
];

export const FINGERPRINT_POOL_SIZE = FINGERPRINT_POOL.length;

@Injectable()
export class FingerprintService {
  private readonly log = new Logger(FingerprintService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Assigns a fingerprint to a session. If the session already has one stored,
   * returns it unchanged — this preserves device consistency across reconnects.
   * Only assigns a fresh random profile when none exists yet.
   */
  async assignFingerprint(sessionId: string): Promise<DeviceFingerprint> {
    const existing = await this.getFingerprint(sessionId);
    if (existing) {
      this.log.debug(`[${sessionId}] fingerprint reused → ${existing.deviceModel} (${existing.osVersion})`);
      return existing;
    }
    const fp = this.pickProfile();
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { fingerprint: fp as unknown as Prisma.InputJsonValue },
    });
    this.log.debug(`[${sessionId}] fingerprint → ${fp.deviceModel} (${fp.osVersion})`);
    return fp;
  }

  /**
   * Reads the stored fingerprint for a session.
   * Returns undefined when none has been assigned.
   */
  async getFingerprint(sessionId: string): Promise<DeviceFingerprint | undefined> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { fingerprint: true },
    });
    if (!row?.fingerprint) return undefined;
    return row.fingerprint as unknown as DeviceFingerprint;
  }

  /** Picks a random profile from the pool, excluding the given device model when possible. */
  private pickProfile(excludeModel?: string): DeviceFingerprint {
    const candidates = excludeModel
      ? FINGERPRINT_POOL.filter((p) => p.deviceModel !== excludeModel)
      : FINGERPRINT_POOL;
    const pool = candidates.length ? candidates : FINGERPRINT_POOL;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  /**
   * Weekly Sunday 03:00 rotation: force-assign a new random fingerprint. Must write directly
   * to Prisma rather than calling assignFingerprint(), which returns the existing fingerprint
   * unchanged when one is already stored (correct for reconnects, wrong for rotation).
   */
  @Cron('0 3 * * 0')
  async rotateFingerprints(): Promise<void> {
    // Rotate only OFFLINE sessions — changing a fingerprint on an ONLINE session causes a
    // device-identity mismatch the moment it reconnects and is a ban signal. This is a
    // deliberate security choice: a real phone does not change its model, so we only ever
    // re-roll the profile of a session that is not currently linked.
    const sessions = await this.prisma.session.findMany({
      where: { status: SessionStatus.OFFLINE },
      select: { id: true, fingerprint: true },
    });

    for (const { id, fingerprint } of sessions) {
      const currentModel = (fingerprint as unknown as DeviceFingerprint | null)?.deviceModel;
      const fp = this.pickProfile(currentModel); // ensure the rotation actually changes the profile
      await this.prisma.session.update({
        where: { id },
        data: { fingerprint: fp as unknown as Prisma.InputJsonValue },
      });
      this.log.debug(`[${id}] fingerprint rotated → ${fp.deviceModel} (${fp.osVersion})`);
    }

    this.log.log(`Fingerprint rotation: rotated ${sessions.length} session(s)`);
  }
}

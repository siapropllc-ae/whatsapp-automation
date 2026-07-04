import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';

export interface ProxyConfig {
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'socks5' | 'socks4';
  username?: string;
  password?: string;
}

@Injectable()
export class ProxyService {
  private readonly log = new Logger(ProxyService.name);
  private readonly rotationHours: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.rotationHours = +(config.get<string>('PROXY_ROTATION_HOURS') ?? '24');
  }

  /**
   * Assigns a free proxy to the session atomically.
   * Returns the proxy details on success, null when the pool is exhausted
   * (caller should connect without proxy — proxies are optional infrastructure).
   */
  async assignProxy(sessionId: string): Promise<ProxyConfig | null> {
    const proxy = await this.prisma.$transaction(async (tx) => {
      // SELECT FOR UPDATE SKIP LOCKED prevents two concurrent assigns from racing on the same row
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Proxy" WHERE "inUse" = false LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      if (!rows[0]) return null;

      await tx.proxy.update({
        where: { id: rows[0].id },
        data: { inUse: true, lastRotat: new Date() },
      });
      await tx.session.update({
        where: { id: sessionId },
        data: { proxyId: rows[0].id },
      });
      return tx.proxy.findUnique({ where: { id: rows[0].id } });
    });

    if (!proxy) {
      // Distinguish "no proxies configured at all" (bare server IP — higher ban risk) from
      // "pool exhausted" (all proxies busy) so the operator knows whether to add proxies.
      const total = await this.prisma.proxy.count();
      if (total === 0) {
        this.log.warn(
          `[${sessionId}] no proxies configured — connecting on the bare server IP (higher ban risk). ` +
          `Add proxies in Settings → Proxies to rotate IPs across sessions.`,
        );
      } else {
        this.log.warn(`[${sessionId}] proxy pool exhausted (${total} configured, all in use) — connecting without proxy`);
      }
      return null;
    }

    this.log.debug(`[${sessionId}] proxy → ${proxy.protocol}://${proxy.host}:${proxy.port}`);
    const raw = proxy.protocol;
    const protocol: ProxyConfig['protocol'] =
      raw === 'https' ? 'https' : raw === 'socks5' ? 'socks5' : raw === 'socks4' ? 'socks4' : 'http';
    return {
      host: proxy.host,
      port: proxy.port,
      protocol,
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  }

  /**
   * Releases the session's proxy back to the pool.
   * Safe to call when no proxy is assigned (no-op).
   */
  async releaseProxy(sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { proxyId: true },
    });
    if (!session?.proxyId) return;

    const proxyId = session.proxyId;
    await this.prisma.$transaction([
      this.prisma.proxy.update({ where: { id: proxyId }, data: { inUse: false } }),
      this.prisma.session.update({ where: { id: sessionId }, data: { proxyId: null } }),
    ]);
    this.log.debug(`[${sessionId}] proxy released (${proxyId})`);
  }

  /**
   * Hourly check: rotate proxies that have been in use longer than PROXY_ROTATION_HOURS.
   * Finds stale proxy IDs first, then finds affected sessions, release + re-assign.
   */
  @Cron('0 * * * *')
  async rotateStalledProxies(): Promise<void> {
    const cutoff = new Date(Date.now() - this.rotationHours * 3_600_000);

    const staleProxies = await this.prisma.proxy.findMany({
      where: { inUse: true, lastRotat: { lt: cutoff } },
      select: { id: true },
    });

    if (!staleProxies.length) return;

    const staleIds = staleProxies.map((p) => p.id);
    const staleSessions = await this.prisma.session.findMany({
      where: { proxyId: { in: staleIds } },
      select: { id: true },
    });

    for (const { id } of staleSessions) {
      await this.releaseProxy(id);
      await this.assignProxy(id);
      // NOTE: the new proxy is stored in the DB and will be used on the
      // next socket reconnect (natural disconnect or manual reconnect from panel).
      // Live sockets cannot hot-swap their proxy agent — this is by design to avoid
      // forced disconnects that could trigger WhatsApp ban detection.
      this.log.warn(
        `[${id}] proxy rotated in DB — will apply on next socket reconnect`,
      );
    }

    this.log.log(`Proxy rotation: cycled ${staleSessions.length} session(s)`);
  }
}

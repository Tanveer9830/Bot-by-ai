import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { AppConfig, Logger } from '@bot-by-ai/shared';
import type { StatusService } from './services/status.js';

export interface HealthServerOptions {
  config: AppConfig;
  port: number;
  status: StatusService;
  client: Client;
  registrySize: () => number;
  logger: Logger;
}

/**
 * Tiny health/metrics endpoint for Docker, Kubernetes and uptime monitors.
 *
 * `/healthz`  liveness  — process is up
 * `/readyz`   readiness — gateway ready, database reachable
 * `/metrics`  JSON snapshot (also Prometheus-friendly text at `/metrics.txt`)
 *
 * Optional bearer protection via HEALTH_TOKEN for the metrics route.
 */
export function startHealthServer(options: HealthServerOptions): Server {
  const { config, port, status, client, registrySize, logger } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: string, contentType = 'application/json'): void => {
      res.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(body);
    };

    if (url.pathname === '/healthz') {
      send(200, JSON.stringify({ status: 'ok', ready: statusErrorFree(client) }));
      return;
    }

    if (url.pathname === '/readyz') {
      const snapshot = await status.snapshot();
      const ready = snapshot.ready && snapshot.database.ok && client.isReady();
      send(ready ? 200 : 503, JSON.stringify({ ready, status: snapshot.status }));
      return;
    }

    if (url.pathname === '/metrics' || url.pathname === '/metrics.txt') {
      const token = process.env.HEALTH_TOKEN;
      if (token) {
        const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token');
        if (provided !== token) {
          send(401, JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      const snapshot = await status.snapshot();
      const payload = { ...snapshot, commandCount: registrySize(), features: statusFeatures(config) };
      if (url.pathname === '/metrics.txt') {
        const lines = [
          `# HELP bot_uptime_seconds Process uptime`,
          `bot_uptime_seconds ${snapshot.uptimeSeconds}`,
          `bot_ws_ping_ms ${snapshot.wsPingMs ?? 0}`,
          `bot_guilds ${snapshot.guildCount}`,
          `bot_users ${snapshot.userCount}`,
          `bot_commands ${registrySize()}`,
          `bot_memory_rss_bytes ${snapshot.memoryUsedMb * 1_048_576}`,
          `bot_cpu_percent ${snapshot.cpuLoadPercent}`,
          `bot_db_up ${snapshot.database.ok ? 1 : 0}`,
          `bot_db_latency_ms ${snapshot.database.latencyMs}`,
          `bot_errors_total ${snapshot.errors.count}`,
          `bot_music_enabled ${snapshot.music.enabled ? 1 : 0}`,
        ];
        send(200, lines.join('\n'), 'text/plain; version=0.0.4');
        return;
      }
      send(200, JSON.stringify(payload));
      return;
    }

    send(404, JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info('health server listening', { port, endpoints: ['/healthz', '/readyz', '/metrics'] });
  });
  server.on('error', (error) => logger.warn('health server error', { error: error.message }));
  return server;
}

function statusErrorFree(client: Client): boolean {
  return client.isReady();
}

function statusFeatures(config: AppConfig): Record<string, boolean> {
  return {
    music: config.music.enabled,
    redis: Boolean(config.redisUrl),
    dashboard: config.dashboard.enabled,
  };
}

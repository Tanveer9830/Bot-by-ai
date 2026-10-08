import { Events, RESTEvents, type Client } from 'discord.js';
import { errorForLog } from '@bot-by-ai/shared';
import type { CommandRegistry } from '../core/registry.js';
import type { BotServices } from '../core/context.js';
import { registerInteractionEvents } from './interactionCreate.js';
import { registerMessageEvents } from './messageCreate.js';
import { registerGuildEvents } from './guildEvents.js';

/** Wires every gateway event to its handler exactly once. */
export function registerEvents(
  client: Client,
  registry: CommandRegistry,
  services: BotServices,
): void {
  registerInteractionEvents(client, registry, services);
  registerMessageEvents(client, services);
  registerGuildEvents(client, services);

  client.on(Events.Error, (error) => {
    services.status.recordError(error);
    services.logger.error('gateway client error', errorForLog(error));
  });

  client.on(Events.Warn, (message) => {
    services.logger.warn('gateway warning', { message });
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    services.logger.warn('shard disconnected', { shardId, code: event.code });
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    services.logger.info('shard reconnecting', { shardId });
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    services.logger.info('shard resumed', { shardId, replayedEvents });
  });

  client.rest.on(RESTEvents.RateLimited, (info) => {
    services.logger.debug('rest rate limit hit', {
      route: info.route,
      timeToReset: info.timeToReset,
      global: info.global,
    });
  });
}

import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';
import type { AppConfig } from '@bot-by-ai/shared';

/**
 * Intents are the *minimum* required for the documented feature set.
 * `MessageContent` is required for AutoMod word filtering and custom commands —
 * it is a privileged intent that must be enabled in the Discord developer
 * portal (see docs/DEPLOYMENT.md).
 */
export function createBotClient(config: AppConfig): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildEmojisAndStickers,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.Reaction, Partials.User],
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      // Bound caches so a 100k-member guild cannot exhaust memory.
      MessageManager: 100,
      PresenceManager: 0,
      GuildMemberManager: { maxSize: 5_000, keepOverLimit: (member) => member.id === member.client.user?.id },
      GuildInviteManager: 0,
      GuildStickerManager: 50,
      GuildScheduledEventManager: 20,
      ThreadManager: 200,
      ReactionManager: 100,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 600, lifetime: 1_800 },
      users: { interval: 3_600, filter: () => (user) => user.bot && user.id !== user.client.user?.id },
      guildMembers: {
        interval: 3_600,
        filter: () => (member) => member.id !== member.client.user?.id && !member.voice.channelId,
      },
    },
    rest: {
      timeout: 20_000,
      retries: 2,
      // The bot never needs more than a handful of concurrent API calls.
      globalRequestsPerSecond: 45,
    },
    presence: {
      status: 'online',
      activities: [{ name: config.isProduction ? '/help' : 'development build', type: 3 }],
    },
  });

  client.on('error', () => {
    /* handled by the central error logger */
  });
  client.on('warn', () => {
    /* handled by the central error logger */
  });

  return client;
}

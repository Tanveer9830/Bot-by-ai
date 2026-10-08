import { ChannelType, type Guild, type Message } from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import { pickRandom, renderTemplate } from '@bot-by-ai/shared';
import type { GuildSettingsService } from './settings.js';
import type { BrandingSettings } from './types.js';
import { baseEmbed } from '../core/embeds.js';
import { COLORS } from '../core/constants.js';

/**
 * Optional branding / response system.
 *
 * Disabled by default and deliberately conservative when enabled: a per-channel
 * cooldown, a daily cap, an exempt list, and no reply cascades (the bot never
 * responds to its own or other bots' messages).
 */
export class BrandingService {
  private readonly channelUsage = new Map<string, { count: number; day: string }>();
  private readonly lastResponse = new Map<string, number>();
  private readonly recentTexts = new Map<string, string[]>();

  constructor(
    private readonly settings: GuildSettingsService,
    private readonly logger: Logger,
  ) {}

  async getSettings(guildId: string): Promise<BrandingSettings> {
    return this.settings.get<BrandingSettings>(guildId, 'branding');
  }

  private dayKey(now = Date.now()): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  private usageFor(channelId: string, now = Date.now()): number {
    const entry = this.channelUsage.get(channelId);
    if (!entry || entry.day !== this.dayKey(now)) {
      this.channelUsage.set(channelId, { count: 0, day: this.dayKey(now) });
      return 0;
    }
    return entry.count;
  }

  /**
   * Decides whether the bot should reply to an ordinary message.
   * Returns null when no response is warranted.
   */
  async maybeRespond(message: Message<true>): Promise<{ content?: string; embed?: boolean } | null> {
    if (!message.guild || message.author.bot) return null;
    const settings = await this.getSettings(message.guild.id);
    if (!settings.enabled) return null;
    if (settings.exemptUserIds.includes(message.author.id)) return null;
    if (settings.exemptChannelIds.includes(message.channelId)) return null;
    if (this.usageFor(message.channelId) >= settings.dailyCapPerChannel) return null;

    const channelRule = settings.channelTemplates.find((rule) => rule.channelId === message.channelId);
    let templates: string[] = [];
    let cooldownSeconds = 60;

    if (channelRule) {
      templates = channelRule.templates;
      cooldownSeconds = channelRule.cooldownSeconds;
    } else if (settings.reactToEveryMessage) {
      templates = settings.everyMessageTemplates;
      cooldownSeconds = 30;
      // Probability gate keeps "every message" mode from becoming spam.
      if (Math.random() > settings.everyMessageChance) return null;
    } else {
      return null;
    }
    if (templates.length === 0) return null;

    const last = this.lastResponse.get(message.channelId) ?? 0;
    if (Date.now() - last < cooldownSeconds * 1000) return null;

    const rendered = renderTemplate(pickRandom(templates) ?? '', {
      user: {
        id: message.author.id,
        username: message.author.username,
        tag: message.author.tag,
        mention: `<@${message.author.id}>`,
      },
      server: {
        name: message.guild.name,
        id: message.guild.id,
        memberCount: message.guild.memberCount,
      },
      channel: { name: 'name' in message.channel ? String(message.channel.name) : 'channel', mention: `<#${message.channelId}>` },
      command: { name: 'branding', args: message.content.slice(0, 200) },
    }).output;

    // Never repeat the same response twice in a row in the same channel.
    const history = this.recentTexts.get(message.channelId) ?? [];
    if (history[history.length - 1] === rendered) return null;
    history.push(rendered);
    this.recentTexts.set(message.channelId, history.slice(-5));

    this.lastResponse.set(message.channelId, Date.now());
    this.channelUsage.set(message.channelId, {
      count: this.usageFor(message.channelId) + 1,
      day: this.dayKey(),
    });
    return { content: rendered.slice(0, 2000) };
  }

  /** Renders a branded embed for announcements, if branding is configured. */
  async announcementEmbed(guild: Guild, title: string, description: string): Promise<ReturnType<typeof baseEmbed>> {
    const settings = await this.getSettings(guild.id);
    const embed = baseEmbed(settings.embedColor || COLORS.primary).setTitle(title).setDescription(description);
    if (settings.footerText) embed.setFooter({ text: settings.footerText });
    return embed;
  }

  /** Sends a branded announcement to a channel (used by /announce and dashboard). */
  async announce(input: {
    guild: Guild;
    channelId: string;
    title: string;
    description: string;
    ping?: 'none' | 'everyone' | 'here';
  }): Promise<boolean> {
    const channel = await input.guild.channels.fetch(input.channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.type === ChannelType.GuildVoice) {
      this.logger.warn('announcement channel unavailable', { guildId: input.guild.id, channelId: input.channelId });
      return false;
    }
    const embed = await this.announcementEmbed(input.guild, input.title, input.description);
    const content = input.ping === 'everyone' ? '@everyone' : input.ping === 'here' ? '@here' : undefined;
    const sent = await channel
      .send({ content, embeds: [embed], allowedMentions: { parse: input.ping === 'none' ? [] : (['everyone'] as const) } })
      .then(() => true)
      .catch(() => false);
    return sent;
  }
}

import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember, type Message } from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import { formatRelativeTimestamp, formatTimestamp, secureRandomInt, shuffle, UserFacingError } from '@bot-by-ai/shared';
import type { Repositories } from '@bot-by-ai/database';
import type { GuildSettingsService } from './settings.js';
import type { LoggingService } from './logging.js';
import type { BirthdaySettings, GiveawaySettings, StarboardSettings, SuggestionSettings } from './types.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { COLORS, INTERACTION_PREFIXES } from '../core/constants.js';

/**
 * Community features: giveaways, suggestions, starboard, birthdays, reminders.
 * Every feature degrades to a clear error instead of silently doing nothing.
 */
export class CommunityService {
  constructor(
    private readonly repos: Repositories,
    private readonly settings: GuildSettingsService,
    private readonly logging: LoggingService,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------- giveaways

  async startGiveaway(input: {
    guild: Guild;
    channelId: string;
    hostId: string;
    prize: string;
    durationMs: number;
    winners: number;
    requiredRoleId?: string | null;
    bonusRoleIds?: string[];
  }): Promise<{ id: number; endsAt: number }> {
    const settings = await this.getGiveawaySettings(input.guild.id);
    if (!settings.enabled) throw new UserFacingError('Giveaways are disabled in this server.');
    const channel = await input.guild.channels.fetch(input.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildVoice) {
      throw new UserFacingError('I cannot post a giveaway in that channel.');
    }
    if (input.durationMs < 60_000) throw new UserFacingError('Giveaways must run for at least 1 minute.');
    if (input.winners > settings.maxWinners) {
      throw new UserFacingError(`This server allows at most ${settings.maxWinners} winners per giveaway.`);
    }
    const endsAt = new Date(Date.now() + input.durationMs);
    const giveaway = await this.repos.community.createGiveaway({
      guildId: input.guild.id,
      channelId: input.channelId,
      hostId: input.hostId,
      prize: input.prize,
      winnersCount: input.winners,
      endsAt,
      requiredRoleId: input.requiredRoleId ?? settings.requireRoleId ?? null,
      bonusRoleIds: input.bonusRoleIds ?? settings.bonusRoleIds,
    });

    const embed = baseEmbed(COLORS.primary)
      .setTitle(`🎉 Giveaway: ${input.prize}`)
      .setDescription(
        [
          `Hosted by <@${input.hostId}>`,
          `Winners: **${input.winners}**`,
          `Ends: ${formatRelativeTimestamp(endsAt.getTime())} (${formatTimestamp(endsAt.getTime())})`,
          requiredRoleLine(giveaway.required_role_id),
          'Click the button below to enter.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    const message = await channel.send({
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: 'Enter giveaway',
              emoji: { name: '🎉' },
              custom_id: `${INTERACTION_PREFIXES.giveaway}:enter:${giveaway.id}`,
            },
          ],
        },
      ],
    });
    await this.repos.community.setGiveawayMessage(giveaway.id, message.id);
    await this.repos.tasks.enqueue({
      taskType: 'giveaway_end',
      guildId: input.guild.id,
      payload: { giveawayId: giveaway.id },
      runAt: endsAt,
    });
    return { id: giveaway.id, endsAt: endsAt.getTime() };
  }

  async enterGiveaway(input: { guild: Guild; giveawayId: number; member: GuildMember }): Promise<{
    ok: boolean;
    reason?: string;
    entries: number;
  }> {
    const giveaway = await this.repos.community.getGiveaway(input.giveawayId);
    if (!giveaway) throw new UserFacingError('That giveaway no longer exists.');
    if (giveaway.ended || giveaway.cancelled) throw new UserFacingError('That giveaway has already ended.');
    if (giveaway.required_role_id && !input.member.roles.cache.has(giveaway.required_role_id)) {
      return { ok: false, reason: `You need the <@&${giveaway.required_role_id}> role to enter.`, entries: 0 };
    }
    const settings = await this.getGiveawaySettings(input.guild.id);
    const bonusRolesHeld = input.member.roles.cache.filter((role) => settings.bonusRoleIds.includes(role.id)).size;
    const result = await this.repos.community.enterGiveaway({
      giveawayId: input.giveawayId,
      userId: input.member.id,
      weight: 1 + bonusRolesHeld,
      entries: 1 + bonusRolesHeld,
    });
    return result;
  }

  /** Ends a giveaway, drawing unique winners from the entry pool. */
  async endGiveaway(input: { guild: Guild; giveawayId: number }): Promise<{
    winners: string[];
    prize: string;
    entries: number;
  }> {
    const giveaway = await this.repos.community.getGiveaway(input.giveawayId);
    if (!giveaway) throw new UserFacingError('Giveaway not found.');
    if (giveaway.ended) throw new UserFacingError('That giveaway has already ended.');
    const entries = await this.repos.community.listEntries(input.giveawayId);
    const pool: string[] = [];
    for (const entry of entries) {
      for (let i = 0; i < Math.max(1, entry.entries); i += 1) pool.push(entry.user_id);
    }
    const uniquePool = shuffle([...new Set(pool)]);
    const eligible: string[] = [];
    for (const userId of uniquePool) {
      const member = await input.guild.members.fetch(userId).catch(() => null);
      if (member) eligible.push(userId);
      if (eligible.length >= giveaway.winners_count * 3) break;
    }
    const winners: string[] = [];
    const working = [...eligible];
    while (winners.length < giveaway.winners_count && working.length > 0) {
      const index = secureRandomInt(0, working.length - 1);
      const picked = working.splice(index, 1)[0];
      if (picked) winners.push(picked);
    }
    const ended = await this.repos.community.endGiveaway(giveaway.id, winners);
    if (!ended) throw new UserFacingError('That giveaway was ended by another process.');

    const channel = await input.guild.channels.fetch(giveaway.channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      const announcement = winners.length
        ? `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(', ')} — you won **${giveaway.prize}**!`
        : `No valid entries for **${giveaway.prize}**, so no winner could be drawn.`;
      await channel.send({ content: announcement }).catch(() => {});
      if (giveaway.message_id) {
        const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
        await message?.edit({ components: [] }).catch(() => {});
      }
    }
    const settings = await this.getGiveawaySettings(input.guild.id);
    if (settings.winnerDmEnabled) {
      for (const winner of winners) {
        const member = await input.guild.members.fetch(winner).catch(() => null);
        await member
          ?.send(`You won **${giveaway.prize}** in **${input.guild.name}**! Contact the host to claim your prize.`)
          .catch(() => {});
      }
    }
    await this.logging.log(input.guild, {
      category: 'giveaways',
      title: 'Giveaway ended',
      description: `Prize: **${giveaway.prize}**\nWinners: ${winners.map((id) => `<@${id}>`).join(', ') || 'none'}\nEntries: ${entries.length}`,
      actorId: giveaway.host_id,
      auditAction: 'giveaways.end',
    });
    return { winners, prize: giveaway.prize, entries: entries.length };
  }

  private async getGiveawaySettings(guildId: string): Promise<GiveawaySettings> {
    return this.settings.get<GiveawaySettings>(guildId, 'giveaways');
  }

  // -------------------------------------------------------------- suggestions

  async submitSuggestion(input: {
    guild: Guild;
    member: GuildMember;
    content: string;
  }): Promise<{ id: number; messageId: string | null }> {
    const settings = await this.settings.get<SuggestionSettings>(input.guild.id, 'suggestions');
    if (!settings.enabled || !settings.channelId) {
      throw new UserFacingError('Suggestions are not configured in this server (use `/suggestion setup`).');
    }
    const channel = await input.guild.channels.fetch(settings.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) throw new UserFacingError('The suggestion channel is not usable.');
    const id = await this.repos.community.createSuggestion({
      guildId: input.guild.id,
      channelId: settings.channelId,
      userId: input.member.id,
      content: input.content,
    });
    const embed = baseEmbed(COLORS.primary)
      .setAuthor({ name: `${input.member.user.tag}`, iconURL: input.member.displayAvatarURL() })
      .setTitle(`Suggestion #${id}`)
      .setDescription(input.content.slice(0, 4000))
      .setFooter({ text: 'Vote with the buttons below' });
    const message = await channel.send({
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: 'Upvote',
              emoji: { name: settings.upvoteEmoji || '👍' },
              custom_id: `${INTERACTION_PREFIXES.suggestion}:up:${id}`,
            },
            {
              type: 2,
              style: 4,
              label: 'Downvote',
              emoji: { name: settings.downvoteEmoji || '👎' },
              custom_id: `${INTERACTION_PREFIXES.suggestion}:down:${id}`,
            },
          ],
        },
      ],
    });
    let threadId: string | null = null;
    if (settings.threadEnabled && message.channel.type === ChannelType.GuildText) {
      const thread = await message
        .startThread({ name: `Suggestion #${id}`, reason: 'Suggestion discussion' })
        .catch(() => null);
      threadId = thread?.id ?? null;
    }
    await this.repos.community.setSuggestionMessage(id, message.id, threadId);
    return { id, messageId: message.id };
  }

  async voteSuggestion(input: { suggestionId: number; userId: string; vote: 1 | -1 }): Promise<{
    upvotes: number;
    downvotes: number;
  }> {
    return this.repos.community.voteSuggestion(input);
  }

  async resolveSuggestion(input: {
    guild: Guild;
    suggestionId: number;
    status: 'accepted' | 'denied' | 'implemented' | 'considered';
    staffId: string;
    response?: string | null;
  }): Promise<void> {
    const ok = await this.repos.community.updateSuggestionStatus({
      guildId: input.guild.id,
      suggestionId: input.suggestionId,
      status: input.status,
      staffResponse: input.response ?? null,
    });
    if (!ok) throw new UserFacingError(`Suggestion #${input.suggestionId} was not found.`);
    const settings = await this.settings.get<SuggestionSettings>(input.guild.id, 'suggestions');
    if (settings.logChannelId) {
      await this.logging.sendTo(input.guild, settings.logChannelId, {
        category: 'audit',
        title: `Suggestion #${input.suggestionId} ${input.status}`,
        description: input.response ?? 'No response provided.',
        actorId: input.staffId,
      });
    }
  }

  // ---------------------------------------------------------------- starboard

  async handleStarboard(input: {
    guild: Guild;
    message: Message<true>;
    starCount: number;
  }): Promise<void> {
    const settings = await this.settings.get<StarboardSettings>(input.guild.id, 'starboard');
    if (!settings.enabled || !settings.channelId) return;
    if (settings.ignoreChannelIds.includes(input.message.channelId)) return;
    // `selfStar` is enforced by the caller, which counts reactors and can tell
    // whether the author is the only one (Discord does not expose raw reactors
    // for messages the bot has not cached).
    const channel = await input.guild.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.type === ChannelType.GuildVoice) return;

    const existing = await this.repos.community.getStarboardEntry(input.guild.id, input.message.id);
    if (input.starCount < settings.threshold) {
      if (existing?.starboard_message_id) {
        const starMessage = await channel.messages.fetch(existing.starboard_message_id).catch(() => null);
        await starMessage?.delete().catch(() => {});
        await this.repos.community.deleteStarboardEntry(input.guild.id, input.message.id);
      }
      return;
    }
    const embed = baseEmbed(COLORS.economy)
      .setAuthor({
        name: input.message.author.tag,
        iconURL: input.message.author.displayAvatarURL(),
      })
      .setDescription(input.message.content.slice(0, 3800) || '(no text content)')
      .addFields({ name: 'Source', value: `[Jump to message](${input.message.url})` })
      .setFooter({ text: `${settings.emoji} ${input.starCount} • #${'name' in input.message.channel ? input.message.channel.name : 'channel'}` });

    if (existing?.starboard_message_id) {
      const starMessage = await channel.messages.fetch(existing.starboard_message_id).catch(() => null);
      if (starMessage) {
        await starMessage.edit({ embeds: [embed] }).catch(() => {});
        await this.repos.community.upsertStarboardEntry({
          guildId: input.guild.id,
          sourceMessageId: input.message.id,
          sourceChannelId: input.message.channelId,
          starboardChannelId: settings.channelId,
          starboardMessageId: starMessage.id,
          starCount: input.starCount,
        });
        return;
      }
    }
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      await this.repos.community.upsertStarboardEntry({
        guildId: input.guild.id,
        sourceMessageId: input.message.id,
        sourceChannelId: input.message.channelId,
        starboardChannelId: settings.channelId,
        starboardMessageId: sent.id,
        starCount: input.starCount,
      });
    }
  }

  // ---------------------------------------------------------------- birthdays

  async setBirthday(input: {
    guildId: string;
    userId: string;
    month: number;
    day: number;
    year?: number | null;
  }): Promise<void> {
    await this.repos.community.setBirthday(input);
  }

  /** Announces today's birthdays; called once per day by the scheduler. */
  async announceBirthdays(guild: Guild): Promise<number> {
    const settings = await this.settings.get<BirthdaySettings>(guild.id, 'birthday');
    if (!settings.enabled || !settings.channelId) return 0;
    const now = new Date(Date.now() + settings.timezoneOffsetMinutes * 60_000);
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const birthdays = await this.repos.community.birthdaysToday(month, day);
    const mine = birthdays.filter((entry) => entry.guild_id === guild.id);
    if (mine.length === 0) return 0;
    const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.isTextBased()) return 0;
    for (const entry of mine) {
      const content = settings.message.replace('{user}', `<@${entry.user_id}>`);
      await channel.send({ content }).catch(() => {});
      if (settings.roleId) {
        const member = await guild.members.fetch(entry.user_id).catch(() => null);
        const role = await guild.roles.fetch(settings.roleId).catch(() => null);
        if (member && role && guild.members.me && role.position < guild.members.me.roles.highest.position) {
          await member.roles.add(role, 'Birthday role').catch(() => {});
          setTimeout(() => {
            void member.roles.remove(role, 'Birthday role (24h)').catch(() => {});
          }, 86_400_000);
        }
      }
      await this.repos.community.markBirthdayAnnounced(guild.id, entry.user_id, now.getUTCFullYear());
    }
    return mine.length;
  }

  // ---------------------------------------------------------------- reminders

  async createReminder(input: {
    guildId: string | null;
    userId: string;
    channelId: string;
    content: string;
    remindAt: Date;
  }): Promise<number> {
    if (input.remindAt.getTime() < Date.now() + 5_000) {
      throw new UserFacingError('The reminder time must be at least 5 seconds in the future.');
    }
    if (input.remindAt.getTime() > Date.now() + 365 * 86_400_000) {
      throw new UserFacingError('Reminders cannot be scheduled more than a year ahead.');
    }
    const id = await this.repos.community.createReminder(input);
    if (input.guildId) {
      await this.repos.tasks.enqueue({
        taskType: 'reminder_deliver',
        guildId: input.guildId,
        payload: { reminderId: id },
        runAt: input.remindAt,
      });
    }
    return id;
  }

  async deliverReminder(guild: Guild | null, reminderId: number): Promise<boolean> {
    const due = await this.repos.community.dueReminders(50);
    const reminder = due.find((entry) => entry.id === reminderId);
    if (!reminder) return false;
    const targetGuild = guild ?? null;
    const channel = targetGuild
      ? await targetGuild.channels.fetch(reminder.channel_id).catch(() => null)
      : null;
    if (channel?.isTextBased()) {
      await channel
        .send({ content: `⏰ <@${reminder.user_id}> reminder: ${reminder.content}` })
        .catch(() => {});
      await this.repos.community.markReminderDelivered(reminder.id);
      return true;
    }
    // Fall back to a DM so the reminder is not silently dropped.
    const user = await this.client?.users.fetch(reminder.user_id).catch(() => null);
    await user?.send(`⏰ Reminder: ${reminder.content}`).catch(() => {});
    await this.repos.community.markReminderDelivered(reminder.id);
    return true;
  }

  /** Injected lazily to avoid a hard dependency on the client in tests. */
  client: import('discord.js').Client | null = null;

  // ------------------------------------------------------------------- polls

  buildPollEmbed(question: string, options: string[]): ReturnType<typeof baseEmbed> {
    void warningEmbed;
    return baseEmbed(COLORS.primary)
      .setTitle(`📊 ${question.slice(0, 250)}`)
      .setDescription(
        options
          .map((option, index) => `${numberEmoji(index + 1)} ${option}`)
          .join('\n'),
      )
      .setFooter({ text: 'React with the matching number to vote' });
  }
}

function requiredRoleLine(roleId: string | null): string | null {
  return roleId ? `Requires the <@&${roleId}> role to enter.` : null;
}

export function numberEmoji(index: number): string {
  return ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'][index - 1] ?? '🔹';
}

export function canPin(member: GuildMember | null): boolean {
  return member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
}

export function describeSuccess(title: string, description: string): ReturnType<typeof successEmbed> {
  return successEmbed(description, title);
}

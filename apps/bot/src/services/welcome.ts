import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import type { Logger } from '@bot-by-ai/shared';
import { accountAgeDays, renderTemplate } from '@bot-by-ai/shared';
import type { GuildSettingsService } from './settings.js';
import type { LoggingService } from './logging.js';
import type { LeaveSettings, WelcomeSettings } from './types.js';
import { baseEmbed } from '../core/embeds.js';

/**
 * Welcome / leave / autorole / verification.
 *
 * Welcome "images" are rendered as an SVG attachment built from text — this
 * avoids pulling a canvas/native dependency while still producing an image card.
 */
export class WelcomeService {
  constructor(
    private readonly settings: GuildSettingsService,
    private readonly logging: LoggingService,
    private readonly logger: Logger,
  ) {}

  async getWelcomeSettings(guildId: string): Promise<WelcomeSettings> {
    return this.settings.get<WelcomeSettings>(guildId, 'welcome');
  }

  async getLeaveSettings(guildId: string): Promise<LeaveSettings> {
    return this.settings.get<LeaveSettings>(guildId, 'leave');
  }

  /** Renders a template exactly like a real welcome message would. */
  preview(guild: Guild, member: GuildMember, template: string): { plain: string } {
    const context = this.buildContext(guild, member);
    return { plain: renderTemplate(template, context).output };
  }

  /**
   * `options.test` is used by `/welcome test`: it sends the message even when
   * the module is disabled and skips auto-roles / audit logging.
   */
  async handleJoin(
    guild: Guild,
    member: GuildMember,
    options: { test?: boolean } = {},
  ): Promise<void> {
    const settings = await this.getWelcomeSettings(guild.id);
    if (!settings.enabled && !options.test) return;
    const accountAge = accountAgeDays(member.id);

    if (
      !options.test &&
      settings.autoRoleIds.length > 0 &&
      accountAge >= settings.minAccountAgeDays &&
      guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)
    ) {
      for (const roleId of settings.autoRoleIds) {
        const role =
          guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
        const me = guild.members.me;
        if (role && me && role.position < me.roles.highest.position) {
          await member.roles.add(role, 'Automatic role on join').catch((error) =>
            this.logger.warn('autorole failed', {
              guildId: guild.id,
              roleId,
              userId: member.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }

    const context = this.buildContext(guild, member, accountAge);

    if (settings.channelId) {
      const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
      if (channel && channel.isTextBased() && channel.type !== ChannelType.GuildVoice) {
        const text = renderTemplate(settings.message, context).output;
        const embed = baseEmbed(settings.embedColor)
          .setTitle(settings.title ?? null)
          .setDescription(text)
          .setAuthor({
            name: `Welcome to ${guild.name}`,
            iconURL: member.displayAvatarURL({ size: 256 }),
          })
          .setThumbnail(settings.thumbnail ? member.displayAvatarURL({ size: 128 }) : null)
          .addFields(
            { name: 'Account age', value: `${accountAge.toFixed(1)} days`, inline: true },
            { name: 'Member count', value: String(guild.memberCount), inline: true },
          );
        if (settings.imageUrl) embed.setImage(settings.imageUrl);
        else embed.setImage('attachment://welcome.svg');
        const files = settings.imageUrl ? undefined : [this.buildWelcomeCard(guild, member)];
        await (channel as TextChannel)
          .send({
            content: settings.useEmbed ? `<@${member.id}>` : text,
            embeds: settings.useEmbed ? [embed] : [],
            ...(files ? { files } : {}),
          })
          .catch((error) =>
            this.logger.warn('welcome message failed', {
              guildId: guild.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    }

    if (settings.dmEnabled && settings.dmMessage) {
      await member
        .send(renderTemplate(settings.dmMessage, context).output.slice(0, 1900))
        .catch(() => {});
    }

    if (options.test) return;

    await this.logging
      .log(guild, {
        category: 'members',
        title: 'Member joined',
        description: `<@${member.id}> joined. Account created ${accountAge.toFixed(1)} days ago.`,
        actorId: member.id,
        auditAction: 'members.join',
      })
      .catch(() => {});
  }

  async handleLeave(
    guild: Guild,
    member: GuildMember,
    options: { test?: boolean } = {},
  ): Promise<void> {
    const settings = await this.getLeaveSettings(guild.id);
    if (!options.test) {
      await this.logging
        .log(guild, {
          category: 'members',
          title: 'Member left',
          description: `**${member.user.tag}** (\`${member.id}\`) left the server.`,
          actorId: member.id,
          auditAction: 'members.leave',
        })
        .catch(() => {});
    }
    if ((!settings.enabled && !options.test) || !settings.channelId) return;
    const channel = await guild.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const text = renderTemplate(settings.message, {
      user: {
        id: member.id,
        username: member.user.username,
        tag: member.user.tag,
        mention: `<@${member.id}>`,
      },
      server: { name: guild.name, id: guild.id, memberCount: guild.memberCount },
    }).output;
    await channel
      .send({
        content: settings.useEmbed ? undefined : text,
        embeds: settings.useEmbed ? [baseEmbed(settings.embedColor).setDescription(text)] : [],
      })
      .catch(() => {});
  }

  /**
   * Builds a lightweight SVG welcome card (no native canvas dependency).
   * Returned as a file attachment so it works on every host.
   */
  buildWelcomeCard(guild: Guild, member: GuildMember): AttachmentBuilder {
    const displayName = escapeXml(member.displayName.slice(0, 24));
    const guildName = escapeXml(guild.name.slice(0, 32));
    const count = guild.memberCount;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="240" viewBox="0 0 800 240">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e1f22"/>
      <stop offset="100%" stop-color="#5865f2"/>
    </linearGradient>
  </defs>
  <rect width="800" height="240" fill="url(#bg)" rx="16"/>
  <text x="40" y="90" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="42" fill="#ffffff">Welcome, ${displayName}!</text>
  <text x="40" y="140" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="24" fill="#dbdee1">You are member #${count} of ${guildName}</text>
  <text x="40" y="190" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="18" fill="#b5bac1">ID: ${member.id}</text>
</svg>`;
    return new AttachmentBuilder(Buffer.from(svg, 'utf8'), { name: 'welcome.svg' });
  }

  /** Grants one role at a time, reporting whether it actually happened. */
  async grantRoleToMember(
    guild: Guild,
    member: GuildMember,
    roleId: string,
    reason: string,
  ): Promise<boolean> {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
    const role =
      guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (!role || role.position >= me.roles.highest.position) return false;
    if (member.roles.cache.has(role.id)) return true;
    return member.roles
      .add(role, reason)
      .then(() => true)
      .catch(() => false);
  }

  /** Backfills a role to every member that is missing it. Returns the count granted. */
  async grantRoleToEveryone(guild: Guild, roleId: string): Promise<number> {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return 0;
    const role =
      guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (!role || role.position >= me.roles.highest.position) return 0;
    await guild.members.fetch();
    let granted = 0;
    for (const member of guild.members.cache.values()) {
      if (member.user.bot || member.roles.cache.has(role.id)) continue;
      const ok = await member.roles
        .add(role, 'Autorole backfill')
        .then(() => true)
        .catch(() => false);
      if (ok) granted += 1;
    }
    return granted;
  }

  private buildContext(guild: Guild, member: GuildMember, accountAge?: number) {
    const age = accountAge ?? accountAgeDays(member.id);
    return {
      user: {
        id: member.id,
        username: member.user.username,
        tag: member.user.tag,
        mention: `<@${member.id}>`,
      },
      server: { name: guild.name, id: guild.id, memberCount: guild.memberCount },
      extras: { accountage: age.toFixed(1), joinedAt: new Date().toISOString().slice(0, 10) },
    };
  }

  /** Verification: grants the configured role after the user clicks the button. */
  async grantVerificationRole(
    guild: Guild,
    member: GuildMember,
    roleIds: string[],
  ): Promise<number> {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return 0;
    let granted = 0;
    for (const roleId of roleIds) {
      const role =
        guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
      if (role && role.position < me.roles.highest.position && !member.roles.cache.has(role.id)) {
        const ok = await member.roles
          .add(role, 'Verification completed')
          .then(() => true)
          .catch(() => false);
        if (ok) granted += 1;
      }
    }
    return granted;
  }
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

import {
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type Role,
  type TextChannel,
} from 'discord.js';
import { formatDuration, formatNumber, formatTimestamp, parseDurationMs, truncate, UserFacingError } from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { confirmAction, sendPaginated } from '../core/ui.js';
import { resolveTarget } from '../core/resolvers.js';
import type { ModerationRequest } from '../services/moderation.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function actorFrom(interaction: ChatInputCommandInteraction): GuildMember {
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember)) throw new UserFacingError('Use this inside a server.');
  return member;
}

/** Resolves guild/actor/target/reason once and returns a ModerationRequest. */
async function buildRequest(interaction: ChatInputCommandInteraction, withReason = true) {
  const guild = guildOf(interaction);
  const actor = actorFrom(interaction);
  const target = await resolveTarget(interaction, 'user');
  const reason = withReason ? interaction.options.getString('reason') ?? undefined : undefined;
  const request: ModerationRequest = {
    guild,
    actor,
    targetMember: target.member,
    targetUser: target.user,
    reason: reason ?? null,
    source: 'command',
  };
  return { guild, actor, target, reason, request };
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member (optionally deleting recent messages)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member to ban').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason recorded in the case'))
      .addIntegerOption((option) => option.setName('delete_days').setDescription('Delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7))
      .addStringOption((option) => option.setName('duration').setDescription('Temporary ban, e.g. 7d (recorded for scheduled review)')),
    async execute({ interaction, services }: CommandContext) {
      const { request, target, reason } = await buildRequest(interaction);
      const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
      const durationMs = parseDurationMs(interaction.options.getString('duration') ?? '') ?? null;
      await interaction.deferReply();
      const result = await services.moderation.ban({ ...request, deleteMessageSeconds: deleteDays * 86_400, durationMs });
      await interaction.editReply({
        embeds: [
          successEmbed(
            [
              `Banned **${target.user.tag}** — case #${result.caseNumber}.`,
              deleteDays > 0 ? `Deleted their messages from the last ${deleteDays} day(s).` : null,
              durationMs ? `Temporary ban recorded for ${formatDuration(durationMs)}.` : null,
              reason ? `Reason: ${truncate(reason, 500)}` : null,
              result.dmDelivered ? 'The member was notified by DM.' : null,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Unban a user by id')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((option) => option.setName('reason').setDescription('Reason'))
      .addStringOption((option) => option.setName('user').setDescription('User id or mention').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const actor = actorFrom(interaction);
      const input = interaction.options.getString('user', true);
      const id = input.match(/\d{17,20}/)?.[0];
      if (!id) throw new UserFacingError('Provide a user id or mention.');
      const banned = await guild.bans.fetch(id).catch(() => null);
      if (!banned) throw new UserFacingError('That user is not banned.');
      await interaction.deferReply();
      const result = await services.moderation.unban({
        guild,
        actor,
        targetUser: banned.user,
        reason: interaction.options.getString('reason') ?? null,
        source: 'command',
      });
      await interaction.editReply({ embeds: [successEmbed(`Unbanned **${banned.user.tag}** — case #${result.caseNumber}.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member to kick').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason recorded in the case')),
    async execute({ interaction, services }: CommandContext) {
      const { request, target } = await buildRequest(interaction);
      await interaction.deferReply();
      const result = await services.moderation.kick(request);
      await interaction.editReply({ embeds: [successEmbed(`Kicked **${target.user.tag}** — case #${result.caseNumber}.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Time out a member (Discord maximum: 28 days)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('duration').setDescription('e.g. 10m, 2h, 7d').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason')),
    async execute({ interaction, services }: CommandContext) {
      const { request, target } = await buildRequest(interaction);
      const durationMs = parseDurationMs(interaction.options.getString('duration', true));
      if (!durationMs) throw new UserFacingError('Could not parse that duration — try `10m`, `2h` or `7d`.');
      await interaction.deferReply();
      const result = await services.moderation.timeout({ ...request, durationMs });
      await interaction.editReply({
        embeds: [successEmbed(`Timed out **${target.user.tag}** for ${formatDuration(durationMs)} — case #${result.caseNumber}.`)],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('Remove a member timeout')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason')),
    async execute({ interaction, services }: CommandContext) {
      const { request, target } = await buildRequest(interaction);
      await interaction.deferReply();
      const result = await services.moderation.removeTimeout(request);
      await interaction.editReply({ embeds: [successEmbed(`Timeout removed from **${target.user.tag}** — case #${result.caseNumber}.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member (may trigger escalation)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      const { request, target } = await buildRequest(interaction);
      await interaction.deferReply();
      const result = await services.moderation.warn(request);
      await interaction.editReply({
        embeds: [
          successEmbed(
            [
              `Warned **${target.user.tag}** — case #${result.caseNumber}.`,
              `Active warnings: **${result.warningCount}**.`,
              result.escalation ? `Escalation applied: **${result.escalation}**.` : 'No escalation threshold reached.',
            ].join('\n'),
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('List a member’s active warnings')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const user = interaction.options.getUser('user', true);
      const warnings = await services.repos.moderation.getActiveWarnings(guild.id, user.id);
      await interaction.reply({
        embeds: [
          baseEmbed(warnings.length > 0 ? COLORS.warning : COLORS.success)
            .setTitle(`⚠️ Warnings for ${user.tag}`)
            .setDescription(
              warnings.length === 0
                ? 'No active warnings.'
                : warnings
                    .map(
                      (warning) =>
                        `\`#${warning.id}\` — ${truncate(warning.reason, 200)}\nby <@${warning.moderator_id}> • ${formatTimestamp(new Date(warning.created_at).getTime())}`,
                    )
                    .join('\n\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('unwarn')
      .setDescription('Remove a single warning by id')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addIntegerOption((option) => option.setName('id').setDescription('Warning id (see /warnings)').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Why is it being removed?')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const id = interaction.options.getInteger('id', true);
      const removed = await services.repos.moderation.clearWarning(guild.id, id);
      if (removed) {
        await services.repos.audit.log({
          guildId: guild.id,
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'moderation.unwarn',
          targetType: 'warning',
          targetId: String(id),
          metadata: { reason: interaction.options.getString('reason') ?? null },
        });
      }
      await interaction.reply({
        embeds: [removed ? successEmbed(`Warning \`#${id}\` removed.`) : warningEmbed(`No active warning with id \`${id}\`.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('clearwarnings')
      .setDescription('Remove every active warning for a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const user = interaction.options.getUser('user', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const confirmed = await confirmAction(interaction, {
        title: 'Clear all warnings',
        description: `Remove every active warning for <@${user.id}>? The action is written to the audit log.`,
        confirmLabel: 'Clear warnings',
      });
      if (!confirmed) {
        await interaction.editReply({ embeds: [warningEmbed('Cancelled.')], components: [] });
        return;
      }
      const count = await services.repos.moderation.clearAllWarnings(guild.id, user.id);
      await services.repos.audit.log({
        guildId: guild.id,
        actorId: interaction.user.id,
        actorType: 'user',
        action: 'moderation.clear_warnings',
        targetType: 'user',
        targetId: user.id,
        metadata: { count },
      });
      await interaction.editReply({ embeds: [successEmbed(`Cleared ${count} warning(s) for <@${user.id}>.`)], components: [] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Bulk delete messages in this channel (last 14 days)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((option) => option.setName('count').setDescription('How many messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((option) => option.setName('user').setDescription('Only this member’s messages'))
      .addStringOption((option) => option.setName('contains').setDescription('Only messages containing this text'))
      .addBooleanOption((option) => option.setName('bots').setDescription('Only bot messages')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased() || channel.isDMBased() || !('bulkDelete' in channel)) {
        throw new UserFacingError('I can only purge messages in a server text channel.');
      }
      const count = interaction.options.getInteger('count', true);
      const user = interaction.options.getUser('user');
      const contains = interaction.options.getString('contains')?.toLowerCase();
      const botsOnly = interaction.options.getBoolean('bots') ?? false;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const fetched = await (channel as TextChannel).messages.fetch({ limit: 100 });
      const cutoff = Date.now() - 13.5 * 86_400_000;
      const candidates = [...fetched.values()]
        .filter((message) => message.createdTimestamp > cutoff)
        .filter((message) => (user ? message.author.id === user.id : true))
        .filter((message) => (contains ? message.content.toLowerCase().includes(contains) : true))
        .filter((message) => (botsOnly ? message.author.bot : true))
        .slice(0, count);
      if (candidates.length === 0) {
        throw new UserFacingError('No messages matched (Discord only bulk-deletes messages younger than 14 days).');
      }
      const deleted = await (channel as TextChannel).bulkDelete(candidates, true);
      await services.logging
        .log(guild, {
          category: 'messages',
          title: 'Messages purged',
          description: `<@${interaction.user.id}> purged ${deleted.size} message(s) in <#${channel.id}>.${user ? ` Filter: <@${user.id}>.` : ''}${contains ? ` Text: \`${truncate(contains, 50)}\`.` : ''}`,
          actorId: interaction.user.id,
          auditAction: 'messages.purge',
        })
        .catch(() => {});
      await interaction.editReply({ embeds: [successEmbed(`Deleted ${deleted.size} message(s).`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set the slowmode for a channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addStringOption((option) => option.setName('duration').setDescription('e.g. 5s, 1m, off').setRequired(true))
      .addChannelOption((option) => option.setName('channel').setDescription('Channel (defaults to here)')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actorFrom(interaction);
      const raw = interaction.options.getString('duration', true).toLowerCase();
      const seconds = raw === 'off' || raw === '0' ? 0 : Math.round((parseDurationMs(raw) ?? 0) / 1000);
      if (raw !== 'off' && seconds <= 0) throw new UserFacingError('Use `off`, `5s`, `1m` … Discord allows 0-21600 seconds.');
      if (seconds > 21_600) throw new UserFacingError('Discord allows at most 6 hours (21600 seconds) of slowmode per channel.');
      const result = await services.moderation.setSlowmode(guild, interaction.options.getChannel('channel')?.id ?? interaction.channelId, seconds, member);
      await interaction.reply({
        embeds: [successEmbed(result.seconds > 0 ? `Slowmode in **${result.channelName}** set to ${result.seconds}s.` : `Slowmode disabled in **${result.channelName}**.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('lock')
      .setDescription('Lock a channel for @everyone')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption((option) => option.setName('channel').setDescription('Channel (defaults to here)'))
      .addStringOption((option) => option.setName('reason').setDescription('Reason shown in the audit log')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actorFrom(interaction);
      await interaction.deferReply();
      const result = await services.moderation.lockChannel(
        guild,
        interaction.options.getChannel('channel')?.id ?? interaction.channelId,
        member,
        interaction.options.getString('reason') ?? 'No reason provided',
      );
      await interaction.editReply({ embeds: [successEmbed(`🔒 **${result.channelName}** is locked. Use \`/unlock\` to reopen it.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('unlock')
      .setDescription('Unlock a locked channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption((option) => option.setName('channel').setDescription('Channel (defaults to here)'))
      .addStringOption((option) => option.setName('reason').setDescription('Reason shown in the audit log')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actorFrom(interaction);
      await interaction.deferReply();
      const result = await services.moderation.unlockChannel(
        guild,
        interaction.options.getChannel('channel')?.id ?? interaction.channelId,
        member,
        interaction.options.getString('reason') ?? 'No reason provided',
      );
      await interaction.editReply({ embeds: [successEmbed(`🔓 **${result.channelName}** is unlocked.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('nickname')
      .setDescription('Change or reset a member nickname')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
      .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('nickname').setDescription('New nickname (omit to reset)').setMaxLength(32)),
    async execute({ interaction, services }: CommandContext) {
      const { request, target } = await buildRequest(interaction, false);
      const nickname = interaction.options.getString('nickname') ?? null;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await services.moderation.setNickname({ ...request, nickname });
      await interaction.editReply({
        embeds: [
          successEmbed(
            nickname
              ? `Nickname of **${target.user.tag}** set to \`${truncate(nickname, 32)}\` (case #${result.caseNumber}).`
              : `Nickname of **${target.user.tag}** reset (case #${result.caseNumber}).`,
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('role')
      .setDescription('Give, remove, create or delete roles')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a role to a member')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('Reason')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a role from a member')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('Reason')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a role')
          .addStringOption((option) => option.setName('name').setDescription('Role name').setRequired(true).setMaxLength(100))
          .addStringOption((option) => option.setName('color').setDescription('Hex colour like #5865f2'))
          .addBooleanOption((option) => option.setName('hoist').setDescription('Show separately in the member list'))
          .addBooleanOption((option) => option.setName('mentionable').setDescription('Allow anyone to mention it')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a role')
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('Reason')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('all')
          .setDescription('Give everyone a role')
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addBooleanOption((option) => option.setName('bots').setDescription('Include bots')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('info')
          .setDescription('List members that have a role')
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actorFrom(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'add' || sub === 'remove') {
        const { request, target } = await buildRequest(interaction);
        const role = interaction.options.getRole('role', true) as Role;
        await interaction.deferReply();
        const result =
          sub === 'add'
            ? await services.moderation.addRole({ ...request, roleId: role.id })
            : await services.moderation.removeRole({ ...request, roleId: role.id });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `${sub === 'add' ? 'Added' : 'Removed'} <@&${role.id}> ${sub === 'add' ? 'to' : 'from'} <@${target.id}> — case #${result.caseNumber}.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'create') {
        const color = interaction.options.getString('color');
        const role = await guild.roles.create({
          name: interaction.options.getString('name', true),
          color: color && /^#?[0-9a-fA-F]{6}$/.test(color) ? Number.parseInt(color.replace('#', ''), 16) : undefined,
          hoist: interaction.options.getBoolean('hoist') ?? false,
          mentionable: interaction.options.getBoolean('mentionable') ?? false,
          reason: `Created by ${member.user.tag} via /role create`,
        });
        await interaction.reply({ embeds: [successEmbed(`Created <@&${role.id}>.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'delete') {
        const role = interaction.options.getRole('role', true) as Role;
        const me = guild.members.me;
        if (!me || role.position >= me.roles.highest.position) throw new UserFacingError('That role is above my highest role.');
        await interaction.deferReply();
        const confirmed = await confirmAction(interaction, {
          title: 'Delete role',
          description: `Delete <@&${role.id}> (${role.members.size} member(s))? Nothing can undo this.`,
          confirmLabel: 'Delete role',
        });
        if (!confirmed) {
          await interaction.editReply({ embeds: [warningEmbed('Cancelled.')], components: [] });
          return;
        }
        const name = role.name;
        const count = role.members.size;
        await role.delete(interaction.options.getString('reason') ?? `Deleted by ${member.user.tag}`);
        await services.repos.audit.log({
          guildId: guild.id,
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'role.delete',
          targetType: 'role',
          targetId: role.id,
          metadata: { name, members: count },
        });
        await interaction.editReply({ embeds: [successEmbed(`Deleted role **${name}**.`)], components: [] });
        return;
      }

      if (sub === 'all') {
        const role = interaction.options.getRole('role', true) as Role;
        const includeBots = interaction.options.getBoolean('bots') ?? false;
        const me = guild.members.me;
        if (!me || role.position >= me.roles.highest.position) throw new UserFacingError('That role is above my highest role.');
        await interaction.deferReply();
        const confirmed = await confirmAction(interaction, {
          title: 'Give everyone a role',
          description: `Add <@&${role.id}> to every member${includeBots ? ' (including bots)' : ''}. This can take a while.`,
          confirmLabel: 'Give the role to everyone',
        });
        if (!confirmed) {
          await interaction.editReply({ embeds: [warningEmbed('Cancelled.')], components: [] });
          return;
        }
        await guild.members.fetch();
        let added = 0;
        let failed = 0;
        for (const target of guild.members.cache.values()) {
          if (!includeBots && target.user.bot) continue;
          if (target.roles.cache.has(role.id)) continue;
          const ok = await target.roles.add(role, `Mass role grant by ${member.user.tag}`).then(() => true).catch(() => false);
          if (ok) added += 1;
          else failed += 1;
        }
        await interaction.editReply({
          embeds: [successEmbed(`Added <@&${role.id}> to ${added} member(s).${failed > 0 ? ` ${failed} failed (check hierarchy/permissions).` : ''}`)],
          components: [],
        });
        return;
      }

      const role = interaction.options.getRole('role', true) as Role;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await sendPaginated(
        interaction,
        [...role.members.values()],
        (target) => `<@${target.id}> — ${truncate(target.user.tag, 60)}`,
        { title: `🎭 Members with ${role.name} (${role.members.size})`, pageSize: 25, emptyMessage: 'Nobody has that role.' },
      );
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('case')
      .setDescription('Inspect, revoke and analyse moderation cases')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('Show one case')
          .addIntegerOption((option) => option.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List recent cases')
          .addUserOption((option) => option.setName('user').setDescription('Filter by member'))
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Filter by action')
              .addChoices(
                { name: 'ban', value: 'ban' },
                { name: 'kick', value: 'kick' },
                { name: 'timeout', value: 'timeout' },
                { name: 'warn', value: 'warn' },
                { name: 'note', value: 'note' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('revoke')
          .setDescription('Revoke a case (lifts bans/timeouts where possible)')
          .addIntegerOption((option) => option.setName('number').setDescription('Case number').setRequired(true).setMinValue(1))
          .addStringOption((option) => option.setName('reason').setDescription('Why is it revoked?')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('stats')
          .setDescription('Show moderation statistics')
          .addIntegerOption((option) => option.setName('days').setDescription('Window in days (default 30)').setMinValue(1).setMaxValue(365)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'view') {
        const number = interaction.options.getInteger('number', true);
        const record = await services.repos.moderation.getCase(guild.id, number);
        if (!record) throw new UserFacingError(`Case #${number} does not exist in this server.`);
        await interaction.reply({
          embeds: [
            baseEmbed(record.status === 'revoked' ? COLORS.warning : COLORS.primary)
              .setTitle(`📁 Case #${record.case_number} — ${record.action}`)
              .setDescription(truncate(record.reason ?? 'No reason recorded.', 1000))
              .addFields(
                { name: 'Member', value: `<@${record.user_id}>`, inline: true },
                { name: 'Moderator', value: `<@${record.moderator_id}>`, inline: true },
                { name: 'Created', value: formatTimestamp(new Date(record.created_at).getTime()), inline: true },
                { name: 'Expires', value: record.expires_at ? formatTimestamp(new Date(record.expires_at).getTime()) : 'never', inline: true },
                { name: 'Status', value: record.status, inline: true },
                { name: 'Source', value: record.source, inline: true },
                { name: 'Appeal', value: record.appeal_status || 'none', inline: true },
                { name: 'Revoked by', value: record.revoked_by ? `<@${record.revoked_by}>` : '—', inline: true },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'list') {
        const user = interaction.options.getUser('user');
        const action = interaction.options.getString('action');
        const result = await services.repos.moderation.listCases(guild.id, {
          userId: user?.id,
          action: action ?? undefined,
          limit: 100,
        });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await sendPaginated(
          interaction,
          result.rows,
          (record) =>
            `**#${record.case_number}** \`${record.action}\` <@${record.user_id}> — ${truncate(record.reason ?? '', 120)}\nby <@${record.moderator_id}> • ${formatTimestamp(new Date(record.created_at).getTime())}${record.status === 'revoked' ? ' • **revoked**' : ''}`,
          { title: `📁 Cases (${result.rows.length} of ${result.total})`, pageSize: 8, emptyMessage: 'No cases recorded yet.' },
        );
        return;
      }

      if (sub === 'revoke') {
        const number = interaction.options.getInteger('number', true);
        const record = await services.repos.moderation.getCase(guild.id, number);
        if (!record) throw new UserFacingError(`Case #${number} does not exist in this server.`);
        const revoked = await services.repos.moderation.revokeCase(
          guild.id,
          number,
          interaction.user.id,
          interaction.options.getString('reason') ?? undefined,
        );
        if (!revoked) throw new UserFacingError(`Case #${number} is already revoked (or was not found).`);
        let note = '';
        if (record.action === 'ban') {
          const unbanned = await guild.bans.remove(record.user_id, `Case #${number} revoked by ${interaction.user.tag}`).then(() => true).catch(() => false);
          note = unbanned ? ' The ban was lifted.' : ' I could not lift the ban — check my permissions.';
        } else if (record.action === 'timeout') {
          const target = await guild.members.fetch(record.user_id).catch(() => null);
          if (target) {
            await services.moderation
              .removeTimeout({ guild, actor: actorFrom(interaction), targetMember: target, targetUser: target.user, reason: `Case #${number} revoked`, source: 'command' })
              .catch(() => {});
            note = ' The timeout was removed.';
          }
        }
        await services.repos.audit.log({
          guildId: guild.id,
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'moderation.case_revoke',
          targetType: 'case',
          targetId: String(number),
          metadata: { action: record.action },
        });
        await interaction.reply({ embeds: [successEmbed(`Case #${number} revoked.${note}`)], flags: MessageFlags.Ephemeral });
        return;
      }

      const days = interaction.options.getInteger('days') ?? 30;
      const stats = await services.repos.analytics.moderationByAction(guild.id, days);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle(`📊 Moderation statistics (last ${days} days)`)
            .setDescription(stats.length === 0 ? 'No moderation actions in that window.' : stats.map((row) => `\`${row.action}\` — ${formatNumber(row.count)}`).join('\n')),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('note')
      .setDescription('Add an internal note to a member’s case history')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('text').setDescription('Note text').setRequired(true).setMaxLength(1000)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const user = interaction.options.getUser('user', true);
      const record = await services.repos.moderation.createCase({
        guildId: guild.id,
        userId: user.id,
        moderatorId: interaction.user.id,
        action: 'note',
        reason: interaction.options.getString('text', true),
        source: 'command',
      });
      await interaction.reply({
        embeds: [successEmbed(`Note stored as case #${record.case_number} for <@${user.id}>.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('appeal')
      .setDescription('Appeal a moderation action, or review appeals as staff')
      .addSubcommand((sub) =>
        sub
          .setName('submit')
          .setDescription('Appeal one of your own cases')
          .addIntegerOption((option) => option.setName('case').setDescription('Case number').setRequired(true).setMinValue(1))
          .addStringOption((option) => option.setName('message').setDescription('Why should this be reviewed?').setRequired(true).setMaxLength(1500)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List appeals (staff)')
          .addStringOption((option) =>
            option
              .setName('status')
              .setDescription('Filter by status')
              .addChoices({ name: 'pending', value: 'pending' }, { name: 'approved', value: 'approved' }, { name: 'denied', value: 'denied' }),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('review')
          .setDescription('Approve or deny an appeal (staff)')
          .addIntegerOption((option) => option.setName('appeal').setDescription('Appeal id').setRequired(true).setMinValue(1))
          .addStringOption((option) =>
            option
              .setName('decision')
              .setDescription('Decision')
              .setRequired(true)
              .addChoices({ name: 'approve', value: 'approved' }, { name: 'deny', value: 'denied' }),
          )
          .addStringOption((option) => option.setName('note').setDescription('Note sent to the member').setMaxLength(500)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actorFrom(interaction);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'submit') {
        const caseNumber = interaction.options.getInteger('case', true);
        const record = await services.repos.moderation.getCase(guild.id, caseNumber);
        if (!record) throw new UserFacingError(`Case #${caseNumber} does not exist.`);
        if (record.user_id !== interaction.user.id) throw new UserFacingError('You can only appeal your own cases.');
        if (record.appeal_status && record.appeal_status !== 'none') throw new UserFacingError('That case already has an appeal on record.');
        const appealId = await services.repos.moderation.createAppeal({
          guildId: guild.id,
          caseId: record.id,
          userId: interaction.user.id,
          message: interaction.options.getString('message', true),
        });
        const settings = await services.settings.get<{ appealInstructions?: string | null }>(guild.id, 'moderation');
        await interaction.reply({
          embeds: [
            successEmbed(
              `Appeal \`#${appealId}\` for case #${caseNumber} submitted. Staff will review it and you will be notified by DM.${settings.appealInstructions ? `\n\n${truncate(settings.appealInstructions, 500)}` : ''}`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'list') {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) throw new UserFacingError('Only moderators can list appeals.');
        const status = interaction.options.getString('status') ?? 'pending';
        const appeals = await services.repos.moderation.listAppeals(guild.id, status, 50);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await sendPaginated(
          interaction,
          appeals,
          (appeal) =>
            `\`#${appeal.id}\` case **#${appeal.case_number}** by <@${appeal.user_id}> — ${truncate(appeal.message, 200)}\n<t:${Math.floor(new Date(appeal.created_at).getTime() / 1000)}:R>`,
          { title: `📨 Appeals (${status})`, pageSize: 6, emptyMessage: `No ${status} appeals.` },
        );
        return;
      }

      if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) throw new UserFacingError('Only moderators can review appeals.');
      const appealId = interaction.options.getInteger('appeal', true);
      const decision = interaction.options.getString('decision', true) as 'approved' | 'denied';
      const note = interaction.options.getString('note');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reviewed = await services.repos.moderation.reviewAppeal({
        guildId: guild.id,
        appealId,
        reviewerId: interaction.user.id,
        decision,
        note: note ?? undefined,
      });
      if (!reviewed) throw new UserFacingError(`Appeal \`#${appealId}\` was not found or has already been reviewed.`);
      if (decision === 'approved' && reviewed.action === 'ban') {
        await guild.bans.remove(reviewed.userId, `Appeal #${appealId} approved`).catch(() => {});
      }
      const user = await interaction.client.users.fetch(reviewed.userId).catch(() => null);
      await user
        ?.send(`Your appeal \`#${appealId}\` for **${guild.name}** was **${decision}**.${note ? `\n\nStaff note: ${note}` : ''}`)
        .catch(() => {});
      await interaction.editReply({ embeds: [successEmbed(`Appeal \`#${appealId}\` ${decision}. The member was notified by DM where possible.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('modlog')
      .setDescription('Configure the moderation log channel and policy')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the moderation log configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set the log channel')
          .addChannelOption((option) => option.setName('channel').setDescription('Log channel').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('disable').setDescription('Stop logging moderation actions'))
      .addSubcommand((sub) =>
        sub
          .setName('options')
          .setDescription('Change moderation behaviour')
          .addBooleanOption((option) => option.setName('require_reason').setDescription('Require a reason for ban/kick/timeout'))
          .addBooleanOption((option) => option.setName('dm_on_action').setDescription('DM members when they are actioned'))
          .addIntegerOption((option) => option.setName('retention_days').setDescription('Delete cases older than N days (0 = forever)').setMinValue(0).setMaxValue(3650)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<{
        logChannelId: string | null;
        requireReason: boolean;
        dmOnAction: boolean;
        caseRetentionDays: number;
        warnThresholds: { timeoutAt: number; kickAt: number; banAt: number };
      }>(guild.id, 'moderation');

      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.logChannelId ? COLORS.success : COLORS.warning)
              .setTitle('🛡️ Moderation log')
              .addFields(
                { name: 'Channel', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'disabled', inline: true },
                { name: 'Require reason', value: settings.requireReason ? 'yes' : 'no', inline: true },
                { name: 'DM on action', value: settings.dmOnAction ? 'yes' : 'no', inline: true },
                { name: 'Retention', value: settings.caseRetentionDays > 0 ? `${settings.caseRetentionDays} day(s)` : 'unlimited', inline: true },
                { name: 'Escalation', value: `timeout ${settings.warnThresholds.timeoutAt} • kick ${settings.warnThresholds.kickAt} • ban ${settings.warnThresholds.banAt}` },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        const result = await services.moderation.setLogChannel(guild.id, channel.id, interaction.user.id);
        await interaction.reply({ embeds: [successEmbed(`Moderation actions will be logged to <#${result.channelId}>.`)], flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === 'disable') {
        await services.settings.update(guild.id, 'moderation', { logChannelId: null }, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [warningEmbed('Moderation logging disabled.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const patch: Record<string, unknown> = {};
      const requireReason = interaction.options.getBoolean('require_reason');
      const dm = interaction.options.getBoolean('dm_on_action');
      const retention = interaction.options.getInteger('retention_days');
      if (requireReason !== null) patch.requireReason = requireReason;
      if (dm !== null) patch.dmOnAction = dm;
      if (retention !== null) patch.caseRetentionDays = retention;
      await services.settings.update(guild.id, 'moderation', patch, { actorId: interaction.user.id, source: 'command' });
      await interaction.reply({ embeds: [successEmbed('Moderation options updated.')], flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('escalation')
      .setDescription('Configure automatic escalation for repeated warnings')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the current escalation policy'))
      .addSubcommand((sub) =>
        sub
          .setName('thresholds')
          .setDescription('Set warning counts that trigger timeout/kick/ban (0 disables a step)')
          .addIntegerOption((option) => option.setName('timeout_at').setDescription('Timeout at N warnings').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('kick_at').setDescription('Kick at N warnings').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('ban_at').setDescription('Ban at N warnings').setMinValue(0).setMaxValue(100))
          .addStringOption((option) => option.setName('timeout_duration').setDescription('Timeout length, e.g. 10m')),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<{
        warnThresholds: { timeoutAt: number; kickAt: number; banAt: number; timeoutMs: number };
      }>(guild.id, 'moderation');
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('⚖️ Warning escalation')
              .setDescription(
                [
                  `**${settings.warnThresholds.timeoutAt || 'off'}** warnings → timeout (${formatDuration(settings.warnThresholds.timeoutMs)})`,
                  `**${settings.warnThresholds.kickAt || 'off'}** warnings → kick`,
                  `**${settings.warnThresholds.banAt || 'off'}** warnings → ban`,
                  '',
                  '`0` disables a step. Every automatic action creates its own case.',
                ].join('\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const timeoutAt = interaction.options.getInteger('timeout_at');
      const kickAt = interaction.options.getInteger('kick_at');
      const banAt = interaction.options.getInteger('ban_at');
      const duration = interaction.options.getString('timeout_duration');
      const next = {
        ...settings.warnThresholds,
        ...(timeoutAt !== null ? { timeoutAt } : {}),
        ...(kickAt !== null ? { kickAt } : {}),
        ...(banAt !== null ? { banAt } : {}),
        ...(duration ? { timeoutMs: parseDurationMs(duration) ?? settings.warnThresholds.timeoutMs } : {}),
      };
      if (next.timeoutAt > 0 && next.kickAt > 0 && next.kickAt <= next.timeoutAt) {
        throw new UserFacingError('`kick_at` must be greater than `timeout_at` (or 0 to disable one step).');
      }
      if (next.kickAt > 0 && next.banAt > 0 && next.banAt <= next.kickAt) {
        throw new UserFacingError('`ban_at` must be greater than `kick_at`.');
      }
      await services.settings.update(guild.id, 'moderation', { warnThresholds: next }, { actorId: interaction.user.id, source: 'command' });
      await interaction.reply({
        embeds: [successEmbed(`Escalation: timeout at ${next.timeoutAt}, kick at ${next.kickAt}, ban at ${next.banAt} warnings.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('bulkban')
      .setDescription('Ban several users at once (max 25)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((option) => option.setName('users').setDescription('Space or comma separated ids/mentions').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason applied to every ban'))
      .addIntegerOption((option) => option.setName('delete_days').setDescription('Delete messages from the last N days (0-7)').setMinValue(0).setMaxValue(7)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actorFrom(interaction);
      const ids = [...new Set(interaction.options.getString('users', true).match(/\d{17,20}/g) ?? [])];
      if (ids.length === 0) throw new UserFacingError('No valid user ids found in that input.');
      if (ids.length > 25) throw new UserFacingError('At most 25 users per /bulkban call.');
      if (ids.includes(guild.ownerId)) throw new UserFacingError('The server owner cannot be bulk banned.');
      if (ids.includes(interaction.user.id)) throw new UserFacingError('You cannot ban yourself.');
      const reason = interaction.options.getString('reason') ?? 'Bulk ban';
      const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
      await interaction.deferReply();
      const confirmed = await confirmAction(interaction, {
        title: 'Bulk ban',
        description: `Ban ${ids.length} user(s)? Each ban creates its own case.\n\nIds: \`${truncate(ids.join(', '), 500)}\``,
        confirmLabel: `Ban ${ids.length} user(s)`,
      });
      if (!confirmed) {
        await interaction.editReply({ embeds: [warningEmbed('Cancelled.')], components: [] });
        return;
      }
      const succeeded: string[] = [];
      const failed: string[] = [];
      for (const id of ids) {
        const existing = await guild.bans.fetch(id).catch(() => null);
        if (existing) {
          failed.push(`${id} (already banned)`);
          continue;
        }
        const ok = await guild.bans
          .create(id, { reason: `${reason} — by ${member.user.tag}`, deleteMessageSeconds: deleteDays * 86_400 })
          .then(() => true)
          .catch(() => false);
        if (ok) {
          succeeded.push(id);
          await services.repos.moderation
            .createCase({ guildId: guild.id, userId: id, moderatorId: interaction.user.id, action: 'ban', reason, source: 'command' })
            .catch(() => {});
        } else {
          failed.push(`${id} (Discord rejected the ban)`);
        }
      }
      await interaction.editReply({
        embeds: [successEmbed(`Banned ${succeeded.length} user(s).${failed.length > 0 ? `\nFailed: ${truncate(failed.join(', '), 800)}` : ''}`)],
        components: [],
      });
    },
  },
]);

import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { formatDuration, parseDurationMs, truncate, UserFacingError } from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, errorEmbed, infoEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { confirmAction } from '../core/ui.js';
import { replyWithError, requireUserPermissions, resolveTarget } from '../core/resolvers.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function actorMember(interaction: ChatInputCommandInteraction): GuildMember {
  if (!interaction.member || !(interaction.member instanceof GuildMember)) {
    throw new UserFacingError('This command must be used inside a server.');
  }
  return interaction.member;
}

async function moderationContext(interaction: ChatInputCommandInteraction, services: CommandContext['services']) {
  const guild = guildOf(interaction);
  const actor = actorMember(interaction);
  const target = await resolveTarget(interaction);
  return {
    guild,
    actor,
    target,
    request: {
      guild,
      actor,
      targetMember: target.member,
      targetUser: target.user,
      botOwnerOverride: services.owners.isOwner(interaction.user.id),
    },
  };
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member or user ID')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member to ban').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason (recorded in the case)'))
      .addIntegerOption((option) =>
        option.setName('delete_messages_days').setDescription('Delete this many days of their messages (0-7)').setMinValue(0).setMaxValue(7),
      ),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.BanMembers], 'banning members');
      await interaction.deferReply();
      const { request } = await moderationContext(interaction, services);
      const result = await services.moderation.ban({
        ...request,
        reason: interaction.options.getString('reason'),
        deleteMessageSeconds: (interaction.options.getInteger('delete_messages_days') ?? 0) * 86_400,
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            `**${result.userId}** was banned (case **#${result.caseNumber}**).\nDM delivered: ${result.dmDelivered ? 'yes' : 'no'}`,
            '🔨 Banned',
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Remove a ban using the user ID')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((option) => option.setName('user_id').setDescription('Discord user ID').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason')),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.BanMembers], 'unbanning members');
      await interaction.deferReply();
      const guild = guildOf(interaction);
      const userId = interaction.options.getString('user_id', true).trim();
      if (!/^\d{17,20}$/.test(userId)) throw new UserFacingError('That is not a valid user ID.');
      const user = await interaction.client.users.fetch(userId).catch(() => null);
      if (!user) throw new UserFacingError('I could not resolve that user ID.');
      const result = await services.moderation.unban({
        guild,
        actor: actorMember(interaction),
        targetUser: user,
        reason: interaction.options.getString('reason'),
        botOwnerOverride: services.owners.isOwner(interaction.user.id),
      });
      await interaction.editReply({
        embeds: [successEmbed(`<@${userId}> was unbanned (case **#${result.caseNumber}**).`, '✅ Unbanned')],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member to kick').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason (recorded in the case)')),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.KickMembers], 'kicking members');
      await interaction.deferReply();
      const { request } = await moderationContext(interaction, services);
      const result = await services.moderation.kick({ ...request, reason: interaction.options.getString('reason') });
      await interaction.editReply({
        embeds: [
          successEmbed(`**${result.userId}** was kicked (case **#${result.caseNumber}**).`, '👋 Kicked'),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Timeout a member (max 28 days)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('duration').setDescription('e.g. 10m, 2h, 7d').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason')),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.ModerateMembers], 'timing out members');
      const duration = parseDurationMs(interaction.options.getString('duration', true));
      if (duration === null) throw new UserFacingError('Use a duration like `10m`, `2h` or `3d`.');
      if (duration < 1_000) throw new UserFacingError('Timeouts must be at least 1 second.');
      await interaction.deferReply();
      const { request } = await moderationContext(interaction, services);
      const result = await services.moderation.timeout({
        ...request,
        durationMs: duration,
        reason: interaction.options.getString('reason'),
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            `**${result.userId}** is timed out for **${formatDuration(duration)}** (case **#${result.caseNumber}**).`,
            '🔇 Timed out',
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('Remove a timeout')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason')),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.ModerateMembers], 'removing timeouts');
      await interaction.deferReply();
      const { request } = await moderationContext(interaction, services);
      const result = await services.moderation.removeTimeout({ ...request, reason: interaction.options.getString('reason') });
      await interaction.editReply({
        embeds: [successEmbed(`Timeout removed for **${result.userId}** (case **#${result.caseNumber}**).`, '🔊 Timeout removed')],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member (participates in escalation)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.ModerateMembers], 'warning members');
      await interaction.deferReply();
      const { request } = await moderationContext(interaction, services);
      const result = await services.moderation.warn({ ...request, reason: interaction.options.getString('reason', true) });
      await interaction.editReply({
        embeds: [
          successEmbed(
            [
              `**${result.userId}** was warned (case **#${result.caseNumber}**).`,
              `Active warning weight: **${result.warningCount}**`,
              result.escalation ? `Escalation applied: ${result.escalation}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            '⚠️ Warned',
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('List the active warnings of a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      const { target } = await moderationContext(interaction, services);
      const warnings = await services.repos.moderation.getActiveWarnings(guildOf(interaction).id, target.id);
      await interaction.reply({
        embeds: [
          baseEmbed(warnings.length > 0 ? COLORS.warning : COLORS.success)
            .setTitle(`Warnings for ${target.user.tag}`)
            .setDescription(
              warnings.length === 0
                ? 'No active warnings.'
                : warnings
                    .map(
                      (warning) =>
                        `**#${warning.id}** (weight ${warning.weight}) — ${truncate(warning.reason, 200)}\n<@${warning.moderator_id}> • <t:${Math.floor(warning.created_at.getTime() / 1000)}:R>`,
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
      .setDescription('Remove a specific warning by ID')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addIntegerOption((option) => option.setName('warning_id').setDescription('Warning ID from /warnings').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.ModerateMembers], 'managing warnings');
      const id = interaction.options.getInteger('warning_id', true);
      const removed = await services.repos.moderation.clearWarning(guildOf(interaction).id, id);
      await services.repos.audit
        .log({
          guildId: interaction.guildId,
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'moderation.unwarn',
          targetType: 'warning',
          targetId: String(id),
        })
        .catch(() => {});
      await interaction.reply({
        embeds: [removed ? successEmbed(`Warning #${id} cleared.`) : warningEmbed(`No active warning with ID ${id}.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('clearwarnings')
      .setDescription('Clear every active warning of a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.ModerateMembers], 'managing warnings');
      const { target, guild } = await moderationContext(interaction, services);
      await interaction.deferReply();
      const count = await services.repos.moderation.clearAllWarnings(guild.id, target.id);
      await services.logging.log(guild, {
        category: 'moderation',
        title: 'Warnings cleared',
        description: `${count} warning(s) cleared for <@${target.id}> by <@${interaction.user.id}>.`,
        actorId: interaction.user.id,
        targetId: target.id,
        auditAction: 'moderation.clear_warnings',
      });
      await interaction.editReply({
        embeds: [successEmbed(`Cleared **${count}** warning(s) for <@${target.id}>.`)],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Delete recent messages in a channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((option) =>
        option.setName('count').setDescription('How many messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100),
      )
      .addUserOption((option) => option.setName('user').setDescription('Only delete messages from this user'))
      .addStringOption((option) => option.setName('contains').setDescription('Only delete messages containing this text'))
      .addBooleanOption((option) => option.setName('bots_only').setDescription('Only delete bot messages')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const actor = actorMember(interaction);
      requireUserPermissions(actor, [PermissionFlagsBits.ManageMessages], 'purging messages');
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildVoice) {
        throw new UserFacingError('I cannot purge messages in this channel.');
      }
      const count = interaction.options.getInteger('count', true);
      const user = interaction.options.getUser('user');
      const contains = interaction.options.getString('contains')?.toLowerCase();
      const botsOnly = interaction.options.getBoolean('bots_only') ?? false;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const messages = await channel.messages.fetch({ limit: Math.min(100, count) });
      const filtered = messages.filter((message) => {
        if (message.id === interaction.id) return false;
        if (user && message.author.id !== user.id) return false;
        if (contains && !message.content.toLowerCase().includes(contains)) return false;
        if (botsOnly && !message.author.bot) return false;
        return true;
      });
      // Discord refuses bulk delete for messages older than 14 days.
      const fresh = filtered.filter((message) => Date.now() - message.createdTimestamp < 14 * 86_400_000);
      const deleted = await (channel as TextChannel).bulkDelete(fresh, true).catch(() => null);
      const deletedCount = deleted?.size ?? 0;
      await services.logging
        .log(guild, {
          category: 'moderation',
          title: 'Messages purged',
          description: `<@${interaction.user.id}> deleted ${deletedCount} message(s) in <#${channel.id}>.`,
          actorId: interaction.user.id,
          auditAction: 'moderation.purge',
          fields: [
            { name: 'Requested', value: String(count), inline: true },
            { name: 'Deleted', value: String(deletedCount), inline: true },
            { name: 'Skipped (too old)', value: String(filtered.size - fresh.size), inline: true },
          ],
        })
        .catch(() => {});
      await interaction.editReply({
        embeds: [
          successEmbed(
            `Deleted **${deletedCount}** message(s). Skipped ${filtered.size - fresh.size} message(s) older than 14 days (Discord limitation).`,
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set channel slowmode')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addIntegerOption((option) => option.setName('seconds').setDescription('0 disables slowmode (max 21600)').setRequired(true).setMinValue(0).setMaxValue(21_600))
      .addChannelOption((option) =>
        option.setName('channel').setDescription('Channel (defaults to here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const actor = actorMember(interaction);
      const seconds = interaction.options.getInteger('seconds', true);
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel) throw new UserFacingError('Channel not found.');
      const result = await services.moderation.setSlowmode(guild, channel.id, seconds, actor);
      await interaction.reply({
        embeds: [
          successEmbed(
            seconds === 0
              ? `Slowmode disabled in **#${result.channelName}**.`
              : `Slowmode set to **${formatDuration(seconds * 1000)}** in **#${result.channelName}**.`,
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('lock')
      .setDescription('Lock a channel (deny @everyone the ability to send messages)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption((option) =>
        option.setName('channel').setDescription('Channel (defaults to here)').addChannelTypes(ChannelType.GuildText),
      )
      .addStringOption((option) => option.setName('reason').setDescription('Reason')).setDescription('Lock the current channel'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const actor = actorMember(interaction);
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel) throw new UserFacingError('Channel not found.');
      const reason = interaction.options.getString('reason') ?? 'No reason provided';
      const result = await services.moderation.lockChannel(guild, channel.id, actor, reason);
      await services.logging.log(guild, {
        category: 'channels',
        title: 'Channel locked',
        description: `<#${channel.id}> locked by <@${actor.id}>: ${reason}`,
        actorId: actor.id,
        auditAction: 'channels.lock',
      });
      await interaction.reply({ embeds: [successEmbed(`🔒 Locked **#${result.channelName}**.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('unlock')
      .setDescription('Unlock a previously locked channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption((option) =>
        option.setName('channel').setDescription('Channel (defaults to here)').addChannelTypes(ChannelType.GuildText),
      )
      .addStringOption((option) => option.setName('reason').setDescription('Reason')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const actor = actorMember(interaction);
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel) throw new UserFacingError('Channel not found.');
      const result = await services.moderation.unlockChannel(
        guild,
        channel.id,
        actor,
        interaction.options.getString('reason') ?? 'No reason provided',
      );
      await services.logging.log(guild, {
        category: 'channels',
        title: 'Channel unlocked',
        description: `<#${channel.id}> unlocked by <@${actor.id}>.`,
        actorId: actor.id,
        auditAction: 'channels.unlock',
      });
      await interaction.reply({ embeds: [successEmbed(`🔓 Unlocked **#${result.channelName}**.`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('nickname')
      .setDescription('Change or reset a member nickname')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
      .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('nickname').setDescription('New nickname (leave empty to reset)'))
      .addStringOption((option) => option.setName('reason').setDescription('Reason')),
    async execute({ interaction, services }: CommandContext) {
      const { request } = await moderationContext(interaction, services);
      const nickname = interaction.options.getString('nickname');
      const result = await services.moderation.setNickname({
        ...request,
        nickname,
        reason: interaction.options.getString('reason'),
      });
      await interaction.reply({
        embeds: [
          successEmbed(
            nickname
              ? `Nickname of <@${result.userId}> set to **${truncate(nickname, 32)}** (case #${result.caseNumber}).`
              : `Nickname of <@${result.userId}> reset (case #${result.caseNumber}).`,
          ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('role')
      .setDescription('Manage roles for a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a role to a member')
          .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('Reason')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a role from a member')
          .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('Reason')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('info')
          .setDescription('Show who has a role')
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('all')
          .setDescription('Add or remove a role for every human member')
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addBooleanOption((option) => option.setName('add').setDescription('true = add, false = remove').setRequired(true)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const actor = actorMember(interaction);
      requireUserPermissions(actor, [PermissionFlagsBits.ManageRoles], 'managing roles');
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'add' || sub === 'remove') {
        const targetUser = interaction.options.getUser('target', true);
        const role = interaction.options.getRole('role', true);
        const member = await guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) throw new UserFacingError('That member is not in this server.');
        const request = {
          guild,
          actor,
          targetMember: member,
          targetUser: member.user,
          reason: interaction.options.getString('reason'),
          botOwnerOverride: services.owners.isOwner(interaction.user.id),
          roleId: role.id,
        };
        const result =
          sub === 'add' ? await services.moderation.addRole(request) : await services.moderation.removeRole(request);
        await interaction.reply({
          embeds: [
            successEmbed(
              `${sub === 'add' ? 'Added' : 'Removed'} **${result.detail}** ${sub === 'add' ? 'to' : 'from'} <@${member.id}> (case #${result.caseNumber}).`,
            ),
          ],
        });
        return;
      }

      if (sub === 'info') {
        const role = interaction.options.getRole('role', true);
        const detailed = await guild.roles.fetch(role.id).catch(() => null);
        if (!detailed) throw new UserFacingError('Role not found.');
        const members = detailed.members;
        const { sendPaginated } = await import('../core/ui.js');
        await interaction.deferReply();
        await sendPaginated(
          interaction,
          [...members.values()],
          (member) => `<@${member.id}> — ${member.user.tag}`,
          { title: `Members with ${detailed.name}`, pageSize: 20, emptyMessage: 'No members currently have this role.' },
        );
        return;
      }

      const role = interaction.options.getRole('role', true);
      const shouldAdd = interaction.options.getBoolean('add', true);
      const confirmed = await interaction.deferReply().then(async () => {
        const detailed = await guild.roles.fetch(role.id).catch(() => null);
        if (!detailed) throw new UserFacingError('Role not found.');
        const me = guild.members.me;
        if (me && detailed.position >= me.roles.highest.position) {
          throw new UserFacingError('That role is higher than my highest role.');
        }
        return confirmAction(interaction, {
          title: shouldAdd ? 'Mass role add' : 'Mass role removal',
          description: `This will ${shouldAdd ? 'add' : 'remove'} **${detailed.name}** for every human member (${detailed.members.size} currently affected). Continue?`,
          confirmLabel: shouldAdd ? 'Add to everyone' : 'Remove from everyone',
        });
      });
      if (!confirmed) {
        await interaction.editReply({ embeds: [infoEmbed('Cancelled — nothing was changed.')], components: [] });
        return;
      }
      await interaction.editReply({ embeds: [infoEmbed('Working… this can take a while for large servers.')] });
      let changed = 0;
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        if (member.user.bot) continue;
        const has = member.roles.cache.has(role.id);
        if (shouldAdd && !has) {
          const ok = await member.roles.add(role.id, `Mass role ${shouldAdd ? 'add' : 'remove'} by ${actor.user.tag}`).then(() => true).catch(() => false);
          if (ok) changed += 1;
        } else if (!shouldAdd && has) {
          const ok = await member.roles.remove(role.id, `Mass role remove by ${actor.user.tag}`).then(() => true).catch(() => false);
          if (ok) changed += 1;
        }
      }
      await services.logging.log(guild, {
        category: 'roles',
        title: shouldAdd ? 'Mass role add' : 'Mass role remove',
        description: `<@${actor.id}> ${shouldAdd ? 'added' : 'removed'} **${role.name}** for ${changed} member(s).`,
        actorId: actor.id,
        auditAction: 'roles.mass_update',
      });
      await interaction.editReply({ embeds: [successEmbed(`Updated **${changed}** member(s).`)] });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('case')
      .setDescription('Inspect moderation cases')
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('View a case by number')
          .addIntegerOption((option) => option.setName('number').setDescription('Case number').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List recent cases')
          .addUserOption((option) => option.setName('user').setDescription('Filter by user'))
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Filter by action')
              .addChoices(
                { name: 'ban', value: 'ban' },
                { name: 'kick', value: 'kick' },
                { name: 'timeout', value: 'timeout' },
                { name: 'warn', value: 'warn' },
                { name: 'unban', value: 'unban' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('revoke')
          .setDescription('Mark a case as revoked (does not undo the Discord action)')
          .addIntegerOption((option) => option.setName('number').setDescription('Case number').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('Why is it being revoked?')),
      )
      .addSubcommand((sub) => sub.setName('stats').setDescription('Moderation statistics for this server')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'view') {
        const number = interaction.options.getInteger('number', true);
        const record = await services.repos.moderation.getCase(guild.id, number);
        if (!record) throw new UserFacingError(`Case #${number} does not exist.`);
        const embed = baseEmbed(record.action === 'ban' ? COLORS.danger : COLORS.primary)
          .setTitle(`Case #${record.case_number} • ${record.action}`)
          .addFields(
            { name: 'Target', value: `<@${record.user_id}>`, inline: true },
            { name: 'Moderator', value: `<@${record.moderator_id}>`, inline: true },
            { name: 'Status', value: record.status, inline: true },
            { name: 'Created', value: `<t:${Math.floor(record.created_at.getTime() / 1000)}:F>`, inline: true },
            { name: 'Expires', value: record.expires_at ? `<t:${Math.floor(record.expires_at.getTime() / 1000)}:R>` : 'never', inline: true },
            { name: 'Source', value: record.source, inline: true },
            { name: 'Reason', value: truncate(record.reason ?? 'No reason recorded', 1024) },
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }
      if (sub === 'list') {
        const user = interaction.options.getUser('user');
        const action = interaction.options.getString('action');
        const { rows, total } = await services.repos.moderation.listCases(guild.id, {
          userId: user?.id,
          action: action ?? undefined,
          limit: 50,
        });
        const { sendPaginated } = await import('../core/ui.js');
        await interaction.deferReply();
        await sendPaginated(
          interaction,
          rows,
          (record) =>
            `**#${record.case_number}** \`${record.action}\` <@${record.user_id}> — ${truncate(record.reason ?? 'no reason', 80)} (<t:${Math.floor(record.created_at.getTime() / 1000)}:R>)`,
          { title: `Moderation cases (${total} total)`, pageSize: 15, emptyMessage: 'No cases matched.' },
        );
        return;
      }
      if (sub === 'revoke') {
        requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.ModerateMembers], 'revoking cases');
        const number = interaction.options.getInteger('number', true);
        const reason = interaction.options.getString('reason') ?? undefined;
        const ok = await services.repos.moderation.revokeCase(guild.id, number, interaction.user.id, reason);
        await interaction.reply({
          embeds: [
            ok
              ? successEmbed(
                  `Case #${number} marked as revoked. Note: Discord actions that already happened (bans/kicks) are not undone automatically — use \`/unban\` or re-invite where appropriate.`,
                )
              : warningEmbed(`Case #${number} was not found or is already revoked.`),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const stats = await services.repos.analytics.moderationByAction(guild.id, 30);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('📊 Moderation statistics (30 days)')
            .setDescription(
              stats.length === 0
                ? 'No moderation actions were recorded in the last 30 days.'
                : stats.map((entry) => `\`${entry.action}\` — ${entry.count}`).join('\n'),
            ),
        ],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('note')
      .setDescription('Attach a private staff note to a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) => option.setName('target').setDescription('Member').setRequired(true))
      .addStringOption((option) => option.setName('note').setDescription('Note text').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const target = interaction.options.getUser('target', true);
      const note = interaction.options.getString('note', true);
      const record = await services.repos.moderation.createCase({
        guildId: guild.id,
        userId: target.id,
        moderatorId: interaction.user.id,
        action: 'note',
        reason: note,
        source: 'command',
      });
      await services.logging.log(guild, {
        category: 'moderation',
        title: `Case #${record.case_number} • note`,
        description: truncate(note, 900),
        actorId: interaction.user.id,
        targetId: target.id,
        auditAction: 'moderation.note',
      });
      await interaction.reply({
        embeds: [successEmbed(`Note recorded as case **#${record.case_number}**.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('bulkban')
      .setDescription('Ban several user IDs at once (with safeguards)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((option) =>
        option.setName('user_ids').setDescription('Space or comma separated IDs (max 25)').setRequired(true),
      )
      .addStringOption((option) => option.setName('reason').setDescription('Reason recorded on every case')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const actor = actorMember(interaction);
      requireUserPermissions(actor, [PermissionFlagsBits.BanMembers], 'bulk banning');
      const raw = interaction.options.getString('user_ids', true);
      const ids = [...new Set(raw.split(/[\s,]+/).filter((id) => /^\d{17,20}$/.test(id)))].slice(0, 25);
      if (ids.length === 0) throw new UserFacingError('No valid user IDs were provided.');
      const reason = interaction.options.getString('reason') ?? 'Bulk ban';
      await interaction.deferReply();
      const confirmed = await confirmAction(interaction, {
        title: 'Confirm bulk ban',
        description: `This will attempt to ban **${ids.length}** user ID(s) with the reason "${truncate(reason, 100)}". Cases are recorded for each success.`,
        confirmLabel: `Ban ${ids.length} user(s)`,
      });
      if (!confirmed) {
        await interaction.editReply({ embeds: [infoEmbed('Bulk ban cancelled — nothing was changed.')], components: [] });
        return;
      }
      let banned = 0;
      const failures: string[] = [];
      for (const id of ids) {
        if (id === guild.ownerId || services.owners.isOwner(id)) {
          failures.push(`${id} (protected account)`);
          continue;
        }
        try {
          const caseRecord = await services.repos.moderation.createCase({
            guildId: guild.id,
            userId: id,
            moderatorId: actor.id,
            action: 'ban',
            reason,
            source: 'command',
          });
          await guild.bans.create(id, { reason: `${actor.user.tag}: ${reason} (case #${caseRecord.case_number})` });
          banned += 1;
        } catch {
          failures.push(id);
        }
      }
      await services.logging.log(guild, {
        category: 'moderation',
        title: 'Bulk ban executed',
        description: `<@${actor.id}> banned ${banned}/${ids.length} user(s). Reason: ${truncate(reason, 300)}`,
        actorId: actor.id,
        auditAction: 'moderation.bulk_ban',
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            `Banned **${banned}** of ${ids.length} user(s).${failures.length > 0 ? `\nFailed: ${failures.slice(0, 10).join(', ')}` : ''}`,
          ),
        ],
        components: [],
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('appeal')
      .setDescription('Appeal a moderation case')
      .addSubcommand((sub) =>
        sub
          .setName('submit')
          .setDescription('Appeal one of your cases')
          .addIntegerOption((option) => option.setName('case').setDescription('Case number').setRequired(true))
          .addStringOption((option) => option.setName('message').setDescription('Why should this be reviewed?').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List pending appeals (staff only)'))
      .addSubcommand((sub) =>
        sub
          .setName('review')
          .setDescription('Approve or deny an appeal (staff only)')
          .addIntegerOption((option) => option.setName('appeal_id').setDescription('Appeal ID').setRequired(true))
          .addStringOption((option) =>
            option
              .setName('decision')
              .setDescription('Decision')
              .setRequired(true)
              .addChoices({ name: 'approve', value: 'approved' }, { name: 'deny', value: 'denied' }),
          )
          .addStringOption((option) => option.setName('note').setDescription('Internal note')),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'submit') {
        const caseNumber = interaction.options.getInteger('case', true);
        const message = interaction.options.getString('message', true);
        const record = await services.repos.moderation.getCase(guild.id, caseNumber);
        if (!record) throw new UserFacingError(`Case #${caseNumber} does not exist.`);
        if (record.user_id !== interaction.user.id) {
          throw new UserFacingError('You can only appeal your own cases.');
        }
        const ticketSettings = await services.settings.get<{ appealInstructions?: string | null }>(guild.id, 'moderation');
        const appealId = await services.repos.moderation.createAppeal({
          guildId: guild.id,
          caseId: record.id,
          userId: interaction.user.id,
          message: truncate(message, 1900),
        });
        await services.logging.log(guild, {
          category: 'moderation',
          title: `Appeal #${appealId} submitted`,
          description: [
            `Case: #${caseNumber} (${record.action})`,
            `User: <@${interaction.user.id}>`,
            `Message: ${truncate(message, 800)}`,
          ].join('\n'),
          actorId: interaction.user.id,
          auditAction: 'moderation.appeal_submit',
        });
        await interaction.reply({
          embeds: [
            successEmbed(
              `Appeal **#${appealId}** submitted for case **#${caseNumber}**. Staff will review it.${ticketSettings.appealInstructions ? `\n\n${ticketSettings.appealInstructions}` : ''}`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      requireUserPermissions(actorMember(interaction), [PermissionFlagsBits.ModerateMembers], 'appeal review');
      if (sub === 'list') {
        const appeals = await services.repos.moderation.listAppeals(guild.id, 'pending');
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('📨 Pending appeals')
              .setDescription(
                appeals.length === 0
                  ? 'No pending appeals.'
                  : appeals
                      .map(
                        (appeal) =>
                          `**#${appeal.id}** — case #${appeal.case_number ?? '?'} (${appeal.action ?? 'unknown'})\n<@${appeal.user_id}>: ${truncate(appeal.message, 200)}`,
                      )
                      .join('\n\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const appealId = interaction.options.getInteger('appeal_id', true);
      const decision = interaction.options.getString('decision', true) as 'approved' | 'denied';
      const note = interaction.options.getString('note');
      const ok = await services.repos.moderation.reviewAppeal({
        guildId: guild.id,
        appealId,
        reviewerId: interaction.user.id,
        decision,
        note: note ?? undefined,
      });
      await interaction.reply({
        embeds: [
          ok
            ? successEmbed(
                `Appeal #${appealId} marked as **${decision}**. ${decision === 'approved' ? 'Remember to undo the Discord action manually if appropriate (`/unban`, role restore, etc.) — the bot cannot reverse actions Discord already executed.' : ''}`,
              )
            : warningEmbed('That appeal was not found or is already reviewed.'),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'moderation',
    data: new SlashCommandBuilder()
      .setName('modlog')
      .setDescription('Configure moderation logging for this server')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Set the moderation log channel')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) => sub.setName('disable').setDescription('Disable the moderation log channel'))
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the current moderation settings'))
      .addSubcommand((sub) =>
        sub
          .setName('reason_required')
          .setDescription('Require a reason for bans and kicks')
          .addBooleanOption((option) => option.setName('required').setDescription('Require a reason?').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('dm')
          .setDescription('Send members a DM when they are moderated')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Enable DMs?').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('thresholds')
          .setDescription('Configure automatic warning escalation (0 disables a step)')
          .addIntegerOption((option) => option.setName('timeout_at').setDescription('Timeout at N warnings').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('kick_at').setDescription('Kick at N warnings').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('ban_at').setDescription('Ban at N warnings').setMinValue(0).setMaxValue(100)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const current = await services.moderation.getSettings(guild.id);
      if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel', true);
        await interaction.deferReply();
        const updated = await services.moderation.setLogChannel(guild.id, channel.id, interaction.user.id);
        await interaction.editReply({
          embeds: [successEmbed(`Moderation logs will be sent to <#${updated.channelId}>.`)],
        });
        return;
      }
      if (sub === 'disable') {
        await services.settings.update(guild.id, 'moderation', { logChannelId: null }, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [successEmbed('Moderation log channel disabled.')] });
        return;
      }
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🔨 Moderation settings')
              .addFields(
                { name: 'Log channel', value: current.logChannelId ? `<#${current.logChannelId}>` : 'not set', inline: true },
                { name: 'DM on action', value: current.dmOnAction ? 'yes' : 'no', inline: true },
                { name: 'Reason required', value: current.requireReason ? 'yes' : 'no', inline: true },
                {
                  name: 'Escalation',
                  value:
                    current.warnThresholds.timeoutAt || current.warnThresholds.kickAt || current.warnThresholds.banAt
                      ? [
                          `timeout @ ${current.warnThresholds.timeoutAt || 'off'}`,
                          `kick @ ${current.warnThresholds.kickAt || 'off'}`,
                          `ban @ ${current.warnThresholds.banAt || 'off'}`,
                        ].join(' • ')
                      : 'disabled',
                },
              ),
          ],
        });
        return;
      }
      if (sub === 'reason_required') {
        await services.settings.update(
          guild.id,
          'moderation',
          { requireReason: interaction.options.getBoolean('required', true) },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({ embeds: [successEmbed('Updated the reason requirement.')] });
        return;
      }
      if (sub === 'dm') {
        await services.settings.update(
          guild.id,
          'moderation',
          { dmOnAction: interaction.options.getBoolean('enabled', true) },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({ embeds: [successEmbed('Updated DM notifications.')] });
        return;
      }
      const patch: Record<string, number> = {};
      for (const [key, option] of [
        ['timeoutAt', 'timeout_at'],
        ['kickAt', 'kick_at'],
        ['banAt', 'ban_at'],
      ] as const) {
        const value = interaction.options.getInteger(option);
        if (value !== null) patch[key] = value;
      }
      await services.settings.update(
        guild.id,
        'moderation',
        { warnThresholds: { ...current.warnThresholds, ...patch } },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({
        embeds: [successEmbed(`Warning thresholds updated: ${JSON.stringify({ ...current.warnThresholds, ...patch })}`)],
      });
    },
  },
]);

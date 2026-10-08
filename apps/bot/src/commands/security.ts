import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { formatDuration, UserFacingError } from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { requireUserPermissions } from '../core/resolvers.js';
import type { NoPinSettings, NoTagSettings, SecuritySettings } from '../services/types.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function actor(interaction: ChatInputCommandInteraction): GuildMember {
  if (!interaction.member || !(interaction.member instanceof GuildMember)) {
    throw new UserFacingError('This command must be used inside a server.');
  }
  return interaction.member;
}

function requireSecurityAccess(interaction: ChatInputCommandInteraction): GuildMember {
  const member = actor(interaction);
  requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'security configuration');
  return member;
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('security')
      .setDescription('Server security: status, lockdown, trusted entities and alerts')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the current security posture'))
      .addSubcommand((sub) =>
        sub
          .setName('enable')
          .setDescription('Enable the security subsystem')
          .addBooleanOption((option) => option.setName('lockdown_on_breach').setDescription('Automatically lock down when a nuke threshold is hit'))
          .addStringOption((option) =>
            option
              .setName('response')
              .setDescription('What to do with the offending actor')
              .addChoices(
                { name: 'alert only', value: 'alert' },
                { name: 'remove their roles', value: 'remove_roles' },
                { name: 'ban them', value: 'ban' },
              ),
          ),
      )
      .addSubcommand((sub) => sub.setName('disable').setDescription('Disable the security subsystem'))
      .addSubcommand((sub) =>
        sub
          .setName('lockdown')
          .setDescription('Lock or unlock the server')
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('on = lock, off = unlock')
              .setRequired(true)
              .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
          )
          .addStringOption((option) => option.setName('duration').setDescription('Auto-unlock after e.g. 15m (lockdown on only)'))
          .addStringOption((option) => option.setName('reason').setDescription('Reason shown in the security log')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('trusted')
          .setDescription('Manage users/roles exempt from anti-nuke')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('add / remove / list')
              .setRequired(true)
              .addChoices(
                { name: 'add user', value: 'add_user' },
                { name: 'add role', value: 'add_role' },
                { name: 'remove user', value: 'remove_user' },
                { name: 'remove role', value: 'remove_role' },
                { name: 'list', value: 'list' },
              ),
          )
          .addUserOption((option) => option.setName('user').setDescription('User (for add/remove user)'))
          .addRoleOption((option) => option.setName('role').setDescription('Role (for add/remove role)')),
      )
      .addSubcommand((sub) => sub.setName('events').setDescription('Show the latest security events'))
      .addSubcommand((sub) => sub.setName('alerts').setDescription('Show unhandled high-severity alerts')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.security.getSettings(guild.id);

      if (sub === 'status') {
        const events = await services.repos.security.listEvents(guild.id, { limit: 5 });
        const alerts = await services.repos.security.countOpenAlerts(guild.id);
        const trusted = await services.repos.security.listTrusted(guild.id);
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('🛡️ Security status')
              .setDescription(
                settings.enabled
                  ? 'The security subsystem is **enabled**. The bot detects, alerts and contains — it cannot prevent an action Discord has already executed.'
                  : 'The security subsystem is **disabled**. Enable it with `/security enable`.',
              )
              .addFields(
                { name: 'Anti-nuke', value: settings.antiNuke.enabled ? `on (${settings.antiNuke.windowMs / 1000}s window, response: ${settings.antiNuke.response})` : 'off', inline: true },
                { name: 'Anti-raid', value: settings.antiRaid.enabled ? `on (${settings.antiRaid.joinsThreshold} joins / ${settings.antiRaid.joinsWindowMs / 1000}s)` : 'off', inline: true },
                { name: 'Anti-spam', value: settings.antiSpam.enabled ? `on (${settings.antiSpam.messagesPerWindow} msgs / ${settings.antiSpam.windowMs / 1000}s)` : 'off', inline: true },
                { name: 'Lockdown', value: settings.lockdown.active ? `ACTIVE ${settings.lockdown.until ? `until <t:${Math.floor(settings.lockdown.until / 1000)}:R>` : ''}` : 'inactive', inline: true },
                { name: 'Trusted entries', value: String(trusted.length), inline: true },
                { name: 'Open alerts', value: String(alerts), inline: true },
              )
              .setFooter({ text: events.rows[0] ? `Last event: ${events.rows[0].kind}` : 'No security events recorded yet' }),
          ],
        });
        return;
      }

      requireSecurityAccess(interaction);

      if (sub === 'enable') {
        const lockdown = interaction.options.getBoolean('lockdown_on_breach');
        const response = interaction.options.getString('response') as 'alert' | 'remove_roles' | 'ban' | null;
        const updated = await services.settings.update<SecuritySettings>(
          guild.id,
          'security',
          {
            enabled: true,
            antiNuke: {
              ...settings.antiNuke,
              enabled: true,
              ...(lockdown === null ? {} : { autoLockdown: lockdown }),
              ...(response ? { response } : {}),
            },
            antiRaid: { ...settings.antiRaid, enabled: true },
          },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              `Security enabled.\n• Anti-nuke response: **${updated.antiNuke.response}**\n• Auto-lockdown on breach: **${updated.antiNuke.autoLockdown ? 'yes' : 'no'}**\n\nAdd trusted staff with \`/security trusted\` so their actions do not trigger alerts.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'disable') {
        await services.settings.update(guild.id, 'security', { enabled: false }, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [warningEmbed('Security subsystem disabled for this server.')] });
        return;
      }

      if (sub === 'lockdown') {
        const mode = interaction.options.getString('mode', true);
        await interaction.deferReply();
        if (mode === 'on') {
          const durationRaw = interaction.options.getString('duration');
          const duration = durationRaw ? (await import('@bot-by-ai/shared')).parseDurationMs(durationRaw) : null;
          if (durationRaw && duration === null) throw new UserFacingError('Use a duration like `15m` or `1h`.');
          const reason = interaction.options.getString('reason') ?? `Lockdown requested by ${interaction.user.tag}`;
          const minutes = duration ? Math.max(1, Math.round(duration / 60_000)) : 60;
          const result = await services.security.lockdown(guild, minutes, reason, interaction.user.id);
          await interaction.editReply({
            embeds: [
              successEmbed(
                `🔒 Lockdown active — ${result.channels} channel(s) locked until <t:${Math.floor(result.until / 1000)}:R>.\nReason: ${reason}`,
              ),
            ],
          });
        } else {
          const result = await services.security.liftLockdown(guild, interaction.user.id);
          await interaction.editReply({ embeds: [successEmbed(`🔓 Lockdown lifted — ${result.channels} channel(s) unlocked.`)] });
        }
        return;
      }

      if (sub === 'trusted') {
        const action = interaction.options.getString('action', true);
        if (action === 'list') {
          const trusted = await services.repos.security.listTrusted(guild.id);
          await interaction.reply({
            embeds: [
              baseEmbed(COLORS.primary)
                .setTitle('🤝 Trusted entities')
                .setDescription(
                  trusted.length === 0
                    ? 'No trusted users or roles yet. Members with these roles never trigger anti-nuke alerts.'
                    : trusted
                        .map((entry) =>
                          entry.entity_type === 'user'
                            ? `<@${entry.entity_id}> (user) — added by <@${entry.added_by ?? 'unknown'}>`
                            : `<@&${entry.entity_id}> (role) — added by <@${entry.added_by ?? 'unknown'}>`,
                        )
                        .join('\n'),
                )
                .addFields({
                  name: 'Also configured as settings',
                  value: [
                    settings.trustedUserIds.length ? `users: ${settings.trustedUserIds.map((id) => `<@${id}>`).join(', ')}` : null,
                    settings.trustedRoleIds.length ? `roles: ${settings.trustedRoleIds.map((id) => `<@&${id}>`).join(', ')}` : null,
                  ]
                    .filter(Boolean)
                    .join('\n') || 'none',
                }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        if (action.endsWith('user') && !user) throw new UserFacingError('Provide the `user` option.');
        if (action.endsWith('role') && !role) throw new UserFacingError('Provide the `role` option.');
        if (action.startsWith('add')) {
          await services.repos.security.addTrusted({
            guildId: guild.id,
            entityType: user ? 'user' : 'role',
            entityId: user?.id ?? role?.id ?? '',
            addedBy: interaction.user.id,
          });
          if (user) {
            await services.settings.update(
              guild.id,
              'security',
              { trustedUserIds: [...new Set([...settings.trustedUserIds, user.id])] },
              { actorId: interaction.user.id, source: 'command' },
            );
          } else if (role) {
            await services.settings.update(
              guild.id,
              'security',
              { trustedRoleIds: [...new Set([...settings.trustedRoleIds, role.id])] },
              { actorId: interaction.user.id, source: 'command' },
            );
          }
        } else {
          await services.repos.security.removeTrusted(guild.id, user ? 'user' : 'role', user?.id ?? role?.id ?? '');
          if (user) {
            await services.settings.update(
              guild.id,
              'security',
              { trustedUserIds: settings.trustedUserIds.filter((id) => id !== user.id) },
              { actorId: interaction.user.id, source: 'command' },
            );
          } else if (role) {
            await services.settings.update(
              guild.id,
              'security',
              { trustedRoleIds: settings.trustedRoleIds.filter((id) => id !== role.id) },
              { actorId: interaction.user.id, source: 'command' },
            );
          }
        }
        await services.logging.logSecurity(guild, {
          title: 'Trusted entities updated',
          description: `<@${interaction.user.id}> performed \`${action}\`${user ? ` for <@${user.id}>` : role ? ` for <@&${role.id}>` : ''}.`,
          actorId: interaction.user.id,
          kind: 'trusted_update',
        });
        await interaction.reply({
          embeds: [successEmbed(`Trusted list updated (\`${action}\`).`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'events') {
        const events = await services.repos.security.listEvents(guild.id, { limit: 25 });
        const { sendPaginated } = await import('../core/ui.js');
        await interaction.deferReply();
        await sendPaginated(
          interaction,
          events.rows,
          (event) =>
            `\`${event.kind}\` **${event.severity}/3** — ${event.description.slice(0, 120)} (<t:${Math.floor(event.created_at.getTime() / 1000)}:R>)`,
          { title: '🛡️ Security events', pageSize: 12, emptyMessage: 'No security events recorded yet.' },
        );
        return;
      }

      const alerts = await services.repos.security.listEvents(guild.id, { minSeverity: 2, limit: 25 });
      const unhandled = alerts.rows.filter((row) => !row.handled);
      await interaction.reply({
        embeds: [
          baseEmbed(unhandled.length > 0 ? COLORS.danger : COLORS.success)
            .setTitle('🚨 Open security alerts')
            .setDescription(
              unhandled.length === 0
                ? 'No unhandled alerts. '
                : unhandled
                    .map(
                      (alert) =>
                        `**#${alert.id}** \`${alert.kind}\` (severity ${alert.severity})\n${alert.description.slice(0, 250)}\n<t:${Math.floor(alert.created_at.getTime() / 1000)}:R>`,
                    )
                    .join('\n\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('antinuke')
      .setDescription('Configure anti-nuke thresholds and response')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show current anti-nuke thresholds'))
      .addSubcommand((sub) =>
        sub
          .setName('thresholds')
          .setDescription('Set how many events within the window are tolerated')
          .addStringOption((option) =>
            option.setName('target').setDescription('Which event').setRequired(true).addChoices(
              { name: 'bans', value: 'bans' },
              { name: 'kicks', value: 'kicks' },
              { name: 'channel deletes', value: 'channelDeletes' },
              { name: 'role deletes', value: 'roleDeletes' },
              { name: 'webhook creates', value: 'webhookCreates' },
              { name: 'permission changes', value: 'permissionChanges' },
              { name: 'member role updates', value: 'memberRoleUpdates' },
            ),
          )
          .addIntegerOption((option) => option.setName('limit').setDescription('Allowed count before triggering').setRequired(true).setMinValue(1).setMaxValue(500)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('window')
          .setDescription('Set the detection window in seconds')
          .addIntegerOption((option) => option.setName('seconds').setDescription('5-300 seconds').setRequired(true).setMinValue(5).setMaxValue(300)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('response')
          .setDescription('Choose what happens to an actor that trips a threshold')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Response')
              .setRequired(true)
              .addChoices(
                { name: 'alert only', value: 'alert' },
                { name: 'remove their roles', value: 'remove_roles' },
                { name: 'ban them', value: 'ban' },
              ),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireSecurityAccess(interaction);
      const settings = await services.security.getSettings(guild.id);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'status') {
        const thresholds = settings.antiNuke.thresholds;
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('☢️ Anti-nuke configuration')
              .addFields(
                { name: 'Enabled', value: settings.antiNuke.enabled ? 'yes' : 'no', inline: true },
                { name: 'Window', value: formatDuration(settings.antiNuke.windowMs), inline: true },
                { name: 'Response', value: settings.antiNuke.response, inline: true },
                {
                  name: 'Thresholds',
                  value: Object.entries(thresholds)
                    .map(([key, value]) => `\`${key}\`: ${value}`)
                    .join('\n'),
                },
              )
              .setFooter({ text: 'Thresholds are counted per actor inside the window.' }),
          ],
        });
        return;
      }
      if (sub === 'thresholds') {
        const target = interaction.options.getString('target', true);
        const limit = interaction.options.getInteger('limit', true);
        await services.settings.update(
          guild.id,
          'security',
          { antiNuke: { ...settings.antiNuke, thresholds: { ...settings.antiNuke.thresholds, [target]: limit } } },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({ embeds: [successEmbed(`Threshold for \`${target}\` set to **${limit}** per window.`)] });
        return;
      }
      if (sub === 'window') {
        const seconds = interaction.options.getInteger('seconds', true);
        await services.settings.update(
          guild.id,
          'security',
          { antiNuke: { ...settings.antiNuke, windowMs: seconds * 1000 } },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({ embeds: [successEmbed(`Detection window set to **${seconds}s**.`)] });
        return;
      }
      const action = interaction.options.getString('action', true) as 'alert' | 'remove_roles' | 'ban';
      await services.settings.update(
        guild.id,
        'security',
        { antiNuke: { ...settings.antiNuke, response: action }, enabled: true, antiNukeEnabled: true },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({
        embeds: [
          successEmbed(
            `Anti-nuke response set to **${action}**. ${
              action === 'ban'
                ? 'Careful: the offending actor is banned — make sure your trusted staff list is complete.'
                : ''
            }`,
          ),
        ],
      });
    },
  },
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('antiraid')
      .setDescription('Configure raid protection (join velocity + account age)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the anti-raid configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Update anti-raid settings')
          .addIntegerOption((option) => option.setName('joins').setDescription('Joins allowed in the window').setMinValue(2).setMaxValue(500))
          .addIntegerOption((option) => option.setName('window_seconds').setDescription('Window length').setMinValue(5).setMaxValue(600))
          .addIntegerOption((option) => option.setName('min_account_age_days').setDescription('Flag accounts younger than N days').setMinValue(0).setMaxValue(365))
          .addBooleanOption((option) => option.setName('block_new_accounts').setDescription('Kick accounts younger than the minimum'))
          .addStringOption((option) =>
            option
              .setName('response')
              .setDescription('What to do when a raid is detected')
              .addChoices(
                { name: 'alert only', value: 'alert' },
                { name: 'lock the server down', value: 'lockdown' },
                { name: 'kick new joiners', value: 'kick_new' },
                { name: 'ban new joiners', value: 'ban_new' },
              ),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireSecurityAccess(interaction);
      const settings = await services.security.getSettings(guild.id);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🚪 Anti-raid configuration')
              .addFields(
                { name: 'Enabled', value: settings.antiRaid.enabled ? 'yes' : 'no', inline: true },
                { name: 'Join threshold', value: `${settings.antiRaid.joinsThreshold} / ${formatDuration(settings.antiRaid.joinsWindowMs)}`, inline: true },
                { name: 'Min account age', value: `${settings.antiRaid.minAccountAgeDays} days`, inline: true },
                { name: 'Block new accounts', value: settings.antiRaid.blockNewAccounts ? 'yes' : 'no', inline: true },
                { name: 'Response', value: settings.antiRaid.response, inline: true },
              ),
          ],
        });
        return;
      }
      const patch: Record<string, unknown> = { ...settings.antiRaid, enabled: true };
      const joins = interaction.options.getInteger('joins');
      const windowSeconds = interaction.options.getInteger('window_seconds');
      const minAge = interaction.options.getInteger('min_account_age_days');
      const blockNew = interaction.options.getBoolean('block_new_accounts');
      const response = interaction.options.getString('response');
      if (joins !== null) patch.joinsThreshold = joins;
      if (windowSeconds !== null) patch.joinsWindowMs = windowSeconds * 1000;
      if (minAge !== null) patch.minAccountAgeDays = minAge;
      if (blockNew !== null) patch.blockNewAccounts = blockNew;
      if (response) patch.response = response;
      await services.settings.update(
        guild.id,
        'security',
        { antiRaid: patch as never, enabled: true },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({ embeds: [successEmbed('Anti-raid configuration updated.')] });
    },
  },
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('antispam')
      .setDescription('Configure automatic flood protection')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the anti-spam configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Update anti-spam settings')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Enable or disable'))
          .addIntegerOption((option) => option.setName('messages').setDescription('Messages per window').setMinValue(2).setMaxValue(100))
          .addIntegerOption((option) => option.setName('window_seconds').setDescription('Window length').setMinValue(1).setMaxValue(120))
          .addStringOption((option) => option.setName('timeout').setDescription('Timeout duration, e.g. 10m (0 disables)')),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireSecurityAccess(interaction);
      const settings = await services.security.getSettings(guild.id);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🌊 Anti-spam configuration')
              .addFields(
                { name: 'Enabled', value: settings.antiSpam.enabled ? 'yes' : 'no', inline: true },
                { name: 'Rate', value: `${settings.antiSpam.messagesPerWindow} messages / ${formatDuration(settings.antiSpam.windowMs)}`, inline: true },
                { name: 'Timeout', value: settings.antiSpam.timeoutMs > 0 ? formatDuration(settings.antiSpam.timeoutMs) : 'disabled', inline: true },
              ),
          ],
        });
        return;
      }
      const patch: Record<string, unknown> = { ...settings.antiSpam };
      const enabled = interaction.options.getBoolean('enabled');
      const messages = interaction.options.getInteger('messages');
      const windowSeconds = interaction.options.getInteger('window_seconds');
      const timeoutRaw = interaction.options.getString('timeout');
      if (enabled !== null) patch.enabled = enabled;
      if (messages !== null) patch.messagesPerWindow = messages;
      if (windowSeconds !== null) patch.windowMs = windowSeconds * 1000;
      if (timeoutRaw) {
        const { parseDurationMs } = await import('@bot-by-ai/shared');
        const parsed = parseDurationMs(timeoutRaw);
        if (parsed === null) throw new UserFacingError('Use a timeout like `10m` or `1h` (or `0` to disable).');
        patch.timeoutMs = parsed;
      }
      await services.settings.update(guild.id, 'security', { antiSpam: patch as never }, { actorId: interaction.user.id, source: 'command' });
      await interaction.reply({ embeds: [successEmbed('Anti-spam configuration updated.')] });
    },
  },
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('notag')
      .setDescription('Protect members from unwanted mentions')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('setup').setDescription('Enable mention protection and choose the action'))
      .addSubcommand((sub) =>
        sub
          .setName('protect')
          .setDescription('Add a protected user')
          .addUserOption((option) => option.setName('user').setDescription('User to protect').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('unprotect')
          .setDescription('Remove protection from a user')
          .addUserOption((option) => option.setName('user').setDescription('User').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show protected users and settings'))
      .addSubcommand((sub) =>
        sub
          .setName('exempt')
          .setDescription('Exempt a user, role or channel from the rule')
          .addStringOption((option) =>
            option
              .setName('type')
              .setDescription('What to exempt')
              .setRequired(true)
              .addChoices({ name: 'user', value: 'user' }, { name: 'role', value: 'role' }, { name: 'channel', value: 'channel' }),
          )
          .addUserOption((option) => option.setName('user').setDescription('User (type: user)'))
          .addRoleOption((option) => option.setName('role').setDescription('Role (type: role)'))
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel (type: channel)').addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('settings')
          .setDescription('Change the no-tag behaviour')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('What to do on a violation')
              .addChoices(
                { name: 'log only', value: 'log' },
                { name: 'warn the author', value: 'warn' },
                { name: 'delete the message', value: 'delete' },
                { name: 'timeout the author', value: 'timeout' },
                { name: 'kick the author', value: 'kick' },
              ),
          )
          .addBooleanOption((option) => option.setName('allow_replies').setDescription('Allow mentions inside replies'))
          .addBooleanOption((option) => option.setName('allow_self_mention').setDescription('Allow users to mention themselves'))
          .addIntegerOption((option) => option.setName('escalation_threshold').setDescription('Repeat offences before escalation').setMinValue(2).setMaxValue(20))
          .addStringOption((option) => option.setName('timeout_duration').setDescription('Timeout length, e.g. 10m'))
          .addChannelOption((option) =>
            option.setName('log_channel').setDescription('Channel for violation logs').addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) => sub.setName('logs').setDescription('Show recent no-tag violations')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireSecurityAccess(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<NoTagSettings>(guild.id, 'notag');

      if (sub === 'setup') {
        const updated = await services.settings.update<NoTagSettings>(
          guild.id,
          'notag',
          { enabled: true, action: settings.action === 'log' ? 'warn' : settings.action, deleteMessage: true },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              `Mention protection is **enabled** (action: ${updated.action}).\n\nAdd protected members with \`/notag protect @user\`.\n\n**Honest limitation:** Discord delivers the message before any bot can react, so a mention can still appear briefly (and clients may show a notification). The bot deletes the message, warns/times-out the author and logs the incident — it cannot stop the ping from being sent.`,
            ),
          ],
        });
        return;
      }
      if (sub === 'protect' || sub === 'unprotect') {
        const user = interaction.options.getUser('user', true);
        const list = new Set(settings.protectedUserIds);
        if (sub === 'protect') list.add(user.id);
        else list.delete(user.id);
        const updated = await services.settings.update<NoTagSettings>(
          guild.id,
          'notag',
          { protectedUserIds: [...list], enabled: sub === 'protect' ? true : settings.enabled },
          { actorId: interaction.user.id, source: 'command' },
        );
        await services.logging.logSecurity(guild, {
          title: 'No-tag protection updated',
          description: `<@${interaction.user.id}> ${sub === 'protect' ? 'protected' : 'unprotected'} <@${user.id}>. Protected users: ${updated.protectedUserIds.length}`,
          actorId: interaction.user.id,
          kind: 'notag_update',
        });
        await interaction.reply({
          embeds: [
            successEmbed(
              sub === 'protect'
                ? `<@${user.id}> is now protected from unwanted mentions (${updated.protectedUserIds.length} protected user(s)).`
                : `Protection removed for <@${user.id}>.`,
            ),
          ],
        });
        return;
      }
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('🔔 No-tag protection')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                { name: 'Action', value: settings.action, inline: true },
                { name: 'Escalation after', value: `${settings.escalationThreshold} violations`, inline: true },
                { name: 'Allow replies', value: settings.allowReplies ? 'yes' : 'no', inline: true },
                { name: 'Allow self-mention', value: settings.allowSelfMention ? 'yes' : 'no', inline: true },
                { name: 'Log channel', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'default security log', inline: true },
                {
                  name: `Protected users (${settings.protectedUserIds.length})`,
                  value: settings.protectedUserIds.slice(0, 30).map((id) => `<@${id}>`).join(' ') || 'none',
                },
                {
                  name: 'Exemptions',
                  value: [
                    settings.exemptUserIds.length ? `users: ${settings.exemptUserIds.map((id) => `<@${id}>`).join(' ')}` : null,
                    settings.exemptRoleIds.length ? `roles: ${settings.exemptRoleIds.map((id) => `<@&${id}>`).join(' ')}` : null,
                    settings.exemptChannelIds.length ? `channels: ${settings.exemptChannelIds.map((id) => `<#${id}>`).join(' ')}` : null,
                  ]
                    .filter(Boolean)
                    .join('\n') || 'none',
                },
              ),
          ],
        });
        return;
      }
      if (sub === 'exempt') {
        const type = interaction.options.getString('type', true);
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const channel = interaction.options.getChannel('channel');
        const target = type === 'user' ? user : type === 'role' ? role : channel;
        if (!target) throw new UserFacingError(`Provide the \`${type}\` option.`);
        const patch =
          type === 'user'
            ? { exemptUserIds: [...new Set([...settings.exemptUserIds, target.id])] }
            : type === 'role'
              ? { exemptRoleIds: [...new Set([...settings.exemptRoleIds, target.id])] }
              : { exemptChannelIds: [...new Set([...settings.exemptChannelIds, target.id])] };
        await services.settings.update(guild.id, 'notag', patch, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [successEmbed(`Added an exemption for ${type} \`${target.id}\`.`)], flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === 'settings') {
        const patch: Record<string, unknown> = {};
        const action = interaction.options.getString('action');
        const allowReplies = interaction.options.getBoolean('allow_replies');
        const allowSelf = interaction.options.getBoolean('allow_self_mention');
        const threshold = interaction.options.getInteger('escalation_threshold');
        const timeoutRaw = interaction.options.getString('timeout_duration');
        const logChannel = interaction.options.getChannel('log_channel');
        if (action) patch.action = action;
        if (allowReplies !== null) patch.allowReplies = allowReplies;
        if (allowSelf !== null) patch.allowSelfMention = allowSelf;
        if (threshold !== null) patch.escalationThreshold = threshold;
        if (logChannel) patch.logChannelId = logChannel.id;
        if (timeoutRaw) {
          const { parseDurationMs } = await import('@bot-by-ai/shared');
          const parsed = parseDurationMs(timeoutRaw);
          if (parsed === null) throw new UserFacingError('Use a duration like `10m`.');
          patch.timeoutMs = parsed;
        }
        await services.settings.update(guild.id, 'notag', patch, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [successEmbed('No-tag settings updated.')] });
        return;
      }
      const violations = await services.repos.security.listEvents(guild.id, { limit: 50 });
      const noTagRows = violations.rows.filter((row) => row.kind === 'notag' || row.description.includes('No-tag'));
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('📋 Recent no-tag violations')
            .setDescription(
              noTagRows.length === 0
                ? 'No violations recorded yet.'
                : noTagRows
                    .slice(0, 20)
                    .map((row) => `#${row.id} — ${row.description.slice(0, 200)}`)
                    .join('\n\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('nopin')
      .setDescription('Monitor and revert unauthorised pins on protected messages')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('setup').setDescription('Enable pin monitoring'))
      .addSubcommand((sub) =>
        sub
          .setName('protect')
          .setDescription('Protect a user’s messages from being pinned by others')
          .addUserOption((option) => option.setName('user').setDescription('User').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('unprotect')
          .setDescription('Stop protecting a user’s messages')
          .addUserOption((option) => option.setName('user').setDescription('User').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the pin protection configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('exempt')
          .setDescription('Exempt a channel from pin monitoring')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('settings')
          .setDescription('Change the pin monitoring behaviour')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('What to do when an unauthorised pin is detected')
              .addChoices(
                { name: 'log only', value: 'log' },
                { name: 'alert staff', value: 'alert' },
                { name: 'revert the pin', value: 'revert' },
                { name: 'timeout the actor', value: 'timeout' },
              ),
          )
          .addBooleanOption((option) => option.setName('allow_self_pin').setDescription('Allow the author to pin their own message'))
          .addBooleanOption((option) => option.setName('allow_moderators').setDescription('Allow members with Manage Messages'))
          .addStringOption((option) => option.setName('timeout_duration').setDescription('Timeout length when action=timeout'))
          .addChannelOption((option) =>
            option.setName('alert_channel').setDescription('Channel for pin alerts').addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) => sub.setName('logs').setDescription('Show recent pin events')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireSecurityAccess(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<NoPinSettings>(guild.id, 'nopin');

      if (sub === 'setup') {
        const updated = await services.settings.update<NoPinSettings>(
          guild.id,
          'nopin',
          { enabled: true, action: settings.action === 'log' ? 'alert' : settings.action },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              `Pin monitoring is **enabled** (action: ${updated.action}).\n\nProtect users with \`/nopin protect @user\`.\n\n**Honest limitation:** Discord fires the pin event after it happens and the audit-log entry that identifies the actor can arrive seconds later (or not at all). The bot attributes the event when possible, alerts staff, and can unpin the message again — it cannot block a pin before it occurs.`,
            ),
          ],
        });
        return;
      }
      if (sub === 'protect' || sub === 'unprotect') {
        const user = interaction.options.getUser('user', true);
        const list = new Set(settings.protectedUserIds);
        if (sub === 'protect') list.add(user.id);
        else list.delete(user.id);
        await services.settings.update(
          guild.id,
          'nopin',
          { protectedUserIds: [...list], enabled: sub === 'protect' ? true : settings.enabled },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [successEmbed(sub === 'protect' ? `<@${user.id}> is now pin-protected.` : `Pin protection removed for <@${user.id}>.`)],
        });
        return;
      }
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('📌 Pin protection')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                { name: 'Action', value: settings.action, inline: true },
                { name: 'Allow self-pin', value: settings.allowSelfPin ? 'yes' : 'no', inline: true },
                { name: 'Allow moderators', value: settings.allowModerators ? 'yes' : 'no', inline: true },
                { name: 'Alert channel', value: settings.alertChannelId ? `<#${settings.alertChannelId}>` : 'default security log', inline: true },
                {
                  name: `Protected users (${settings.protectedUserIds.length})`,
                  value: settings.protectedUserIds.map((id) => `<@${id}>`).join(' ') || 'none',
                },
                {
                  name: 'Trusted roles',
                  value: settings.trustedRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none',
                },
              ),
          ],
        });
        return;
      }
      if (sub === 'exempt') {
        const channel = interaction.options.getChannel('channel', true);
        await services.settings.update(
          guild.id,
          'nopin',
          { exemptChannelIds: [...new Set([...settings.exemptChannelIds, channel.id])] },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({ embeds: [successEmbed(`Pin monitoring exempt in <#${channel.id}>.`)], flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === 'settings') {
        const patch: Record<string, unknown> = {};
        const action = interaction.options.getString('action');
        const allowSelf = interaction.options.getBoolean('allow_self_pin');
        const allowMods = interaction.options.getBoolean('allow_moderators');
        const timeoutRaw = interaction.options.getString('timeout_duration');
        const alertChannel = interaction.options.getChannel('alert_channel');
        if (action) patch.action = action;
        if (allowSelf !== null) patch.allowSelfPin = allowSelf;
        if (allowMods !== null) patch.allowModerators = allowMods;
        if (alertChannel) patch.alertChannelId = alertChannel.id;
        if (timeoutRaw) {
          const { parseDurationMs } = await import('@bot-by-ai/shared');
          const parsed = parseDurationMs(timeoutRaw);
          if (parsed === null) throw new UserFacingError('Use a duration like `10m`.');
          patch.timeoutMs = parsed;
        }
        await services.settings.update(guild.id, 'nopin', patch, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [successEmbed('Pin monitoring settings updated.')] });
        return;
      }
      const events = await services.repos.security.findLatestEvent(guild.id, 'nopin');
      const recent = await services.repos.security.listEvents(guild.id, { kinds: ['nopin'], limit: 25 });
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('📌 Recent pin events')
            .setDescription(
              recent.rows.length === 0
                ? `No pin events recorded yet.${events ? '' : ''}`
                : recent.rows
                    .map(
                      (row) =>
                        `#${row.id} — ${row.description.slice(0, 180)} (<t:${Math.floor(row.created_at.getTime() / 1000)}:R>)`,
                    )
                    .join('\n\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('raidmode')
      .setDescription('Emergency shortcuts for raids and lockdowns')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('on')
          .setDescription('Lock the server down immediately for a period')
          .addStringOption((option) => option.setName('duration').setDescription('e.g. 15m (default 60m)'))
          .addStringOption((option) => option.setName('reason').setDescription('Reason')),
      )
      .addSubcommand((sub) => sub.setName('off').setDescription('Lift an active lockdown'))
      .addSubcommand((sub) => sub.setName('status').setDescription('Show whether a lockdown is active')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireSecurityAccess(interaction);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'status') {
        const settings = await services.security.getSettings(guild.id);
        await interaction.reply({
          embeds: [
            baseEmbed(settings.lockdown.active ? COLORS.danger : COLORS.success)
              .setTitle('🚨 Raid mode')
              .setDescription(
                settings.lockdown.active
                  ? `Lockdown is **active**${settings.lockdown.until ? ` until <t:${Math.floor(settings.lockdown.until / 1000)}:R>` : ''}.\nReason: ${settings.lockdown.reason ?? 'not recorded'}`
                  : 'No lockdown is active.',
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply();
      if (sub === 'on') {
        const durationRaw = interaction.options.getString('duration');
        const { parseDurationMs } = await import('@bot-by-ai/shared');
        const duration = durationRaw ? parseDurationMs(durationRaw) : null;
        const minutes = duration ? Math.max(1, Math.round(duration / 60_000)) : 60;
        const reason = interaction.options.getString('reason') ?? `Raid mode enabled by ${interaction.user.tag}`;
        const result = await services.security.lockdown(guild, minutes, reason, interaction.user.id);
        await interaction.editReply({
          embeds: [successEmbed(`🚨 Raid mode active — ${result.channels} channel(s) locked until <t:${Math.floor(result.until / 1000)}:R>.`)],
        });
        return;
      }
      const result = await services.security.liftLockdown(guild, interaction.user.id);
      await interaction.editReply({ embeds: [successEmbed(`Raid mode disabled — ${result.channels} channel(s) unlocked.`)] });
    },
  },
  {
    category: 'security',
    data: new SlashCommandBuilder()
      .setName('securitylog')
      .setDescription('Set a dedicated channel for security alerts')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Choose the security log channel')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) => sub.setName('disable').setDescription('Stop sending security alerts')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireSecurityAccess(interaction);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'disable') {
        await services.settings.update(guild.id, 'security', { alertChannelId: null }, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [warningEmbed('Security alerts disabled.')] });
        return;
      }
      const channel = interaction.options.getChannel('channel', true);
      await services.settings.update(
        guild.id,
        'security',
        { alertChannelId: channel.id, enabled: true },
        { actorId: interaction.user.id, source: 'command' },
      );
      await services.settings.update(
        guild.id,
        'logging',
        { enabled: true, channels: { security: channel.id } },
        { actorId: interaction.user.id, source: 'command' },
      );
      const test = await services.logging.sendTo(guild, channel.id, {
        category: 'security',
        title: 'Security alerts enabled',
        description: `This channel will receive anti-nuke, anti-raid, anti-spam, no-tag and no-pin alerts.\nConfigured by <@${interaction.user.id}>.`,
        color: COLORS.security,
      });
      await interaction.reply({
        embeds: [
          test
            ? successEmbed(`Security alerts will be sent to <#${channel.id}>.`)
            : warningEmbed(
                `I could not post in <#${channel.id}>. Check that I have View Channel, Send Messages and Embed Links there.`,
              ),
        ],
      });
    },
  },
]);

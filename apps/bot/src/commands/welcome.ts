import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { formatDuration, truncate, UserFacingError } from '@bot-by-ai/shared';
import { COLORS, WELCOME_VARIABLES } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { requireUserPermissions } from '../core/resolvers.js';
import { EmbedBuilder } from 'discord.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function actor(interaction: ChatInputCommandInteraction): GuildMember {
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember))
    throw new UserFacingError('Use this inside a server.');
  return member;
}

function variablesHelp(): string {
  return WELCOME_VARIABLES.map((variable) => `\`${variable.name}\` — ${variable.description}`).join(
    '\n',
  );
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('Welcome messages, join cards and join auto-roles')
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Show the welcome configuration'),
      )
      .addSubcommand((sub) =>
        sub.setName('variables').setDescription('List the placeholders you can use in messages'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Set the welcome channel')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('message')
          .setDescription('Set the welcome message (supports placeholders)')
          .addStringOption((option) =>
            option
              .setName('text')
              .setDescription('Message text')
              .setRequired(true)
              .setMaxLength(2000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('dm')
          .setDescription('Send a DM to joining members')
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enable the DM').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('message')
              .setDescription('DM text (placeholders allowed)')
              .setMaxLength(2000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('style')
          .setDescription('Customise the welcome embed')
          .addBooleanOption((option) =>
            option.setName('embed').setDescription('Use an embed instead of plain text'),
          )
          .addBooleanOption((option) =>
            option.setName('card').setDescription('Attach a generated welcome card image'),
          )
          .addBooleanOption((option) =>
            option.setName('thumbnail').setDescription('Show the member avatar as thumbnail'),
          )
          .addStringOption((option) =>
            option.setName('color').setDescription('Embed colour as #RRGGBB'),
          )
          .addStringOption((option) => option.setName('image').setDescription('Banner image URL'))
          .addStringOption((option) => option.setName('title').setDescription('Embed title')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('autorole')
          .setDescription('Roles granted on join')
          .addRoleOption((option) => option.setName('role').setDescription('Role to add'))
          .addBooleanOption((option) =>
            option.setName('remove').setDescription('Remove the role instead of adding it'),
          )
          .addIntegerOption((option) =>
            option
              .setName('min_age_days')
              .setDescription('Only auto-role accounts older than N days')
              .setMinValue(0)
              .setMaxValue(365),
          )
          .addBooleanOption((option) =>
            option.setName('apply_now').setDescription('Apply the change to every existing member'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('Enable or disable welcome messages')
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enabled?').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('test').setDescription('Send a test welcome message using your own account'),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.welcome.getWelcomeSettings(guild.id);
      const update = async (patch: Record<string, unknown>) =>
        services.settings.update(guild.id, 'welcome', patch, {
          actorId: interaction.user.id,
          source: 'command',
        });

      if (sub === 'variables') {
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🏷️ Welcome placeholders')
              .setDescription(variablesHelp()),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('👋 Welcome configuration')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                {
                  name: 'Channel',
                  value: settings.channelId ? `<#${settings.channelId}>` : 'not set',
                  inline: true,
                },
                { name: 'Embed', value: settings.useEmbed ? 'yes' : 'no', inline: true },
                {
                  name: 'Avatar thumbnail',
                  value: settings.thumbnail ? 'yes' : 'no',
                  inline: true,
                },
                { name: 'DM enabled', value: settings.dmEnabled ? 'yes' : 'no', inline: true },
                {
                  name: 'Banner',
                  value: settings.imageUrl ? truncate(settings.imageUrl, 80) : 'none',
                  inline: true,
                },
                {
                  name: 'Auto-roles',
                  value: settings.autoRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none',
                },
                {
                  name: 'Minimum account age',
                  value:
                    settings.minAccountAgeDays > 0
                      ? `${settings.minAccountAgeDays} day(s)`
                      : 'none',
                  inline: true,
                },
                { name: 'Message', value: truncate(settings.message, 500) },
                {
                  name: 'DM message',
                  value: settings.dmMessage ? truncate(settings.dmMessage, 300) : 'not set',
                },
              ),
          ],
        });
        return;
      }
      if (sub === 'test') {
        if (!settings.channelId)
          throw new UserFacingError('Set a welcome channel first with `/welcome channel`.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await services.welcome.handleJoin(guild, member, { test: true });
        await interaction.editReply({
          embeds: [successEmbed(`Test welcome message sent to <#${settings.channelId}>.`)],
        });
        return;
      }
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'welcome configuration');

      if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel', true);
        const updated = await update({ channelId: channel.id, enabled: true });
        await interaction.reply({
          embeds: [successEmbed(`Welcome messages enabled in <#${channel.id}>.`)],
          flags: MessageFlags.Ephemeral,
        });
        void updated;
        return;
      }
      if (sub === 'message') {
        const text = interaction.options.getString('text', true);
        await update({ message: text, enabled: true });
        const sample = services.welcome.preview(guild, member, text);
        await interaction.reply({
          embeds: [
            successEmbed(
              `Welcome message updated.\n\nPreview as plain text:\n${truncate(sample.plain, 1000)}`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'dm') {
        const enabled = interaction.options.getBoolean('enabled', true);
        const message = interaction.options.getString('message');
        const patch: Record<string, unknown> = { dmEnabled: enabled };
        if (message) patch.dmMessage = message;
        await update(patch);
        await interaction.reply({
          embeds: [successEmbed(enabled ? 'Welcome DMs enabled.' : 'Welcome DMs disabled.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'style') {
        const embed = interaction.options.getBoolean('embed');
        const thumbnail = interaction.options.getBoolean('thumbnail');
        const color = interaction.options.getString('color');
        const image = interaction.options.getString('image');
        const title = interaction.options.getString('title');
        const patch: Record<string, unknown> = {};
        if (embed !== null) patch.useEmbed = embed;
        if (thumbnail !== null) patch.thumbnail = thumbnail;
        if (color) patch.embedColor = color;
        if (image) {
          if (!/^https?:\/\//i.test(image))
            throw new UserFacingError('`image` must be an http(s) URL.');
          patch.imageUrl = image;
        }
        if (title !== null) patch.title = title;
        const updated = await update(patch);
        void updated;
        await interaction.reply({
          embeds: [successEmbed('Welcome style updated.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'autorole') {
        const role = interaction.options.getRole('role');
        const remove = interaction.options.getBoolean('remove') ?? false;
        const minAge = interaction.options.getInteger('min_age_days');
        const applyNow = interaction.options.getBoolean('apply_now') ?? false;
        if (!role && minAge === null)
          throw new UserFacingError('Provide a `role` and/or `min_age_days`.');
        const autoRoleIds = role
          ? remove
            ? settings.autoRoleIds.filter((id) => id !== role.id)
            : [...new Set([...settings.autoRoleIds, role.id])]
          : settings.autoRoleIds;
        const patch: Record<string, unknown> = { autoRoleIds, enabled: true };
        if (minAge !== null) patch.minAccountAgeDays = minAge;
        await update(patch);
        let applied = 0;
        if (applyNow && role && !remove) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          applied = await services.welcome.grantRoleToEveryone(guild, role.id);
          await interaction.editReply({
            embeds: [
              successEmbed(
                `<@&${role.id}> auto-role saved and granted to ${applied} existing member(s).`,
              ),
            ],
          });
          return;
        }
        await interaction.reply({
          embeds: [
            successEmbed(
              role
                ? `${remove ? 'Removed' : 'Added'} <@&${role.id}> ${remove ? 'from' : 'to'} the join auto-roles.${applyNow ? '' : ' Existing members are untouched — use `apply_now:true` to backfill.'}\nYour role must sit below the bot’s highest role for this to work.`
                : `Minimum account age set to ${String(minAge)} day(s).`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled && !settings.channelId)
        throw new UserFacingError('Set a welcome channel first with `/welcome channel`.');
      await update({ enabled });
      await interaction.reply({
        embeds: [
          enabled
            ? successEmbed('Welcome messages enabled.')
            : warningEmbed('Welcome messages disabled.'),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('goodbye')
      .setDescription('Goodbye messages for members that leave')
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Show the goodbye configuration'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Set the goodbye channel')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('message')
          .setDescription('Set the goodbye message')
          .addStringOption((option) =>
            option
              .setName('text')
              .setDescription('Message text (placeholders allowed)')
              .setRequired(true)
              .setMaxLength(2000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('Enable or disable goodbye messages')
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enabled?').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('test').setDescription('Send a test goodbye message')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.welcome.getLeaveSettings(guild.id);
      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.danger : COLORS.warning)
              .setTitle('👋 Goodbye configuration')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                {
                  name: 'Channel',
                  value: settings.channelId ? `<#${settings.channelId}>` : 'not set',
                  inline: true,
                },
                { name: 'Embed', value: settings.useEmbed ? 'yes' : 'no', inline: true },
                { name: 'Message', value: truncate(settings.message, 500) },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'goodbye configuration');
      if (sub === 'test') {
        if (!settings.channelId) throw new UserFacingError('Set a goodbye channel first.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await services.welcome.handleLeave(guild, member, { test: true });
        await interaction.editReply({
          embeds: [successEmbed(`Test goodbye message sent to <#${settings.channelId}>.`)],
        });
        return;
      }
      if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel', true);
        await services.settings.update(
          guild.id,
          'leave',
          { channelId: channel.id, enabled: true },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [successEmbed(`Goodbye messages enabled in <#${channel.id}>.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'message') {
        const text = interaction.options.getString('text', true);
        await services.settings.update(
          guild.id,
          'leave',
          { message: text, enabled: true },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [successEmbed('Goodbye message updated.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled && !settings.channelId) throw new UserFacingError('Set a goodbye channel first.');
      await services.settings.update(
        guild.id,
        'leave',
        { enabled },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({
        embeds: [
          enabled
            ? successEmbed('Goodbye messages enabled.')
            : warningEmbed('Goodbye messages disabled.'),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('autorole')
      .setDescription('Automatic roles: join roles, bot roles and backfilling')
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Show the configured join auto-roles'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('human')
          .setDescription('Add or remove a role granted to every human on join')
          .addRoleOption((option) =>
            option.setName('role').setDescription('Role').setRequired(true),
          )
          .addBooleanOption((option) =>
            option.setName('remove').setDescription('Remove instead of add'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('bot')
          .setDescription('Add or remove a role granted to every bot on join')
          .addRoleOption((option) =>
            option.setName('role').setDescription('Role').setRequired(true),
          )
          .addBooleanOption((option) =>
            option.setName('remove').setDescription('Remove instead of add'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('sync')
          .setDescription('Grant the configured join roles to every member that is missing them')
          .addBooleanOption((option) =>
            option.setName('dry_run').setDescription('Only report what would change'),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      requireUserPermissions(member, [PermissionFlagsBits.ManageRoles], 'autorole configuration');
      const sub = interaction.options.getSubcommand(true);
      const welcome = await services.welcome.getWelcomeSettings(guild.id);
      const general = await services.settings.get<{ botRoleIds?: string[] }>(guild.id, 'general');

      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🎭 Autorole configuration')
              .addFields(
                {
                  name: 'Join roles',
                  value: welcome.autoRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none',
                },
                {
                  name: 'Bot join roles',
                  value: general.botRoleIds?.length
                    ? general.botRoleIds.map((id) => `<@&${id}>`).join(' ')
                    : 'none',
                },
                {
                  name: 'Minimum account age',
                  value:
                    welcome.minAccountAgeDays > 0 ? `${welcome.minAccountAgeDays} day(s)` : 'none',
                },
              )
              .setFooter({
                text: 'Roles are skipped when the bot lacks Manage Roles or the role is above its highest role.',
              }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'human' || sub === 'bot') {
        const role = interaction.options.getRole('role', true);
        const remove = interaction.options.getBoolean('remove') ?? false;
        const me = guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
          throw new UserFacingError('I need the **Manage Roles** permission to do that.');
        }
        if (role.position >= me.roles.highest.position && !role.managed) {
          throw new UserFacingError('That role is above my highest role, so I cannot assign it.');
        }
        if (sub === 'human') {
          const autoRoleIds = remove
            ? welcome.autoRoleIds.filter((id) => id !== role.id)
            : [...new Set([...welcome.autoRoleIds, role.id])];
          await services.settings.update(
            guild.id,
            'welcome',
            { autoRoleIds, enabled: true },
            { actorId: interaction.user.id, source: 'command' },
          );
        } else {
          const list = new Set(general.botRoleIds ?? []);
          if (remove) list.delete(role.id);
          else list.add(role.id);
          await services.settings.update(
            guild.id,
            'general',
            { botRoleIds: [...list] },
            { actorId: interaction.user.id, source: 'command' },
          );
        }
        await interaction.reply({
          embeds: [
            successEmbed(
              `${remove ? 'Removed' : 'Added'} <@&${role.id}> for ${sub === 'bot' ? 'bot' : 'human'} joins.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const dryRun = interaction.options.getBoolean('dry_run') ?? false;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const roles = welcome.autoRoleIds;
      if (roles.length === 0) throw new UserFacingError('No join roles are configured.');
      let granted = 0;
      let skipped = 0;
      let checked = 0;
      await guild.members.fetch();
      for (const target of guild.members.cache.values()) {
        if (target.user.bot) continue;
        const missing = roles.filter((roleId) => !target.roles.cache.has(roleId));
        if (missing.length === 0) continue;
        checked += 1;
        if (dryRun) continue;
        for (const roleId of missing) {
          const applied = await services.welcome.grantRoleToMember(
            guild,
            target,
            roleId,
            'Autorole backfill',
          );
          if (applied) granted += 1;
          else skipped += 1;
        }
      }
      await interaction.editReply({
        embeds: [
          successEmbed(
            dryRun
              ? `${checked} member(s) are missing at least one of ${roles.length} join role(s). No changes were made (dry run).`
              : `Backfill complete: ${granted} role(s) granted, ${skipped} skipped (hierarchy or permissions), ${checked} member(s) inspected.`,
          ),
        ],
      });
    },
  },
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('boost')
      .setDescription('Boost messages and the temporary booster role')
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the boost configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('Set the boost announcement channel')
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('message')
          .setDescription('Set the boost message ({user} and {server} supported)')
          .addStringOption((option) =>
            option
              .setName('text')
              .setDescription('Message text')
              .setRequired(true)
              .setMaxLength(2000),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('role')
          .setDescription('Set a role granted while the boost is active')
          .addRoleOption((option) => option.setName('role').setDescription('Role')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('Enable or disable boost messages')
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('Enabled?').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('test').setDescription('Preview the boost message as an embed'),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.settings.get<{
        enabled: boolean;
        channelId: string | null;
        message: string;
        useEmbed: boolean;
        embedColor: number;
        roleId: string | null;
        dmEnabled: boolean;
        dmMessage: string | null;
      }>(guild.id, 'boost');

      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('🚀 Boost configuration')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                {
                  name: 'Channel',
                  value: settings.channelId ? `<#${settings.channelId}>` : 'not set',
                  inline: true,
                },
                {
                  name: 'Booster role',
                  value: settings.roleId ? `<@&${settings.roleId}>` : 'none',
                  inline: true,
                },
                { name: 'DM on boost', value: settings.dmEnabled ? 'yes' : 'no', inline: true },
                { name: 'Message', value: truncate(settings.message, 500) },
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'test') {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(settings.embedColor || 0xf47fff)
              .setTitle('🚀 Boost preview')
              .setDescription(services.welcome.preview(guild, member, settings.message).plain),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'boost configuration');
      if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel', true);
        await services.settings.update(
          guild.id,
          'boost',
          { channelId: channel.id, enabled: true },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [successEmbed(`Boost announcements enabled in <#${channel.id}>.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'message') {
        const text = interaction.options.getString('text', true);
        await services.settings.update(
          guild.id,
          'boost',
          { message: text },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [successEmbed('Boost message updated.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'role') {
        const role = interaction.options.getRole('role');
        if (role) {
          const me = guild.members.me;
          if (!me?.permissions.has(PermissionFlagsBits.ManageRoles))
            throw new UserFacingError('I need **Manage Roles** to assign a booster role.');
          if (role.position >= me.roles.highest.position)
            throw new UserFacingError('That role is above my highest role.');
        }
        await services.settings.update(
          guild.id,
          'boost',
          { roleId: role?.id ?? null },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              role
                ? `<@&${role.id}> will be granted while a boost is active.`
                : 'Booster role cleared.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled && !settings.channelId) throw new UserFacingError('Set a boost channel first.');
      await services.settings.update(
        guild.id,
        'boost',
        { enabled },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({
        embeds: [
          enabled
            ? successEmbed('Boost messages enabled.')
            : warningEmbed('Boost messages disabled.'),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
]);

export { formatDuration };

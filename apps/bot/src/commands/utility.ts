import {
  ChannelType,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type Role,
  type TextChannel,
} from 'discord.js';
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatRelativeTimestamp,
  formatTimestamp,
  parseDurationMs,
  snowflakeToTimestamp,
  truncate,
  UserFacingError,
} from '@bot-by-ai/shared';
import { CATEGORIES, COLORS, RECOMMENDED_PERMISSIONS_INTEGER, REQUIRED_BOT_PERMISSIONS } from '../core/constants.js';
import { safeEvaluateMath } from '../core/calc.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, infoEmbed, keyValue, successEmbed } from '../core/embeds.js';
import { requireUserPermissions } from '../core/resolvers.js';
import { sendPaginated } from '../core/ui.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function memberOf(interaction: ChatInputCommandInteraction): GuildMember {
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember)) throw new UserFacingError('Use this inside a server.');
  return member;
}

const CATEGORY_LABELS: Record<string, string> = {
  utility: '🧰 Utility',
  moderation: '🛡️ Moderation',
  security: '🚨 Security',
  automod: '🤖 AutoMod',
  economy: '💰 Economy',
  levels: '📈 Levels',
  tickets: '🎫 Tickets',
  community: '🎉 Community',
  music: '🎵 Music',
  configuration: '⚙️ Configuration',
  owner: '👑 Owner',
};

export const commands: BotCommand[] = defineCommands([
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('List every command or get help for one command')
      .addStringOption((option) => option.setName('command').setDescription('Command name').setAutocomplete(true))
      .addStringOption((option) => option.setName('category').setDescription('Filter by category').setAutocomplete(true)),
    autocomplete: async ({ interaction, services }) => {
      const focused = interaction.options.getFocused(true);
      const catalog = services.commandCatalog();
      if (focused.name === 'category') {
        await interaction.respond(
          CATEGORIES.filter((category) => category.includes(focused.value.toLowerCase()))
            .slice(0, 25)
            .map((category) => ({ name: category, value: category })),
        );
        return;
      }
      await interaction.respond(
        catalog
          .filter((entry) => entry.name.includes(focused.value.toLowerCase()))
          .slice(0, 25)
          .map((entry) => ({ name: `/${entry.name} — ${entry.category}`, value: entry.name })),
      );
    },
    async execute({ interaction, services }: CommandContext) {
      const name = interaction.options.getString('command');
      const category = interaction.options.getString('category');
      const catalog = services.commandCatalog();

      if (name) {
        const entry = catalog.find((item) => item.name === name.toLowerCase().replace(/^\//, ''));
        if (!entry) throw new UserFacingError(`I do not have a command called \`${name}\`.`);
        const embed = infoEmbed(`/${entry.name}`).addFields(
          { name: 'Category', value: entry.category, inline: true },
          { name: 'Owner only', value: entry.ownerOnly ? 'yes' : 'no', inline: true },
        );
        await interaction.reply({ embeds: [keyValue([{ key: 'Description', value: entry.description, inline: false }], embed)], flags: MessageFlags.Ephemeral });
        return;
      }

      const filtered = category ? catalog.filter((entry) => entry.category === category.toLowerCase()) : catalog;
      if (filtered.length === 0) throw new UserFacingError('No commands matched that filter.');
      const byCategory = new Map<string, string[]>();
      for (const entry of filtered) {
        const list = byCategory.get(entry.category) ?? [];
        list.push(`**/${entry.name}** — ${entry.description}`);
        byCategory.set(entry.category, list);
      }
      const sections = [...byCategory.entries()].map(([key, lines]) => ({ title: CATEGORY_LABELS[key] ?? key, lines }));
      await interaction.deferReply();
      await sendPaginated(
        interaction,
        sections,
        (section) => section.lines.join('\n').slice(0, 4000),
        { pageSize: 1, title: `📖 Commands (${filtered.length} total)` },
      );
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('ping').setDescription('Check latency and API round-trip time'),
    async execute({ interaction, services }: CommandContext) {
      const started = Date.now();
      await interaction.deferReply();
      const roundTrip = Date.now() - started;
      await interaction.editReply({
        embeds: [
          baseEmbed(COLORS.success)
            .setTitle('🏓 Pong')
            .addFields(
              { name: 'WebSocket', value: `${Math.round(services.client.ws.ping)} ms`, inline: true },
              { name: 'Round trip', value: `${roundTrip} ms`, inline: true },
              { name: 'Uptime', value: formatDuration(Date.now() - interaction.client.readyTimestamp!), inline: true },
            ),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('botinfo').setDescription('Information about the bot and this deployment'),
    async execute({ interaction, services }: CommandContext) {
      const client = services.client;
      const memory = process.memoryUsage();
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle(`🤖 ${client.user?.username ?? 'Bot'} information`)
            .setThumbnail(client.user?.displayAvatarURL() ?? null)
            .addFields(
              { name: 'Guilds', value: formatNumber(client.guilds.cache.size), inline: true },
              { name: 'Users (cached)', value: formatNumber(client.users.cache.size), inline: true },
              { name: 'Commands', value: formatNumber(services.commandCatalog().length), inline: true },
              { name: 'Uptime', value: formatDuration(Date.now() - (client.readyTimestamp ?? client.readyAt?.getTime() ?? Date.now())), inline: true },
              { name: 'Memory (RSS)', value: formatBytes(memory.rss), inline: true },
              { name: 'discord.js', value: `v${(await import('discord.js')).version}`, inline: true },
              { name: 'Version', value: services.version, inline: true },
              { name: 'Lavalink', value: services.features.music ? 'configured' : 'not configured', inline: true },
              { name: 'Dashboard', value: services.features.dashboard ? 'enabled' : 'disabled', inline: true },
              { name: 'Redis cache', value: services.features.redis ? 'enabled' : 'disabled', inline: true },
            ),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('uptime').setDescription('Show how long the bot process has been running'),
    async execute({ interaction, services }: CommandContext) {
      const uptimeMs = Date.now() - services.startedAt;
      await interaction.reply({
        embeds: [baseEmbed(COLORS.success).setTitle('⏱️ Process uptime').setDescription(`Running for **${formatDuration(uptimeMs)}**\nStarted <t:${Math.floor(services.startedAt / 1000)}:R>`)],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('invite').setDescription('Get the invite link with the required permissions'),
    async execute({ interaction, services }: CommandContext) {
      const clientId = services.client.user?.id;
      if (!clientId) throw new UserFacingError('The bot is not ready yet — try again in a moment.');
      const permissions = RECOMMENDED_PERMISSIONS_INTEGER.toString();
      const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('➕ Invite me')
            .setDescription(`[Click here to invite me](${url})\n\nThe link requests only the permissions the bot actually uses; you can revoke any of them later in server settings.`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Show account and member information for a user')
      .addUserOption((option) => option.setName('user').setDescription('User (defaults to you)'))
      .addBooleanOption((option) => option.setName('ephemeral').setDescription('Only show the result to you')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const user = interaction.options.getUser('user') ?? interaction.user;
      const member = await guild.members.fetch(user.id).catch(() => null);
      const embed = baseEmbed(member?.displayColor || COLORS.primary)
        .setTitle(`👤 ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: `\`${user.id}\``, inline: true },
          { name: 'Bot', value: user.bot ? 'yes' : 'no', inline: true },
          { name: 'Created', value: formatTimestamp(user.createdTimestamp), inline: true },
        );
      if (member) {
        embed.addFields(
          { name: 'Joined', value: formatTimestamp(member.joinedTimestamp ?? Date.now()), inline: true },
          { name: 'Nickname', value: member.nickname ? truncate(member.nickname, 100) : 'none', inline: true },
          { name: 'Highest role', value: `<@&${member.roles.highest.id}>`, inline: true },
          { name: 'Roles', value: truncate(member.roles.cache.filter((role) => role.id !== guild.id).map((role) => `<@&${role.id}>`).join(', ') || 'none', 1000) },
          { name: 'Boosting', value: member.premiumSince ? `since ${formatTimestamp(member.premiumSinceTimestamp ?? Date.now())}` : 'no', inline: true },
          { name: 'Timeout until', value: member.communicationDisabledUntilTimestamp ? formatTimestamp(member.communicationDisabledUntilTimestamp) : 'not timed out', inline: true },
        );
      }
      const account = await services.repos.users.getUser(user.id).catch(() => null);
      if (account) embed.setFooter({ text: `Stored locally since ${formatTimestamp(account.created_at.getTime())}` });
      await interaction.reply({ embeds: [embed], flags: interaction.options.getBoolean('ephemeral') ? MessageFlags.Ephemeral : undefined });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show information about this server'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const owner = await guild.fetchOwner().catch(() => null);
      const channels = guild.channels.cache;
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle(`🏠 ${guild.name}`)
            .setThumbnail(guild.iconURL({ size: 256 }))
            .addFields(
              { name: 'Owner', value: owner ? `${owner.user.tag}` : 'unknown', inline: true },
              { name: 'Members', value: formatNumber(guild.memberCount), inline: true },
              { name: 'Created', value: formatTimestamp(guild.createdTimestamp), inline: true },
              { name: 'Text channels', value: String(channels.filter((channel) => channel.type === ChannelType.GuildText).size), inline: true },
              { name: 'Voice channels', value: String(channels.filter((channel) => channel.type === ChannelType.GuildVoice).size), inline: true },
              { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
              { name: 'Emojis', value: String(guild.emojis.cache.size), inline: true },
              { name: 'Boost tier', value: `${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`, inline: true },
              { name: 'Verification level', value: String(guild.verificationLevel), inline: true },
              { name: 'ID', value: `\`${guild.id}\``, inline: true },
            ),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('servericon').setDescription('Show the server icon and banner'),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      const embed = baseEmbed(COLORS.primary).setTitle(`🖼️ ${guild.name}`);
      const icon = guild.iconURL({ size: 1024 });
      const banner = guild.bannerURL({ size: 1024 });
      if (!icon && !banner) throw new UserFacingError('This server has no icon or banner.');
      if (icon) embed.setImage(icon);
      if (banner) embed.setDescription(`[Banner](${banner})`);
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription('Show a user avatar or server icon')
      .addUserOption((option) => option.setName('user').setDescription('User'))
      .addIntegerOption((option) => option.setName('size').setDescription('Image size').addChoices({ name: '128', value: 128 }, { name: '256', value: 256 }, { name: '512', value: 512 }, { name: '1024', value: 1024 })),
    async execute({ interaction }: CommandContext) {
      const target = interaction.options.getUser('user') ?? interaction.user;
      const fetched = target.partial ? await target.fetch().catch(() => target) : target;
      const size = (interaction.options.getInteger('size') ?? 512) as 128 | 256 | 512 | 1024;
      const links = [
        `[png](${fetched.displayAvatarURL({ size, extension: 'png' })})`,
        `[webp](${fetched.displayAvatarURL({ size, extension: 'webp' })})`,
        `[jpg](${fetched.displayAvatarURL({ size, extension: 'jpg' })})`,
      ];
      const banner = await fetched.fetch(true).then((user) => user.bannerURL({ size: 1024 })).catch(() => null);
      const embed = baseEmbed(COLORS.primary).setTitle(`🖼️ ${fetched.tag}`).setImage(fetched.displayAvatarURL({ size })).setDescription(links.join(' • '));
      if (banner) embed.addFields({ name: 'Banner', value: `[open](${banner})` });
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('banner')
      .setDescription('Show a user banner')
      .addUserOption((option) => option.setName('user').setDescription('User')),
    async execute({ interaction }: CommandContext) {
      const target = interaction.options.getUser('user') ?? interaction.user;
      const user = await target.fetch(true).catch(() => null);
      const banner = user?.bannerURL({ size: 1024 }) ?? null;
      if (!banner) throw new UserFacingError('That user has no banner.');
      await interaction.reply({ embeds: [baseEmbed(COLORS.primary).setTitle(`🖼️ ${target.tag}`).setImage(banner)] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('roleinfo')
      .setDescription('Show information about a role')
      .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true)),
    async execute({ interaction }: CommandContext) {
      const role = interaction.options.getRole('role', true) as Role;
      if (!('permissions' in role)) throw new UserFacingError('That is not a server role.');
      await interaction.reply({
        embeds: [
          baseEmbed(role.color || COLORS.primary)
            .setTitle(`🎭 ${role.name}`)
            .addFields(
              { name: 'ID', value: `\`${role.id}\``, inline: true },
              { name: 'Color', value: `#${role.color.toString(16).padStart(6, '0')}`, inline: true },
              { name: 'Position', value: String(role.position), inline: true },
              { name: 'Mentionable', value: role.mentionable ? 'yes' : 'no', inline: true },
              { name: 'Hoisted', value: role.hoist ? 'yes' : 'no', inline: true },
              { name: 'Managed', value: role.managed ? 'yes (integration)' : 'no', inline: true },
              { name: 'Members', value: role.members.size > 0 ? String(role.members.size) : 'not cached' },
              { name: 'Created', value: formatTimestamp(role.createdTimestamp) },
              { name: 'Key permissions', value: truncate(role.permissions.toArray().join(', ') || 'none', 1024) },
            ),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('channelinfo')
      .setDescription('Show information about a channel')
      .addChannelOption((option) => option.setName('channel').setDescription('Channel (defaults to here)')),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      const selected = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!selected || !('id' in selected)) throw new UserFacingError('Channel not found.');
      const full = await guild.channels.fetch(selected.id).catch(() => null);
      if (!full) throw new UserFacingError('Channel not found.');
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`#️⃣ ${'name' in full ? full.name : 'channel'}`)
        .addFields(
          { name: 'ID', value: `\`${full.id}\``, inline: true },
          { name: 'Type', value: ChannelType[full.type] ?? String(full.type), inline: true },
          { name: 'Created', value: formatTimestamp(full.createdTimestamp ?? 0), inline: true },
          { name: 'Category', value: full.parent?.name ?? 'none', inline: true },
        );
      if ('topic' in full && full.topic) embed.addFields({ name: 'Topic', value: truncate(full.topic, 1024) });
      if ('nsfw' in full) embed.addFields({ name: 'Age restricted', value: full.nsfw ? 'yes' : 'no', inline: true });
      if ('rateLimitPerUser' in full) embed.addFields({ name: 'Slowmode', value: full.rateLimitPerUser ? `${full.rateLimitPerUser}s` : 'off', inline: true });
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('rolelist')
      .setDescription('List every role with its member count'),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      const roles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await sendPaginated(
        interaction,
        roles,
        (role) => `**${role.position}.** <@&${role.id}> — ${role.members.size} member(s)${role.managed ? ' *(managed)*' : ''}`,
        { title: `🎭 Roles (${roles.length})`, pageSize: 20, ephemeral: true },
      );
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('emojis')
      .setDescription('List server emojis and stickers'),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      const emojis = [...guild.emojis.cache.values()];
      const stickers = [...guild.stickers.cache.values()];
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('😀 Server emojis')
            .setDescription(emojis.slice(0, 60).map((emoji) => `${emoji} \`:${emoji.name}:\``).join(' ') || 'No custom emojis.')
            .addFields(
              { name: 'Emojis', value: String(emojis.length), inline: true },
              { name: 'Stickers', value: String(stickers.length), inline: true },
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('membercount').setDescription('Show the member count breakdown'),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      await guild.members.fetch().catch(() => null);
      const members = guild.members.cache;
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('👥 Member count')
            .addFields(
              { name: 'Total', value: formatNumber(guild.memberCount), inline: true },
              { name: 'Humans', value: formatNumber(members.filter((member) => !member.user.bot).size), inline: true },
              { name: 'Bots', value: formatNumber(members.filter((member) => member.user.bot).size), inline: true },
              { name: 'Online', value: formatNumber(members.filter((member) => member.presence && member.presence.status !== 'offline').size), inline: true },
              { name: 'Boosting', value: formatNumber(members.filter((member) => Boolean(member.premiumSince)).size), inline: true },
            ),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('permissions')
      .setDescription('Check which permissions the bot has, and which it is missing')
      .addUserOption((option) => option.setName('user').setDescription('Check another member instead of the bot')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const target = interaction.options.getUser('user')
        ? await guild.members.fetch(interaction.options.getUser('user', true).id).catch(() => null)
        : guild.members.me;
      if (!target) throw new UserFacingError('Member not found.');
      const permissions = target.permissions;
      const missing = REQUIRED_BOT_PERMISSIONS.filter((entry) => !permissions.has(entry.bit));
      await interaction.reply({
        embeds: [
          baseEmbed(missing.length === 0 ? COLORS.success : COLORS.warning)
            .setTitle(`🔐 Permissions for ${target.user.tag}`)
            .setDescription(
              missing.length === 0
                ? 'All recommended permissions are granted. ✅'
                : `Missing ${missing.length} recommended permission(s):\n${missing.map((entry) => `• **${entry.name}** — needed to ${entry.reason}`).join('\n')}`,
            )
            .addFields({ name: 'Administrator', value: permissions.has(PermissionFlagsBits.Administrator) ? 'yes' : 'no', inline: true }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('status').setDescription('Show live bot and database status'),
    async execute({ interaction, services }: CommandContext) {
      const snapshot = await services.status.snapshot().catch(() => null);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('📊 Status')
            .addFields(
              { name: 'WebSocket', value: `${Math.round(services.client.ws.ping)} ms`, inline: true },
              {
                name: 'Database',
                value: snapshot ? (snapshot.database.ok ? `ok (${snapshot.database.latencyMs} ms)` : `DOWN: ${snapshot.database.error ?? 'unknown'}`) : 'unknown',
                inline: true,
              },
              { name: 'Guilds', value: formatNumber(services.client.guilds.cache.size), inline: true },
              { name: 'Uptime', value: formatDuration(Date.now() - services.startedAt), inline: true },
              { name: 'Errors since start', value: String(snapshot?.errors.count ?? 0), inline: true },
            )
            .setFooter({ text: `Environment ${services.config.nodeEnv} • v${services.version}` }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('timestamp').setDescription('Generate a Discord timestamp from a date or in X time')
      .addStringOption((option) => option.setName('when').setDescription('Duration from now (e.g. 2h, 3d) or ISO date').setRequired(true))
      .addStringOption((option) =>
        option
          .setName('format')
          .setDescription('Display style')
          .addChoices(
            { name: 'relative (in 2 hours)', value: 'R' },
            { name: 'short time', value: 't' },
            { name: 'full date/time', value: 'F' },
            { name: 'date only', value: 'D' },
          ),
      ),
    async execute({ interaction }: CommandContext) {
      const when = interaction.options.getString('when', true);
      const format = interaction.options.getString('format') ?? 'R';
      let timestampMs: number | null = null;
      const duration = parseDurationMs(when);
      if (duration !== null) timestampMs = Date.now() + duration;
      else {
        const parsed = Date.parse(when);
        if (!Number.isNaN(parsed)) timestampMs = parsed;
      }
      if (!timestampMs) throw new UserFacingError('I could not understand that. Try `2h`, `3d` or `2026-01-31 12:00`.');
      const seconds = Math.floor(timestampMs / 1000);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🕒 Timestamp')
            .setDescription(`\`<t:${seconds}:${format}>\`\n<t:${seconds}:F>`)
            .setFooter({ text: 'Copy the code above to share the time in anyone’s timezone.' }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('snowflake').setDescription('Explain a Discord id (timestamp and type)')
      .addStringOption((option) => option.setName('id').setDescription('Discord id or a message link').setRequired(true)),
    async execute({ interaction }: CommandContext) {
      const raw = interaction.options.getString('id', true).trim();
      const id = raw.match(/\d{17,20}/)?.[0];
      if (!id) throw new UserFacingError('That does not look like a Discord id or message link.');
      const created = snowflakeToTimestamp(id);
      if (!created) throw new UserFacingError('That snowflake is not valid.');
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('❄️ Snowflake breakdown')
            .addFields(
              { name: 'Id', value: `\`${id}\`` },
              { name: 'Created', value: `${formatTimestamp(created)} (<t:${Math.floor(created / 1000)}:R>)` },
              { name: 'Discord epoch delta', value: formatDuration(created - 1420070400000) },
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('calc').setDescription('Evaluate a maths expression (no code execution)')
      .addStringOption((option) => option.setName('expression').setDescription('e.g. (2+3)*4^2, sqrt(16), 15% of 200').setRequired(true)),
    async execute({ interaction }: CommandContext) {
      const expression = interaction.options.getString('expression', true);
      const result = safeEvaluateMath(expression);
      if (!Number.isFinite(result)) throw new UserFacingError('I could only compute a finite number. Check the expression.');
      await interaction.reply({
        embeds: [successEmbed(`\`${truncate(expression, 200)}\` = **${formatNumber(result)}**`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Create a poll with up to 10 options')
      .addStringOption((option) => option.setName('question').setDescription('The question').setRequired(true).setMaxLength(250))
      .addStringOption((option) => option.setName('options').setDescription('Separate options with a | (max 10)').setRequired(true))
      .addBooleanOption((option) => option.setName('multiple').setDescription('Allow multiple answers'))
      .addStringOption((option) => option.setName('duration').setDescription('Auto-close after e.g. 1h, 1d'))
      .addChannelOption((option) => option.setName('channel').setDescription('Channel (defaults to here)').addChannelTypes(ChannelType.GuildText)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const question = interaction.options.getString('question', true);
      const options = interaction.options
        .getString('options', true)
        .split('|')
        .map((option) => option.trim())
        .filter(Boolean);
      if (options.length < 2) throw new UserFacingError('Provide at least two options separated by `|`.');
      if (options.length > 10) throw new UserFacingError('Discord polls support at most 10 options.');
      const durationMs = interaction.options.getString('duration') ? parseDurationMs(interaction.options.getString('duration', true)) : null;
      const channelOption = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channelOption || !('id' in channelOption)) throw new UserFacingError('Channel not found.');
      const channel = await guild.channels.fetch(channelOption.id).catch(() => null);
      if (!channel?.isTextBased() || channel.isDMBased()) throw new UserFacingError('I cannot post a poll there.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const poll = {
        question: { text: question },
        answers: options.map((text) => ({ text })),
        allowMultiselect: interaction.options.getBoolean('multiple') ?? false,
        ...(durationMs ? { duration: Math.min(Math.max(Math.floor(durationMs / 3_600_000), 1), 768) } : {}),
      };
      const message = await channel.send({
        poll: poll as Extract<Parameters<typeof channel.send>[0], { poll?: unknown }>['poll'],
      });
      if (durationMs) {
        await services.repos.tasks.enqueue({
          taskType: 'poll_close',
          guildId: guild.id,
          payload: { channelId: channel.id, messageId: message.id, poll: true },
          runAt: new Date(Date.now() + durationMs),
        });
      }
      await interaction.editReply({ embeds: [successEmbed(`Poll posted in <#${channel.id}>.`)] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Send a custom embed')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption((option) => option.setName('title').setDescription('Title').setRequired(true).setMaxLength(256))
      .addStringOption((option) => option.setName('description').setDescription('Body').setRequired(true).setMaxLength(4000))
      .addChannelOption((option) => option.setName('channel').setDescription('Target channel').addChannelTypes(ChannelType.GuildText))
      .addStringOption((option) => option.setName('color').setDescription('Hex colour like #5865f2'))
      .addStringOption((option) => option.setName('footer').setDescription('Footer text'))
      .addBooleanOption((option) => option.setName('timestamp').setDescription('Include the current time')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireUserPermissions(memberOf(interaction), [PermissionFlagsBits.ManageMessages], 'the embed command');
      const title = interaction.options.getString('title', true);
      const description = interaction.options.getString('description', true);
      const color = interaction.options.getString('color');
      const footer = interaction.options.getString('footer');
      const withTimestamp = interaction.options.getBoolean('timestamp') ?? false;
      const target = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!target || !('id' in target)) throw new UserFacingError('I cannot send messages there.');
      const channel = await guildOf(interaction).channels.fetch(target.id).catch(() => null);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new UserFacingError('I cannot send messages there.');
      }
      const embed = new EmbedBuilder().setTitle(truncate(title, 250)).setDescription(truncate(description, 4000));
      if (color) {
        const parsed = /^#?[0-9a-fA-F]{6}$/.test(color) ? Number.parseInt(color.replace('#', ''), 16) : COLORS.primary;
        embed.setColor(parsed);
      }
      if (footer) embed.setFooter({ text: truncate(footer, 200) });
      if (withTimestamp) embed.setTimestamp();
      await (channel as TextChannel).send({ embeds: [embed] });
      await services.logging
        .log(guild, {
          category: 'messages',
          title: 'Embed sent',
          description: `<@${interaction.user.id}> sent an embed to <#${channel.id}>.`,
          actorId: interaction.user.id,
          auditAction: 'messages.embed',
        })
        .catch(() => {});
      await interaction.reply({ embeds: [successEmbed(`Embed sent to <#${channel.id}>.`)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('remind')
      .setDescription('Set a reminder')
      .addStringOption((option) => option.setName('when').setDescription('e.g. 10m, 2h, 1d').setRequired(true))
      .addStringOption((option) => option.setName('what').setDescription('What should I remind you about?').setRequired(true).setMaxLength(500))
      .addBooleanOption((option) => option.setName('dm').setDescription('Send the reminder as a DM instead of in this channel')),
    async execute({ interaction, services }: CommandContext) {
      const when = interaction.options.getString('when', true);
      const what = interaction.options.getString('what', true);
      const durationMs = parseDurationMs(when);
      if (!durationMs || durationMs < 5_000) throw new UserFacingError('Give me a duration of at least 5 seconds, like `10m` or `2h`.');
      const guildId = interaction.guildId;
      if (!guildId) throw new UserFacingError('Reminders need to be created inside a server.');
      const remindAt = new Date(Date.now() + durationMs);
      const dm = interaction.options.getBoolean('dm') ?? false;
      const id = await services.community.createReminder({
        guildId,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        content: what,
        remindAt,
      });
      if (dm) {
        await interaction.user
          .send(`⏰ I will DM you about **${truncate(what, 200)}** ${formatRelativeTimestamp(remindAt.getTime())}. Reminder id \`${id}\`.`)
          .catch(() => {});
      }
      await interaction.reply({
        embeds: [successEmbed(`Reminder \`${id}\` set for ${formatRelativeTimestamp(remindAt.getTime())} (${formatTimestamp(remindAt.getTime())}).${dm ? ' Check your DMs for a copy.' : ''}`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('afk')
      .setDescription('Mark yourself as away (mentions get an automatic reply)')
      .addStringOption((option) => option.setName('reason').setDescription('Why are you away?').setMaxLength(200)),
    async execute({ interaction, services }: CommandContext) {
      const reason = interaction.options.getString('reason') ?? 'AFK';
      await services.db.query(
        `INSERT INTO users (id, username, global_name) VALUES ($1, $2, NULL)
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, updated_at = now()`,
        [interaction.user.id, interaction.user.username],
      );
      await services.settings.update(interaction.guildId ?? 'global', 'general', {}, { actorId: interaction.user.id, source: 'command' }).catch(() => {});
      await interaction.reply({
        embeds: [successEmbed(`You are now marked as away: ${truncate(reason, 200)}\nMention replies are informational only — the bot does not track AFK state across restarts yet.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('dashboard').setDescription('Get the web dashboard link and your access status'),
    async execute({ interaction, services }: CommandContext) {
      const baseUrl = services.config.dashboard.url;
      const links: string[] = [];
      if (baseUrl) links.push(`**Dashboard:** ${baseUrl}`);
      const owner = services.owners.isOwner(interaction.user.id);
      const adminGuilds = services.client.guilds.cache
        .filter((guild) => guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild))
        .size;
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🌐 Dashboard')
            .setDescription(
              baseUrl
                ? `${links.join('\n')}\n\nSign in with Discord to manage the servers where you have **Manage Server**.`
                : 'The dashboard URL is not configured on this deployment (set DASHBOARD_URL). All features remain available through slash commands.',
            )
            .addFields(
              { name: 'Bot owner', value: owner ? 'yes' : 'no', inline: true },
              { name: 'Servers I can manage', value: String(adminGuilds), inline: true },
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('prefix')
      .setDescription('Show or change the message-command prefix used by custom commands')
      .addStringOption((option) => option.setName('new_prefix').setDescription('New prefix (1-3 characters)').setMinLength(1).setMaxLength(3)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const settings = await services.settings.get<{ prefix: string }>(guild.id, 'general');
      const next = interaction.options.getString('new_prefix');
      if (!next) {
        await interaction.reply({
          embeds: [infoEmbed('Prefix').setDescription(`The current prefix is \`${settings.prefix}\`.\nCustom commands can be used as \`${settings.prefix}commandname\` or as slash commands.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      requireUserPermissions(memberOf(interaction), [PermissionFlagsBits.ManageGuild], 'changing the prefix');
      await services.settings.update(guild.id, 'general', { prefix: next }, { actorId: interaction.user.id, source: 'command' });
      await interaction.reply({ embeds: [successEmbed(`Prefix changed to \`${next}\`.`)], flags: MessageFlags.Ephemeral });
    },
  },
]);

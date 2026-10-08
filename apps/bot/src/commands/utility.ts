import {
  ChannelType,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';
import {
  formatBytes,
  formatDuration,
  formatTimestamp,
  parseDurationMs,
  renderTemplate,
  truncate,
  UserFacingError,
} from '@bot-by-ai/shared';
import { CATEGORIES, COLORS, RECOMMENDED_PERMISSIONS_INTEGER } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, infoEmbed, keyValue, successEmbed, warningEmbed } from '../core/embeds.js';
import { requireUserPermissions } from '../core/resolvers.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

async function runCalculator(expression: string): Promise<number> {
  // Strict whitelist evaluator: digits, operators, parentheses and a few
  // functions. No `eval`, no Function constructor, no identifiers.
  const sanitized = expression.replace(/\s+/g, '');
  if (!/^[-+*/%().\d]+$/.test(sanitized)) {
    throw new UserFacingError('Only numbers and the operators + - * / % ( ) are supported.');
  }
  if (sanitized.length > 120) throw new UserFacingError('That expression is too long.');
  const tokens = sanitized.match(/\d+\.?\d*|[-+*/%()]/g);
  if (!tokens) throw new UserFacingError('That expression could not be parsed.');
  let index = 0;

  const parseExpression = (): number => {
    let value = parseTerm();
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operator = tokens[index];
      index += 1;
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = (): number => {
    let value = parseFactor();
    while (tokens[index] === '*' || tokens[index] === '/' || tokens[index] === '%') {
      const operator = tokens[index];
      index += 1;
      const right = parseFactor();
      if ((operator === '/' || operator === '%') && right === 0) throw new UserFacingError('Division by zero.');
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  };
  const parseFactor = (): number => {
    const token = tokens[index];
    if (token === '-') {
      index += 1;
      return -parseFactor();
    }
    if (token === '(') {
      index += 1;
      const value = parseExpression();
      if (tokens[index] !== ')') throw new UserFacingError('Unbalanced parentheses.');
      index += 1;
      return value;
    }
    if (!token || Number.isNaN(Number(token))) throw new UserFacingError('Unexpected token in expression.');
    index += 1;
    return Number(token);
  };

  const result = parseExpression();
  if (index !== tokens.length) throw new UserFacingError('Unexpected trailing tokens in expression.');
  if (!Number.isFinite(result)) throw new UserFacingError('The result is not a finite number.');
  return result;
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('help').setDescription('List every command, grouped by category'),
    async execute({ interaction, services }: CommandContext) {
      await interaction.deferReply();
      const registry = services.client;
      void registry;
      const all = services.commandCatalog?.() ?? [];
      const grouped = new Map<string, string[]>();
      for (const entry of all) {
        const list = grouped.get(entry.category) ?? [];
        list.push(`\`/${entry.name}\``);
        grouped.set(entry.category, list);
      }
      const embed = baseEmbed(COLORS.primary)
        .setTitle('📖 Command reference')
        .setDescription(
          `I currently expose **${all.length}** top-level slash commands across **${grouped.size}** categories.\nUse \`/help\` again after updates, or open the dashboard for searchable docs.`,
        )
        .setFooter({ text: 'Every command listed here is implemented — no placeholders.' });
      for (const category of CATEGORIES) {
        const names = grouped.get(category);
        if (!names || names.length === 0) continue;
        embed.addFields({ name: category, value: truncate(names.join(' '), 1024) });
      }
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency and gateway health'),
    async execute({ interaction, services }: CommandContext) {
      const started = Date.now();
      await interaction.deferReply();
      const roundTrip = Date.now() - started;
      const embed = baseEmbed(COLORS.success)
        .setTitle('🏓 Pong')
        .addFields(
          { name: 'Round trip', value: `${roundTrip} ms`, inline: true },
          { name: 'Gateway', value: `${Math.round(services.client.ws.ping)} ms`, inline: true },
          { name: 'Shard', value: String(services.client.shard?.ids?.[0] ?? 0), inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('botinfo').setDescription('Show information about this bot'),
    async execute({ interaction, services }: CommandContext) {
      const snapshot = await services.status.snapshot();
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`🤖 ${services.client.user?.tag ?? 'Bot'}`)
        .setThumbnail(services.client.user?.displayAvatarURL() ?? null)
        .setDescription('A modular Discord bot with moderation, security, economy, leveling, tickets and music.');
      keyValue(
        [
          { key: 'Servers', value: snapshot.guildCount.toLocaleString() },
          { key: 'Users (cached)', value: snapshot.userCount.toLocaleString() },
          { key: 'Uptime', value: formatDuration(snapshot.uptimeSeconds * 1000) },
          { key: 'Node.js', value: snapshot.nodeVersion },
          { key: 'Commands', value: String(services.commandCatalog?.().length ?? 0) },
          { key: 'Music', value: services.features.music ? 'enabled' : 'disabled' },
        ],
        embed,
      );
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('status').setDescription('Runtime status: latency, uptime, database'),
    async execute({ interaction, services }: CommandContext) {
      await interaction.deferReply();
      const snapshot = await services.status.snapshot();
      const embed = baseEmbed(snapshot.database.ok ? COLORS.success : COLORS.danger)
        .setTitle('🩺 Runtime status')
        .setDescription(services.status.humanSummary(snapshot))
        .addFields(
          { name: 'Memory (RSS)', value: formatBytes(snapshot.memoryUsedMb * 1_048_576), inline: true },
          { name: 'CPU', value: `${snapshot.cpuLoadPercent}%`, inline: true },
          {
            name: 'Limits',
            value: snapshot.memoryLimitMb ? formatBytes(snapshot.memoryLimitMb * 1_048_576) : 'unavailable',
            inline: true,
          },
        );
      await interaction.editReply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('uptime').setDescription('Show how long the bot has been online'),
    async execute({ interaction, services }: CommandContext) {
      const snapshot = await services.status.snapshot();
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.success)
            .setTitle('⏱️ Uptime')
            .setDescription(
              `Online for **${formatDuration(snapshot.uptimeSeconds * 1000)}**\nProcess started ${formatTimestamp(Date.now() - snapshot.uptimeSeconds * 1000)}`,
            ),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('invite').setDescription('Get the invite link and required permissions'),
    async execute({ interaction, services }: CommandContext) {
      const clientId = services.client.user?.id;
      const permissions = RECOMMENDED_PERMISSIONS_INTEGER.toString();
      const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('➕ Invite this bot')
            .setDescription(`[Add me to your server](${url})\n\nThe invite requests exactly the permissions the feature set needs (moderation, logging, tickets, roles). You can review each permission with \`/permissions\`.`),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Show detailed information about a user')
      .addUserOption((option) => option.setName('user').setDescription('User to inspect (defaults to you)')),
    async execute({ interaction, services }: CommandContext) {
      const target = interaction.options.getUser('user') ?? interaction.user;
      const member = interaction.guild
        ? await interaction.guild.members.fetch(target.id).catch(() => null)
        : null;
      const profile = await services.repos.users.upsertUser({
        id: target.id,
        username: target.username,
        globalName: target.globalName,
        discriminator: target.discriminator,
        avatar: target.avatar,
        isBot: target.bot,
      });
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`${target.username}`)
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: `\`${target.id}\``, inline: true },
          { name: 'Bot', value: target.bot ? 'yes' : 'no', inline: true },
          { name: 'Account created', value: `${formatTimestamp(target.createdTimestamp)} (${formatTimestamp(target.createdTimestamp)})`, inline: true },
        );
      if (member) {
        embed.addFields(
          { name: 'Joined server', value: member.joinedTimestamp ? formatTimestamp(member.joinedTimestamp) : 'unknown', inline: true },
          { name: 'Nickname', value: member.nickname ?? 'none', inline: true },
          {
            name: `Roles (${member.roles.cache.size - 1})`,
            value: truncate(
              member.roles.cache
                .filter((role) => role.id !== interaction.guildId)
                .sort((a, b) => b.position - a.position)
                .map((role) => `${role}`)
                .join(' ') || 'none',
              1024,
            ),
          },
        );
        if (member.premiumSinceTimestamp) {
          embed.addFields({ name: 'Boosting since', value: formatTimestamp(member.premiumSinceTimestamp), inline: true });
        }
      }
      embed.setFooter({ text: `First tracked by this bot: ${profile.created_at.toISOString().slice(0, 10)}` });
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show information about this server'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      await guild.fetch().catch(() => null);
      const owner = await guild.fetchOwner().catch(() => null);
      const settings = await services.settings.getAll(guild.id).catch(() => ({}));
      const enabledModules = Object.entries(settings)
        .filter(([, values]) => (values as { enabled?: boolean }).enabled === true)
        .map(([name]) => name);
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`🏠 ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
        .addFields(
          { name: 'Owner', value: owner ? `<@${owner.id}>` : 'unknown', inline: true },
          { name: 'Members', value: guild.memberCount.toLocaleString(), inline: true },
          { name: 'Created', value: formatTimestamp(guild.createdTimestamp), inline: true },
          { name: 'Channels', value: String(guild.channels.cache.size), inline: true },
          { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
          { name: 'Boost tier', value: String(guild.premiumTier), inline: true },
          {
            name: 'Enabled modules',
            value: enabledModules.length > 0 ? truncate(enabledModules.join(', '), 1024) : 'none configured yet',
          },
        );
      if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('servericon')
      .setDescription('Show the server icon and banner')
      .addStringOption((option) =>
        option
          .setName('size')
          .setDescription('Image size')
          .addChoices(
            { name: '128', value: '128' },
            { name: '256', value: '256' },
            { name: '512', value: '512' },
            { name: '1024', value: '1024' },
            { name: '2048', value: '2048' },
            { name: '4096', value: '4096' },
          ),
      ),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      const size = Number(interaction.options.getString('size') ?? '1024') as 128 | 256 | 512 | 1024 | 2048 | 4096;
      const icon = guild.iconURL({ size, extension: 'png' });
      const banner = guild.bannerURL({ size });
      if (!icon && !banner) {
        await interaction.reply({ embeds: [warningEmbed('This server has no icon or banner set.')] });
        return;
      }
      const embed = baseEmbed(COLORS.primary).setTitle(`🖼️ ${guild.name}`);
      if (icon) embed.setThumbnail(icon).setImage(icon);
      if (banner) embed.setImage(banner);
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription('Show a user avatar (or server icon) in full size')
      .addUserOption((option) => option.setName('user').setDescription('User (defaults to you)'))
      .addBooleanOption((option) => option.setName('server').setDescription('Show the server icon instead')),
    async execute({ interaction }: CommandContext) {
      if (interaction.options.getBoolean('server')) {
        const guild = guildOf(interaction);
        const url = guild.iconURL({ size: 1024 });
        if (!url) throw new UserFacingError('This server has no icon.');
        await interaction.reply({ embeds: [baseEmbed(COLORS.primary).setTitle(`${guild.name} icon`).setImage(url)] });
        return;
      }
      const user = interaction.options.getUser('user') ?? interaction.user;
      const fetched = await user.fetch(true).catch(() => user);
      const global = fetched.displayAvatarURL({ size: 1024 });
      const server = interaction.guild ? fetched.displayAvatarURL({ size: 1024, extension: 'png' }) : null;
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`${fetched.username}'s avatar`)
        .setImage(server ?? global)
        .setFooter({ text: server ? 'Server avatar' : 'Global avatar' });
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('banner')
      .setDescription('Show a user banner or accent colour')
      .addUserOption((option) => option.setName('user').setDescription('User (defaults to you)')),
    async execute({ interaction }: CommandContext) {
      const user = interaction.options.getUser('user') ?? interaction.user;
      const fetched = await user.fetch(true).catch(() => null);
      const banner = fetched?.bannerURL({ size: 1024 });
      if (!banner) {
        await interaction.reply({
          embeds: [
            warningEmbed(
              `${user.username} has no banner${fetched?.hexAccentColor ? ` (accent colour #${fetched.hexAccentColor.replace('#', '')})` : ''}.`,
            ),
          ],
        });
        return;
      }
      await interaction.reply({ embeds: [baseEmbed(COLORS.primary).setTitle(`${user.username}'s banner`).setImage(banner)] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('roleinfo')
      .setDescription('Show details about a role')
      .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true)),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const role = interaction.options.getRole('role', true);
      const detailed = await guild.roles.fetch(role.id).catch(() => null);
      if (!detailed) throw new UserFacingError('That role no longer exists.');
      const members = detailed.members.size;
      const embed = baseEmbed(detailed.color || COLORS.primary)
        .setTitle(`🎭 ${detailed.name}`)
        .addFields(
          { name: 'ID', value: `\`${detailed.id}\``, inline: true },
          { name: 'Position', value: String(detailed.position), inline: true },
          { name: 'Members', value: String(members), inline: true },
          { name: 'Colour', value: detailed.hexColor, inline: true },
          { name: 'Hoisted', value: detailed.hoist ? 'yes' : 'no', inline: true },
          { name: 'Mentionable', value: detailed.mentionable ? 'yes' : 'no', inline: true },
          { name: 'Managed', value: detailed.managed ? 'yes (integration)' : 'no', inline: true },
          { name: 'Created', value: formatTimestamp(detailed.createdTimestamp), inline: true },
          {
            name: 'Key permissions',
            value: truncate(
              detailed.permissions
                .toArray()
                .slice(0, 12)
                .join(', ') || 'none',
              1024,
            ),
          },
        );
      void services;
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('channelinfo')
      .setDescription('Show details about a channel')
      .addChannelOption((option) =>
        option.setName('channel').setDescription('Channel (defaults to the current one)').addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildVoice,
          ChannelType.GuildCategory,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
        ),
      ),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel || !('id' in channel)) throw new UserFacingError('Channel not found.');
      const full = await guild.channels.fetch(channel.id).catch(() => null);
      if (!full) throw new UserFacingError('Channel not found.');
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`#️⃣ ${'name' in full ? full.name : 'channel'}`)
        .addFields(
          { name: 'ID', value: `\`${full.id}\``, inline: true },
          { name: 'Type', value: ChannelType[full.type] ?? String(full.type), inline: true },
          { name: 'Created', value: formatTimestamp(full.createdTimestamp ?? 0), inline: true },
          {
            name: 'Category',
            value: full.parent?.name ?? 'none',
            inline: true,
          },
          {
            name: 'Slowmode',
            value: 'rateLimitPerUser' in full ? `${full.rateLimitPerUser ?? 0}s` : 'n/a',
            inline: true,
          },
        );
      if ('topic' in full && full.topic) {
        embed.addFields({ name: 'Topic', value: truncate(full.topic, 1024) });
      }
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('rolelist').setDescription('List every role with its position and member count'),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      await interaction.deferReply();
      const roles = await guild.roles.fetch().catch(() => null);
      if (!roles) throw new UserFacingError('Could not fetch roles.');
      const lines = [...roles.values()]
        .sort((a, b) => b.position - a.position)
        .map((role) => `\`${String(role.position).padStart(3)}\` ${role} — ${role.members.size} member(s)`);
      const { sendPaginated } = await import('../core/ui.js');
      await sendPaginated(interaction, lines, (line) => line, { title: `Roles in ${guild.name}`, pageSize: 20 });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('emojis').setDescription('List the custom emojis of this server'),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      await interaction.deferReply();
      const emojis = [...guild.emojis.cache.values()];
      const { sendPaginated } = await import('../core/ui.js');
      await sendPaginated(
        interaction,
        emojis,
        (emoji) => `${emoji} \`:${emoji.name}:\` — \`${emoji.id}\``,
        { title: `Emojis in ${guild.name}`, pageSize: 20, emptyMessage: 'This server has no custom emojis.' },
      );
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('permissions')
      .setDescription('Show a member’s permissions or the permissions the bot needs')
      .addUserOption((option) => option.setName('user').setDescription('Member to inspect'))
      .addBooleanOption((option) => option.setName('bot_requirements').setDescription('Show permissions this bot needs')),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      if (interaction.options.getBoolean('bot_requirements')) {
        const { REQUIRED_BOT_PERMISSIONS } = await import('../core/constants.js');
        const embed = baseEmbed(COLORS.primary)
          .setTitle('🔐 Permissions this bot needs')
          .setDescription(
            REQUIRED_BOT_PERMISSIONS.map((entry) => `• **${entry.name}** — ${entry.reason}`).join('\n'),
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }
      const user = interaction.options.getUser('user') ?? interaction.user;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) throw new UserFacingError('That user is not in this server.');
      const permissions = member.permissions.toArray();
      const embed = baseEmbed(member.permissions.has(PermissionFlagsBits.Administrator) ? COLORS.danger : COLORS.primary)
        .setTitle(`🔐 Permissions for ${member.user.tag}`)
        .setDescription(truncate(permissions.join(', ') || 'no significant permissions', 4000))
        .setFooter({ text: `${permissions.length} permission(s) • highest role: ${member.roles.highest.name}` });
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder().setName('membercount').setDescription('Show member statistics for this server'),
    async execute({ interaction }: CommandContext) {
      const guild = guildOf(interaction);
      const members = await guild.members.fetch().catch(() => null);
      if (!members) throw new UserFacingError('Could not fetch members (requires the Server Members intent).');
      const bots = members.filter((member) => member.user.bot).size;
      const online = members.filter((member) => member.presence?.status && member.presence.status !== 'offline').size;
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`👥 ${guild.name}`)
        .addFields(
          { name: 'Total', value: String(members.size), inline: true },
          { name: 'Humans', value: String(members.size - bots), inline: true },
          { name: 'Bots', value: String(bots), inline: true },
          { name: 'Non-offline (cached)', value: online > 0 ? String(online) : 'unavailable (presence intent off)', inline: true },
        );
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('timestamp')
      .setDescription('Render a Discord timestamp from a relative duration or a date')
      .addStringOption((option) =>
        option.setName('input').setDescription('e.g. "2h", "3d", "2025-01-01" or a unix timestamp').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('style')
          .setDescription('Formatting style')
          .addChoices(
            { name: 'Relative (in 2 hours)', value: 'R' },
            { name: 'Short time', value: 't' },
            { name: 'Long time', value: 'T' },
            { name: 'Short date', value: 'd' },
            { name: 'Long date', value: 'D' },
            { name: 'Long date + time', value: 'F' },
          ),
      ),
    async execute({ interaction }: CommandContext) {
      const input = interaction.options.getString('input', true);
      const style = interaction.options.getString('style') ?? 'R';
      let timestamp: number | null = null;
      if (/^\d{10,13}$/.test(input)) {
        timestamp = input.length === 13 ? Number(input) : Number(input) * 1000;
      } else {
        const parsedDuration = parseDurationMs(input);
        if (parsedDuration !== null) timestamp = Date.now() + parsedDuration;
        else {
          const parsedDate = Date.parse(input);
          if (!Number.isNaN(parsedDate)) timestamp = parsedDate;
        }
      }
      if (timestamp === null) throw new UserFacingError('Could not parse that as a duration, date or timestamp.');
      const seconds = Math.floor(timestamp / 1000);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🕒 Timestamp')
            .setDescription(`\`<t:${seconds}:${style}>\` → <t:${seconds}:${style}>`)
            .setFooter({ text: 'Copy the code on the left and paste it anywhere in Discord' }),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('snowflake')
      .setDescription('Decode a Discord ID (creation date and shard info)')
      .addStringOption((option) => option.setName('id').setDescription('Discord ID').setRequired(true)),
    async execute({ interaction }: CommandContext) {
      const id = interaction.options.getString('id', true).trim();
      if (!/^\d{17,20}$/.test(id)) throw new UserFacingError('That is not a valid Discord snowflake (17-20 digits).');
      const { snowflakeToTimestamp } = await import('@bot-by-ai/shared');
      const created = snowflakeToTimestamp(id);
      const embed = baseEmbed(COLORS.primary)
        .setTitle('❄️ Snowflake decoded')
        .addFields(
          { name: 'ID', value: `\`${id}\``, inline: true },
          { name: 'Created', value: `${formatTimestamp(created)}\n<t:${Math.floor(created / 1000)}:R>`, inline: true },
          { name: 'Worker', value: String((BigInt(id) >> 17n) & 0x1fn), inline: true },
          { name: 'Process', value: String((BigInt(id) >> 12n) & 0x1fn), inline: true },
          { name: 'Increment', value: String(BigInt(id) & 0xfffn), inline: true },
        );
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('calc')
      .setDescription('Evaluate a mathematical expression safely')
      .addStringOption((option) => option.setName('expression').setDescription('e.g. (12+8)*3/4').setRequired(true)),
    async execute({ interaction }: CommandContext) {
      const expression = interaction.options.getString('expression', true);
      const result = await runCalculator(expression);
      await interaction.reply({
        embeds: [
          successEmbed(`\`${truncate(expression, 200)}\` = **${result}**`, '🧮 Result'),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Create a reaction poll')
      .addStringOption((option) => option.setName('question').setDescription('Poll question').setRequired(true))
      .addStringOption((option) => option.setName('options').setDescription('Options separated by | (max 10)'))
      .addBooleanOption((option) => option.setName('multiple').setDescription('Allow multiple answers'))
      .addIntegerOption((option) =>
        option.setName('duration_minutes').setDescription('Auto-close after N minutes (1-1440)').setMinValue(1).setMaxValue(1440),
      ),
    async execute({ interaction, services }: CommandContext) {
      const question = interaction.options.getString('question', true);
      const raw = interaction.options.getString('options');
      const multiple = interaction.options.getBoolean('multiple') ?? false;
      const duration = interaction.options.getInteger('duration_minutes');
      const options = raw
        ? raw
            .split('|')
            .map((option) => option.trim())
            .filter((option) => option.length > 0)
            .slice(0, 10)
        : ['Yes', 'No'];
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`📊 ${truncate(question, 250)}`)
        .setDescription(options.map((option, index) => `${emojis[index]} ${option}`).join('\n'))
        .setFooter({ text: multiple ? 'You may vote for several options' : 'React with one option to vote' });
      if (duration) embed.addFields({ name: 'Closes', value: formatTimestamp(Date.now() + duration * 60_000) });
      const message = await interaction.reply({ embeds: [embed], withResponse: true }).then((response) => response.resource?.message ?? null);
      if (!message) return;
      for (let index = 0; index < options.length; index += 1) {
        await message.react(emojis[index] as string).catch(() => {});
      }
      if (duration) {
        await services.repos.tasks.enqueue({
          taskType: 'poll_close',
          guildId: interaction.guildId,
          payload: { channelId: message.channelId, messageId: message.id, question },
          runAt: new Date(Date.now() + duration * 60_000),
        });
      }
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Build and send a custom embed')
      .addStringOption((option) => option.setName('title').setDescription('Embed title').setRequired(true))
      .addStringOption((option) => option.setName('description').setDescription('Embed body').setRequired(true))
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel to send to (defaults to here)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addStringOption((option) => option.setName('color').setDescription('Hex colour e.g. #5865F2'))
      .addStringOption((option) => option.setName('footer').setDescription('Footer text'))
      .addBooleanOption((option) => option.setName('timestamp').setDescription('Include a timestamp')),
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(interaction.member as GuildMember, [PermissionFlagsBits.ManageMessages], 'the embed command');
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
        .log(guildOf(interaction), {
          category: 'messages',
          title: 'Embed sent',
          description: `<@${interaction.user.id}> sent an embed to <#${channel.id}>.`,
          actorId: interaction.user.id,
          auditAction: 'utility.embed',
        })
        .catch(() => {});
      await interaction.reply({
        embeds: [successEmbed(`Embed sent to <#${channel.id}>.`)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('remind')
      .setDescription('Set and manage reminders')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Create a reminder')
          .addStringOption((option) => option.setName('when').setDescription('e.g. 10m, 2h, 3d').setRequired(true))
          .addStringOption((option) => option.setName('what').setDescription('Reminder text').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List your pending reminders'))
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Cancel a reminder')
          .addIntegerOption((option) => option.setName('id').setDescription('Reminder ID from /remind list').setRequired(true)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'set') {
        const when = interaction.options.getString('when', true);
        const what = interaction.options.getString('what', true);
        const duration = parseDurationMs(when);
        if (duration === null) throw new UserFacingError('Use a duration like `10m`, `2h`, `1d` or `30s`.');
        const remindAt = new Date(Date.now() + duration);
        const id = await services.community.createReminder({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          channelId: interaction.channelId,
          content: truncate(what, 500),
          remindAt,
        });
        await interaction.reply({
          embeds: [
            successEmbed(`Reminder **#${id}** set for <t:${Math.floor(remindAt.getTime() / 1000)}:R>.`),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'list') {
        const reminders = await services.repos.community.listUserReminders(interaction.guildId ?? '', interaction.user.id);
        if (reminders.length === 0) {
          await interaction.reply({ embeds: [infoEmbed('You have no pending reminders.')], flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('⏰ Your reminders')
              .setDescription(
                reminders
                  .map((reminder) => `**#${reminder.id}** — <t:${Math.floor(reminder.remind_at.getTime() / 1000)}:R>: ${truncate(reminder.content, 100)}`)
                  .join('\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const id = interaction.options.getInteger('id', true);
      const cancelled = await services.repos.community.cancelReminder(interaction.guildId ?? '', interaction.user.id, id);
      await interaction.reply({
        embeds: [
          cancelled ? successEmbed(`Reminder #${id} cancelled.`) : warningEmbed(`No pending reminder with ID ${id} belongs to you.`),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('prefix')
      .setDescription('Show or change the prefix used for custom commands')
      .addStringOption((option) => option.setName('set').setDescription('New prefix (1-5 characters)')),
    async execute({ interaction, services }: CommandContext) {
      const set = interaction.options.getString('set');
      if (!set) {
        const settings = await services.settings.get<{ prefix: string }>(guildOf(interaction).id, 'general');
        await interaction.reply({ embeds: [infoEmbed(`The current prefix is \`${settings.prefix}\``)], flags: MessageFlags.Ephemeral });
        return;
      }
      requireUserPermissions(interaction.member as GuildMember, [PermissionFlagsBits.ManageGuild], 'changing the prefix');
      if (set.length > 5) throw new UserFacingError('The prefix must be 5 characters or fewer.');
      const updated = await services.settings.update<{ prefix: string }>(
        guildOf(interaction).id,
        'general',
        { prefix: set },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({ embeds: [successEmbed(`Prefix updated to \`${updated.prefix}\`.`)] });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('dashboard')
      .setDescription('Get the link to the web dashboard for this server'),
    async execute({ interaction, services }: CommandContext) {
      const base = services.config.dashboard.url;
      if (!base) {
        await interaction.reply({
          embeds: [warningEmbed('The dashboard URL is not configured on this instance (DASHBOARD_URL).')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🖥️ Web dashboard')
            .setDescription(
              `Manage moderation, security, tickets, economy and more without slash commands:\n\n**${base}**\n\nSign in with Discord — you only see servers where you have Manage Server.`,
            ),
        ],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('module')
      .setDescription('Enable or disable bot modules for this server')
      .addSubcommand((sub) => sub.setName('list').setDescription('Show every module and whether it is enabled'))
      .addSubcommand((sub) =>
        sub
          .setName('enable')
          .setDescription('Enable a module')
          .addStringOption((option) => option.setName('module').setDescription('Module').setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('disable')
          .setDescription('Disable a module')
          .addStringOption((option) => option.setName('module').setDescription('Module').setRequired(true).setAutocomplete(true)),
      ),
    autocomplete: async ({ interaction }) => {
      const { MODULE_NAMES } = await import('@bot-by-ai/shared');
      const focused = interaction.options.getFocused(true).value.toLowerCase();
      await interaction.respond(
        MODULE_NAMES.filter((name) => name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map((name) => ({ name, value: name })),
      );
    },
    async execute({ interaction, services }: CommandContext) {
      requireUserPermissions(interaction.member as GuildMember, [PermissionFlagsBits.ManageGuild], 'module management');
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const { MODULE_NAMES, moduleDefaults } = await import('@bot-by-ai/shared');
      if (sub === 'list') {
        const values = await services.settings.getAll(guild.id);
        const lines = MODULE_NAMES.map((name) => {
          const enabled = (values[name] as { enabled?: boolean } | undefined)?.enabled;
          return `${enabled === true ? '🟢' : enabled === false ? '⚪' : '➖'} \`${name}\``;
        });
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🧩 Modules')
              .setDescription(lines.join('\n'))
              .setFooter({ text: '➖ = module has no on/off switch (always available)' }),
          ],
        });
        return;
      }
      const module = interaction.options.getString('module', true);
      if (!MODULE_NAMES.includes(module as never)) throw new UserFacingError(`Unknown module \`${module}\`.`);
      const defaults = moduleDefaults(module as never);
      if (!('enabled' in defaults)) {
        throw new UserFacingError(`The \`${module}\` module has no enable/disable switch.`);
      }
      await services.settings.update(
        guild.id,
        module as never,
        { enabled: sub === 'enable' },
        { actorId: interaction.user.id, source: 'command' },
      );
      await interaction.reply({
        embeds: [successEmbed(`Module \`${module}\` ${sub === 'enable' ? 'enabled' : 'disabled'}.`)],
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('helpmenu')
      .setDescription('Interactive help menu with category navigation'),
    async execute({ interaction, services }: CommandContext) {
      const catalog = services.commandCatalog?.() ?? [];
      const emojis: Record<string, string> = {
        utility: '🧰',
        moderation: '🔨',
        security: '🛡️',
        automod: '🤖',
        economy: '💰',
        levels: '📈',
        tickets: '🎫',
        community: '🎉',
        welcome: '👋',
        logging: '📜',
        'reaction-roles': '🎭',
        music: '🎵',
        configuration: '⚙️',
        owner: '👑',
      };
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('help:category')
          .setPlaceholder('Choose a category')
          .addOptions(
            CATEGORIES.filter((category) => catalog.some((entry) => entry.category === category))
              .slice(0, 25)
              .map((category) => ({
                label: category,
                value: category,
                emoji: emojis[category],
              })),
          ),
      );
      const message = await interaction
        .reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('📖 Help')
              .setDescription(
                `**${catalog.length}** commands available. Pick a category below, or use \`/help\` for the full list.`,
              ),
          ],
          components: [row],
          withResponse: true,
        })
        .then((response) => response.resource?.message ?? null);
      if (!message) return;
      const collector = message.createMessageComponentCollector({ time: 120_000 });
      collector.on('collect', async (component) => {
        if (!component.isStringSelectMenu()) return;
        if (component.user.id !== interaction.user.id) {
          await component.reply({ content: 'Run `/helpmenu` yourself to browse commands.', flags: MessageFlags.Ephemeral });
          return;
        }
        const category = component.values[0] ?? 'utility';
        const names = catalog.filter((entry) => entry.category === category).map((entry) => `\`/${entry.name}\``);
        await component.update({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle(`${emojis[category] ?? '📁'} ${category}`)
              .setDescription(names.join(' ') || 'No commands in this category.'),
          ],
        });
      });
      collector.on('end', async () => {
        await interaction.editReply({ components: [] }).catch(() => {});
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('afk')
      .setDescription('Set an AFK status that is announced when you are mentioned')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set your AFK status')
          .addStringOption((option) => option.setName('reason').setDescription('Why are you away?'))
          .addStringOption((option) => option.setName('until').setDescription('Optional return time, e.g. "2h"')),
      )
      .addSubcommand((sub) => sub.setName('clear').setDescription('Clear your AFK status'))
      .addSubcommand((sub) => sub.setName('list').setDescription('List members currently registered as AFK')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const stored = await services.settings.get<{ afkEntries?: Record<string, { reason: string; until: number | null }> }>(
        guild.id,
        'general',
      );
      const entries = { ...(stored.afkEntries ?? {}) };
      if (sub === 'set') {
        const reason = interaction.options.getString('reason') ?? 'AFK';
        const untilRaw = interaction.options.getString('until');
        const until = untilRaw ? parseDurationMs(untilRaw) : null;
        entries[interaction.user.id] = { reason: truncate(reason, 200), until: until ? Date.now() + until : null };
        await services.settings.update(
          guild.id,
          'general',
          { afkEntries: entries },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.reply({
          embeds: [
            successEmbed(
              `AFK status set: **${truncate(reason, 200)}**${until ? ` until ${formatTimestamp(Date.now() + until)}` : ''}.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'clear') {
        delete entries[interaction.user.id];
        await services.settings.update(guild.id, 'general', { afkEntries: entries }, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({ embeds: [successEmbed('AFK status cleared.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const list = Object.entries(entries);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('💤 AFK members')
            .setDescription(
              list.length === 0
                ? 'Nobody is marked as AFK.'
                : list
                    .map(
                      ([userId, entry]) =>
                        `<@${userId}> — ${entry.reason}${entry.until ? ` (until <t:${Math.floor(entry.until / 1000)}:R>)` : ''}`,
                    )
                    .join('\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'utility',
    data: new SlashCommandBuilder()
      .setName('render')
      .setDescription('Preview how a template string renders with your details')
      .addStringOption((option) => option.setName('template').setDescription('Template with {user} style variables').setRequired(true)),
    async execute({ interaction }: CommandContext) {
      const template = interaction.options.getString('template', true);
      const result = renderTemplate(template, {
        user: {
          id: interaction.user.id,
          username: interaction.user.username,
          tag: interaction.user.tag,
          mention: `<@${interaction.user.id}>`,
        },
        server: {
          name: interaction.guild?.name ?? 'this server',
          id: interaction.guildId ?? '',
          memberCount: interaction.guild?.memberCount ?? 0,
        },
        channel: { name: 'name' in (interaction.channel ?? {}) ? String((interaction.channel as { name?: string }).name) : 'channel' },
      });
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🧪 Template preview')
            .setDescription(truncate(result.output || '(empty)', 4000))
            .setFooter({
              text:
                result.unknownVariables.length > 0
                  ? `Unknown variables left as-is: ${result.unknownVariables.join(', ')}`
                  : 'All variables resolved',
            }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
]);

import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { formatDuration, formatNumber, progressBar, UserFacingError } from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { requireUserPermissions } from '../core/resolvers.js';
import type { LevelSettings } from '../services/types.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function actor(interaction: ChatInputCommandInteraction): GuildMember {
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember)) throw new UserFacingError('Use this inside a server.');
  return member;
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'levels',
    data: new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Show your level, XP and rank')
      .addUserOption((option) => option.setName('user').setDescription('Member (defaults to you)')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const target = interaction.options.getUser('user') ?? interaction.user;
      const settings = await services.levels.getSettings(guild.id);
      if (!settings.enabled) throw new UserFacingError('Leveling is disabled in this server.');
      const profile = await services.levels.profile(guild.id, target.id);
      const member = await guild.members.fetch(target.id).catch(() => null);
      const nextReward = settings.roleRewards
        .filter((reward) => reward.level > profile.level)
        .sort((a, b) => a.level - b.level)[0];
      const embed = baseEmbed(COLORS.primary)
        .setTitle(`📈 ${target.username}`)
        .setThumbnail(target.displayAvatarURL({ size: 128 }))
        .setDescription(
          `${progressBar(profile.xpIntoLevel, profile.xpForLevel, 16)}\n**Level ${profile.level}** — ${formatNumber(profile.xpIntoLevel)} / ${formatNumber(profile.xpForLevel)} XP`,
        )
        .addFields(
          { name: 'Total XP', value: formatNumber(profile.xp), inline: true },
          { name: 'Rank', value: profile.rank ? `#${profile.rank}` : 'unranked', inline: true },
          { name: 'Messages', value: formatNumber(profile.messages), inline: true },
          { name: 'Voice minutes', value: formatNumber(profile.voiceMinutes), inline: true },
          { name: 'Next role reward', value: nextReward ? `level ${nextReward.level} → <@&${nextReward.roleId}>` : 'none configured', inline: true },
        )
        .setFooter({ text: `XP per message: ${settings.minXp}-${settings.maxXp} • cooldown ${formatDuration(settings.cooldownMs)}` });
      if (member) embed.setColor(member.displayColor || COLORS.primary);
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    category: 'levels',
    data: new SlashCommandBuilder()
      .setName('levelconfig')
      .setDescription('Configure leveling for this server')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the leveling configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('Enable or disable leveling')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Enabled?').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('xp')
          .setDescription('Configure XP gain')
          .addIntegerOption((option) => option.setName('min').setDescription('Minimum XP per message').setMinValue(1).setMaxValue(1000))
          .addIntegerOption((option) => option.setName('max').setDescription('Maximum XP per message').setMinValue(1).setMaxValue(1000))
          .addIntegerOption((option) => option.setName('cooldown_seconds').setDescription('Per-user XP cooldown').setMinValue(1).setMaxValue(600))
          .addNumberOption((option) => option.setName('multiplier').setDescription('Global XP multiplier').setMinValue(0.1).setMaxValue(10))
          .addIntegerOption((option) => option.setName('voice_per_minute').setDescription('XP per voice minute').setMinValue(0).setMaxValue(500))
          .addIntegerOption((option) => option.setName('max_level').setDescription('Level cap').setMinValue(1).setMaxValue(500))
          .addBooleanOption((option) => option.setName('stack_cooldown').setDescription('Stack XP while on cooldown for the next message')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('announce')
          .setDescription('Configure level-up announcements')
          .addChannelOption((option) =>
            option.setName('channel').setDescription('Announcement channel').addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((option) => option.setName('message').setDescription('Template, e.g. "GG {user}, level {level}!"'))
          .addBooleanOption((option) => option.setName('dm').setDescription('Also DM the member on level up')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('ignored')
          .setDescription('Ignore channels or roles for XP')
          .addStringOption((option) =>
            option
              .setName('type')
              .setDescription('What to ignore')
              .setRequired(true)
              .addChoices({ name: 'channel', value: 'channel' }, { name: 'role', value: 'role' }),
          )
          .addChannelOption((option) => option.setName('channel').setDescription('Channel to ignore'))
          .addRoleOption((option) => option.setName('role').setDescription('Role to ignore')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reward')
          .setDescription('Configure a role reward for reaching a level')
          .addIntegerOption((option) => option.setName('level').setDescription('Level required').setRequired(true).setMinValue(1).setMaxValue(500))
          .addRoleOption((option) => option.setName('role').setDescription('Role to grant').setRequired(true))
          .addBooleanOption((option) => option.setName('remove').setDescription('Remove this reward instead')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('roleboost')
          .setDescription('Give members with a role a XP multiplier')
          .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
          .addNumberOption((option) => option.setName('multiplier').setDescription('Multiplier (1-5)').setRequired(true).setMinValue(1).setMaxValue(5)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireUserPermissions(actor(interaction), [PermissionFlagsBits.ManageGuild], 'level configuration');
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.levels.getSettings(guild.id);
      const update = async (patch: Record<string, unknown>): Promise<LevelSettings> =>
        services.settings.update<LevelSettings>(guild.id, 'levels', patch, { actorId: interaction.user.id, source: 'command' });

      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('📈 Leveling configuration')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                { name: 'XP per message', value: `${settings.minXp}-${settings.maxXp}`, inline: true },
                { name: 'Cooldown', value: formatDuration(settings.cooldownMs), inline: true },
                { name: 'Multiplier', value: `×${settings.multiplier}`, inline: true },
                { name: 'Voice XP/min', value: String(settings.xpPerVoiceMinute), inline: true },
                { name: 'Level cap', value: String(settings.maxLevel), inline: true },
                { name: 'Announce channel', value: settings.announceChannelId ? `<#${settings.announceChannelId}>` : 'not set', inline: true },
                { name: 'DM on level up', value: settings.announceDm ? 'yes' : 'no', inline: true },
                { name: 'Template', value: settings.message.slice(0, 200) },
                { name: 'Ignored channels', value: settings.ignoredChannelIds.map((id) => `<#${id}>`).join(' ') || 'none' },
                { name: 'Ignored roles', value: settings.ignoredRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none' },
                {
                  name: `Role rewards (${settings.roleRewards.length})`,
                  value:
                    settings.roleRewards
                      .sort((a, b) => a.level - b.level)
                      .map((reward) => `level ${reward.level} → <@&${reward.roleId}>`)
                      .join('\n') || 'none',
                },
                {
                  name: `Role boosts (${settings.levelMultiplierRoleIds.length})`,
                  value:
                    settings.levelMultiplierRoleIds.map((boost) => `<@&${boost.roleId}> ×${boost.multiplier}`).join('\n') || 'none',
                },
              ),
          ],
        });
        return;
      }
      if (sub === 'toggle') {
        const enabled = interaction.options.getBoolean('enabled', true);
        await update({ enabled });
        await interaction.reply({ embeds: [enabled ? successEmbed('Leveling enabled.') : warningEmbed('Leveling disabled.')] });
        return;
      }
      if (sub === 'xp') {
        const patch: Record<string, unknown> = {};
        const min = interaction.options.getInteger('min');
        const max = interaction.options.getInteger('max');
        const cooldown = interaction.options.getInteger('cooldown_seconds');
        const multiplier = interaction.options.getNumber('multiplier');
        const voice = interaction.options.getInteger('voice_per_minute');
        const maxLevel = interaction.options.getInteger('max_level');
        const stack = interaction.options.getBoolean('stack_cooldown');
        if (min !== null) patch.minXp = min;
        if (max !== null) patch.maxXp = max;
        if (cooldown !== null) patch.cooldownMs = cooldown * 1000;
        if (multiplier !== null) patch.multiplier = multiplier;
        if (voice !== null) patch.xpPerVoiceMinute = voice;
        if (maxLevel !== null) patch.maxLevel = maxLevel;
        if (stack !== null) patch.stackCooldown = stack;
        const updated = await update(patch);
        if (updated.maxXp < updated.minXp) throw new UserFacingError('`max` must be greater than or equal to `min`.');
        await interaction.reply({
          embeds: [
            successEmbed(
              `XP settings updated: ${updated.minXp}-${updated.maxXp} XP per message, cooldown ${formatDuration(updated.cooldownMs)}, multiplier ×${updated.multiplier}.`,
            ),
          ],
        });
        return;
      }
      if (sub === 'announce') {
        const patch: Record<string, unknown> = {};
        const channel = interaction.options.getChannel('channel');
        const message = interaction.options.getString('message');
        const dm = interaction.options.getBoolean('dm');
        if (channel) patch.announceChannelId = channel.id;
        if (message) patch.message = message;
        if (dm !== null) patch.announceDm = dm;
        await update(patch);
        await interaction.reply({ embeds: [successEmbed('Level-up announcement settings updated.')] });
        return;
      }
      if (sub === 'ignored') {
        const type = interaction.options.getString('type', true);
        if (type === 'channel') {
          const channel = interaction.options.getChannel('channel');
          if (!channel) throw new UserFacingError('Provide the `channel` option.');
          const list = new Set(settings.ignoredChannelIds);
          if (list.has(channel.id)) list.delete(channel.id);
          else list.add(channel.id);
          const updated = await update({ ignoredChannelIds: [...list] });
          await interaction.reply({
            embeds: [successEmbed(`Ignored channels: ${updated.ignoredChannelIds.map((id) => `<#${id}>`).join(' ') || 'none'}`)],
          });
        } else {
          const role = interaction.options.getRole('role');
          if (!role) throw new UserFacingError('Provide the `role` option.');
          const list = new Set(settings.ignoredRoleIds);
          if (list.has(role.id)) list.delete(role.id);
          else list.add(role.id);
          const updated = await update({ ignoredRoleIds: [...list] });
          await interaction.reply({
            embeds: [successEmbed(`Ignored roles: ${updated.ignoredRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none'}`)],
          });
        }
        return;
      }
      if (sub === 'reward') {
        const level = interaction.options.getInteger('level', true);
        const role = interaction.options.getRole('role', true);
        const remove = interaction.options.getBoolean('remove') ?? false;
        const rewards = remove
          ? settings.roleRewards.filter((reward) => !(reward.level === level && reward.roleId === role.id))
          : [...settings.roleRewards.filter((reward) => reward.level !== level), { level, roleId: role.id }];
        const updated = await update({ roleRewards: rewards });
        await interaction.reply({
          embeds: [
            successEmbed(
              remove
                ? `Removed the level ${level} reward.`
                : `Level ${level} now grants <@&${role.id}>. ${updated.roleRewards.length} reward(s) configured.`,
            ),
          ],
        });
        return;
      }
      const role = interaction.options.getRole('role', true);
      const multiplier = interaction.options.getNumber('multiplier', true);
      const boosts = [
        ...settings.levelMultiplierRoleIds.filter((boost) => boost.roleId !== role.id),
        { roleId: role.id, multiplier },
      ];
      await update({ levelMultiplierRoleIds: boosts });
      await interaction.reply({ embeds: [successEmbed(`<@&${role.id}> now earns ×${multiplier} XP.`)] });
    },
  },
  {
    category: 'levels',
    data: new SlashCommandBuilder()
      .setName('xp')
      .setDescription('Adjust member XP (administrator)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add XP to a member')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((option) => option.setName('amount').setDescription('XP to add').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove XP from a member')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((option) => option.setName('amount').setDescription('XP to remove').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set a member’s XP to an exact value')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((option) => option.setName('amount').setDescription('Total XP').setRequired(true).setMinValue(0)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reset')
          .setDescription('Reset a member’s XP and level')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true)),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireUserPermissions(actor(interaction), [PermissionFlagsBits.ManageGuild], 'XP administration');
      const sub = interaction.options.getSubcommand(true);
      const user = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount') ?? 0;
      const settings = await services.levels.getSettings(guild.id);
      let profile;
      if (sub === 'add') profile = await services.repos.levels.addXpAdmin({ guildId: guild.id, userId: user.id, delta: amount });
      else if (sub === 'remove') profile = await services.repos.levels.addXpAdmin({ guildId: guild.id, userId: user.id, delta: -amount });
      else profile = await services.repos.levels.setXp({ guildId: guild.id, userId: user.id, xp: sub === 'reset' ? 0 : amount, maxLevel: settings.maxLevel });
      await services.repos.audit.log({
        guildId: guild.id,
        actorId: interaction.user.id,
        actorType: 'user',
        action: `levels.${sub}`,
        targetType: 'user',
        targetId: user.id,
        metadata: { amount, newXp: profile.xp, newLevel: profile.level },
      });
      await interaction.reply({
        embeds: [
          successEmbed(
            `<@${user.id}> is now level **${profile.level}** with **${formatNumber(profile.xp)}** XP. This adjustment was written to the audit log.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
]);

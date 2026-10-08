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
import type { AutomodSettings } from '../services/types.js';

function guildOf(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.guild) throw new UserFacingError('This command only works inside a server.');
  return interaction.guild;
}

function requireAutomodAccess(interaction: ChatInputCommandInteraction): GuildMember {
  const member = interaction.member;
  if (!member || !(member instanceof GuildMember)) throw new UserFacingError('Use this inside a server.');
  requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'automod configuration');
  return member;
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'automod',
    data: new SlashCommandBuilder()
      .setName('automod')
      .setDescription('Configure automatic message filtering')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) => sub.setName('status').setDescription('Show the current automod configuration'))
      .addSubcommand((sub) =>
        sub
          .setName('enable')
          .setDescription('Enable automod with sensible defaults')
          .addBooleanOption((option) => option.setName('block_invites').setDescription('Block Discord invite links (default: yes)'))
          .addBooleanOption((option) => option.setName('block_links').setDescription('Block all links'))
          .addBooleanOption((option) => option.setName('block_zalgo').setDescription('Block combining-character spam (default: yes)')),
      )
      .addSubcommand((sub) => sub.setName('disable').setDescription('Disable automod'))
      .addSubcommand((sub) =>
        sub
          .setName('words')
          .setDescription('Manage the blocked word list')
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('add / remove / list / set')
              .setRequired(true)
              .addChoices(
                { name: 'add', value: 'add' },
                { name: 'remove', value: 'remove' },
                { name: 'list', value: 'list' },
                { name: 'set', value: 'set' },
              ),
          )
          .addStringOption((option) => option.setName('words').setDescription('Comma separated words (or a regex when regex mode is on)')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('config')
          .setDescription('Tune detection thresholds')
          .addIntegerOption((option) => option.setName('spam_messages').setDescription('Messages allowed per spam window').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('spam_window_seconds').setDescription('Spam window length').setMinValue(1).setMaxValue(300))
          .addIntegerOption((option) => option.setName('max_mentions').setDescription('Max mentions per message (0 disables)').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('caps_percent').setDescription('Uppercase percentage threshold').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('max_emojis').setDescription('Max emojis per message (0 disables)').setMinValue(0).setMaxValue(100))
          .addIntegerOption((option) => option.setName('duplicate_limit').setDescription('Repeated messages allowed before action').setMinValue(0).setMaxValue(50))
          .addBooleanOption((option) => option.setName('regex_words').setDescription('Treat the word list as regular expressions'))
          .addBooleanOption((option) => option.setName('warn_author').setDescription('Warn the author on a violation'))
          .addStringOption((option) => option.setName('allowed_domains').setDescription('Comma separated domains that are always allowed')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('exempt')
          .setDescription('Exempt a user, role or channel from automod')
          .addStringOption((option) =>
            option
              .setName('type')
              .setDescription('What to exempt')
              .setRequired(true)
              .addChoices({ name: 'user', value: 'user' }, { name: 'role', value: 'role' }, { name: 'channel', value: 'channel' }),
          )
          .addUserOption((option) => option.setName('user').setDescription('User'))
          .addRoleOption((option) => option.setName('role').setDescription('Role'))
          .addChannelOption((option) => option.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('escalation')
          .setDescription('Configure the punishment ladder')
          .addIntegerOption((option) => option.setName('violations').setDescription('Violation count that triggers this step').setRequired(true).setMinValue(1).setMaxValue(1000))
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Action at that count')
              .setRequired(true)
              .addChoices(
                { name: 'delete only', value: 'delete' },
                { name: 'warn', value: 'warn' },
                { name: 'timeout', value: 'timeout' },
                { name: 'kick', value: 'kick' },
                { name: 'ban', value: 'ban' },
              ),
          )
          .addStringOption((option) => option.setName('timeout_duration').setDescription('Required when action=timeout, e.g. 10m'))
          .addBooleanOption((option) => option.setName('reset').setDescription('Replace the whole ladder with this single step')),
      )
      .addSubcommand((sub) => sub.setName('violations').setDescription('Show recent automod violations'))
      .addSubcommand((sub) => sub.setName('test').setDescription('Test the current filters against a sample message'))
      .addSubcommand((sub) => sub.setName('logs').setDescription('Show recorded violations for a member')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireAutomodAccess(interaction);
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.automod.getSettings(guild.id);
      const update = async (patch: Record<string, unknown>): Promise<AutomodSettings> =>
        services.settings.update<AutomodSettings>(guild.id, 'automod', patch, {
          actorId: interaction.user.id,
          source: 'command',
        });

      if (sub === 'status') {
        await interaction.reply({
          embeds: [
            baseEmbed(settings.enabled ? COLORS.success : COLORS.warning)
              .setTitle('🤖 AutoMod configuration')
              .addFields(
                { name: 'Enabled', value: settings.enabled ? 'yes' : 'no', inline: true },
                { name: 'Spam', value: `${settings.spamMessageLimit} msgs / ${formatDuration(settings.spamWindowMs)}`, inline: true },
                { name: 'Duplicates', value: `${settings.duplicateLimit} / ${formatDuration(settings.duplicateWindowMs)}`, inline: true },
                { name: 'Max mentions', value: String(settings.maxMentions), inline: true },
                { name: 'Caps threshold', value: `${settings.capsPercent}%`, inline: true },
                { name: 'Max emojis', value: String(settings.maxEmojis), inline: true },
                { name: 'Block invites', value: settings.blockInvites ? 'yes' : 'no', inline: true },
                { name: 'Block links', value: settings.blockLinks ? 'yes' : 'no', inline: true },
                { name: 'Zalgo filter', value: settings.blockZalgo ? 'yes' : 'no', inline: true },
                { name: `Blocked words (${settings.blockedWords.length})`, value: settings.blockedWords.slice(0, 20).map((word) => `\`${word}\``).join(' ') || 'none' },
                {
                  name: 'Escalation ladder',
                  value:
                    settings.escalation.length === 0
                      ? 'default (delete → warn → timeout → kick → ban)'
                      : settings.escalation
                          .map((step) => `${step.threshold}× → ${step.action}${step.durationMs ? ` (${formatDuration(step.durationMs)})` : ''}`)
                          .join('\n'),
                },
              ),
          ],
        });
        return;
      }

      if (sub === 'enable') {
        const updated = await update({
          enabled: true,
          blockInvites: interaction.options.getBoolean('block_invites') ?? true,
          blockLinks: interaction.options.getBoolean('block_links') ?? settings.blockLinks,
          blockZalgo: interaction.options.getBoolean('block_zalgo') ?? true,
        });
        await interaction.reply({
          embeds: [
            successEmbed(
              `AutoMod enabled.\n• invite links blocked: ${updated.blockInvites ? 'yes' : 'no'}\n• all links blocked: ${updated.blockLinks ? 'yes' : 'no'}\n• spam limit: ${updated.spamMessageLimit}/${formatDuration(updated.spamWindowMs)}\n• mention limit: ${updated.maxMentions}\n\nAdd exemptions with \`/automod exempt\` so staff and bot channels are not affected.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'disable') {
        await update({ enabled: false });
        await interaction.reply({ embeds: [warningEmbed('AutoMod disabled.')] });
        return;
      }

      if (sub === 'words') {
        const action = interaction.options.getString('action', true);
        const raw = interaction.options.getString('words');
        if (action === 'list') {
          await interaction.reply({
            embeds: [
              baseEmbed(COLORS.primary)
                .setTitle(`🚫 Blocked words (${settings.blockedWords.length})`)
                .setDescription(settings.blockedWords.map((word) => `\`${word}\``).join(' ') || 'The list is empty.'),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!raw) throw new UserFacingError('Provide the `words` option.');
        const entries = raw
          .split(',')
          .map((word) => word.trim())
          .filter((word) => word.length > 0);
        if (action === 'set') {
          await update({ blockedWords: entries, blockedWordsAsRegex: settings.blockedWordsAsRegex });
        } else if (action === 'add') {
          await update({ blockedWords: [...new Set([...settings.blockedWords, ...entries])].slice(0, 1000) });
        } else {
          await update({ blockedWords: settings.blockedWords.filter((word) => !entries.includes(word)) });
        }
        await interaction.reply({
          embeds: [successEmbed(`Blocked word list updated (action: \`${action}\`, ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}).`)],
        });
        return;
      }

      if (sub === 'config') {
        const patch: Record<string, unknown> = {};
        const spamMessages = interaction.options.getInteger('spam_messages');
        const spamWindow = interaction.options.getInteger('spam_window_seconds');
        const maxMentions = interaction.options.getInteger('max_mentions');
        const caps = interaction.options.getInteger('caps_percent');
        const maxEmojis = interaction.options.getInteger('max_emojis');
        const duplicateLimit = interaction.options.getInteger('duplicate_limit');
        const regexWords = interaction.options.getBoolean('regex_words');
        const warnAuthor = interaction.options.getBoolean('warn_author');
        const allowedDomains = interaction.options.getString('allowed_domains');
        if (spamMessages !== null) patch.spamMessageLimit = spamMessages;
        if (spamWindow !== null) patch.spamWindowMs = spamWindow * 1000;
        if (maxMentions !== null) patch.maxMentions = maxMentions;
        if (caps !== null) patch.capsPercent = caps;
        if (maxEmojis !== null) patch.maxEmojis = maxEmojis;
        if (duplicateLimit !== null) patch.duplicateLimit = duplicateLimit;
        if (regexWords !== null) patch.blockedWordsAsRegex = regexWords;
        if (warnAuthor !== null) patch.warnOnViolation = warnAuthor;
        if (allowedDomains) {
          patch.allowedDomains = allowedDomains
            .split(',')
            .map((domain) => domain.trim())
            .filter(Boolean);
        }
        await update(patch);
        await interaction.reply({ embeds: [successEmbed('AutoMod rules updated.')] });
        return;
      }

      if (sub === 'exempt') {
        const type = interaction.options.getString('type', true);
        const user = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const channel = interaction.options.getChannel('channel');
        if (type === 'user' && user) {
          await update({ exemptUserIds: [...new Set([...settings.exemptUserIds, user.id])] });
        } else if (type === 'role' && role) {
          await update({ exemptRoleIds: [...new Set([...settings.exemptRoleIds, role.id])] });
        } else if (type === 'channel' && channel) {
          await update({ exemptChannelIds: [...new Set([...settings.exemptChannelIds, channel.id])] });
        } else {
          throw new UserFacingError(`Provide the \`${type}\` option.`);
        }
        await interaction.reply({ embeds: [successEmbed(`Added an automod exemption for ${type}.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'escalation') {
        const violations = interaction.options.getInteger('violations', true);
        const action = interaction.options.getString('action', true);
        const timeoutRaw = interaction.options.getString('timeout_duration');
        const reset = interaction.options.getBoolean('reset') ?? false;
        let durationMs: number | undefined;
        if (action === 'timeout') {
          const { parseDurationMs } = await import('@bot-by-ai/shared');
          const parsed = timeoutRaw ? parseDurationMs(timeoutRaw) : null;
          if (parsed === null) throw new UserFacingError('Provide `timeout_duration` (e.g. `10m`) when the action is timeout.');
          durationMs = parsed;
        }
        const step = { threshold: violations, action: action as 'delete' | 'warn' | 'timeout' | 'kick' | 'ban', ...(durationMs ? { durationMs } : {}) };
        const ladder = reset
          ? [step]
          : [...settings.escalation.filter((entry) => entry.threshold !== violations), step].sort((a, b) => a.threshold - b.threshold);
        await update({ escalation: ladder });
        await interaction.reply({
          embeds: [
            successEmbed(
              `Escalation ladder updated:\n${ladder.map((entry) => `${entry.threshold}× → ${entry.action}${entry.durationMs ? ` (${formatDuration(entry.durationMs)})` : ''}`).join('\n')}`,
            ),
          ],
        });
        return;
      }

      if (sub === 'violations') {
        const violations = await services.repos.security.listEvents(guild.id, { kinds: ['automod'], limit: 25 });
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🤖 Recent automod activity')
              .setDescription(
                violations.rows.length === 0
                  ? 'No automod violations recorded yet.'
                  : violations.rows
                      .map((row) => `#${row.id} — ${row.description.slice(0, 180)} (<t:${Math.floor(row.created_at.getTime() / 1000)}:R>)`)
                      .join('\n\n'),
              ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'test') {
        const sample = interaction.options.getString('words');
        void sample;
        const { sendPaginated } = await import('../core/ui.js');
        const words = settings.blockedWords;
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🧪 AutoMod self-check')
              .setDescription(
                [
                  `Status: **${settings.enabled ? 'enabled' : 'disabled'}**`,
                  `Spam rule: ${settings.spamMessageLimit} messages / ${formatDuration(settings.spamWindowMs)}`,
                  `Mention rule: ${settings.maxMentions === 0 ? 'disabled' : `max ${settings.maxMentions} mentions`}`,
                  `Caps rule: ${settings.capsPercent === 0 ? 'disabled' : `${settings.capsPercent}% uppercase`}`,
                  `Invite filter: ${settings.blockInvites ? 'on' : 'off'}`,
                  `Link filter: ${settings.blockLinks ? 'on' : 'off'}`,
                  `Blocked words: ${words.length === 0 ? 'none' : words.slice(0, 25).join(', ')}`,
                  `Exempt: ${settings.exemptUserIds.length} user(s), ${settings.exemptRoleIds.length} role(s), ${settings.exemptChannelIds.length} channel(s)`,
                ].join('\n'),
              )
              .setFooter({ text: 'Rules are evaluated per message by the shared rule engine.' }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        void sendPaginated;
        return;
      }

      const violations = await services.repos.security.listEvents(guild.id, { kinds: ['automod'], limit: 25 });
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('📋 AutoMod logs')
            .setDescription(
              violations.rows.length === 0
                ? 'Nothing logged yet.'
                : violations.rows
                    .map((row) => `#${row.id} — ${row.description.slice(0, 160)}`)
                    .join('\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
]);

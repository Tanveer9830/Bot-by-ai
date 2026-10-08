import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { truncate, UserFacingError } from '@bot-by-ai/shared';
import { COLORS, INTERACTION_PREFIXES } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed } from '../core/embeds.js';
import { confirmAction, sendPaginated } from '../core/ui.js';
import { requireUserPermissions } from '../core/resolvers.js';

interface PanelOption {
  label: string;
  roleId: string;
  emoji?: string | null;
  description?: string | null;
}

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

function normaliseEmoji(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const custom = trimmed.match(/^<a?:(\w{2,32}):(\d{17,20})>$/);
  if (custom) return `<:${custom[1]}:${custom[2]}>`;
  if (/^\d{17,20}$/.test(trimmed)) return trimmed;
  if (trimmed.length <= 4) return trimmed;
  throw new UserFacingError('Emojis must be a unicode emoji, a custom emoji, or an emoji id.');
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('reactionrole')
      .setDescription('Self-assignable roles through buttons, select menus or reactions')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a panel and post it in a channel')
          .addStringOption((option) =>
            option
              .setName('key')
              .setDescription('Unique panel key (a-z0-9-)')
              .setRequired(true)
              .setMaxLength(32),
          )
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel for the panel')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((option) =>
            option
              .setName('title')
              .setDescription('Panel title')
              .setRequired(true)
              .setMaxLength(256),
          )
          .addRoleOption((option) =>
            option.setName('role').setDescription('Role to grant').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('label').setDescription('Button label (defaults to the role name)'),
          )
          .addStringOption((option) =>
            option.setName('emoji').setDescription('Optional emoji shown on the button'),
          )
          .addStringOption((option) =>
            option
              .setName('description')
              .setDescription('Optional panel description')
              .setMaxLength(1000),
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('How members pick roles')
              .addChoices(
                { name: 'buttons', value: 'button' },
                { name: 'select menu', value: 'select' },
                { name: 'reactions', value: 'reaction' },
              ),
          )
          .addBooleanOption((option) =>
            option
              .setName('exclusive')
              .setDescription('Only one role from this panel may be held at a time'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Change a panel’s title, description or mode and repost it')
          .addStringOption((option) =>
            option
              .setName('key')
              .setDescription('Panel key')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addStringOption((option) =>
            option.setName('title').setDescription('New title').setMaxLength(256),
          )
          .addStringOption((option) =>
            option.setName('description').setDescription('New description').setMaxLength(1000),
          )
          .addStringOption((option) =>
            option
              .setName('mode')
              .setDescription('New mode')
              .addChoices(
                { name: 'buttons', value: 'button' },
                { name: 'select menu', value: 'select' },
                { name: 'reactions', value: 'reaction' },
              ),
          )
          .addBooleanOption((option) =>
            option
              .setName('exclusive')
              .setDescription('Only one role from this panel may be held at a time'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a role option to a panel')
          .addStringOption((option) =>
            option
              .setName('key')
              .setDescription('Panel key')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addRoleOption((option) =>
            option.setName('role').setDescription('Role to grant').setRequired(true),
          )
          .addStringOption((option) => option.setName('label').setDescription('Button label'))
          .addStringOption((option) =>
            option.setName('emoji').setDescription('Emoji (required for reaction mode)'),
          )
          .addStringOption((option) =>
            option.setName('description').setDescription('Short description (select menus only)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a role option from a panel')
          .addStringOption((option) =>
            option
              .setName('key')
              .setDescription('Panel key')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addRoleOption((option) =>
            option.setName('role').setDescription('Role option to remove').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List every panel in this server'))
      .addSubcommand((sub) =>
        sub
          .setName('resend')
          .setDescription('Repost a panel (useful after editing the message away)')
          .addStringOption((option) =>
            option
              .setName('key')
              .setDescription('Panel key')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a panel and its message')
          .addStringOption((option) =>
            option
              .setName('key')
              .setDescription('Panel key')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      ),
    autocomplete: async ({ interaction, services }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.respond([]);
        return;
      }
      const focused = interaction.options.getFocused().toLowerCase();
      const panels = await services.repos.community.listReactionRolePanels(guildId).catch(() => []);
      await interaction.respond(
        panels
          .filter((panel) => panel.panel_key.toLowerCase().includes(focused))
          .slice(0, 25)
          .map((panel) => ({
            name: `${panel.panel_key} — ${panel.mode}${panel.enabled ? '' : ' (disabled)'}`,
            value: panel.panel_key,
          })),
      );
    },
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      requireUserPermissions(member, [PermissionFlagsBits.ManageRoles], 'reaction role management');
      const sub = interaction.options.getSubcommand(true);
      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new UserFacingError(
          'I need the **Manage Roles** permission to manage reaction roles.',
        );
      }

      const loadPanel = async (key: string) => {
        const panels = await services.repos.community.listReactionRolePanels(guild.id);
        return panels.find((panel) => panel.panel_key === key) ?? null;
      };

      if (sub === 'list') {
        const panels = await services.repos.community.listReactionRolePanels(guild.id);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await sendPaginated(
          interaction,
          panels,
          (panel) =>
            `**${panel.panel_key}** \`${panel.mode}\` ${panel.enabled ? '' : '(disabled) '}— <#${panel.channel_id}>${panel.message_id ? ` • [message](https://discord.com/channels/${guild.id}/${panel.channel_id}/${panel.message_id})` : ''}`,
          {
            title: `🎭 Reaction role panels (${panels.length})`,
            pageSize: 10,
            emptyMessage: 'No panels yet — create one with `/reactionrole create`.',
          },
        );
        return;
      }

      if (sub === 'delete') {
        const key = interaction.options.getString('key', true);
        const panel = await loadPanel(key);
        if (!panel) throw new UserFacingError(`No panel with key \`${key}\`.`);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const confirmed = await confirmAction(interaction, {
          title: 'Delete reaction role panel',
          description: `Delete panel \`${key}\`? The panel message is deleted and members keep any roles they already have.`,
          confirmLabel: 'Delete the panel',
        });
        if (!confirmed) return;
        if (panel.message_id) {
          const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
          if (channel?.isTextBased() && !channel.isDMBased()) {
            const message = await channel.messages.fetch(panel.message_id).catch(() => null);
            await message?.delete().catch(() => {});
          }
        }
        await services.repos.community.deleteReactionRolePanel(guild.id, key);
        await interaction.editReply({
          embeds: [successEmbed(`Panel \`${key}\` deleted.`)],
          components: [],
        });
        return;
      }

      if (sub === 'create') {
        const key = interaction.options.getString('key', true).toLowerCase();
        if (!/^[a-z0-9-]{1,32}$/.test(key))
          throw new UserFacingError('Panel keys may only contain a-z, 0-9 and dashes.');
        if (await loadPanel(key))
          throw new UserFacingError(
            `Panel \`${key}\` already exists — use \`/reactionrole add\` or \`edit\`.`,
          );
        const channel = interaction.options.getChannel('channel', true);
        const role = interaction.options.getRole('role', true);
        const mode = (interaction.options.getString('mode') ?? 'button') as
          'button' | 'select' | 'reaction';
        const exclusive = interaction.options.getBoolean('exclusive') ?? false;
        const title = truncate(interaction.options.getString('title', true), 256);
        const description = interaction.options.getString('description');
        const label = interaction.options.getString('label') ?? role.name;
        const emoji = normaliseEmoji(interaction.options.getString('emoji'));
        if (mode === 'reaction' && !emoji)
          throw new UserFacingError(
            'Reaction mode needs an `emoji` so members know what to click.',
          );
        if (role.position >= (me.roles.highest.position ?? 0))
          throw new UserFacingError('That role is above my highest role.');
        const options: PanelOption[] = [{ label, roleId: role.id, emoji, description: null }];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const messageId = await postPanel(guild, channel as TextChannel, {
          key,
          mode,
          title,
          description: description ?? 'Use the controls below to pick your roles.',
          options,
          exclusive,
        });
        await services.repos.community.upsertReactionRolePanel({
          guildId: guild.id,
          panelKey: key,
          channelId: channel.id,
          mode,
          options,
          exclusive,
          messageId,
        });
        await services.settings.update(
          guild.id,
          'reactionRoles',
          {
            enabled: true,
            panels: [
              ...(
                await services.settings.get<{ panels: unknown[] }>(guild.id, 'reactionRoles')
              ).panels.slice(0, 24),
              {
                id: key,
                channelId: channel.id,
                messageId,
                mode,
                title,
                description: description ?? null,
                options,
                exclusive,
              },
            ],
          },
          { actorId: interaction.user.id, source: 'command' },
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Panel \`${key}\` created in <#${channel.id}> with 1 option. Add more with \`/reactionrole add key:${key}\`.`,
            ),
          ],
        });
        return;
      }

      // add / remove / resend / edit need an existing panel
      const key = interaction.options.getString('key', true).toLowerCase();
      const panel = await loadPanel(key);
      if (!panel) throw new UserFacingError(`No panel with key \`${key}\`.`);
      const options = (panel.options as PanelOption[] | null) ?? [];
      const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased() || channel.isDMBased())
        throw new UserFacingError('The panel channel no longer exists.');

      if (sub === 'add') {
        const role = interaction.options.getRole('role', true);
        if (options.some((option) => option.roleId === role.id))
          throw new UserFacingError(`<@&${role.id}> is already an option on this panel.`);
        if (options.length >= 25)
          throw new UserFacingError('A panel can hold at most 25 options (Discord limit).');
        if (role.position >= (me.roles.highest.position ?? 0))
          throw new UserFacingError('That role is above my highest role.');
        const emoji = normaliseEmoji(interaction.options.getString('emoji'));
        if (panel.mode === 'reaction' && !emoji)
          throw new UserFacingError('Reaction panels need an emoji per option.');
        const next = [
          ...options,
          {
            label: interaction.options.getString('label') ?? role.name,
            roleId: role.id,
            emoji,
            description: interaction.options.getString('description') ?? null,
          },
        ];
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await repost(guild, channel as TextChannel, panel.message_id, {
          key,
          mode: panel.mode as 'button' | 'select' | 'reaction',
          title: key,
          description: null,
          options: next,
          exclusive: panel.exclusive,
        });
        await services.repos.community.upsertReactionRolePanel({
          guildId: guild.id,
          panelKey: key,
          channelId: panel.channel_id,
          mode: panel.mode as 'button' | 'select' | 'reaction',
          options: next,
          exclusive: panel.exclusive,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(`Added <@&${role.id}> to panel \`${key}\` (${next.length} option(s)).`),
          ],
        });
        return;
      }

      if (sub === 'remove') {
        const role = interaction.options.getRole('role', true);
        const next = options.filter((option) => option.roleId !== role.id);
        if (next.length === options.length)
          throw new UserFacingError(`<@&${role.id}> is not on that panel.`);
        if (next.length === 0)
          throw new UserFacingError(
            'A panel needs at least one option — delete the panel instead.',
          );
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await repost(guild, channel as TextChannel, panel.message_id, {
          key,
          mode: panel.mode as 'button' | 'select' | 'reaction',
          title: key,
          description: null,
          options: next,
          exclusive: panel.exclusive,
        });
        await services.repos.community.upsertReactionRolePanel({
          guildId: guild.id,
          panelKey: key,
          channelId: panel.channel_id,
          mode: panel.mode as 'button' | 'select' | 'reaction',
          options: next,
          exclusive: panel.exclusive,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Removed <@&${role.id}> from panel \`${key}\`. Members keep the role until they remove it themselves.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'resend') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const messageId = await postPanel(guild, channel as TextChannel, {
          key,
          mode: panel.mode as 'button' | 'select' | 'reaction',
          title: key,
          description: 'Use the controls below to pick your roles.',
          options,
          exclusive: panel.exclusive,
        });
        await services.repos.community.upsertReactionRolePanel({
          guildId: guild.id,
          panelKey: key,
          channelId: panel.channel_id,
          mode: panel.mode as 'button' | 'select' | 'reaction',
          options,
          exclusive: panel.exclusive,
          messageId,
        });
        await interaction.editReply({ embeds: [successEmbed(`Panel \`${key}\` reposted.`)] });
        return;
      }

      // edit
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const mode = interaction.options.getString('mode');
      const exclusive = interaction.options.getBoolean('exclusive');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const nextMode = (mode ?? panel.mode) as 'button' | 'select' | 'reaction';
      const nextExclusive = exclusive ?? panel.exclusive;
      if (nextMode === 'reaction' && options.some((option) => !option.emoji)) {
        throw new UserFacingError('Every option needs an emoji before switching to reaction mode.');
      }
      const messageId = await repost(guild, channel as TextChannel, panel.message_id, {
        key,
        mode: nextMode,
        title: title ?? key,
        description: description ?? null,
        options,
        exclusive: nextExclusive,
      });
      await services.repos.community.upsertReactionRolePanel({
        guildId: guild.id,
        panelKey: key,
        channelId: panel.channel_id,
        mode: nextMode,
        options,
        exclusive: nextExclusive,
        messageId,
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            `Panel \`${key}\` updated (mode \`${nextMode}\`${nextExclusive ? ', exclusive' : ''}).`,
          ),
        ],
      });
    },
  },
]);

interface PanelDefinition {
  key: string;
  mode: 'button' | 'select' | 'reaction';
  title: string;
  description: string | null;
  options: PanelOption[];
  exclusive: boolean;
}

function buildComponents(panel: PanelDefinition) {
  if (panel.mode === 'select') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${INTERACTION_PREFIXES.reactionRole}:select:${panel.key}`)
      .setPlaceholder('Pick your roles')
      .setMinValues(1)
      .setMaxValues(panel.exclusive ? 1 : Math.min(panel.options.length, 25))
      .addOptions(
        panel.options.slice(0, 25).map((option) => ({
          label: option.label.slice(0, 100),
          value: option.roleId,
          ...(option.description ? { description: option.description.slice(0, 100) } : {}),
        })),
      );
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
  }
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let row = new ActionRowBuilder<ButtonBuilder>();
  for (const option of panel.options.slice(0, 25)) {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder<ButtonBuilder>();
    }
    const button = new ButtonBuilder()
      .setCustomId(`${INTERACTION_PREFIXES.reactionRole}:toggle:${option.roleId}`)
      .setLabel(option.label.slice(0, 80))
      .setStyle(ButtonStyle.Secondary);
    if (option.emoji) button.setEmoji(option.emoji);
    row.addComponents(button);
  }
  if (row.components.length > 0) rows.push(row);
  return rows;
}

async function postPanel(
  guild: Guild,
  channel: TextChannel,
  panel: PanelDefinition,
): Promise<string> {
  const embed = baseEmbed(COLORS.primary)
    .setTitle(truncate(panel.title, 256))
    .setDescription(
      panel.description ??
        panel.options
          .map((option) => `${option.emoji ? `${option.emoji} ` : ''}<@&${option.roleId}>`)
          .join('\n'),
    )
    .setFooter({
      text:
        panel.mode === 'reaction'
          ? 'React with the matching emoji to receive the role'
          : panel.exclusive
            ? 'Only one role from this panel can be held at a time'
            : 'Click the buttons to toggle your roles',
    });
  const message = await channel.send({
    embeds: [embed],
    components: panel.mode === 'reaction' ? [] : buildComponents(panel),
  });
  if (panel.mode === 'reaction') {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.AddReactions)) {
      throw new UserFacingError('I need the **Add Reactions** permission for reaction mode.');
    }
    for (const option of panel.options) {
      if (option.emoji) await message.react(option.emoji).catch(() => {});
    }
  }
  return message.id;
}

async function repost(
  guild: Guild,
  channel: TextChannel,
  previousMessageId: string | null,
  panel: PanelDefinition,
): Promise<string> {
  if (previousMessageId) {
    const previous = await channel.messages.fetch(previousMessageId).catch(() => null);
    await previous?.delete().catch(() => {});
  }
  return postPanel(guild, channel, panel);
}

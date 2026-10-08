import {
  AttachmentBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import {
  MODULE_NAMES,
  customCommandSchema,
  moduleDefaults,
  truncate,
  UserFacingError,
  validateModuleSettings,
  type ModuleName,
} from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { confirmAction, sendPaginated } from '../core/ui.js';
import { requireUserPermissions } from '../core/resolvers.js';

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
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('config')
      .setDescription('View, change, export or reset this server’s settings')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('view')
          .setDescription('Show one settings module (or list them all)')
          .addStringOption((option) => option.setName('module').setDescription('Settings module').setAutocomplete(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set one value inside a module using JSON')
          .addStringOption((option) =>
            option.setName('module').setDescription('Settings module').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((option) => option.setName('key').setDescription('Field name, e.g. enabled').setRequired(true))
          .addStringOption((option) =>
            option.setName('value').setDescription('JSON value: true, 12, "text", ["a","b"]').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('reset')
          .setDescription('Reset a module (or everything) to the defaults')
          .addStringOption((option) => option.setName('module').setDescription('Settings module').setAutocomplete(true))
          .addStringOption((option) =>
            option
              .setName('scope')
              .setDescription('Reset everything when module is omitted')
              .addChoices({ name: 'module', value: 'module' }, { name: 'all settings', value: 'all' }),
          ),
      )
      .addSubcommand((sub) => sub.setName('history').setDescription('Show the last 25 settings changes'))
      .addSubcommand((sub) => sub.setName('export').setDescription('Download every setting as JSON'))
      .addSubcommand((sub) =>
        sub
          .setName('import')
          .setDescription('Restore settings from a JSON export (merges per module)')
          .addAttachmentOption((option) => option.setName('file').setDescription('JSON file from /config export').setRequired(true))
          .addBooleanOption((option) => option.setName('overwrite').setDescription('Replace modules that already have values')),
      ),
    autocomplete: async ({ interaction, services }) => {
      void services;
      const focused = interaction.options.getFocused().toLowerCase();
      await interaction.respond(
        MODULE_NAMES.filter((name) => name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map((name) => ({ name, value: name })),
      );
    },
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'server configuration');
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'view') {
        const module = interaction.options.getString('module') as ModuleName | null;
        const settings = await services.settings.getAll(guild.id);
        if (!module) {
          const lines = MODULE_NAMES.map((name) => {
            const stored = settings[name];
            const configured = stored && Object.keys(stored).length > 0;
            return `${configured ? '🟢' : '⚪'} **${name}**${configured ? ` — ${Object.keys(stored).length} field(s) stored` : ' — defaults'}`;
          }).join('\n');
          await interaction.reply({
            embeds: [baseEmbed(COLORS.primary).setTitle('⚙️ Settings modules').setDescription(lines).setFooter({ text: 'Use /config view module:<name> for the full values' })],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!MODULE_NAMES.includes(module)) throw new UserFacingError(`Unknown module \`${module}\`.`);
        const values = settings[module] ?? moduleDefaults(module);
        const json = JSON.stringify(values, null, 2);
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle(`⚙️ ${module}`)
              .setDescription(`\`\`\`json\n${truncate(json, 3800)}\n\`\`\``)
              .setFooter({ text: 'Values are validated again on write.' }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'set') {
        const module = interaction.options.getString('module', true) as ModuleName;
        if (!MODULE_NAMES.includes(module)) throw new UserFacingError(`Unknown module \`${module}\`.`);
        const key = interaction.options.getString('key', true);
        const raw = interaction.options.getString('value', true);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new UserFacingError('The value must be valid JSON: `true`, `12`, `"text"` or `["a","b"]`.');
        }
        const validation = validateModuleSettings(module, { [key]: parsed });
        if (!validation.ok) {
          throw new UserFacingError(`That value was rejected:\n${validation.errors.map((error) => `• \`${error.path}\`: ${error.message}`).join('\n')}`);
        }
        await services.settings.update(guild.id, module, { [key]: parsed }, { actorId: interaction.user.id, source: 'command' });
        await interaction.reply({
          embeds: [successEmbed(`\`${module}.${key}\` updated to \`${truncate(raw, 200)}\`.\nEvery change is validated and recorded in the settings history.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'reset') {
        const module = interaction.options.getString('module') as ModuleName | null;
        const scope = interaction.options.getString('scope') ?? 'module';
        if (!module && scope !== 'all') throw new UserFacingError('Provide a module, or set `scope: all settings` to reset everything.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const confirmed = await confirmAction(interaction, {
          title: 'Reset settings',
          description: module
            ? `Reset **${module}** to its defaults? The previous values stay in the settings history.`
            : 'Reset **every** module in this server to its defaults? The previous values stay in the settings history.',
          confirmLabel: 'Reset settings',
        });
        if (!confirmed) {
          await interaction.editReply({ embeds: [warningEmbed('Cancelled.')], components: [] });
          return;
        }
        const targets = module ? [module] : MODULE_NAMES;
        for (const name of targets) {
          await services.settings.update(guild.id, name, moduleDefaults(name), { actorId: interaction.user.id, source: 'command' });
        }
        await interaction.editReply({ embeds: [successEmbed(`Reset ${targets.length} module(s) to defaults.`)], components: [] });
        return;
      }

      if (sub === 'history') {
        const history = await services.settings.history(guild.id, 25);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await sendPaginated(
          interaction,
          history,
          (entry) =>
            `**${entry.module}** by ${entry.changed_by ? `<@${entry.changed_by}>` : 'system'} (${entry.source}) — <t:${Math.floor(new Date(entry.changed_at).getTime() / 1000)}:R>\n\`\`\`json\n${truncate(JSON.stringify(entry.new_values ?? {}, null, 0), 300)}\n\`\`\``,
          { title: '🕘 Settings history', pageSize: 5, emptyMessage: 'No settings changes recorded yet.' },
        );
        return;
      }

      if (sub === 'export') {
        const settings = await services.settings.getAll(guild.id);
        await interaction.reply({
          embeds: [successEmbed(`Exported ${Object.keys(settings).length} module(s). Keep this file private — it can contain channel ids and message templates.`)],
          files: [
            {
              attachment: Buffer.from(JSON.stringify({ guildId: guild.id, exportedAt: new Date().toISOString(), settings }, null, 2), 'utf8'),
              name: `bot-by-ai-settings-${guild.id}.json`,
            },
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // import
      const attachment = interaction.options.getAttachment('file', true);
      if (attachment.size > 512_000) throw new UserFacingError('That file is too large (limit 500 KB).');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const response = await fetch(attachment.url).catch(() => null);
      if (!response?.ok) throw new UserFacingError('I could not download that attachment.');
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new UserFacingError('That file is not valid JSON.');
      }
      const settings = (parsed as { settings?: unknown }).settings ?? parsed;
      if (!settings || typeof settings !== 'object') throw new UserFacingError('The export does not contain a settings object.');
      const overwrite = interaction.options.getBoolean('overwrite') ?? false;
      const existing = await services.settings.getAll(guild.id);
      const applied: string[] = [];
      const skipped: string[] = [];
      const invalid: string[] = [];
      for (const [module, values] of Object.entries(settings as Record<string, unknown>)) {
        if (!MODULE_NAMES.includes(module as ModuleName)) {
          invalid.push(`${module} (unknown module)`);
          continue;
        }
        if (!overwrite && existing[module] && Object.keys(existing[module]).length > 0) {
          skipped.push(module);
          continue;
        }
        if (!values || typeof values !== 'object') {
          invalid.push(`${module} (not an object)`);
          continue;
        }
        const validation = validateModuleSettings(module, values as Record<string, unknown>);
        if (!validation.ok) {
          invalid.push(`${module} (${validation.errors.map((error) => error.path).join(', ')})`);
          continue;
        }
        await services.settings.update(guild.id, module as ModuleName, values as Record<string, unknown>, {
          actorId: interaction.user.id,
          source: 'command',
        });
        applied.push(module);
      }
      await interaction.editReply({
        embeds: [
          successEmbed(
            [
              `Imported ${applied.length} module(s): ${applied.join(', ') || 'none'}.`,
              skipped.length > 0 ? `Skipped (already configured, use \`overwrite:true\`): ${skipped.join(', ')}.` : null,
              invalid.length > 0 ? `Rejected: ${invalid.join(', ')}.` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ],
      });
    },
  },
  {
    category: 'configuration',
    data: new SlashCommandBuilder()
      .setName('customcommand')
      .setDescription('Server-scoped custom commands (text responses, no code execution)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create or replace a custom command')
          .addStringOption((option) => option.setName('name').setDescription('Command name (a-z0-9-)').setRequired(true).setMaxLength(32))
          .addStringOption((option) => option.setName('response').setDescription('Response text ({user}, {server}, {args} are supported)').setRequired(true).setMaxLength(2000))
          .addStringOption((option) => option.setName('description').setDescription('Shown in the command list').setMaxLength(100))
          .addChannelOption((option) => option.setName('channel').setDescription('Only allow the command in this channel'))
          .addRoleOption((option) => option.setName('required_role').setDescription('Only members with this role may use it'))
          .addStringOption((option) =>
            option
              .setName('action')
              .setDescription('Extra behaviour')
              .addChoices(
                { name: 'reply', value: 'reply' },
                { name: 'reply and delete the trigger', value: 'reply_delete' },
                { name: 'send to the channel and delete the trigger', value: 'send_delete' },
                { name: 'DM the user', value: 'dm' },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a custom command')
          .addStringOption((option) => option.setName('name').setDescription('Command name').setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List every custom command in this server'))
      .addSubcommand((sub) =>
        sub
          .setName('info')
          .setDescription('Show the stored definition of a command')
          .addStringOption((option) => option.setName('name').setDescription('Command name').setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('Enable or disable a command')
          .addStringOption((option) => option.setName('name').setDescription('Command name').setRequired(true).setAutocomplete(true))
          .addBooleanOption((option) => option.setName('enabled').setDescription('Enabled?').setRequired(true)),
      ),
    autocomplete: async ({ interaction, services }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.respond([]);
        return;
      }
      const focused = interaction.options.getFocused().toLowerCase();
      const rows = await services.repos.customCommands.listGuild(guildId).catch(() => []);
      await interaction.respond(
        rows
          .filter((row) => row.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map((row) => ({ name: `${row.name}${row.enabled ? '' : ' (disabled)'}`, value: row.name })),
      );
    },
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const member = actor(interaction);
      requireUserPermissions(member, [PermissionFlagsBits.ManageGuild], 'custom command management');
      const sub = interaction.options.getSubcommand(true);
      const prefix = (await services.settings.get<{ prefix: string }>(guild.id, 'general')).prefix;

      if (sub === 'list') {
        const rows = await services.repos.customCommands.listGuild(guild.id);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await sendPaginated(
          interaction,
          rows,
          (row) =>
            `**${row.name}** ${row.enabled ? '' : '(disabled) '}— uses: ${row.uses}\n\`${prefix}${row.name}\` • ${truncate(String((row.payload as { response?: string }).response ?? ''), 120)}`,
          { title: `🧩 Custom commands (${rows.length})`, pageSize: 8, emptyMessage: `No custom commands yet. Create one with \`/customcommand create\`.` },
        );
        return;
      }

      if (sub === 'info') {
        const name = interaction.options.getString('name', true).toLowerCase();
        const row = await services.repos.customCommands.getGuild(guild.id, name);
        if (!row) throw new UserFacingError(`No custom command called \`${name}\`.`);
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle(`🧩 ${row.name}`)
              .setDescription(`\`\`\`json\n${truncate(JSON.stringify(row.payload, null, 2), 3800)}\n\`\`\``)
              .addFields({ name: 'Uses', value: String(row.uses), inline: true }, { name: 'Enabled', value: row.enabled ? 'yes' : 'no', inline: true }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'delete') {
        const name = interaction.options.getString('name', true).toLowerCase();
        const deleted = await services.repos.customCommands.deleteGuild(guild.id, name);
        await interaction.reply({
          embeds: [deleted ? successEmbed(`Deleted \`${name}\`.`) : warningEmbed(`No custom command called \`${name}\`.`)]
          ,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'toggle') {
        const name = interaction.options.getString('name', true).toLowerCase();
        const enabled = interaction.options.getBoolean('enabled', true);
        const row = await services.repos.customCommands.getGuild(guild.id, name);
        if (!row) throw new UserFacingError(`No custom command called \`${name}\`.`);
        await services.repos.customCommands.upsertGuild(guild.id, {
          name,
          description: row.description,
          payload: { ...(row.payload as Record<string, unknown>), enabled },
          enabled,
          actorId: interaction.user.id,
        });
        await interaction.reply({ embeds: [successEmbed(`\`${name}\` is now ${enabled ? 'enabled' : 'disabled'}.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      // create
      const name = interaction.options.getString('name', true).toLowerCase();
      if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new UserFacingError('Names may only contain a-z, 0-9 and dashes.');
      const response = interaction.options.getString('response', true);
      const channel = interaction.options.getChannel('channel');
      const requiredRole = interaction.options.getRole('required_role');
      const action = interaction.options.getString('action') ?? 'reply';
      const description = interaction.options.getString('description') ?? truncate(response, 100);
      const payload: Record<string, unknown> = {
        name,
        description,
        response,
        actions: action === 'dm' ? [{ type: 'send_dm', message: response.slice(0, 1500) }] : [],
        enabled: true,
        ephemeral: false,
        allowedChannelIds: channel ? [channel.id] : [],
        allowedUserIds: [],
        requiredRoleIds: requiredRole ? [requiredRole.id] : [],
        cooldownSeconds: 3,
        deleteTrigger: action === 'reply_delete' || action === 'send_delete',
      };
      const validation = validateCustomCommand(payload);
      if (!validation.ok) {
        throw new UserFacingError(`That definition was rejected: ${validation.errors.join(', ')}`);
      }
      await services.repos.customCommands.upsertGuild(guild.id, {
        name,
        description,
        payload,
        enabled: true,
        actorId: interaction.user.id,
      });
      await interaction.reply({
        embeds: [
          successEmbed(
            [
              `Custom command \`${name}\` saved.`,
              `Use it as \`${prefix}${name}\` or as the slash command \`/${name}\` after the next \`npm run deploy:commands\` run.`,
              'Responses are plain text — the bot never evaluates code from custom commands.',
            ].join('\n'),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
]);


/** Validates a custom-command definition against the shared zod schema. */
function validateCustomCommand(payload: Record<string, unknown>): { ok: true } | { ok: false; errors: string[] } {
  const parsed = customCommandSchema.safeParse(payload);
  if (parsed.success) return { ok: true };
  return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`) };
}

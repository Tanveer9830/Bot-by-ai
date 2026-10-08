/**
 * Owner-only commands.
 *
 * Every command in this module is declared with `ownerOnly: true`, and
 * `interactionCreate` additionally re-checks `services.owners.isOwner()` before
 * execution — server administrators, even with the Administrator permission,
 * can never reach this code path (see packages/shared/src/security/owner.ts).
 *
 * The only owner ids that exist are the ones parsed from BOT_OWNER_IDS at
 * startup. Both configured ids have identical privileges; there is no primary
 * owner with extra powers and no hidden account.
 */
import { ChannelType, MessageFlags, SlashCommandBuilder, type TextChannel } from 'discord.js';
import {
  customCommandSchema,
  formatDuration,
  formatRelativeTimestamp,
  formatTimestamp,
  truncate,
  UserFacingError,
} from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { confirmAction, sendPaginated } from '../core/ui.js';

const CUSTOM_COMMAND_NAME = /^[a-z0-9][a-z0-9-_]{0,31}$/;

/** Builds the stored payload for a global custom command from validated input. */
function buildPayload(input: {
  name: string;
  description: string;
  response: string;
  ephemeral: boolean;
  cooldownSeconds: number;
  dmInstead: boolean;
  publish: boolean;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    response: input.response,
    embed: null,
    actions: input.dmInstead ? [{ type: 'send_dm', message: truncate(input.response, 1500) }] : [],
    enabled: true,
    ephemeral: input.ephemeral,
    requiredRoleIds: [],
    allowedChannelIds: [],
    allowedUserIds: [],
    cooldownSeconds: input.cooldownSeconds,
    deleteTrigger: false,
  };
  const parsed = customCommandSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UserFacingError(
      `That definition was rejected by the shared validator: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join(', ')}`,
    );
  }
  return payload;
}

export const commands: BotCommand[] = defineCommands([
  /* ------------------------------------------------------------ global commands */
  {
    category: 'owner',
    ownerOnly: true,
    guildOnly: false,
    data: new SlashCommandBuilder()
      .setName('globalcommand')
      .setDescription('Owner-only: manage bot-wide custom commands available in every server')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create (or fully replace) a global custom command')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Command name (a-z0-9, dashes)')
              .setRequired(true)
              .setMaxLength(32),
          )
          .addStringOption((option) =>
            option
              .setName('response')
              .setDescription('Text sent when the command is used')
              .setRequired(true)
              .setMaxLength(4000),
          )
          .addStringOption((option) =>
            option
              .setName('description')
              .setDescription('Description shown in lists')
              .setMaxLength(100),
          )
          .addBooleanOption((option) =>
            option.setName('publish').setDescription('Publish immediately (default: no)'),
          )
          .addBooleanOption((option) =>
            option.setName('ephemeral').setDescription('Only the caller can see the response'),
          )
          .addBooleanOption((option) =>
            option.setName('dm').setDescription('Also DM the caller the response'),
          )
          .addIntegerOption((option) =>
            option
              .setName('cooldown')
              .setDescription('Per-user cooldown in seconds (default 3)')
              .setMinValue(0)
              .setMaxValue(3600),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Edit an existing global custom command')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Existing command name')
              .setRequired(true)
              .setMaxLength(32),
          )
          .addStringOption((option) =>
            option.setName('response').setDescription('New response text').setMaxLength(4000),
          )
          .addStringOption((option) =>
            option.setName('description').setDescription('New description').setMaxLength(100),
          )
          .addBooleanOption((option) =>
            option.setName('ephemeral').setDescription('Only the caller can see the response'),
          )
          .addBooleanOption((option) =>
            option.setName('dm').setDescription('Also DM the caller the response'),
          )
          .addIntegerOption((option) =>
            option
              .setName('cooldown')
              .setDescription('Per-user cooldown in seconds')
              .setMinValue(0)
              .setMaxValue(3600),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a global custom command')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Command name')
              .setRequired(true)
              .setMaxLength(32),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('List global custom commands with usage counts'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('info')
          .setDescription('Show the stored JSON of a global custom command')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Command name')
              .setRequired(true)
              .setMaxLength(32),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('publish')
          .setDescription('Make a global command available in every server')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Command name')
              .setRequired(true)
              .setMaxLength(32),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('disable')
          .setDescription('Take a global command offline in every server')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Command name')
              .setRequired(true)
              .setMaxLength(32),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      // Defence in depth: the runner already blocks non-owners.
      services.owners.assertOwner(interaction.user.id);
      const sub = interaction.options.getSubcommand(true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (sub === 'create') {
        const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
        if (!CUSTOM_COMMAND_NAME.test(name)) {
          throw new UserFacingError(
            'Names must be lowercase letters, numbers, dashes or underscores (max 32 characters).',
          );
        }
        const response = interaction.options.getString('response', true);
        const description = interaction.options.getString('description') ?? truncate(response, 100);
        const publish = interaction.options.getBoolean('publish') === true;
        const ephemeral = interaction.options.getBoolean('ephemeral') === true;
        const dm = interaction.options.getBoolean('dm') === true;
        const cooldown = interaction.options.getInteger('cooldown') ?? 3;

        if (services.commandCatalog().some((entry) => entry.name === name)) {
          throw new UserFacingError(`\`/${name}\` is a built-in command name — pick another name.`);
        }
        const existing = await services.repos.customCommands.getGlobal(name);
        if (existing) {
          throw new UserFacingError(
            `Global command \`${name}\` already exists. Use \`/globalcommand edit\` instead.`,
          );
        }

        const payload = buildPayload({
          name,
          description,
          response,
          ephemeral,
          cooldownSeconds: cooldown,
          dmInstead: dm,
          publish,
        });
        const row = await services.repos.customCommands.upsertGlobal({
          name,
          description,
          payload,
          enabled: true,
          published: publish,
          ownerId: interaction.user.id,
        });
        await services.repos.audit.log({
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'globalcommand.create',
          targetType: 'custom_command',
          targetId: String(row.id),
          metadata: { name, publish },
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Global command \`${name}\` was created${publish ? ' and published' : ' (not published yet — run `/globalcommand publish` when ready)'}.`,
            ),
          ],
        });
        return;
      }

      if (sub === 'edit') {
        const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
        const existing = await services.repos.customCommands.getGlobal(name);
        if (!existing) throw new UserFacingError(`No global command named \`${name}\` exists.`);

        const current = existing.payload as Record<string, unknown>;
        const response =
          interaction.options.getString('response') ?? String(current['response'] ?? '');
        const description = interaction.options.getString('description') ?? existing.description;
        const ephemeral =
          interaction.options.getBoolean('ephemeral') ?? current['ephemeral'] === true;
        const dm =
          interaction.options.getBoolean('dm') ??
          (Array.isArray(current['actions']) && (current['actions'] as unknown[]).length > 0);
        const cooldown =
          interaction.options.getInteger('cooldown') ?? Number(current['cooldownSeconds'] ?? 3);

        const payload = buildPayload({
          name,
          description,
          response,
          ephemeral,
          cooldownSeconds: cooldown,
          dmInstead: dm,
          publish: existing.published,
        });
        await services.repos.customCommands.upsertGlobal({
          name,
          description,
          payload,
          enabled: true,
          published: existing.published,
          ownerId: interaction.user.id,
        });
        await services.repos.audit.log({
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'globalcommand.edit',
          targetType: 'custom_command',
          targetId: String(existing.id),
          metadata: { name },
        });
        await interaction.editReply({
          embeds: [successEmbed(`Global command \`${name}\` was updated.`)],
        });
        return;
      }

      if (sub === 'delete') {
        const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
        const existing = await services.repos.customCommands.getGlobal(name);
        if (!existing) throw new UserFacingError(`No global command named \`${name}\` exists.`);
        const confirmed = await confirmAction(interaction, {
          title: `Delete global command \`${name}\`?`,
          description: `This removes it from every server. It had been used **${existing.uses}** time(s).`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!confirmed) {
          await interaction.editReply({ embeds: [warningEmbed('Nothing was deleted.')] });
          return;
        }
        await services.repos.customCommands.deleteGlobal(name);
        await services.repos.audit.log({
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'globalcommand.delete',
          targetType: 'custom_command',
          targetId: String(existing.id),
          metadata: { name },
        });
        await interaction.editReply({
          embeds: [successEmbed(`Global command \`${name}\` was deleted.`)],
        });
        return;
      }

      if (sub === 'list') {
        const globals = await services.repos.customCommands.listGlobal();
        await sendPaginated(
          interaction,
          globals,
          (row) =>
            [
              `**${row.name}** — ${truncate(row.description, 60)}`,
              `${row.published ? '✅ published' : '⏸️ draft'} • ${row.enabled ? 'enabled' : 'disabled'} • uses ${row.uses}`,
              `updated ${formatTimestamp(new Date(row.updated_at).getTime())} by ${row.updated_by ? `<@${row.updated_by}>` : 'unknown'}`,
            ].join('\n'),
          {
            title: '🌐 Global custom commands',
            pageSize: 5,
            ephemeral: true,
            emptyMessage: 'No global commands exist yet.',
          },
        );
        return;
      }

      if (sub === 'info') {
        const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
        const existing = await services.repos.customCommands.getGlobal(name);
        if (!existing) throw new UserFacingError(`No global command named \`${name}\` exists.`);
        await interaction.editReply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle(`Global command: ${existing.name}`)
              .setDescription(
                `\`\`\`json\n${truncate(JSON.stringify(existing.payload, null, 2), 3500)}\n\`\`\``,
              )
              .addFields(
                { name: 'Published', value: String(existing.published), inline: true },
                { name: 'Enabled', value: String(existing.enabled), inline: true },
                { name: 'Uses', value: String(existing.uses), inline: true },
                {
                  name: 'Created by',
                  value: existing.created_by ? `<@${existing.created_by}>` : 'unknown',
                  inline: true,
                },
              ),
          ],
        });
        return;
      }

      // publish / disable
      const name = (interaction.options.getString('name', true) ?? '').toLowerCase();
      const existing = await services.repos.customCommands.getGlobal(name);
      if (!existing) throw new UserFacingError(`No global command named \`${name}\` exists.`);
      if (sub === 'publish') {
        await services.repos.customCommands.setGlobalPublished(name, true, interaction.user.id);
      } else {
        await services.repos.customCommands.setGlobalPublished(name, false, interaction.user.id);
      }
      await services.repos.audit.log({
        actorId: interaction.user.id,
        actorType: 'user',
        action: sub === 'publish' ? 'globalcommand.publish' : 'globalcommand.disable',
        targetType: 'custom_command',
        targetId: String(existing.id),
        metadata: { name },
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            sub === 'publish'
              ? `\`${name}\` is now published — it will respond in every server as \`!${name}\`.`
              : `\`${name}\` is now offline everywhere. Existing data was kept.`,
          ),
        ],
      });
    },
  },

  /* --------------------------------------------------------------- owner panel */
  {
    category: 'owner',
    ownerOnly: true,
    guildOnly: false,
    data: new SlashCommandBuilder()
      .setName('owner')
      .setDescription('Owner-only: runtime status, diagnostics and maintenance')
      .addSubcommand((sub) =>
        sub.setName('status').setDescription('Live runtime snapshot with real metrics'),
      )
      .addSubcommand((sub) =>
        sub.setName('instances').setDescription('Recorded bot heartbeats from bot_instances'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('guilds')
          .setDescription('Servers this bot is in, with member counts and DB state'),
      )
      .addSubcommand((sub) =>
        sub.setName('commands').setDescription('Loaded commands and validation issues'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('lookup')
          .setDescription('Look up a stored user record')
          .addUserOption((option) =>
            option.setName('user').setDescription('User to look up').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('cache').setDescription('Clear the in-process guild settings cache'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('announce')
          .setDescription('Send an announcement as the bot')
          .addStringOption((option) =>
            option
              .setName('message')
              .setDescription('Message to send')
              .setRequired(true)
              .setMaxLength(1500),
          )
          .addChannelOption((option) =>
            option
              .setName('channel')
              .setDescription('Channel (defaults to the current one)')
              .addChannelTypes(ChannelType.GuildText),
          )
          .addBooleanOption((option) =>
            option
              .setName('all_guilds')
              .setDescription('Send to the system channel of every server (max 50, asks first)'),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      services.owners.assertOwner(interaction.user.id);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'status') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const snapshot = await services.status.snapshot();
        const usage = await services.repos.commandUsage.globalStats(7).catch(() => null);
        await interaction.editReply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle('🛠️ Owner status')
              .setDescription(
                [
                  `Status: **${snapshot.status}** • uptime ${formatDuration(snapshot.uptimeSeconds * 1000)}`,
                  `Gateway ping: ${snapshot.wsPingMs === null ? 'unavailable' : `${snapshot.wsPingMs} ms`}`,
                  `Guilds: **${snapshot.guildCount}** • cached members: **${snapshot.userCount}**`,
                  `Database: ${snapshot.database.ok ? `ok (${snapshot.database.latencyMs} ms)` : `DOWN — ${snapshot.database.error ?? 'unknown'}`}`,
                  `Memory: ${snapshot.memoryUsedMb} MB${snapshot.memoryLimitMb ? ` / ${snapshot.memoryLimitMb} MB limit` : ''} • CPU ${snapshot.cpuLoadPercent}%`,
                  `Node ${snapshot.nodeVersion} • bot v${snapshot.version} • instance \`${snapshot.instanceId}\``,
                  `Music: ${snapshot.music.enabled ? 'enabled' : 'disabled'}`,
                  `Errors since start: **${snapshot.errors.count}**${snapshot.errors.lastError ? ` (last: ${truncate(snapshot.errors.lastError, 120)})` : ''}`,
                  usage
                    ? `Commands (7d, all guilds): **${usage.total}** runs, ${usage.failed} failed, ${usage.activeGuilds} active guild(s)`
                    : 'Command usage: unavailable',
                  `Owner ids: ${services.owners.ids.map((id) => `\`${id}\``).join(', ')}`,
                ].join('\n'),
              ),
          ],
        });
        return;
      }

      if (sub === 'instances') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const instances = await services.repos.analytics.listBotInstances();
        await sendPaginated(
          interaction,
          instances,
          (instance) =>
            [
              `**${instance.id}** — ${instance.status} • shard ${instance.shard_id ?? 0}`,
              `guilds ${instance.guild_count} • users ${instance.user_count} • commands ${instance.command_count}`,
              `ping ${instance.ws_ping_ms ?? 'n/a'} ms • memory ${instance.memory_mb ?? 'n/a'} MB • up ${formatDuration(instance.uptime_seconds * 1000)}`,
              `v${instance.version ?? '?'} on ${instance.node_version ?? '?'} • last heartbeat ${formatTimestamp(new Date(instance.last_heartbeat_at).getTime())}`,
            ].join('\n'),
          {
            title: '📡 Recorded instances',
            pageSize: 4,
            emptyMessage: 'No heartbeat has been recorded yet.',
          },
        );
        return;
      }

      if (sub === 'guilds') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const cached = [...services.client.guilds.cache.values()].sort(
          (a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0),
        );
        const rows = await services.repos.guilds
          .listGuildsForIds(cached.map((guild) => guild.id))
          .catch(() => []);
        const tracked = new Set(rows.map((row) => row.id));
        await sendPaginated(
          interaction,
          cached,
          (guild) =>
            `**${truncate(guild.name, 60)}** (\`${guild.id}\`)\nmembers ${guild.memberCount ?? 'unknown'} • ${
              tracked.has(guild.id) ? 'tracked in DB' : 'not seen in DB'
            } • created ${formatRelativeTimestamp(guild.createdTimestamp)}`,
          { title: '🏠 Servers', pageSize: 6, emptyMessage: 'The bot is not in any server.' },
        );
        return;
      }

      if (sub === 'commands') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const catalog = services.commandCatalog();
        const byCategory = new Map<string, number>();
        for (const entry of catalog)
          byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
        await sendPaginated(
          interaction,
          catalog,
          (entry) =>
            `\`/${entry.name}\` —${entry.ownerOnly ? ' 🔒' : ''} ${truncate(entry.description, 70)}\n_category:_ ${entry.category}`,
          {
            title: `🧩 Loaded commands (${catalog.length})`,
            pageSize: 12,
            renderPageCustom: (page) => ({
              title: `🧩 Loaded commands (${catalog.length})`,
              description: '',
              footer: `${[...byCategory.entries()].map(([category, count]) => `${category}: ${count}`).join(' • ')} • page ${page}`,
            }),
          },
        );
        return;
      }

      if (sub === 'lookup') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user', true);
        const record = await services.repos.users.getUser(user.id);
        if (!record) {
          await interaction.editReply({
            embeds: [
              warningEmbed(
                `No database record exists for <@${user.id}>. Users are stored when they trigger an event.`,
              ),
            ],
          });
          return;
        }
        await interaction.editReply({
          embeds: [
            baseEmbed(COLORS.primary)
              .setTitle(`User record: ${record.username}`)
              .addFields(
                { name: 'Id', value: `\`${record.id}\``, inline: true },
                { name: 'Global name', value: record.global_name ?? '—', inline: true },
                { name: 'Bot account', value: String(record.is_bot), inline: true },
                { name: 'Locale', value: record.locale ?? '—', inline: true },
                {
                  name: 'First seen',
                  value: formatTimestamp(new Date(record.created_at).getTime()),
                  inline: true,
                },
                {
                  name: 'Updated',
                  value: formatTimestamp(new Date(record.updated_at).getTime()),
                  inline: true,
                },
              ),
          ],
        });
        return;
      }

      if (sub === 'cache') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        services.settings.invalidateAll();
        await interaction.editReply({
          embeds: [
            successEmbed(
              'The guild settings cache was cleared. The next read reloads from PostgreSQL.',
            ),
          ],
        });
        return;
      }

      // announce
      const message = interaction.options.getString('message', true);
      const channelOption = interaction.options.getChannel('channel');
      const allGuilds = interaction.options.getBoolean('all_guilds') === true;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (allGuilds) {
        if (channelOption)
          throw new UserFacingError('Combine `channel` or `all_guilds`, not both.');
        const targets = [...services.client.guilds.cache.values()]
          .map((guild) => guild.systemChannel ?? guild.publicUpdatesChannel)
          .filter((channel): channel is TextChannel => Boolean(channel && channel.isTextBased()))
          .slice(0, 50);
        if (targets.length === 0)
          throw new UserFacingError('None of the servers expose a system channel I can post in.');
        const confirmed = await confirmAction(interaction, {
          title: 'Send to every server?',
          description: `This posts to the system channel of **${targets.length}** server(s). Some servers have no system channel and are skipped.`,
          confirmLabel: 'Send announcement',
          danger: true,
        });
        if (!confirmed) {
          await interaction.editReply({ embeds: [warningEmbed('Announcement cancelled.')] });
          return;
        }
        let sent = 0;
        const failed: string[] = [];
        for (const channel of targets) {
          const ok = await channel
            .send({ content: message, allowedMentions: { parse: [] } })
            .then(() => true)
            .catch(() => false);
          if (ok) sent += 1;
          else failed.push(channel.guild.name);
        }
        await services.repos.audit.log({
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'owner.announce.broadcast',
          targetType: 'guild',
          targetId: null,
          metadata: { sent, failed: failed.length, length: message.length },
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Announcement delivered to **${sent}** server(s).${failed.length ? `\nCould not post in: ${truncate(failed.join(', '), 300)}` : ''}`,
            ),
          ],
        });
        return;
      }

      const guild = interaction.guild ?? null;
      const target = channelOption ?? interaction.channel;
      if (!target || !('send' in target)) {
        throw new UserFacingError('Point me at a text channel with the `channel` option.');
      }
      const resolvedGuild = 'guild' in target && target.guild ? target.guild : guild;
      await (target as TextChannel).send({ content: message, allowedMentions: { parse: [] } });
      await services.repos.audit.log({
        guildId: resolvedGuild?.id ?? null,
        actorId: interaction.user.id,
        actorType: 'user',
        action: 'owner.announce',
        targetType: 'channel',
        targetId: target.id,
        metadata: { length: message.length },
      });
      await interaction.editReply({
        embeds: [successEmbed(`Announcement sent to <#${target.id}>.`)],
      });
    },
  },

  /* -------------------------------------------------------------- maintenance */
  {
    category: 'owner',
    ownerOnly: true,
    guildOnly: false,
    data: new SlashCommandBuilder()
      .setName('ownermaintenance')
      .setDescription('Owner-only: database housekeeping and audit inspection')
      .addSubcommand((sub) =>
        sub
          .setName('audit')
          .setDescription('Show recent audit log entries')
          .addStringOption((option) =>
            option.setName('action').setDescription('Filter by action, e.g. owner.announce'),
          )
          .addStringOption((option) =>
            option.setName('actor').setDescription('Filter by actor user id'),
          )
          .addIntegerOption((option) =>
            option
              .setName('limit')
              .setDescription('Rows to fetch (1-50)')
              .setMinValue(1)
              .setMaxValue(50),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('prune')
          .setDescription('Delete audit log rows older than N days')
          .addIntegerOption((option) =>
            option
              .setName('days')
              .setDescription('Retention in days')
              .setRequired(true)
              .setMinValue(7)
              .setMaxValue(3650),
          )
          .addBooleanOption((option) =>
            option.setName('confirm').setDescription('Required to actually delete rows'),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('expire-cases').setDescription('Run the temporary-punishment expiry sweep now'),
      )
      .addSubcommand((sub) =>
        sub.setName('dbstats').setDescription('Row counts for the main tables'),
      ),
    async execute({ interaction, services }: CommandContext) {
      services.owners.assertOwner(interaction.user.id);
      const sub = interaction.options.getSubcommand(true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (sub === 'audit') {
        const action = interaction.options.getString('action');
        const actor = interaction.options.getString('actor');
        const limit = interaction.options.getInteger('limit') ?? 20;
        const { rows, total } = await services.repos.audit.list({
          ...(action ? { action } : {}),
          ...(actor ? { actorId: actor } : {}),
          limit,
        });
        await sendPaginated(
          interaction,
          rows,
          (row) =>
            `**${row.action}** by <@${row.actor_id ?? '0'}> (${row.actor_type}) ${formatRelativeTimestamp(new Date(row.created_at).getTime())}\n` +
            `target: ${row.target_type ?? '—'}${row.target_id ? ` \`${row.target_id}\`` : ''} • ${truncate(JSON.stringify(row.metadata ?? {}), 120)}`,
          {
            title: `📜 Audit log (${total} rows match)`,
            pageSize: 6,
            emptyMessage: 'No audit entries match that filter.',
          },
        );
        return;
      }

      if (sub === 'prune') {
        const days = interaction.options.getInteger('days', true);
        const confirm = interaction.options.getBoolean('confirm') === true;
        const { total } = await services.repos.audit.list({ limit: 1 });
        if (!confirm) {
          await interaction.editReply({
            embeds: [
              warningEmbed(
                `Dry run: pruning would delete audit rows older than **${days}** days (${total} rows currently stored). Re-run with \`confirm: true\` to execute.`,
              ),
            ],
          });
          return;
        }
        const deleted = await services.repos.audit.pruneOlderThan(days);
        await services.repos.audit.log({
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'owner.maintenance.prune',
          targetType: 'audit_logs',
          metadata: { days, deleted },
        });
        await interaction.editReply({
          embeds: [successEmbed(`Deleted **${deleted}** audit row(s) older than ${days} day(s).`)],
        });
        return;
      }

      if (sub === 'expire-cases') {
        const expired = await services.moderation.expireCases();
        await interaction.editReply({
          embeds: [
            successEmbed(`Expiry sweep finished: **${expired}** moderation case(s) processed.`),
          ],
        });
        return;
      }

      // dbstats
      const stats = (
        await services.db.query<Record<string, string>>(
          `SELECT
           (SELECT count(*)::text FROM guilds) AS guilds,
           (SELECT count(*)::text FROM users) AS users,
           (SELECT count(*)::text FROM guild_settings) AS guild_settings,
           (SELECT count(*)::text FROM moderation_cases) AS moderation_cases,
           (SELECT count(*)::text FROM warnings) AS warnings,
           (SELECT count(*)::text FROM security_events) AS security_events,
           (SELECT count(*)::text FROM automod_violations) AS automod_violations,
           (SELECT count(*)::text FROM tickets) AS tickets,
           (SELECT count(*)::text FROM giveaways) AS giveaways,
           (SELECT count(*)::text FROM economy_accounts) AS economy_accounts,
           (SELECT count(*)::text FROM member_levels) AS member_levels,
           (SELECT count(*)::text FROM custom_commands) AS custom_commands,
           (SELECT count(*)::text FROM audit_logs) AS audit_logs,
           (SELECT count(*)::text FROM command_usage) AS command_usage,
           (SELECT count(*)::text FROM scheduled_tasks WHERE completed_at IS NULL) AS pending_tasks,
           (SELECT count(*)::text FROM notag_violations) AS notag_violations,
           (SELECT count(*)::text FROM nopin_events) AS nopin_events`,
        )
      ).rows;
      const row = stats[0] ?? {};
      await interaction.editReply({
        embeds: [
          baseEmbed(COLORS.primary)
            .setTitle('🗄️ Database statistics')
            .setDescription(
              Object.entries(row)
                .map(
                  ([key, value]) =>
                    `${key.replace(/_/g, ' ')}: **${Number(value).toLocaleString('en-US')}**`,
                )
                .join('\n'),
            )
            .setFooter({ text: `Fetched ${new Date().toISOString()}` }),
        ],
      });
    },
  },
]);

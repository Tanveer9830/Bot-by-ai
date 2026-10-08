import {
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import {
  formatDuration,
  formatNumber,
  progressBar,
  truncate,
  UserFacingError,
  MAX_CURRENCY_AMOUNT,
} from '@bot-by-ai/shared';
import { COLORS } from '../core/constants.js';
import { defineCommands, type BotCommand, type CommandContext } from '../core/command.js';
import { baseEmbed, errorEmbed, successEmbed, warningEmbed } from '../core/embeds.js';
import { requireUserPermissions } from '../core/resolvers.js';
import type { EconomySettings } from '../services/types.js';

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

async function balanceEmbed(input: {
  guildId: string;
  userId: string;
  settings: EconomySettings;
  services: CommandContext['services'];
}) {
  const account = await input.services.economy.account(input.guildId, input.userId);
  const rank = await input.services.repos.economy.getRank(input.guildId, input.userId);
  const cooldowns = await Promise.all([
    input.services.repos.economy.getCooldown(input.guildId, input.userId, 'daily'),
    input.services.repos.economy.getCooldown(input.guildId, input.userId, 'work'),
    input.services.repos.economy.getCooldown(input.guildId, input.userId, 'weekly'),
  ]);
  const [daily, work, weekly] = cooldowns;
  const ready = (last: Date | undefined, windowMs: number): string => {
    if (!last) return 'ready now';
    const remaining = last.getTime() + windowMs - Date.now();
    return remaining <= 0 ? 'ready now' : `in ${formatDuration(remaining)}`;
  };
  return baseEmbed(COLORS.economy)
    .setTitle(`${input.settings.currencySymbol} Balance`)
    .setDescription(`<@${input.userId}>`)
    .addFields(
      { name: 'Wallet', value: formatNumber(account.wallet), inline: true },
      { name: 'Bank', value: formatNumber(account.bank), inline: true },
      { name: 'Rank', value: rank ? `#${rank.rank}` : 'unranked', inline: true },
      {
        name: 'Daily',
        value: ready(daily?.lastUsedAt, input.settings.dailyCooldownMs),
        inline: true,
      },
      {
        name: 'Weekly',
        value: ready(weekly?.lastUsedAt, input.settings.weeklyCooldownMs),
        inline: true,
      },
      { name: 'Work', value: ready(work?.lastUsedAt, input.settings.workCooldownMs), inline: true },
      {
        name: 'Streaks',
        value: `daily: ${daily?.streak ?? 0} • work: ${work?.streak ?? 0}`,
        inline: false,
      },
    )
    .setFooter({ text: `Currency: ${input.settings.currencyName}` });
}

export const commands: BotCommand[] = defineCommands([
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('balance')
      .setDescription('Show your or another member’s balance')
      .addUserOption((option) => option.setName('user').setDescription('Member (defaults to you)')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const user = interaction.options.getUser('user') ?? interaction.user;
      const settings = await services.economy.getSettings(guild.id);
      if (!settings.enabled) throw new UserFacingError('The economy is disabled in this server.');
      await interaction.reply({
        embeds: [await balanceEmbed({ guildId: guild.id, userId: user.id, settings, services })],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('daily')
      .setDescription('Claim your daily reward (streak bonus applies)'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const settings = await services.economy.getSettings(guild.id);
      await interaction.deferReply();
      const result = await services.economy.daily(guild.id, interaction.user.id);
      await interaction.editReply({
        embeds: [
          successEmbed(
            `You claimed **${formatNumber(result.amount)}** ${settings.currencySymbol}\nStreak: **${result.streak}** (multiplier ×${result.multiplier?.toFixed(2) ?? '1.00'})\nNew wallet balance: **${formatNumber(result.balance)}**`,
            '🎁 Daily reward',
          ),
        ],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder().setName('weekly').setDescription('Claim your weekly reward'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const settings = await services.economy.getSettings(guild.id);
      await interaction.deferReply();
      const result = await services.economy.weekly(guild.id, interaction.user.id);
      await interaction.editReply({
        embeds: [
          successEmbed(
            `You claimed **${formatNumber(result.amount)}** ${settings.currencySymbol} (weekly streak **${result.streak}**).\nNew wallet balance: **${formatNumber(result.balance)}**`,
            '📅 Weekly reward',
          ),
        ],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('work')
      .setDescription('Work for some currency (cooldown applies)'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const settings = await services.economy.getSettings(guild.id);
      const profile = await services.repos.levels.getProfile(guild.id, interaction.user.id);
      await interaction.deferReply();
      const result = await services.economy.work(
        guild.id,
        interaction.user.id,
        profile?.level ?? 0,
      );
      const jobs = [
        'cleaned the counters',
        'delivered a package',
        'fixed a bug',
        'streamed for 3 viewers',
        'walked the bot’s dog',
      ];
      const job = jobs[(Date.now() / 1_000_000) % jobs.length];
      await interaction.editReply({
        embeds: [
          successEmbed(
            `You ${job} and earned **${formatNumber(result.amount)}** ${settings.currencySymbol}.\nNew wallet balance: **${formatNumber(result.balance)}** • next shift: <t:${Math.floor((Date.now() + settings.workCooldownMs) / 1000)}:R>`,
            '💼 Work',
          ),
        ],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('transfer')
      .setDescription('Send currency to another member')
      .addUserOption((option) =>
        option.setName('user').setDescription('Recipient').setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('amount')
          .setDescription('Amount to send')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(MAX_CURRENCY_AMOUNT),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const recipient = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      if (recipient.id === interaction.user.id)
        throw new UserFacingError('You cannot transfer to yourself.');
      if (recipient.bot) throw new UserFacingError('You cannot transfer to a bot.');
      const settings = await services.economy.getSettings(guild.id);
      await interaction.deferReply();
      const result = await services.economy.transfer({
        guildId: guild.id,
        fromUserId: interaction.user.id,
        toUserId: recipient.id,
        amount,
      });
      await interaction.editReply({
        embeds: [
          successEmbed(
            `Sent **${formatNumber(result.amount)}** ${settings.currencySymbol} to <@${recipient.id}>.${result.fee > 0 ? ` Fee: ${formatNumber(result.fee)}` : ''}\nYour wallet: **${formatNumber(result.senderWallet)}**`,
            '💸 Transfer complete',
          ),
        ],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('bank')
      .setDescription('Move currency between your wallet and your bank')
      .addSubcommand((sub) =>
        sub
          .setName('deposit')
          .setDescription('Deposit into your bank')
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('Amount (or all)')
              .setRequired(true)
              .setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('withdraw')
          .setDescription('Withdraw from your bank')
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('Amount (or all)')
              .setRequired(true)
              .setMinValue(1),
          ),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const amount = interaction.options.getInteger('amount', true);
      const settings = await services.economy.getSettings(guild.id);
      const account = await services.repos.economy.ensureAccount(
        guild.id,
        interaction.user.id,
        settings.starterBalance,
      );
      const deposit = sub === 'deposit';
      if (deposit && account.wallet < amount)
        throw new UserFacingError(`You only have ${account.wallet} in your wallet.`);
      if (!deposit && account.bank < amount)
        throw new UserFacingError(`You only have ${account.bank} in your bank.`);

      await services.db.transaction(async (client) => {
        await client.query(
          `UPDATE economy_accounts
              SET wallet = wallet ${deposit ? '-' : '+'} $3, bank = bank ${deposit ? '+' : '-'} $3, updated_at = now()
            WHERE guild_id = $1 AND user_id = $2`,
          [guild.id, interaction.user.id, amount],
        );
        await client.query(
          `INSERT INTO economy_transactions (guild_id, user_id, type, amount, balance_after)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            guild.id,
            interaction.user.id,
            deposit ? 'deposit' : 'withdraw',
            deposit ? -amount : amount,
            deposit ? account.wallet - amount : account.wallet + amount,
          ],
        );
      });
      const updated = await services.repos.economy.getAccount(guild.id, interaction.user.id);
      await interaction.reply({
        embeds: [
          successEmbed(
            `${deposit ? 'Deposited' : 'Withdrew'} **${formatNumber(amount)}** ${settings.currencySymbol}.\nWallet: **${formatNumber(updated?.wallet ?? 0)}** • Bank: **${formatNumber(updated?.bank ?? 0)}**`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder().setName('shop').setDescription('Browse the server shop'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const settings = await services.economy.getSettings(guild.id);
      if (!settings.shopEnabled) throw new UserFacingError('The shop is disabled in this server.');
      const items = await services.repos.economy.listShopItems(guild.id);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.economy)
            .setTitle(`🛒 ${guild.name} shop`)
            .setDescription(
              items.length === 0
                ? 'The shop is empty. Staff can add items with `/shopmanage add`.'
                : items
                    .slice(0, 25)
                    .map(
                      (item) =>
                        `**${item.name}** — ${formatNumber(item.price)} ${settings.currencySymbol}\n${truncate(item.description ?? 'No description', 120)}${item.stock !== null ? `\nStock: ${item.stock}` : ''}${item.role_id ? `\nRole: <@&${item.role_id}>` : ''}`,
                    )
                    .join('\n\n'),
            )
            .setFooter({ text: 'Buy with /buy <item>' }),
        ],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('buy')
      .setDescription('Buy an item from the shop')
      .addStringOption((option) =>
        option.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true),
      )
      .addIntegerOption((option) =>
        option.setName('quantity').setDescription('How many').setMinValue(1).setMaxValue(100),
      ),
    autocomplete: async ({ interaction, services }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.respond([]);
        return;
      }
      const items = await services.repos.economy.listShopItems(guildId).catch(() => []);
      const focused = interaction.options.getFocused().toLowerCase();
      await interaction.respond(
        items
          .filter((item) => item.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map((item) => ({ name: `${item.name} — ${item.price}`, value: item.name })),
      );
    },
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const itemName = interaction.options.getString('item', true);
      const quantity = interaction.options.getInteger('quantity') ?? 1;
      const settings = await services.economy.getSettings(guild.id);
      await interaction.deferReply();
      const result = await services.economy.buy(guild.id, interaction.user.id, itemName, quantity);
      let roleApplied = false;
      if (result.roleId) {
        const member = actor(interaction);
        const role = await guild.roles.fetch(result.roleId).catch(() => null);
        const me = guild.members.me;
        if (role && me && role.position < me.roles.highest.position) {
          roleApplied = await member.roles
            .add(role, `Purchased ${result.itemName}`)
            .then(() => true)
            .catch(() => false);
        }
      }
      await services.logging
        .log(guild, {
          category: 'economy',
          title: 'Purchase',
          description: `<@${interaction.user.id}> bought **${result.itemName}** ×${result.quantity} for ${formatNumber(result.price * result.quantity)} ${settings.currencySymbol}.`,
          actorId: interaction.user.id,
          auditAction: 'economy.purchase',
        })
        .catch(() => {});
      await interaction.editReply({
        embeds: [
          successEmbed(
            `You bought **${result.itemName}** ×${result.quantity} for **${formatNumber(result.price * result.quantity)}** ${settings.currencySymbol}.\nNew wallet balance: **${formatNumber(result.balance)}**${result.roleId ? `\nRole applied: ${roleApplied ? 'yes' : 'no — ask staff to grant it manually'}` : ''}`,
          ),
        ],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('inventory')
      .setDescription('Show your purchased items'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const items = await services.repos.economy.getInventory(guild.id, interaction.user.id);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.economy)
            .setTitle('🎒 Inventory')
            .setDescription(
              items.length === 0
                ? 'You have not purchased anything yet.'
                : items
                    .map(
                      (item) =>
                        `**${item.name}** ×${item.quantity} — acquired <t:${Math.floor(item.acquired_at.getTime() / 1000)}:R>`,
                    )
                    .join('\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('top')
      .setDescription('Leaderboards for currency and levels')
      .addSubcommand((sub) =>
        sub
          .setName('currency')
          .setDescription('Richest members')
          .addIntegerOption((option) =>
            option.setName('page').setDescription('Page').setMinValue(1).setMaxValue(50),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('levels')
          .setDescription('Highest XP members')
          .addIntegerOption((option) =>
            option.setName('page').setDescription('Page').setMinValue(1).setMaxValue(50),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('messages').setDescription('Most messages sent (tracked)'),
      )
      .addSubcommand((sub) => sub.setName('voice').setDescription('Most voice minutes (tracked)')),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const sub = interaction.options.getSubcommand(true);
      const page = interaction.options.getInteger('page') ?? 1;
      await interaction.deferReply();
      const { sendPaginated } = await import('../core/ui.js');
      const settings = await services.economy.getSettings(guild.id);
      if (sub === 'currency') {
        const rows = await services.repos.economy.getLeaderboard(guild.id, 100);
        await sendPaginated(
          interaction,
          rows,
          (row, index) =>
            `**${index + 1}.** <@${row.user_id}> — ${formatNumber(row.total)} ${settings.currencySymbol} (wallet ${formatNumber(row.wallet)})`,
          {
            title: `💰 Richest members`,
            pageSize: 15,
            emptyMessage: 'No economy accounts yet.',
            timeoutMs: 180_000,
          },
        );
        void page;
        return;
      }
      if (sub === 'levels') {
        const rows = await services.repos.levels.getLeaderboard(guild.id, 100);
        await sendPaginated(
          interaction,
          rows,
          (row, index) =>
            `**${index + 1}.** <@${row.user_id}> — level **${row.level}** (${formatNumber(row.xp)} XP)`,
          {
            title: '📈 Level leaderboard',
            pageSize: 15,
            emptyMessage: 'Nobody has earned XP yet.',
          },
        );
        return;
      }
      if (sub === 'messages') {
        const rows = await services.db
          .query<{ user_id: string; messages: number }>(
            `SELECT user_id, messages FROM member_levels WHERE guild_id = $1 ORDER BY messages DESC LIMIT 100`,
            [guild.id],
          )
          .then((result) => result.rows);
        await sendPaginated(
          interaction,
          rows,
          (row, index) =>
            `**${index + 1}.** <@${row.user_id}> — ${formatNumber(Number(row.messages))} messages`,
          {
            title: '💬 Most active members',
            pageSize: 15,
            emptyMessage: 'No message statistics yet.',
          },
        );
        return;
      }
      const rows = await services.db
        .query<{ user_id: string; voice_minutes: number }>(
          `SELECT user_id, voice_minutes FROM member_levels WHERE guild_id = $1 ORDER BY voice_minutes DESC LIMIT 100`,
          [guild.id],
        )
        .then((result) => result.rows);
      await sendPaginated(
        interaction,
        rows,
        (row, index) =>
          `**${index + 1}.** <@${row.user_id}> — ${formatNumber(Number(row.voice_minutes))} voice minutes`,
        { title: '🎙️ Voice activity', pageSize: 15, emptyMessage: 'No voice statistics yet.' },
      );
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('achievements')
      .setDescription('Show your achievement progress'),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const achievements = await services.economy.achievements(guild.id, interaction.user.id);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.economy)
            .setTitle('🏆 Achievements')
            .setDescription(
              achievements.length === 0
                ? 'No achievements are configured. Run `npm run seed` or add them in the database.'
                : achievements
                    .map((achievement) => {
                      const requirement = achievement.requirement as { value?: number } | null;
                      const target = requirement?.value ?? 1;
                      return `${achievement.completed ? '✅' : '⬜'} **${achievement.name}** — ${achievement.description ?? ''}\n${progressBar(achievement.progress, target, 10)} ${achievement.progress}/${target} • reward ${achievement.reward}`;
                    })
                    .join('\n\n'),
            ),
        ],
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('econ')
      .setDescription('Economy administration')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add currency to a member')
          .addUserOption((option) =>
            option.setName('user').setDescription('Member').setRequired(true),
          )
          .addIntegerOption((option) =>
            option.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Reason (recorded in the audit log)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove currency from a member')
          .addUserOption((option) =>
            option.setName('user').setDescription('Member').setRequired(true),
          )
          .addIntegerOption((option) =>
            option.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Reason (recorded in the audit log)'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set a member’s wallet to an exact value')
          .addUserOption((option) =>
            option.setName('user').setDescription('Member').setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('New wallet balance')
              .setRequired(true)
              .setMinValue(0),
          )
          .addStringOption((option) => option.setName('reason').setDescription('Reason')),
      )
      .addSubcommand((sub) => sub.setName('stats').setDescription('Show economy supply statistics'))
      .addSubcommand((sub) =>
        sub
          .setName('reset')
          .setDescription('Reset every economy account in this server (dangerous)'),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireUserPermissions(
        actor(interaction),
        [PermissionFlagsBits.ManageGuild],
        'economy administration',
      );
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.economy.getSettings(guild.id);

      if (sub === 'stats') {
        const stats = await services.repos.economy.economyStats(guild.id);
        await interaction.reply({
          embeds: [
            baseEmbed(COLORS.economy)
              .setTitle('📊 Economy statistics')
              .addFields(
                { name: 'Accounts', value: formatNumber(stats.accounts), inline: true },
                { name: 'Total supply', value: formatNumber(stats.totalSupply), inline: true },
                { name: 'Total earned', value: formatNumber(stats.totalEarned), inline: true },
                { name: 'Total spent', value: formatNumber(stats.totalSpent), inline: true },
                {
                  name: 'Currency',
                  value: `${settings.currencySymbol} ${settings.currencyName}`,
                  inline: true,
                },
                {
                  name: 'Shop items',
                  value: String(
                    (await services.repos.economy.listShopItems(guild.id, true)).length,
                  ),
                  inline: true,
                },
              ),
          ],
        });
        return;
      }

      if (sub === 'reset') {
        const { confirmAction } = await import('../core/ui.js');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const confirmed = await confirmAction(interaction, {
          title: 'Reset the entire economy',
          description:
            'This deletes every balance, transaction, cooldown and inventory entry for this server. Shop items and achievements are kept. This cannot be undone.',
          confirmLabel: 'Delete all economy data',
        });
        if (!confirmed) {
          await interaction.editReply({
            embeds: [warningEmbed('Reset cancelled.')],
            components: [],
          });
          return;
        }
        const deleted = await services.db.transaction(async (client) => {
          const result = await client.query(
            `WITH removed AS (
               DELETE FROM economy_accounts WHERE guild_id = $1 RETURNING 1
             ) SELECT count(*)::int AS count FROM removed`,
            [guild.id],
          );
          await client.query('DELETE FROM economy_transactions WHERE guild_id = $1', [guild.id]);
          await client.query('DELETE FROM economy_cooldowns WHERE guild_id = $1', [guild.id]);
          await client.query('DELETE FROM inventory WHERE guild_id = $1', [guild.id]);
          return Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0);
        });
        await services.repos.audit.log({
          guildId: guild.id,
          actorId: interaction.user.id,
          actorType: 'user',
          action: 'economy.reset',
          metadata: { accounts: deleted },
        });
        await interaction.editReply({
          embeds: [successEmbed(`Economy reset — ${deleted} account(s) deleted.`)],
          components: [],
        });
        return;
      }

      const user = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason') ?? null;
      if (sub === 'set') {
        const account = await services.repos.economy.ensureAccount(
          guild.id,
          user.id,
          settings.starterBalance,
        );
        const delta = amount - account.wallet;
        if (delta !== 0) {
          await services.economy.adminAdjust({
            guildId: guild.id,
            userId: user.id,
            amount: delta,
            actorId: interaction.user.id,
            reason,
          });
        }
        const updated = await services.repos.economy.getAccount(guild.id, user.id);
        await interaction.reply({
          embeds: [
            successEmbed(
              `Wallet of <@${user.id}> set to **${formatNumber(updated?.wallet ?? 0)}** ${settings.currencySymbol}.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const delta = sub === 'add' ? amount : -amount;
      const result = await services.economy.adminAdjust({
        guildId: guild.id,
        userId: user.id,
        amount: delta,
        actorId: interaction.user.id,
        reason,
      });
      await interaction.reply({
        embeds: [
          successEmbed(
            `${sub === 'add' ? 'Added' : 'Removed'} **${formatNumber(amount)}** ${settings.currencySymbol} ${sub === 'add' ? 'to' : 'from'} <@${user.id}>.\nNew wallet: **${formatNumber(result.balance)}**`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('shopmanage')
      .setDescription('Manage shop items')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Create or update a shop item')
          .addStringOption((option) =>
            option.setName('name').setDescription('Item name').setRequired(true),
          )
          .addIntegerOption((option) =>
            option.setName('price').setDescription('Price').setRequired(true).setMinValue(0),
          )
          .addStringOption((option) => option.setName('description').setDescription('Description'))
          .addRoleOption((option) =>
            option.setName('role').setDescription('Role granted on purchase'),
          )
          .addIntegerOption((option) =>
            option
              .setName('stock')
              .setDescription('Limited stock (omit for unlimited)')
              .setMinValue(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Delete a shop item')
          .addStringOption((option) =>
            option
              .setName('name')
              .setDescription('Item name')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('List every item including disabled ones'),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      requireUserPermissions(
        actor(interaction),
        [PermissionFlagsBits.ManageGuild],
        'shop management',
      );
      const sub = interaction.options.getSubcommand(true);
      const settings = await services.economy.getSettings(guild.id);
      if (sub === 'add') {
        const id = await services.repos.economy.createShopItem({
          guildId: guild.id,
          name: interaction.options.getString('name', true),
          description: interaction.options.getString('description'),
          price: interaction.options.getInteger('price', true),
          roleId: interaction.options.getRole('role')?.id ?? null,
          stock: interaction.options.getInteger('stock'),
          createdBy: interaction.user.id,
        });
        await interaction.reply({
          embeds: [successEmbed(`Shop item saved (id ${id}).`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'remove') {
        const removed = await services.repos.economy.deleteShopItem(
          guild.id,
          interaction.options.getString('name', true),
        );
        await interaction.reply({
          embeds: [removed ? successEmbed('Item deleted.') : warningEmbed('No such item.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const items = await services.repos.economy.listShopItems(guild.id, true);
      await interaction.reply({
        embeds: [
          baseEmbed(COLORS.economy)
            .setTitle('🏪 Shop items')
            .setDescription(
              items.length === 0
                ? 'No items configured.'
                : items
                    .map(
                      (item) =>
                        `**${item.name}** — ${formatNumber(item.price)} ${settings.currencySymbol} • ${item.enabled ? 'enabled' : 'disabled'}${item.stock !== null ? ` • stock ${item.stock}` : ''}${item.role_id ? ` • role <@&${item.role_id}>` : ''}`,
                    )
                    .join('\n'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    category: 'economy',
    data: new SlashCommandBuilder()
      .setName('econfiscate')
      .setDescription('Confiscate currency from a member (moderator action, logged as a case)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((option) =>
        option.setName('target').setDescription('Member').setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName('amount')
          .setDescription('Amount to confiscate')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('Reason').setRequired(true),
      ),
    async execute({ interaction, services }: CommandContext) {
      const guild = guildOf(interaction);
      const target = interaction.options.getUser('target', true);
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason', true);
      const settings = await services.economy.getSettings(guild.id);
      const account = await services.repos.economy.ensureAccount(
        guild.id,
        target.id,
        settings.starterBalance,
      );
      const take = Math.min(amount, account.wallet);
      await interaction.deferReply();
      const caseRecord = await services.repos.moderation.createCase({
        guildId: guild.id,
        userId: target.id,
        moderatorId: interaction.user.id,
        action: 'note',
        reason: `Confiscated ${take} ${settings.currencyName}: ${reason}`,
        source: 'command',
      });
      if (take > 0) {
        await services.economy.adminAdjust({
          guildId: guild.id,
          userId: target.id,
          amount: -take,
          actorId: interaction.user.id,
          reason: `Confiscation (case #${caseRecord.case_number}): ${reason}`,
        });
      }
      await interaction.editReply({
        embeds: [
          take > 0
            ? successEmbed(
                `Confiscated **${formatNumber(take)}** ${settings.currencySymbol} from <@${target.id}> (case #${caseRecord.case_number}).`,
              )
            : errorEmbed(`<@${target.id}> has nothing in their wallet to confiscate.`),
        ],
      });
    },
  },
]);

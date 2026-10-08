import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type Message,
  type MessageActionRowComponentBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { paginate, type Page } from '@bot-by-ai/shared';
import { INTERACTION_PREFIXES } from './constants.js';

export interface PaginatedPage {
  title?: string;
  description?: string;
  footer?: string;
}

/** Renders one page of a paginated result set as an embed. */
export function renderPage<const T>(
  items: readonly T[],
  page: number,
  pageSize: number,
  renderItem: (item: T, index: number) => string,
  options: { title?: string; emptyMessage?: string; pageSize?: number } = {},
): { page: Page<T>; title?: string; description: string; footer: string } {
  const result = paginate(items, page, pageSize);
  if (result.total === 0) {
    return {
      page: result,
      title: options.title,
      description: options.emptyMessage ?? 'Nothing to show here yet.',
      footer: '',
    };
  }
  const lines = result.items.map((item, index) => renderItem(item, (result.page - 1) * pageSize + index));
  return {
    page: result,
    title: options.title,
    description: lines.join('\n'),
    footer: `Page ${result.page}/${result.pageCount} • ${result.total} entries`,
  };
}

/**
 * Sends a paginated embed with working pagination buttons for 2 minutes.
 * Collectors are scoped to the invoking user so other members cannot hijack it.
 */
export async function sendPaginated<const T>(
  interaction: ChatInputCommandInteraction,
  items: readonly T[],
  renderItem: (item: T, index: number) => string,
  options: {
    title?: string;
    emptyMessage?: string;
    pageSize?: number;
    ephemeral?: boolean;
    /** Custom page renderer for pages with different titles/footers. */
    renderPageCustom?: (page: number) => PaginatedPage;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 10, 1), 25);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  let current = 1;

  const buildPayload = (): InteractionReplyOptions & InteractionEditReplyOptions => {
    let description: string;
    let title = options.title;
    let footer = `Page ${current}/${pageCount} • ${total} entries`;
    if (total === 0) {
      description = options.emptyMessage ?? 'Nothing to show here yet.';
      footer = '';
    } else if (options.renderPageCustom) {
      const custom = options.renderPageCustom(current);
      description = custom.description ?? '';
      title = custom.title ?? title;
      footer = custom.footer ?? footer;
    } else {
      const slice = items.slice((current - 1) * pageSize, current * pageSize);
      description = slice
        .map((item, index) => renderItem(item, (current - 1) * pageSize + index))
        .join('\n');
    }
    const embed = {
      title,
      description: description.slice(0, 4000),
      color: 0x5865f2,
      footer: footer ? { text: footer } : undefined,
    };
    const components =
      pageCount > 1 ? [buildPaginationRow(current, pageCount)] : [];
    return { embeds: [embed], components } as InteractionReplyOptions & InteractionEditReplyOptions;
  };

  if (pageCount <= 1) {
    await interaction.editReply(buildPayload());
    return;
  }
  await interaction.editReply(buildPayload());
  const message = (await interaction.fetchReply()) as Message;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: options.timeoutMs ?? 120_000,
    filter: (button) => button.user.id === interaction.user.id,
  });

  collector.on('collect', async (button) => {
    if (button.customId.endsWith(':next') && current < pageCount) current += 1;
    else if (button.customId.endsWith(':prev') && current > 1) current -= 1;
    else if (button.customId.endsWith(':first')) current = 1;
    else if (button.customId.endsWith(':last')) current = pageCount;
    await button.update(buildPayload() as Parameters<typeof button.update>[0]);
  });

  collector.on('end', async () => {
    await interaction.editReply({ components: [] }).catch(() => {});
  });
}

export function buildPaginationRow(
  page: number,
  pageCount: number,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const prefix = INTERACTION_PREFIXES.pagination;
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:first`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`${prefix}:prev`).setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}:counter`)
      .setLabel(`${page}/${pageCount}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder().setCustomId(`${prefix}:next`).setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(page >= pageCount),
    new ButtonBuilder().setCustomId(`${prefix}:last`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount),
  );
}

/**
 * Two-step confirmation for destructive actions.
 * Returns true only when the same user confirmed within the timeout.
 */
export async function confirmAction(
  interaction: ChatInputCommandInteraction,
  prompt: { title: string; description: string; confirmLabel?: string; danger?: boolean },
): Promise<boolean> {
  const prefix = INTERACTION_PREFIXES.confirm;
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:yes:${interaction.user.id}`)
      .setLabel(prompt.confirmLabel ?? 'Confirm')
      .setStyle(prompt.danger === false ? ButtonStyle.Primary : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${prefix}:no:${interaction.user.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    embeds: [{ title: prompt.title, description: prompt.description, color: 0xfee75c }],
    components: [row],
  });
  const message = (await interaction.fetchReply()) as Message;
  try {
    const button = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30_000,
      filter: (component) =>
        component.user.id === interaction.user.id && component.customId.startsWith(prefix),
    });
    const confirmed = button.customId === `${prefix}:yes:${interaction.user.id}`;
    await button.update({ components: [] });
    return confirmed;
  } catch {
    await interaction.editReply({ components: [] }).catch(() => {});
    return false;
  }
}

import { EmbedBuilder, type APIEmbed } from 'discord.js';
import { COLORS } from './constants.js';
import { truncate } from '@bot-by-ai/shared';

export function baseEmbed(color: number = COLORS.primary): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

export function successEmbed(description: string, title?: string): EmbedBuilder {
  const embed = baseEmbed(COLORS.success).setDescription(truncate(description, 4000));
  if (title) embed.setTitle(truncate(title, 256));
  return embed;
}

export function errorEmbed(description: string, title = 'Something went wrong'): EmbedBuilder {
  return baseEmbed(COLORS.danger)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(description, 4000));
}

export function warningEmbed(description: string, title = 'Warning'): EmbedBuilder {
  return baseEmbed(COLORS.warning)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(description, 4000));
}

export function infoEmbed(description: string, title?: string): EmbedBuilder {
  const embed = baseEmbed(COLORS.primary).setDescription(truncate(description, 4000));
  if (title) embed.setTitle(truncate(title, 256));
  return embed;
}

export function securityEmbed(description: string, title = 'Security event'): EmbedBuilder {
  return baseEmbed(COLORS.security)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(description, 4000));
}

export function fieldValue(lines: (string | null | undefined | false)[]): string {
  const filtered = lines.filter(
    (line): line is string => typeof line === 'string' && line.length > 0,
  );
  return filtered.length > 0 ? filtered.join('\n') : '—';
}

export function keyValue(
  entries: { key: string; value: string | number | null | undefined; inline?: boolean }[],
  embed: EmbedBuilder,
): EmbedBuilder {
  for (const entry of entries) {
    embed.addFields({
      name: truncate(entry.key, 256),
      value: truncate(
        entry.value === null || entry.value === undefined ? '—' : String(entry.value),
        1024,
      ),
      inline: entry.inline ?? true,
    });
  }
  return embed;
}

export function fromApiEmbed(embed: APIEmbed | undefined | null): EmbedBuilder | null {
  if (!embed) return null;
  return EmbedBuilder.from(embed);
}

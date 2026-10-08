/** Discord snowflake helpers (no discord.js dependency). */

export const DISCORD_EPOCH = 1_420_070_400_000;

export function isSnowflake(value: unknown): boolean {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

export function snowflakeToDate(snowflake: string): Date {
  const id = BigInt(snowflake);
  const timestamp = Number(id >> 22n) + DISCORD_EPOCH;
  return new Date(timestamp);
}

export function snowflakeToTimestamp(snowflake: string): number {
  return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH;
}

/** Account age in days — used by anti-raid / suspicious-account checks. */
export function accountAgeDays(snowflake: string, now = Date.now()): number {
  return (now - snowflakeToTimestamp(snowflake)) / 86_400_000;
}

/** Default avatar URL without needing a discord.js Client. */
export function defaultAvatarUrl(userId: string, discriminator = '0'): string {
  const index =
    discriminator !== '0' ? Number(discriminator) % 5 : Number((BigInt(userId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

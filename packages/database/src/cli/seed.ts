#!/usr/bin/env node
/**
 * Idempotent seed script: global achievements + optional demo guild data.
 *
 * Usage:
 *   npm run seed                 # global achievements only
 *   SEED_GUILD_ID=123 npm run seed   # also seed a guild with a demo shop
 */
import { createDatabase, createRepositories } from '../index.js';

const GLOBAL_ACHIEVEMENTS = [
  {
    key: 'first_message',
    name: 'First Words',
    description: 'Send your first tracked message',
    reward: 50,
    requirement: { type: 'messages', value: 1 },
  },
  {
    key: 'chatterbox',
    name: 'Chatterbox',
    description: 'Send 1,000 messages',
    reward: 500,
    requirement: { type: 'messages', value: 1000 },
  },
  {
    key: 'level_10',
    name: 'Rising Star',
    description: 'Reach level 10',
    reward: 250,
    requirement: { type: 'level', value: 10 },
  },
  {
    key: 'level_50',
    name: 'Veteran',
    description: 'Reach level 50',
    reward: 2500,
    requirement: { type: 'level', value: 50 },
  },
  {
    key: 'rich',
    name: 'Well Off',
    description: 'Hold 10,000 in your wallet',
    reward: 0,
    requirement: { type: 'wallet', value: 10000 },
  },
  {
    key: 'helper',
    name: 'Helper',
    description: 'Have 10 suggestions accepted',
    reward: 300,
    requirement: { type: 'suggestions_accepted', value: 10 },
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const db = createDatabase({ url, max: 2, applicationName: 'bot-by-ai-seed' });
  const repos = createRepositories(db);

  try {
    for (const achievement of GLOBAL_ACHIEVEMENTS) {
      await db.query(
        `INSERT INTO achievements (guild_id, key, name, description, requirement, reward)
         VALUES (NULL, $1, $2, $3, $4::jsonb, $5)
         ON CONFLICT DO NOTHING`,
        [
          achievement.key,
          achievement.name,
          achievement.description,
          JSON.stringify(achievement.requirement),
          achievement.reward,
        ],
      );
    }
    console.log(`seeded ${GLOBAL_ACHIEVEMENTS.length} global achievements`);

    const guildId = process.env.SEED_GUILD_ID;
    if (guildId) {
      await repos.guilds.ensureGuild({ id: guildId, name: 'Seeded Guild', memberCount: 0 });
      await repos.economy.createShopItem({
        guildId,
        name: 'Custom Colour',
        description: 'Unlock a custom role colour (staff applies the role).',
        price: 5000,
        createdBy: 'seed',
      });
      await repos.economy.createShopItem({
        guildId,
        name: 'VIP Role',
        description: 'Grants the VIP role in this server.',
        price: 25000,
        createdBy: 'seed',
      });
      console.log(`seeded demo shop items for guild ${guildId}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

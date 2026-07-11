import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

export async function pushSchema(connectionString: string) {
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      team_id TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      webhook_url TEXT NOT NULL DEFAULT '',
      auto_approve_users TEXT NOT NULL DEFAULT '',
      metadata_schema TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      slack_ts TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_ts ON messages(channel_id, slack_ts)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, timestamp DESC)
  `);

  // Add auto_approve_users column if it doesn't exist (for existing DBs)
  await db.execute(sql`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS auto_approve_users TEXT NOT NULL DEFAULT ''
  `);
  await db.execute(sql`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS metadata_schema TEXT NOT NULL DEFAULT ''
  `);
  await db.execute(sql`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata TEXT NOT NULL DEFAULT ''
  `);

  await client.end();
}

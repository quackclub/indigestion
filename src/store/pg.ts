import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Store, StoreChannel, StoreMessage } from "./store";

export class PostgresStore implements Store {
  private db: ReturnType<typeof drizzle>;
  private client: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    this.client = postgres(connectionString, { prepare: false });
    this.db = drizzle(this.client, { schema });
  }

  async getChannel(id: string): Promise<StoreChannel | null> {
    const rows = await this.db.select().from(schema.channels).where(eq(schema.channels.id, id)).limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, name: r.name, teamId: r.teamId, enabled: Boolean(r.enabled), webhookUrl: r.webhookUrl, autoApproveUsers: r.autoApproveUsers ? r.autoApproveUsers.split(",").filter(Boolean) : [], metadataSchema: r.metadataSchema, createdAt: r.createdAt };
  }

  async upsertChannel(ch: StoreChannel): Promise<void> {
    await this.db
      .insert(schema.channels)
      .values({
        id: ch.id,
        name: ch.name,
        teamId: ch.teamId,
        enabled: ch.enabled ? 1 : 0,
        webhookUrl: ch.webhookUrl,
        autoApproveUsers: ch.autoApproveUsers.join(","),
        metadataSchema: ch.metadataSchema,
        createdAt: sql`COALESCE((SELECT created_at FROM channels WHERE id = ${ch.id}), now()::text)`,
      })
      .onConflictDoUpdate({
        target: schema.channels.id,
        set: {
          name: ch.name,
          teamId: ch.teamId,
          enabled: ch.enabled ? 1 : 0,
          webhookUrl: ch.webhookUrl,
          autoApproveUsers: ch.autoApproveUsers.join(","),
          metadataSchema: ch.metadataSchema,
        },
      });
  }

  async listEnabledChannels(): Promise<StoreChannel[]> {
    const rows = await this.db.select().from(schema.channels).where(eq(schema.channels.enabled, 1));
    return rows.map((r) => ({ id: r.id, name: r.name, teamId: r.teamId, enabled: true, webhookUrl: r.webhookUrl, autoApproveUsers: r.autoApproveUsers ? r.autoApproveUsers.split(",").filter(Boolean) : [], metadataSchema: r.metadataSchema, createdAt: r.createdAt }));
  }

  async upsertMessage(msg: StoreMessage): Promise<void> {
    await this.db
      .insert(schema.messages)
      .values({
        slackTs: msg.slackTs,
        channelId: msg.channelId,
        userId: msg.userId,
        userName: msg.userName,
        text: msg.text,
        timestamp: msg.timestamp,
        metadata: typeof msg.metadata === "string" ? msg.metadata : JSON.stringify(msg.metadata || {}),
      })
      .onConflictDoUpdate({
        target: [schema.messages.channelId, schema.messages.slackTs],
        set: {
          userId: msg.userId,
          userName: msg.userName,
          text: msg.text,
          timestamp: msg.timestamp,
          metadata: typeof msg.metadata === "string" ? msg.metadata : JSON.stringify(msg.metadata || {}),
        },
      });
  }

  async getMessages(channelId: string, limit = 50, offset = 0): Promise<StoreMessage[]> {
    if (limit > 200) limit = 200;
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, channelId))
      .orderBy(sql`timestamp DESC`)
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      slackTs: r.slackTs,
      channelId: r.channelId,
      userId: r.userId,
      userName: r.userName,
      text: r.text,
      timestamp: r.timestamp,
      metadata: typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata || {}),
    }));
  }

  close(): void {
    this.client.end();
  }
}

import { pgTable, text, integer, uniqueIndex, index } from "drizzle-orm/pg-core";

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  teamId: text("team_id").notNull().default(""),
  enabled: integer("enabled").notNull().default(0),
  webhookUrl: text("webhook_url").notNull().default(""),
  autoApproveUsers: text("auto_approve_users").notNull().default(""),
  createdAt: text("created_at").notNull().default("now()"),
});

export const messages = pgTable(
  "messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    slackTs: text("slack_ts").notNull(),
    channelId: text("channel_id").notNull(),
    userId: text("user_id").notNull().default(""),
    userName: text("user_name").notNull().default(""),
    text: text("text").notNull().default(""),
    timestamp: text("timestamp").notNull(),
  },
  (t) => ({
    uniqueMsg: uniqueIndex("uq_messages_channel_ts").on(t.channelId, t.slackTs),
    channelTsIdx: index("idx_messages_channel_ts").on(t.channelId, t.timestamp.desc()),
  }),
);

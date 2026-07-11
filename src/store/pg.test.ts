import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { PostgresStore } from "./pg";
import { pushSchema } from "../db/migrate";

const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!TEST_DB_URL) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set");
}

let store: PostgresStore;

beforeAll(async () => {
  await pushSchema(TEST_DB_URL);
  store = new PostgresStore(TEST_DB_URL);
  // Clean any leftover data from previous runs
  const { sql } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = await import("postgres");
  const cleanClient = postgres.default(TEST_DB_URL, { max: 1 });
  const cleanDb = drizzle(cleanClient);
  await cleanDb.execute(sql`DELETE FROM messages`);
  await cleanDb.execute(sql`DELETE FROM channels`);
  await cleanClient.end();
});

afterAll(() => {
  store.close();
});

describe("PostgresStore", () => {
  it("should insert and retrieve a channel", async () => {
    await store.upsertChannel({ id: "C001", name: "general", teamId: "T001", enabled: false, webhookUrl: "", autoApproveUsers: [], createdAt: "" });
    const ch = await store.getChannel("C001");
    expect(ch).not.toBeNull();
    expect(ch!.name).toBe("general");
    expect(ch!.enabled).toBe(false);
  });

  it("should enable a channel via upsert", async () => {
    await store.upsertChannel({ id: "C001", name: "general", teamId: "T001", enabled: true, webhookUrl: "", autoApproveUsers: [], createdAt: "" });
    const ch = await store.getChannel("C001");
    expect(ch!.enabled).toBe(true);
  });

  it("should update channel fields on upsert", async () => {
    await store.upsertChannel({
      id: "C001", name: "updated-name", teamId: "T001", enabled: true,
      webhookUrl: "https://hook.example.com", autoApproveUsers: ["U1", "U2"], createdAt: "",
    });
    const ch = await store.getChannel("C001");
    expect(ch!.name).toBe("updated-name");
    expect(ch!.webhookUrl).toBe("https://hook.example.com");
    expect(ch!.autoApproveUsers).toEqual(["U1", "U2"]);
  });

  it("should list only enabled channels", async () => {
    await store.upsertChannel({ id: "C002", name: "random", teamId: "T001", enabled: false, webhookUrl: "", autoApproveUsers: [], createdAt: "" });
    await store.upsertChannel({ id: "C003", name: "dev", teamId: "T001", enabled: true, webhookUrl: "", autoApproveUsers: [], createdAt: "" });
    const enabled = await store.listEnabledChannels();
    expect(enabled.length).toBe(2);
    expect(enabled.map((c) => c.id).sort()).toEqual(["C001", "C003"]);
  });

  it("should return null for missing channel", async () => {
    expect(await store.getChannel("NONEXISTENT")).toBeNull();
  });

  it("should insert and retrieve messages in descending order", async () => {
    const now = new Date();
    const msgs = [
      { slackTs: "1.000", channelId: "C001", userId: "U1", userName: "alice", text: "first", timestamp: new Date(now.getTime() - 3000).toISOString() },
      { slackTs: "2.000", channelId: "C001", userId: "U2", userName: "bob", text: "second", timestamp: new Date(now.getTime() - 2000).toISOString() },
      { slackTs: "3.000", channelId: "C001", userId: "U1", userName: "alice", text: "third", timestamp: new Date(now.getTime() - 1000).toISOString() },
    ];
    for (const m of msgs) await store.upsertMessage(m);

    const got = await store.getMessages("C001", 10, 0);
    expect(got.length).toBe(3);
    expect(got[0].slackTs).toBe("3.000");
    expect(got[1].slackTs).toBe("2.000");
    expect(got[2].slackTs).toBe("1.000");
  });

  it("should deduplicate and update messages on conflict", async () => {
    await store.upsertMessage({ slackTs: "1.000", channelId: "C001", userId: "U1", userName: "alice", text: "edited text", timestamp: new Date().toISOString() });
    const got = await store.getMessages("C001", 10, 0);
    const updated = got.find((m) => m.slackTs === "1.000");
    expect(updated).not.toBeUndefined();
    expect(updated!.text).toBe("edited text");
  });

  it("should respect limit and offset", async () => {
    const got = await store.getMessages("C001", 2, 0);
    expect(got.length).toBe(2);
    const got2 = await store.getMessages("C001", 10, 2);
    expect(got2.length).toBe(1);
  });

  it("should not allow limit > 200", async () => {
    const got = await store.getMessages("C001", 999, 0);
    expect(got.length).toBeLessThanOrEqual(200);
  });

  it("should persist webhookUrl and autoApproveUsers on channel", async () => {
    await store.upsertChannel({ id: "C010", name: "webhook-test", teamId: "T001", enabled: true, webhookUrl: "https://hooks.example.com/feed", autoApproveUsers: ["U100", "U200"], createdAt: "" });
    const ch = await store.getChannel("C010");
    expect(ch!.webhookUrl).toBe("https://hooks.example.com/feed");
    expect(ch!.autoApproveUsers).toEqual(["U100", "U200"]);
  });
});

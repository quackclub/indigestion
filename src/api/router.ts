import { z } from "zod";
import type { Store, StoreMessage } from "../store/store";

const listInput = z.object({
  channel: z.string().min(1, "channel is required"),
  after: z.string().optional(),
  before: z.string().optional(),
  userId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10000).default(50),
  page: z.coerce.number().int().min(1).default(1),
});

const getInput = z.object({
  slackTs: z.string(),
  channel: z.string().min(1, "channel is required"),
});

export async function handleAPI(store: Store, url: URL, req: Request): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/messages" && method === "GET") {
    const parsed = listInput.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { channel, after, before, userId, limit, page } = parsed.data;

    const ch = await store.getChannel(channel);
    if (!ch || !ch.enabled) {
      return new Response(JSON.stringify({ error: "channel not found or not enabled" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const all = await store.getMessages(channel, 100000, 0);

    let filtered: StoreMessage[] = all;
    if (after) filtered = filtered.filter((m) => m.timestamp >= after);
    if (before) filtered = filtered.filter((m) => m.timestamp <= before);
    if (userId) filtered = filtered.filter((m) => m.userId === userId);

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const items = filtered.slice(offset, offset + limit);

    return new Response(
      JSON.stringify({
        data: items,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const msgMatch = path.match(/^\/api\/messages\/([^/]+)$/);
  if (msgMatch && method === "GET") {
    const slackTs = decodeURIComponent(msgMatch[1]);
    const channel = url.searchParams.get("channel") || "";

    const parsed = getInput.safeParse({ slackTs, channel });
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const all = await store.getMessages(channel, 100000, 0);
    const msg = all.find((m) => m.slackTs === slackTs);
    if (!msg) {
      return new Response(JSON.stringify({ error: "message not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null; // not an API route
}

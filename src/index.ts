import { WebClient } from "@slack/web-api";
import { verifyRequestSignature } from "@slack/events-api";
import { Feed } from "feed";
import type { Store, StoreChannel, StoreMessage } from "./store/store";
import { PostgresStore } from "./store/pg";
import { handleAPI } from "./api/router";

// --- Config ---

const PORT = parseInt(process.env.PORT || "8080");
const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;
const DATABASE_URL = process.env.DATABASE_URL || "";
const API_USERNAME = process.env.API_USERNAME || "admin";
const API_PASSWORD = process.env.API_PASSWORD || "";
const LOCKDOWN_USERS = (process.env.LOCKDOWN_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET) {
  console.error("Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET");
  process.exit(1);
}

// --- Store ---

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

console.log("using postgres store");
const { pushSchema } = await import("./db/migrate");
await pushSchema(DATABASE_URL);
const store: Store = new PostgresStore(DATABASE_URL);

// --- API handler ---

// --- Slack client (single token for all operations) ---

const slack = new WebClient(SLACK_BOT_TOKEN);

// --- Basic auth ---

function requireAuth(request: Request): boolean {
  if (!API_PASSWORD) return true; // no password set = no auth
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Basic\s+(.+)$/);
  if (!match) return false;
  const decoded = atob(match[1]);
  const [user, pass] = decoded.split(":");
  return user === API_USERNAME && pass === API_PASSWORD;
}

// --- Helpers ---

function slackTsToTime(ts: string): Date {
  const parts = ts.split(".");
  const sec = parseInt(parts[0] || "0") || 0;
  const nsec = parseInt(parts[1] || "0") || 0;
  return new Date(sec * 1000 + nsec / 1e6);
}

async function isChannelManager(
  channelId: string,
  userId: string,
): Promise<boolean> {
  try {
    const conv = await slack.conversations.info({ channel: channelId });
    if ((conv.channel as any)?.creator === userId) return true;
  } catch {}
  return false;
}

function verifySignature(request: Request, body: string): boolean {
  const ts = request.headers.get("X-Slack-Request-Timestamp") || "";
  const sig = request.headers.get("X-Slack-Signature") || "";
  try {
    verifyRequestSignature({
      signingSecret: SLACK_SIGNING_SECRET,
      requestSignature: sig,
      requestTimestamp: ts,
      body,
    });
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: Request): Promise<string> {
  return await req.text();
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function slackResponse(responseUrl: string, text: string) {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, response_type: "ephemeral", replace_original: false }),
    });
  } catch {}
}

async function fireWebhook(ch: StoreChannel, msg: StoreMessage) {
  if (!ch.webhookUrl) return;
  try {
    await fetch(ch.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message.approved",
        channel: { id: ch.id, name: ch.name },
        message: {
          ts: msg.slackTs,
          user_id: msg.userId,
          user_name: msg.userName,
          text: msg.text,
          timestamp: msg.timestamp,
        },
      }),
    });
  } catch {}
}

// --- Event handlers ---

async function handleMemberJoined(channelId: string, userId: string) {
  // Only care when our bot joins a channel
  const auth = await slack.auth.test();
  if (userId !== auth.user_id) return;

  const ch: StoreChannel = {
    id: channelId,
    name: "",
    teamId: auth.team_id || "",
    enabled: false,
    webhookUrl: "",
    autoApproveUsers: [],
    createdAt: "",
  };
  await store.upsertChannel(ch);

  try {
    const conv = await slack.conversations.info({ channel: channelId });
    ch.name = (conv.channel as any)?.name || "";
    await store.upsertChannel(ch);
  } catch {}
}

async function handleMessage(channelId: string, userId: string, text: string, ts: string) {
  const ch = await store.getChannel(channelId);
  if (!ch || !ch.enabled) return;

  // Auto-approve mode: if autoApproveUsers is set, only auto-approve those users
  if (ch.autoApproveUsers.length > 0) {
    if (!ch.autoApproveUsers.includes(userId)) return; // skip non-auto users silently

    let userName = userId;
    try {
      const u = await slack.users.info({ user: userId });
      userName = (u.user as any)?.name || userId;
    } catch {}
    await store.upsertMessage({
      slackTs: ts,
      channelId,
      userId,
      userName,
      text,
      timestamp: slackTsToTime(ts).toISOString(),
    });
    await fireWebhook(ch, { slackTs: ts, channelId, userId, userName, text, timestamp: slackTsToTime(ts).toISOString() });
    return;
  }

  // Manual mode: show Yep!/No buttons for every message
  const section = {
    type: "section",
    text: { type: "mrkdwn", text: `Add this to the SlackFeed? 👇\n>${text}` },
    accessory: {
      type: "button",
      action_id: "slackfeed_yes",
      text: { type: "plain_text", text: "Yep!" },
      value: ts,
    },
  };

  const actions = {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "slackfeed_no",
        text: { type: "plain_text", text: "No thanks" },
        style: "danger" as const,
        value: ts,
      },
    ],
  };

  try {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: ts,
      blocks: [section, actions],
    });
  } catch {}
}

// --- Server ---

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // === Events ===

    if (path === "/events" && req.method === "POST") {
      const body = await readBody(req);
      if (!verifySignature(req, body)) {
        return jsonResponse({ error: "invalid signature" }, 401);
      }

      const payload = JSON.parse(body);

      if (payload.type === "url_verification") {
        return new Response(payload.challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (payload.type === "event_callback") {
        const ev = payload.event;

        if (ev.type === "member_joined_channel") {
          await handleMemberJoined(ev.channel, ev.user);
        }

        if (ev.type === "message" && !ev.subtype && !ev.bot_id) {
          await handleMessage(ev.channel, ev.user, ev.text, ev.ts);
        }
      }

      return new Response("ok", { status: 200 });
    }

    // === Interactive Components (button clicks) ===

    if (path === "/interactions" && req.method === "POST") {
      const body = await readBody(req);
      const formData = new URLSearchParams(body);
      const payloadStr = formData.get("payload");
      if (!payloadStr) return jsonResponse({ error: "missing payload" }, 400);

      const cb = JSON.parse(payloadStr);
      if (cb.type !== "block_actions") return jsonResponse({});

      const action = cb.actions?.[0];
      if (!action) return jsonResponse({});

      const channelId = cb.channel?.id;
      const messageTs = action.value;
      const responseUrl = cb.response_url;

      const ch = await store.getChannel(channelId);
      if (!ch || !ch.enabled) {
        await slackResponse(responseUrl, "This channel is not enabled.");
        return jsonResponse({});
      }

      if (action.action_id === "slackfeed_yes") {
        try {
          const history = await slack.conversations.history({
            channel: channelId,
            latest: messageTs,
            limit: 1,
            inclusive: true,
          });
          const msg = history.messages?.[0] as any;
          if (!msg) {
            await slackResponse(responseUrl, "Couldn't fetch that message.");
            return jsonResponse({});
          }

          let userName = msg.user || "";
          try {
            const u = await slack.users.info({ user: msg.user });
            userName = (u.user as any)?.name || userName;
          } catch {}

          await store.upsertMessage({
            slackTs: messageTs,
            channelId,
            userId: msg.user || "",
            userName,
            text: msg.text || "",
            timestamp: slackTsToTime(messageTs).toISOString(),
          });

          const savedMsg = { slackTs: messageTs, channelId, userId: msg.user || "", userName, text: msg.text || "", timestamp: slackTsToTime(messageTs).toISOString() };
          await fireWebhook(ch, savedMsg);

          await slackResponse(responseUrl, "✅ Message added to the SlackFeed!");
        } catch (err: any) {
          await slackResponse(responseUrl, `Error: ${err.message}`);
        }
      } else if (action.action_id === "slackfeed_no") {
        await slackResponse(responseUrl, "Got it, won't add it.");
      }

      return jsonResponse({});
    }

    // === Slash Commands ===

    if (path === "/slack" && req.method === "POST") {
      const body = await readBody(req);
      const form = new URLSearchParams(body);

      const sourceChannelId = form.get("channel_id") || "";
      const userId = form.get("user_id") || "";
      const text = (form.get("text") || "").trim();

      // --- Parse #channel prefix ---
      // Formats: <#C12345> or <#C12345|general> or #general
      const channelRefMatch = text.match(/^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*(.*)$/);
      let targetChannelId: string;
      let rest: string;

      if (channelRefMatch) {
        // Resolve by ID if available, otherwise by name
        const idFromRef = channelRefMatch[2]; // <#C12345...>
        const nameFromRef = channelRefMatch[4]; // #general
        rest = channelRefMatch[5].trim();

        if (idFromRef) {
          targetChannelId = idFromRef;
        } else {
          // Look up channel by name
          try {
            const list = await slack.conversations.list({ types: "public_channel,private_channel", limit: 1000 });
            const channels = list.channels as any[] || [];
            const found = channels.find((c: any) => c.name === nameFromRef);
            if (!found) {
              return jsonResponse({ response_type: "ephemeral", text: `Channel #${nameFromRef} not found.` });
            }
            targetChannelId = found.id;
          } catch {
            return jsonResponse({ response_type: "ephemeral", text: "Couldn't look up channels." });
          }
        }
      } else {
        targetChannelId = sourceChannelId;
        rest = text;
      }

      // Get or create channel record for the target
      let ch = await store.getChannel(targetChannelId);
      if (!ch) {
        let name = targetChannelId;
        try {
          const conv = await slack.conversations.info({ channel: targetChannelId });
          name = (conv.channel as any)?.name || targetChannelId;
        } catch {}
        const auth = await slack.auth.test();
        ch = { id: targetChannelId, name, teamId: auth.team_id || "", enabled: false, webhookUrl: "", autoApproveUsers: [], createdAt: "" };
        await store.upsertChannel(ch);
      }

      const parts = rest.split(/\s+/);
      const cmd = parts[0];
      const subcmd = parts[1];
      const arg = parts.slice(2).join(" ");

      // --- Helper: check channel ownership for the target channel ---
      const targetManager = () => isChannelManager(targetChannelId, userId);

      // --- Lockdown: restrict write commands to approved users ---
      if (LOCKDOWN_USERS.length > 0 && !LOCKDOWN_USERS.includes(userId) && cmd !== "status") {
        return jsonResponse({
          response_type: "ephemeral",
          text: "🔒 SlackFeed is in lockdown mode. Only authorized users can run commands.",
        });
      }

      switch (cmd) {
        case "enable": {
          if (subcmd === "auto") {
            // /slackfeed enable [#channel] auto @user
            const target = arg.replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();
            if (!target) {
              return jsonResponse({ response_type: "ephemeral", text: "Usage: \`/slackfeed enable auto @user\` — you can only enable auto for yourself or a bot." });
            }

            // Auto-approve mode implicitly enables the channel
            ch.enabled = true;

            // Self or bot check
            if (target !== userId) {
              try {
                const u = await slack.users.info({ user: target });
                const isBot = (u.user as any)?.is_bot;
                if (!isBot) {
                  // For non-bot targets, the caller must be the channel owner
                  if (!(await targetManager())) {
                    return jsonResponse({ response_type: "ephemeral", text: "Only the channel creator can enable auto-approve for another non-bot user." });
                  }
                }
              } catch {
                return jsonResponse({ response_type: "ephemeral", text: "Couldn't look up that user." });
              }
            }

            if (ch.autoApproveUsers.includes(target)) {
              return jsonResponse({ response_type: "ephemeral", text: `<@${target}> already has auto-approve.` });
            }
            ch.autoApproveUsers.push(target);
            await store.upsertChannel(ch);
            return jsonResponse({ response_type: "ephemeral", text: `✅ Auto-approve enabled for <@${target}> in #${ch.name}.` });
          }

          if (subcmd === "manual") {
            // /slackfeed enable [#channel] manual — manual reply-based mode, clear auto
            if (!(await targetManager())) {
              return jsonResponse({ response_type: "ephemeral", text: "Only the channel creator can enable manual mode." });
            }
            ch.enabled = true;
            ch.autoApproveUsers = [];
            await store.upsertChannel(ch);
            const label = targetChannelId === sourceChannelId ? "this channel" : `#${ch.name}`;
            return jsonResponse({ response_type: "ephemeral", text: `✅ Manual mode enabled for ${label}. Every message will get a Yep!/No prompt.` });
          }

          // /slackfeed enable [#channel] — manual mode
          if (subcmd) {
            return jsonResponse({ response_type: "ephemeral", text: "Usage: \`/slackfeed enable\` | \`/slackfeed enable #channel\` | \`/slackfeed enable auto @user\` | \`/slackfeed enable manual\`" });
          }
          if (!(await targetManager())) {
            return jsonResponse({ response_type: "ephemeral", text: "Only the channel creator can enable SlackFeed." });
          }
          ch.enabled = true;
          ch.autoApproveUsers = [];
          await store.upsertChannel(ch);
          const label = targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
          return jsonResponse({ response_type: "ephemeral", text: `✅ SlackFeed enabled${label}. New messages will get a prompt to add to the feed.` });
        }

        case "disable": {
          if (subcmd === "auto") {
            // /slackfeed disable [#channel] auto [@user]
            if (!ch.enabled) {
              return jsonResponse({ response_type: "ephemeral", text: `SlackFeed is not enabled in that channel.` });
            }
            const target = arg.replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();
            if (!target) {
              ch.autoApproveUsers = [];
              await store.upsertChannel(ch);
              return jsonResponse({ response_type: "ephemeral", text: `Auto-approve disabled for all users in #${ch.name}.` });
            }
            ch.autoApproveUsers = ch.autoApproveUsers.filter((id) => id !== target);
            await store.upsertChannel(ch);
            return jsonResponse({ response_type: "ephemeral", text: `Auto-approve disabled for <@${target}> in #${ch.name}.` });
          }

          // /slackfeed disable [#channel]
          if (subcmd) {
            return jsonResponse({ response_type: "ephemeral", text: "Usage: \`/slackfeed disable\` | \`/slackfeed disable #channel\` | \`/slackfeed disable auto [@user]\`" });
          }
          if (!(await targetManager())) {
            return jsonResponse({ response_type: "ephemeral", text: "Only the channel creator can disable SlackFeed." });
          }
          ch.enabled = false;
          await store.upsertChannel(ch);
          const label = targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
          return jsonResponse({ response_type: "ephemeral", text: `SlackFeed disabled${label}.` });
        }

        case "status": {
          const chName = targetChannelId === sourceChannelId ? "" : `#${ch.name} `;
          if (ch.enabled) {
            let msg = `✅ SlackFeed enabled for ${chName}\nRSS: ${BASE_URL}/feed/${targetChannelId}\nJSON: ${BASE_URL}/feed/${targetChannelId}.json`;
            if (ch.webhookUrl) msg += `\nWebhook: ${ch.webhookUrl}`;
            if (ch.autoApproveUsers.length > 0) {
              msg += `\nAuto-approve: ${ch.autoApproveUsers.map((id) => `<@${id}>`).join(", ")}`;
            }
            return jsonResponse({ response_type: "ephemeral", text: msg });
          }
          return jsonResponse({ response_type: "ephemeral", text: `SlackFeed is not enabled for ${chName}Run \`/slackfeed enable\` to start.` });
        }

        default: {
          if (!cmd) {
            return jsonResponse({
              response_type: "ephemeral",
              text: "Commands: \`enable [#channel]\` | \`disable [#channel]\` | \`status [#channel]\` | \`enable [#channel] auto @user\` | \`enable [#channel] manual\` | \`disable [#channel] auto [@user]\` | \`auto list [#channel]\` | \`webhook <url>\`",
            });
          }

          if (cmd === "webhook") {
            // /slackfeed webhook <url> or webhook clear (always from source channel, no cross-channel)
            if (targetChannelId !== sourceChannelId) {
              return jsonResponse({ response_type: "ephemeral", text: "Webhook commands must be run from the target channel." });
            }
            if (!(await targetManager())) {
              return jsonResponse({ response_type: "ephemeral", text: "Only the channel creator can configure webhooks." });
            }
            if (subcmd === "clear") {
              ch.webhookUrl = "";
              await store.upsertChannel(ch);
              return jsonResponse({ response_type: "ephemeral", text: "Webhook cleared." });
            }
            const url = parts.slice(1).join(" ");
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
              return jsonResponse({ response_type: "ephemeral", text: "Invalid URL. Must start with http:// or https://" });
            }
            ch.webhookUrl = url;
            await store.upsertChannel(ch);
            return jsonResponse({ response_type: "ephemeral", text: `✅ Webhook set to ${url}` });
          }

          if (cmd === "auto" && subcmd === "list") {
            // /slackfeed [#channel] auto list
            if (ch.autoApproveUsers.length === 0) {
              return jsonResponse({ response_type: "ephemeral", text: `No users have auto-approve in #${ch.name}.` });
            }
            const users = ch.autoApproveUsers.map((id) => `<@${id}>`).join(", ");
            return jsonResponse({ response_type: "ephemeral", text: `Auto-approve in #${ch.name}: ${users}` });
          }

          return jsonResponse({
            response_type: "ephemeral",
            text: "Commands: \`enable [#channel]\` | \`disable [#channel]\` | \`status [#channel]\` | \`enable [#channel] auto @user\` | \`enable [#channel] manual\` | \`disable [#channel] auto @user\` | \`auto list [#channel]\` | \`webhook <url>\`",
          });
        }
      }
    }

    // === RSS Feed / JSON API ===

    const feedMatch = path.match(/^\/feed\/([A-Za-z0-9]+)(\.json)?$/);
    if (feedMatch) {
      const channelId = feedMatch[1];
      const isJson = feedMatch[2] === ".json";

      const ch = await store.getChannel(channelId);
      if (!ch || !ch.enabled) {
        return jsonResponse({ error: "not found" }, 404);
      }

      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50") || 50, 200);
      const offset = parseInt(url.searchParams.get("offset") || "0") || 0;
      const msgs = await store.getMessages(channelId, limit, offset);

      if (isJson) {
        return jsonResponse(msgs);
      }

      const feed = new Feed({
        title: `#${ch.name} — SlackFeed`,
        link: `${BASE_URL}/feed/${channelId}`,
        description: `Recent messages from #${ch.name}`,
      });

      for (const m of msgs) {
        feed.addItem({
          title: m.userName || "unknown",
          description: m.text.substring(0, 500),
          date: new Date(m.timestamp),
          guid: `${channelId}:${m.slackTs}`,
        });
      }

      return new Response(feed.rss2(), {
        status: 200,
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      });
    }

    // === REST API (Basic Auth) ===

    if (path.startsWith("/api/")) {
      if (!requireAuth(req)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Basic realm=indigestion" },
        });
      }

      const result = await handleAPI(store, url, req);
      if (result) return result;
      return jsonResponse({ error: "not found" }, 404);
    }

    return jsonResponse({ error: "not found" }, 404);
  },
});

console.log(`indigestion listening on http://localhost:${PORT}`);

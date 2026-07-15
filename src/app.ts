import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { verifyRequestSignature } from "@slack/events-api";
import { Feed } from "feed";
import type { Store, StoreChannel, StoreMessage } from "./store/store";
import { PostgresStore } from "./store/pg";
import { handleAPI } from "./api/router";

// --- Config ---

const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;
const DATABASE_URL = process.env.DATABASE_URL || "";
const API_USERNAME = process.env.API_USERNAME || "admin";
const API_PASSWORD = process.env.API_PASSWORD || "";
const LOCKDOWN_USERS = (process.env.LOCKDOWN_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
const HACK_CLUB_CDN_KEY = process.env.HACK_CLUB_CDN_KEY || "";

if (LOCKDOWN_USERS.length > 0) {
  console.log(`lockdown active for users: [${LOCKDOWN_USERS.join(", ")}]`);
}

// --- Store (lazy singleton) ---

let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (storeInstance) return storeInstance;
  console.log("using postgres store");
  const { pushSchema } = await import("./db/migrate");
  await pushSchema(DATABASE_URL);
  storeInstance = new PostgresStore(DATABASE_URL);
  return storeInstance;
}

// --- Slack client (lazy singleton) ---

let slackInstance: WebClient | null = null;

function getSlack(): WebClient {
  if (slackInstance) return slackInstance;
  slackInstance = new WebClient(SLACK_BOT_TOKEN);
  return slackInstance;
}

// --- Helpers ---

function slackTsToTime(ts: string): Date {
  const parts = ts.split(".");
  const sec = parseInt(parts[0] || "0") || 0;
  const nsec = parseInt(parts[1] || "0") || 0;
  return new Date(sec * 1000 + nsec / 1e6);
}

async function isChannelManager(channelId: string, userId: string, slack: WebClient): Promise<boolean> {
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
          metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined,
        },
      }),
    });
  } catch {}
}

async function uploadToCDN(slackUrl: string, slack: WebClient): Promise<string> {
  if (!HACK_CLUB_CDN_KEY) return slackUrl;
  const resp = await fetch(slackUrl, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  if (!resp.ok) return slackUrl;
  const blob = await resp.blob();
  const formData = new FormData();
  formData.append("file", blob, "upload");
  const cdnResp = await fetch("https://cdn.hackclub.com/api/v4/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${HACK_CLUB_CDN_KEY}` },
    body: formData,
  });
  if (!cdnResp.ok) {
    console.error("CDN upload failed:", await cdnResp.text());
    return slackUrl;
  }
  const data = (await cdnResp.json()) as any;
  return data.url || slackUrl;
}

// --- Hono App ---

const app = new Hono();

// Middleware: Basic Auth for /api routes
app.use("/api/*", async (c, next) => {
  if (!API_PASSWORD) return next();
  const header = c.req.header("Authorization") || "";
  const match = header.match(/^Basic\s+(.+)$/);
  if (!match) {
    return c.text("Unauthorized", 401, { "WWW-Authenticate": "Basic realm=indigestion" });
  }
  const decoded = atob(match[1]);
  const [user, pass] = decoded.split(":");
  if (user !== API_USERNAME || pass !== API_PASSWORD) {
    return c.text("Unauthorized", 401, { "WWW-Authenticate": "Basic realm=indigestion" });
  }
  return next();
});

// === Slack Events ===
app.post("/events", async (c) => {
  const body = await c.req.text();
\  const payload = JSON.parse(body);

  if (payload.type === "url_verification") {
    return c.text(payload.challenge, 200, { "Content-Type": "text/plain" });
  }

  if (!verifySignature(c.req.raw, body)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  if (payload.type === "event_callback") {
    const ev = payload.event;
    const store = await getStore();
    const slack = getSlack();

    if (ev.type === "member_joined_channel") {
      const auth = await slack.auth.test();
      if (ev.user !== auth.user_id) {
        return c.text("ok", 200);
      }
      const ch: StoreChannel = {
        id: ev.channel,
        name: "",
        teamId: auth.team_id || "",
        enabled: false,
        webhookUrl: "",
        autoApproveUsers: [],
        metadataSchema: "",
        createdAt: "",
      };
      await store.upsertChannel(ch);
      try {
        const conv = await slack.conversations.info({ channel: ev.channel });
        ch.name = (conv.channel as any)?.name || "";
        await store.upsertChannel(ch);
      } catch {}
    }

    if (ev.type === "message" && !ev.subtype && !ev.bot_id) {
      const ch = await store.getChannel(ev.channel);
      if (!ch || !ch.enabled) {
        return c.text("ok", 200);
      }

      if (ch.autoApproveUsers.length > 0) {
        if (!ch.autoApproveUsers.includes(ev.user)) {
          return c.text("ok", 200);
        }
        let userName = ev.user;
        try {
          const u = await slack.users.info({ user: ev.user });
          userName = (u.user as any)?.name || ev.user;
        } catch {}
        await store.upsertMessage({
          slackTs: ev.ts,
          channelId: ev.channel,
          userId: ev.user,
          userName,
          text: ev.text,
          timestamp: slackTsToTime(ev.ts).toISOString(),
          metadata: {},
        });
        await fireWebhook(ch, {
          slackTs: ev.ts,
          channelId: ev.channel,
          userId: ev.user,
          userName,
          text: ev.text,
          timestamp: slackTsToTime(ev.ts).toISOString(),
          metadata: {},
        });
      } else {
        const section = {
          type: "section",
          text: { type: "mrkdwn", text: `Expose this message to indigestion via RSS and API?\n>${ev.text}\n` },
          accessory: {
            type: "button",
            action_id: "slackfeed_yes",
            text: { type: "plain_text", text: "Yep!" },
            value: ev.ts,
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
              value: ev.ts,
            },
          ],
        };
        try {
          await slack.chat.postMessage({
            channel: ev.channel,
            thread_ts: ev.ts,
            blocks: [section, actions],
          });
        } catch {}
      }
    }
  }

  return c.text("ok", 200);
});

// === Interactive Components ===
app.post("/interactions", async (c) => {
  const body = await c.req.text();
  const formData = new URLSearchParams(body);
  const payloadStr = formData.get("payload");
  if (!payloadStr) return c.json({ error: "missing payload" }, 400);

  const cb = JSON.parse(payloadStr);
  const store = await getStore();
  const slack = getSlack();

  if (cb.type === "view_submission" && cb.view?.callback_id === "metadata_modal") {
    const privateMeta = JSON.parse(cb.view.private_metadata || "{}");
    const { channelId, messageTs } = privateMeta;
    const channel = await store.getChannel(channelId);
    if (!channel || !channel.enabled) {
      return c.json({});
    }

    let schema: any = null;
    try { schema = JSON.parse(channel.metadataSchema); } catch {}

    const metadata = schema ? await (async () => {
      const m: Record<string, any> = {};
      for (const field of schema.fields || []) {
        const values = cb.view.state?.values?.[`field_${field.action_id}`]?.[field.action_id];
        if (!values) continue;
        if (field.type === "multi_static_select") m[field.action_id] = values.selected_options?.map((o: any) => o.value) || [];
        else if (field.type === "datepicker") m[field.action_id] = values.selected_date || "";
        else if (field.type === "file_input") {
          const files = values.files || [];
          m[field.action_id] = await Promise.all(
            files.map(async (f: any) => {
              if (!f.url_private) return { ...f, cdn_url: null };
              const cdnUrl = await uploadToCDN(f.url_private, slack);
              return { ...f, cdn_url: cdnUrl };
            }),
          );
        }
        else m[field.action_id] = values.value || "";
      }
      return JSON.stringify(m);
    })() : "";

    const client = new WebClient(SLACK_BOT_TOKEN);
    try {
      const history = await client.conversations.history({ channel: channelId, latest: messageTs, limit: 1, inclusive: true });
      const msg = history.messages?.[0] as any;
      if (!msg) return c.json({});

      let userName = msg.user || "";
      try { const u = await client.users.info({ user: msg.user }); userName = (u.user as any)?.name || userName; } catch {}

      await store.upsertMessage({
        slackTs: messageTs,
        channelId,
        userId: msg.user || "",
        userName,
        text: msg.text || "",
        timestamp: slackTsToTime(messageTs).toISOString(),
        metadata,
      });

      await fireWebhook(channel, {
        slackTs: messageTs,
        channelId,
        userId: msg.user || "",
        userName,
        text: msg.text || "",
        timestamp: slackTsToTime(messageTs).toISOString(),
        metadata,
      });
    } catch {}
    return c.json({});
  }

  if (cb.type !== "block_actions") return c.json({});

  const action = cb.actions?.[0];
  if (!action) return c.json({});

  const channelId = cb.channel?.id;
  const messageTs = action.value;
  const responseUrl = cb.response_url;
  const triggerId = cb.trigger_id;

  const ch = await store.getChannel(channelId);
  if (!ch || !ch.enabled) {
    await slackResponse(responseUrl, "This channel is not enabled.");
    return c.json({});
  }

  if (action.action_id === "slackfeed_yes") {
    if (ch.metadataSchema) {
      let schema: any = null;
      try { schema = JSON.parse(ch.metadataSchema); } catch {}
      if (schema && schema.fields?.length > 0) {
        const { openMetadataModal } = await import("./api/modal");
        try {
          await openMetadataModal(slack, triggerId, channelId, messageTs, schema, ch.metadataSchema);
          await slackResponse(responseUrl, "");
          return c.json({});
        } catch (err: any) {
          await slackResponse(responseUrl, `Error opening form: ${err.message}`);
          return c.json({});
        }
      }
    }

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
        return c.json({});
      }

      let userName = msg.user || "";
      try { const u = await slack.users.info({ user: msg.user }); userName = (u.user as any)?.name || userName; } catch {}

      await store.upsertMessage({
        slackTs: messageTs,
        channelId,
        userId: msg.user || "",
        userName,
        text: msg.text || "",
        timestamp: slackTsToTime(messageTs).toISOString(),
        metadata: {},
      });

      const savedMsg = { slackTs: messageTs, channelId, userId: msg.user || "", userName, text: msg.text || "", timestamp: slackTsToTime(messageTs).toISOString(), metadata: {} };
      await fireWebhook(ch, savedMsg);

      await slackResponse(responseUrl, "✅ Message added to the SlackFeed!");
    } catch (err: any) {
      await slackResponse(responseUrl, `Error: ${err.message}`);
    }
  } else if (action.action_id === "slackfeed_no") {
    await slackResponse(responseUrl, "Got it, won't add it.");
  }

  return c.json({});
});

// === Slash Commands ===
app.post("/slack", async (c) => {
  const body = await c.req.text();
  const form = new URLSearchParams(body);

  const sourceChannelId = form.get("channel_id") || "";
  const userId = form.get("user_id") || "";
  const text = (form.get("text") || "").trim();

  const store = await getStore();
  const slack = getSlack();

  const channelRefMatch = text.match(/^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*(.*)$/);
  let targetChannelId: string;
  let rest: string;

  if (channelRefMatch) {
    const idFromRef = channelRefMatch[2];
    const nameFromRef = channelRefMatch[4];
    rest = channelRefMatch[5].trim();

    if (idFromRef) {
      targetChannelId = idFromRef;
    } else {
      try {
        const list = await slack.conversations.list({ types: "public_channel,private_channel", limit: 1000 });
        const channels = list.channels as any[] || [];
        const found = channels.find((c: any) => c.name === nameFromRef);
        if (!found) {
          return c.json({ response_type: "ephemeral", text: `Channel #${nameFromRef} not found.` });
        }
        targetChannelId = found.id;
      } catch {
        return c.json({ response_type: "ephemeral", text: "Couldn't look up channels." });
      }
    }
  } else {
    targetChannelId = sourceChannelId;
    rest = text;
  }

  let ch = await store.getChannel(targetChannelId);
  if (!ch) {
    let name = targetChannelId;
    try {
      const conv = await slack.conversations.info({ channel: targetChannelId });
      name = (conv.channel as any)?.name || targetChannelId;
    } catch {}
    const auth = await slack.auth.test();
    ch = { id: targetChannelId, name, teamId: auth.team_id || "", enabled: false, webhookUrl: "", autoApproveUsers: [], metadataSchema: "", createdAt: "" };
    await store.upsertChannel(ch);
  }

  const parts = rest.split(/\s+/);
  const cmd = parts[0];
  const subcmd = parts[1];
  const arg = parts.slice(2).join(" ");

  const targetManager = () => isChannelManager(targetChannelId, userId, slack);

  if (LOCKDOWN_USERS.length > 0 && !LOCKDOWN_USERS.includes(userId) && cmd !== "status" && cmd !== "") {
    return c.json({
      response_type: "ephemeral",
      text: "🔒 SlackFeed is in lockdown mode. Only authorized users can run commands.",
    });
  }

  switch (cmd) {
    case "enable": {
      if (subcmd === "auto") {
        const target = arg.replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();
        if (!target) {
          return c.json({ response_type: "ephemeral", text: "Usage: \`/slackfeed enable auto @user\` — you can only enable auto for yourself or a bot." });
        }

        ch.enabled = true;

        if (target !== userId) {
          try {
            const u = await slack.users.info({ user: target });
            const isBot = (u.user as any)?.is_bot;
            if (!isBot) {
              if (!(await targetManager())) {
                return c.json({ response_type: "ephemeral", text: "Only the channel creator can enable auto-approve for another non-bot user." });
              }
            }
          } catch {
            return c.json({ response_type: "ephemeral", text: "Couldn't look up that user." });
          }
        }

        if (ch.autoApproveUsers.includes(target)) {
          return c.json({ response_type: "ephemeral", text: `<@${target}> already has auto-approve.` });
        }
        ch.autoApproveUsers.push(target);
        await store.upsertChannel(ch);
        return c.json({ response_type: "ephemeral", text: `✅ Auto-approve enabled for <@${target}> in #${ch.name}.` });
      }

      if (subcmd === "manual") {
        if (!(await targetManager())) {
          return c.json({ response_type: "ephemeral", text: "Only the channel creator can enable manual mode." });
        }
        ch.enabled = true;
        ch.autoApproveUsers = [];
        await store.upsertChannel(ch);
        const label = targetChannelId === sourceChannelId ? "this channel" : `#${ch.name}`;
        return c.json({ response_type: "ephemeral", text: `✅ Manual mode enabled for ${label}. Every message will get a Yep!/No prompt.` });
      }

      if (subcmd) {
        return c.json({ response_type: "ephemeral", text: "Usage: \`/slackfeed enable\` | \`/slackfeed enable #channel\` | \`/slackfeed enable auto @user\` | \`/slackfeed enable manual\`" });
      }
      if (!(await targetManager())) {
        return c.json({ response_type: "ephemeral", text: "Only the channel creator can enable SlackFeed." });
      }
      ch.enabled = true;
      ch.autoApproveUsers = [];
      await store.upsertChannel(ch);
      const label = targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
      return c.json({ response_type: "ephemeral", text: `✅ SlackFeed enabled${label}. New messages will get a prompt to add to the feed.` });
    }

    case "disable": {
      if (subcmd === "auto") {
        if (!ch.enabled) {
          return c.json({ response_type: "ephemeral", text: `SlackFeed is not enabled in that channel.` });
        }
        const target = arg.replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();
        if (!target) {
          ch.autoApproveUsers = [];
          await store.upsertChannel(ch);
          return c.json({ response_type: "ephemeral", text: `Auto-approve disabled for all users in #${ch.name}.` });
        }
        ch.autoApproveUsers = ch.autoApproveUsers.filter((id) => id !== target);
        await store.upsertChannel(ch);
        return c.json({ response_type: "ephemeral", text: `Auto-approve disabled for <@${target}> in #${ch.name}.` });
      }

      if (subcmd) {
        return c.json({ response_type: "ephemeral", text: "Usage: \`/slackfeed disable\` | \`/slackfeed disable #channel\` | \`/slackfeed disable auto [@user]\`" });
      }
      if (!(await targetManager())) {
        return c.json({ response_type: "ephemeral", text: "Only the channel creator can disable SlackFeed." });
      }
      ch.enabled = false;
      await store.upsertChannel(ch);
      const label = targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
      return c.json({ response_type: "ephemeral", text: `SlackFeed disabled${label}.` });
    }

    case "status": {
      const chName = targetChannelId === sourceChannelId ? "" : `#${ch.name} `;

      const perms: string[] = [];
      try {
        const conv = await slack.conversations.info({ channel: targetChannelId });
        const creator = (conv.channel as any)?.creator;
        if (creator === userId) perms.push("channel creator");
      } catch {}
      if (LOCKDOWN_USERS.includes(userId)) perms.push("lockdown override");
      const permStr = perms.length > 0 ? `\nYour perms: ${perms.join(", ")}` : "\nYour perms: none (can view feeds only)";

      if (ch.enabled) {
        let msg = `✅ SlackFeed enabled for ${chName}\nRSS: ${BASE_URL}/feed/${targetChannelId}\nJSON: ${BASE_URL}/feed/${targetChannelId}.json`;
        if (ch.webhookUrl) msg += `\nWebhook: ${ch.webhookUrl}`;
        if (ch.autoApproveUsers.length > 0) {
          msg += `\nAuto-approve: ${ch.autoApproveUsers.map((id) => `<@${id}>`).join(", ")}`;
        }
        if (ch.metadataSchema) {
          try {
            const s = JSON.parse(ch.metadataSchema);
            msg += `\nMetadata schema: ${s.fields?.length || 0} field(s)`;
          } catch {}
        }
        msg += permStr;
        return c.json({ response_type: "ephemeral", text: msg });
      }
      return c.json({ response_type: "ephemeral", text: `SlackFeed is not enabled for ${chName}Run \`/slackfeed enable\` to start.${permStr}` });
    }

    default: {
      if (!cmd) {
        return c.json({
          response_type: "ephemeral",
          text: "Commands: \`enable [#channel]\` | \`disable [#channel]\` | \`status [#channel]\` | \`enable [#channel] auto @user\` | \`enable [#channel] manual\` | \`disable [#channel] auto @user\` | \`auto list [#channel]\` | \`webhook <url>\` | \`schema set <json>\` | \`schema get\` | \`schema clear\`",
        });
      }

      if (cmd === "webhook") {
        if (targetChannelId !== sourceChannelId) {
          return c.json({ response_type: "ephemeral", text: "Webhook commands must be run from the target channel." });
        }
        if (!(await targetManager())) {
          return c.json({ response_type: "ephemeral", text: "Only the channel creator can configure webhooks." });
        }
        if (subcmd === "clear") {
          ch.webhookUrl = "";
          await store.upsertChannel(ch);
          return c.json({ response_type: "ephemeral", text: "Webhook cleared." });
        }
        const url = parts.slice(1).join(" ");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return c.json({ response_type: "ephemeral", text: "Invalid URL. Must start with http:// or https://" });
        }
        ch.webhookUrl = url;
        await store.upsertChannel(ch);
        return c.json({ response_type: "ephemeral", text: `✅ Webhook set to ${url}` });
      }

      if (cmd === "auto" && subcmd === "list") {
        if (ch.autoApproveUsers.length === 0) {
          return c.json({ response_type: "ephemeral", text: `No users have auto-approve in #${ch.name}.` });
        }
        const users = ch.autoApproveUsers.map((id) => `<@${id}>`).join(", ");
        return c.json({ response_type: "ephemeral", text: `Auto-approve in #${ch.name}: ${users}` });
      }

      if (cmd === "schema") {
        if (subcmd === "get") {
          if (!ch.metadataSchema) {
            return c.json({ response_type: "ephemeral", text: "No metadata schema configured for this channel." });
          }
          try {
            const pretty = JSON.stringify(JSON.parse(ch.metadataSchema), null, 2);
            return c.json({ response_type: "ephemeral", text: `\`\`\`${pretty}\`\`\`` });
          } catch {
            return c.json({ response_type: "ephemeral", text: `Raw schema:\n${ch.metadataSchema}` });
          }
        }

        if (subcmd === "clear") {
          ch.metadataSchema = "";
          await store.upsertChannel(ch);
          return c.json({ response_type: "ephemeral", text: "Metadata schema cleared." });
        }

        if (subcmd === "set") {
          if (!arg) {
            return c.json({ response_type: "ephemeral", text: "Usage: \`/indigestion schema set <json>\` — provide a valid metadata schema JSON." });
          }
          try {
            const parsed = JSON.parse(arg);
            if (!parsed.fields || !Array.isArray(parsed.fields)) {
              return c.json({ response_type: "ephemeral", text: "Schema must have a \`fields\` array. Example: \`{\"title\": \"Metadata\", \"fields\": [{\"action_id\": \"title\", \"label\": \"Title\", \"type\": \"plain_text_input\"}]}\`" });
            }
            ch.metadataSchema = JSON.stringify(parsed);
            await store.upsertChannel(ch);
            return c.json({ response_type: "ephemeral", text: `✅ Metadata schema set with ${parsed.fields.length} field(s).` });
          } catch (e: any) {
            return c.json({ response_type: "ephemeral", text: `Invalid JSON: ${e.message}` });
          }
        }

        return c.json({
          response_type: "ephemeral",
          text: "Usage: \`/indigestion schema set <json>\` | \`/indigestion schema get\` | \`/indigestion schema clear\`",
        });
      }

      return c.json({
        response_type: "ephemeral",
        text: "Commands: \`enable [#channel]\` | \`disable [#channel]\` | \`status [#channel]\` | \`enable [#channel] auto @user\` | \`enable [#channel] manual\` | \`disable [#channel] auto @user\` | \`auto list [#channel]\` | \`webhook <url>\` | \`schema set <json>\` | \`schema get\` | \`schema clear\`",
      });
    }
  }
});

// === RSS Feed / JSON API ===
app.get("/feed/:channelId", async (c) => {
  const channelId = c.req.param("channelId");
  const store = await getStore();
  const ch = await store.getChannel(channelId);
  if (!ch || !ch.enabled) {
    return c.json({ error: "not found" }, 404);
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "50") || 50, 200);
  const offset = parseInt(c.req.query("offset") || "0") || 0;
  const msgs = await store.getMessages(channelId, limit, offset);

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

  return c.text(feed.rss2(), 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
});

app.get("/feed/:channelId.json", async (c) => {
  const channelId = c.req.param("channelId");
  const store = await getStore();
  const ch = await store.getChannel(channelId);
  if (!ch || !ch.enabled) {
    return c.json({ error: "not found" }, 404);
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "50") || 50, 200);
  const offset = parseInt(c.req.query("offset") || "0") || 0;
  const msgs = await store.getMessages(channelId, limit, offset);

  return c.json(msgs);
});

// === REST API ===
app.get("/api/messages", async (c) => {
  const store = await getStore();
  const channel = c.req.query("channel");
  if (!channel) {
    return c.json({ error: "channel is required" }, 400);
  }

  const ch = await store.getChannel(channel);
  if (!ch || !ch.enabled) {
    return c.json({ error: "channel not found or not enabled" }, 404);
  }

  const after = c.req.query("after");
  const before = c.req.query("before");
  const userId = c.req.query("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || "50") || 50, 10000);
  const page = parseInt(c.req.query("page") || "1") || 1;

  const all = await store.getMessages(channel, 100000, 0);

  let filtered = all;
  if (after) filtered = filtered.filter((m) => m.timestamp >= after);
  if (before) filtered = filtered.filter((m) => m.timestamp <= before);
  if (userId) filtered = filtered.filter((m) => m.userId === userId);

  const total = filtered.length;
  const offset = (page - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  return c.json({
    data: items,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

app.get("/api/messages/:slackTs", async (c) => {
  const store = await getStore();
  const slackTs = decodeURIComponent(c.req.param("slackTs"));
  const channel = c.req.query("channel") || "";

  if (!channel) {
    return c.json({ error: "channel is required" }, 400);
  }

  const all = await store.getMessages(channel, 100000, 0);
  const msg = all.find((m) => m.slackTs === slackTs);
  if (!msg) {
    return c.json({ error: "message not found" }, 404);
  }

  return c.json({ data: msg });
});

export default app;

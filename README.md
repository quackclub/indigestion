# indigestion

A Slack bot (TypeScript + Bun) that lets channel members opt individual messages into a public RSS feed and JSON API.

## How it works

1. A workspace admin **installs** the Slack app to the workspace
2. The bot is added to any channel (any member can invite it)
3. The **channel creator** runs `/indigestion enable`
4. Messages get approved manually (buttons) or automatically (auto-approve)
5. Approved messages are stored in PostgreSQL and served via RSS/JSON/Webhooks

## Setup

### Create a Slack App

Go to https://api.slack.com/apps and create a new app called "indigestion".

**OAuth & Permissions** → **Bot Token Scopes**: add all of:

| Scope | Why |
|-------|-----|
| `channels:history` | Read messages (to fetch edited content on approval) |
| `channels:read` | Read channel metadata (name, creator) |
| `chat:write` | Post message with buttons |
| `commands` | Register `/indigestion` |
| `groups:history` | Read private channel messages |
| `groups:read` | Read private channel metadata |
| `team:read` | Read workspace name |

**Event Subscriptions** → **Enable Events** → set **Request URL** to `https://your-host/events` → subscribe to bot events:
- `message.channels`
- `message.groups`
- `member_joined_channel`

**Slash Commands** → **Create New Command**:
| Field | Value |
|-------|-------|
| Command | `/indigestion` |
| Request URL | `https://your-host/slack` |
| Short Description | `Manage indigestion for the channel` |

**Interactivity & Shortcuts** → **Enable Interactivity** → set **Request URL** to `https://your-host/interactions`.

## Environment

See `.env.example` for all variables:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
BASE_URL=https://your-host
DATABASE_URL=postgres://...
```

## Deploy

```bash
docker compose up -d
```

## Commands

| Command | Description |
|---------|-------------|
| `/indigestion enable` | Enable manual mode (buttons on every message) |
| `/indigestion enable manual` | Same as above |
| `/indigestion enable auto @user` | Enable auto-approve for user, silently syncs their messages |
| `/indigestion enable auto @bot` | Enable auto-approve for a bot |
| `/indigestion enable #channel ...` | Run against another channel from anywhere |
| `/indigestion disable` | Disable indigestion |
| `/indigestion disable auto [@user]` | Remove auto-approve |
| `/indigestion status` | Check status, get feed URLs |
| `/indigestion auto list` | List auto-approve users |
| `/indigestion webhook <url>` | Set webhook for approved messages |

## Webhooks

When approved, fires `POST` to the webhook URL:

```json
{
  "event": "message.approved",
  "channel": { "id": "C123", "name": "general" },
  "message": {
    "ts": "1234567890.123456",
    "user_id": "U456",
    "user_name": "alice",
    "text": "the message text",
    "timestamp": "2025-01-01T00:00:00.000Z"
  }
}
```

## Feeds

- **RSS**: `https://your-host/feed/{channel_id}`
- **JSON**: `https://your-host/feed/{channel_id}.json?limit=50&offset=0`

## Drizzle

```bash
bun run db:studio    # Browse DB
bun run db:push      # Push schema
bun run db:generate  # Generate migration
bun run db:migrate   # Run migrations
```

## Project structure

```
src/
├── db/schema.ts       — Drizzle ORM schema
├── db/migrate.ts      — Auto-creates tables on startup
├── store/
│   ├── store.ts       — Store interface
│   ├── pg.ts          — PostgresStore
│   ├── memory.ts      — MemoryStore for testing
│   └── memory.test.ts
└── index.ts           — Bun.serve server
compose.yml            — Postgres + app + tunnel
Dockerfile
```

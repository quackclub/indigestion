<table border="0">
  <tr>
    <td rowspan="2"><img width="84" height="84" alt="image" src="https://github.com/user-attachments/assets/eaec6187-0389-4e87-814a-7820af5ad761" />
</td>
    <td>indigestion</td>
  </tr>
  <tr>
    <td>A  (TypeScript + Bun) Slack bot that lets channel members opt individual messages into a RSS feeds, a REST API, and webhooks.
</td>
  </tr>
</table>

## How it works

1. A workspace admin **installs** the Slack app to the workspace
2. The bot is added to any channel (any member can invite it)
3. The **channel creator** runs `/indigestion enable`
4. Messages get approved manually (buttons) or automatically (auto-approve)
5. Approved messages are stored in PostgreSQL and served via RSS/JSON/Webhooks

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
| `/indigestion` | Show help message with all commands |
| `/indigestion enable` | Enable manual mode (buttons on every message) |
| `/indigestion enable manual` | Same as above |
| `/indigestion enable auto @user` | Enable auto-approve for user, silently syncs their messages |
| `/indigestion enable auto @bot` | Enable auto-approve for a bot |
| `/indigestion enable #channel ...` | Run against another channel from anywhere |
| `/indigestion disable` | Disable indigestion |
| `/indigestion disable auto [@user]` | Remove auto-approve |
| `/indigestion status` | Check status, get feed URLs, see your permissions |
| `/indigestion auto list` | List auto-approve users |
| `/indigestion webhook <url>` | Set webhook for approved messages |
| `/indigestion webhook clear` | Remove webhook |
| `/indigestion schema set <json>` | Set metadata schema (form fields in modal on Yep) |
| `/indigestion schema get` | View current metadata schema |
| `/indigestion schema clear` | Remove metadata schema |

## Permissions

When you run `/indigestion status`, the bot shows your permissions for that channel:

- **channel creator** — you created the channel, you can run all commands
- **lockdown override** — you're in the `LOCKDOWN_USERS` list, you can run all commands even without being channel creator
- **none** — you can only view feed URLs

`/indigestion` alone (no subcommand) shows the full help message.

## Metadata Schema

Channel creators and lockdown users can define a metadata form that opens in a **modal** when someone clicks **Yep!**. Set one with:

```
/indigestion schema set {"title":"Message Metadata","fields":[
  {"action_id":"title","label":"Title","type":"plain_text_input","placeholder":"Enter a title"},
  {"action_id":"description","label":"Description","type":"plain_text_input","multiline":true},
  {"action_id":"priority","label":"Priority","type":"static_select","options":[{"label":"Low","value":"low"},{"label":"High","value":"high"}]},
  {"action_id":"due_date","label":"Due Date","type":"datepicker"}
]}
```

**Supported field types:**

| Type | BlockKit Element | Notes |
|------|------------------|-------|
| `plain_text_input` | `plain_text_input` | Supports `multiline`, `min_length`, `max_length`, `placeholder`, `initial_value` |
| `url_text_input` | `url_text_input` | URL validation built in |
| `email_text_input` | `email_text_input` | Email validation built in |
| `number_input` | `number_input` | Integer only (`is_decimal_allowed: false`) |
| `static_select` | `static_select` | Single select, requires `options` array with `{label, value}` |
| `multi_static_select` | `multi_static_select` | Multi-select, requires `options` array |
| `datepicker` | `datepicker` | Date picker, supports `initial_value` as date string |
| `file_input` | `file_input` | File upload (requires Slack app config) |

The submitted metadata is stored as JSON in the `metadata` column, included in webhook payloads, and returned in the JSON API.

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
    "timestamp": "2025-01-01T00:00:00.000Z",
    "metadata": {"title":"My Title","priority":"high"}
  }
}
```

## Lockdown Mode

Set `LOCKDOWN_USERS` env var to a comma-separated list of Slack user IDs. When set, only those users can run write commands (`enable`, `disable`, `webhook`, `schema`, `auto`). Everyone else only sees `status` and feed URLs.

```
LOCKDOWN_USERS=U07VA44DNBA,U09Q8MLTE58
```

## REST API

All endpoints require **Basic Auth** using the `API_USERNAME` / `API_PASSWORD` env vars. If `API_PASSWORD` is empty, auth is disabled.

### List Messages

```
GET /api/messages?channel=<channel_id>&limit=50&page=1&after=2025-01-01T00:00:00Z&before=2026-01-01T00:00:00Z&user_id=U12345
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | string | ✅ | Slack channel ID (e.g. `C0ACWHCA16F`) |
| `limit` | number | ❌ | Results per page (1-10000, default 50) |
| `page` | number | ❌ | Page number (default 1) |
| `after` | string | ❌ | ISO 8601 timestamp — only messages after this time |
| `before` | string | ❌ | ISO 8601 timestamp — only messages before this time |
| `user_id` | string | ❌ | Filter by Slack user ID |

**Response:**
```json
{
  "data": [
    {
      "id": 3,
      "slack_ts": "1783464404.108959",
      "channel_id": "C0ACWHCA16F",
      "user_id": "U07VA44DNBA",
      "user_name": "mat",
      "text": "hello world",
      "timestamp": "2026-07-07T22:46:44.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1,
    "total_pages": 1
  }
}
```

### Get Single Message

```
GET /api/messages/{slack_ts}?channel=<channel_id>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slack_ts` | string | ✅ | Slack message timestamp (in path) |
| `channel` | string | ✅ | Slack channel ID (query param) |

**Response:**
```json
{
  "data": {
    "id": 3,
    "slack_ts": "1783464404.108959",
    "channel_id": "C0ACWHCA16F",
    "user_id": "U07VA44DNBA",
    "user_name": "mat",
    "text": "hello world",
    "timestamp": "2026-07-07T22:46:44.000Z"
  }
}
```

### cURL Examples

```bash
# List messages with auth
curl -u admin:your-password 'https://your-host/api/messages?channel=C0ACWHCA16F&limit=10&page=1'

# Filter by time range
curl -u admin:your-password 'https://your-host/api/messages?channel=C0ACWHCA16F&after=2025-06-01T00:00:00Z&before=2025-07-01T00:00:00Z'

# Filter by user
curl -u admin:your-password 'https://your-host/api/messages?channel=C0ACWHCA16F&user_id=U07VA44DNBA'

# Get a specific message
curl -u admin:your-password 'https://your-host/api/messages/1783464404.108959?channel=C0ACWHCA16F'
```

### Postman Setup

1. Create a new request
2. Set **Method** to `GET`
3. Enter URL: `https://slackfeed.matmanna.dev/api/messages?channel=C0ACWHCA16F`
4. Go to **Authorization** tab → select **Basic Auth** → enter username/password
5. Send — if you get `401`, check your `API_USERNAME`/`API_PASSWORD` env vars

Or import this cURL into Postman:
```bash
curl --location 'https://slackfeed.matmanna.dev/api/messages?channel=C0ACWHCA16F&limit=10' \
--header 'Authorization: Basic YWRtaW46eW91ci1wYXNzd29yZA=='
```

(Replace the Basic token with your own base64-encoded `username:password`.)

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

or if using docker-compose 

```bash
docker compose run app bun run db:studio
```
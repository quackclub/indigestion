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

## Drizzle

```bash
bun run db:studio    # Browse DB
bun run db:push      # Push schema
bun run db:generate  # Generate migration
bun run db:migrate   # Run migrations
```


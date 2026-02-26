# Supabase + Webhook Deploy

## 1) Supabase
1. Create a Supabase project.
2. Open `Project Settings -> Database`.
3. Copy the Postgres connection string and put it into `DATABASE_URL`.

## 2) Telegram Bot
1. In `@BotFather`, ensure inline mode is enabled (`/setinline`).
2. Keep your token for `BOT_TOKEN`.

## 3) Deploy 24/7
You can deploy as a web service on Render / Railway / Fly.io / VPS.

Required environment variables:
- `BOT_TOKEN`
- `DATABASE_URL`
- `WEBHOOK_URL` (public `https://.../telegram/webhook`)

Optional:
- `WEBHOOK_SECRET`
- `PORT` (usually provided by hosting)
- `HOST` (`0.0.0.0`)

Build command:
```bash
npm install && npm run build
```

Start command:
```bash
npm start
```

## 4) Local check
```bash
npm run typecheck
npm run build
```

If `WEBHOOK_URL` is set, bot starts in webhook mode.
If `WEBHOOK_URL` is empty, bot starts in long polling mode.

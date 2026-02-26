# Cloudflare Workers + Supabase

## 1) Supabase
1. Open Supabase SQL Editor.
2. Run `supabase/schema.sql`.
3. Copy:
- Project URL (`SUPABASE_URL`)
- Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`)

## 2) Cloudflare Workers secrets
```bash
wrangler secret put BOT_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put WEBHOOK_SECRET
wrangler secret put WEBHOOK_URL
```

`WEBHOOK_URL` example:
`https://tg-photo-bot.<your-subdomain>.workers.dev/telegram/webhook`

## 3) Deploy
```bash
npm run cf:deploy
```

## 4) Final setup check
Open in browser:
`https://tg-photo-bot.<your-subdomain>.workers.dev/`

You should get JSON with `configured: true`.

## Notes
- Worker is stateless; sessions are stored in `bot_sessions` table.
- Photos are stored in `photos` table on Supabase.
- Inline results are personal and without caption.

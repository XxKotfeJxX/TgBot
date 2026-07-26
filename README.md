# Telegram Media Library Bot

A personal Telegram bot for saving, organizing, searching, and reusing photos,
GIFs, and videos. It supports a traditional Telegraf process as well as a
serverless Cloudflare Workers deployment backed by Supabase.

## Features

- save Telegram media with captions and hashtags;
- browse a paginated personal gallery;
- search captions and tags;
- mark media as favorite;
- use personal media through Telegram inline queries;
- deploy as a long-running Node.js process or a Cloudflare Worker;
- persist serverless data and sessions in Supabase.

## Requirements

- Node.js 22+
- a Telegram bot token from BotFather
- Supabase for the Worker deployment

## Local setup

```bash
npm ci
copy .env.example .env
```

Fill in `BOT_TOKEN`. For Supabase-backed operation, also provide
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

Run the development process:

```bash
npm run dev
```

## Cloudflare Workers

Initialize Supabase with `supabase/schema.sql`, configure the secrets described
in [DEPLOY_CLOUDFLARE_WORKERS.md](DEPLOY_CLOUDFLARE_WORKERS.md), then deploy:

```bash
npm run cf:deploy
```

## Validation

```bash
npm run typecheck
npm run build
npm run cf:check
```

## Security

Never commit `.env`, `.dev.vars`, bot tokens, Supabase service-role keys, or
production database files. See [SECURITY.md](SECURITY.md) for reporting
security problems.

## License

ISC. See [LICENSE](LICENSE).

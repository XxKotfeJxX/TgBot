import { Telegraf } from "telegraf";
import { BOT_COMMANDS } from "../core";
import type { BotConfig } from "./config";
import { parseWebhookUrl, withTimeout } from "./config";
import { registerBotHandlers } from "./handlers";
import { createBotRepository, createDbPool } from "./repository";

export function createBotRuntime(config: BotConfig) {
  const bot = new Telegraf(config.BOT_TOKEN);
  const db = createDbPool(config.DATABASE_URL);
  const repo = createBotRepository(db);

  registerBotHandlers(bot, repo);

  async function start(): Promise<void> {
    console.log("Starting bot...");

    await withTimeout(repo.initDb(), 20000, "Database init timeout");
    console.log("Database ready (Supabase Postgres)");

    const me = await withTimeout(bot.telegram.getMe(), 15000, "Telegram getMe timeout");
    (bot as any).botInfo = me;
    console.log(`Telegram auth OK: @${me.username || "unknown"} (${me.id})`);
    console.log(`Inline enabled: ${me.supports_inline_queries ? "yes" : "no"}`);

    try {
      await withTimeout(bot.telegram.setMyCommands(BOT_COMMANDS), 15000, "setMyCommands timeout");
      console.log("Bot commands updated");
    } catch (error) {
      console.error("Failed to set commands:", error);
    }

    if (config.WEBHOOK_URL) {
      const { domain, path } = parseWebhookUrl(config.WEBHOOK_URL);
      console.log(`Starting webhook mode: ${config.WEBHOOK_URL}`);

      await bot.launch(
        {
          dropPendingUpdates: true,
          webhook: {
            domain,
            path,
            host: config.HOST,
            port: config.PORT,
            secretToken: config.WEBHOOK_SECRET
          }
        },
        () => {
          console.log(`Bot started (webhook) on ${config.HOST}:${config.PORT}${path}`);
        }
      );
      return;
    }

    console.log("Starting long polling...");
    await bot.launch({ dropPendingUpdates: true }, () => {
      console.log("Bot started (long polling)");
    });
  }

  async function shutdown(signal: string): Promise<void> {
    console.log(`${signal} received. Stopping bot...`);

    try {
      bot.stop(signal);
    } catch {
      // bot may not be running yet
    }

    try {
      await repo.close();
    } catch (error) {
      console.error("Failed to close DB pool:", error);
    }
  }

  return {
    bot,
    repo,
    start,
    shutdown
  };
}

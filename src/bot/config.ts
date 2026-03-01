export interface BotConfig {
  BOT_TOKEN: string;
  DATABASE_URL: string;
  WEBHOOK_URL: string;
  WEBHOOK_SECRET?: string;
  HOST: string;
  PORT: number;
}

export function loadBotConfig(): BotConfig {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) throw new Error("Set BOT_TOKEN env var");

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("Set DATABASE_URL env var (Supabase Postgres URL)");

  const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
  const HOST = process.env.HOST || "0.0.0.0";
  const PORT = Number.parseInt(process.env.PORT || "3000", 10);

  if (Number.isNaN(PORT) || PORT <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  return {
    BOT_TOKEN,
    DATABASE_URL,
    WEBHOOK_URL,
    WEBHOOK_SECRET,
    HOST,
    PORT
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function parseWebhookUrl(rawUrl: string): { domain: string; path: string } {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("WEBHOOK_URL must start with https://");
  }

  const path = url.pathname && url.pathname !== "/" ? url.pathname : "/telegram/webhook";
  return { domain: url.host, path };
}

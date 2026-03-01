import { BOT_COMMANDS } from "../core";
import { getSupabase, maskValue, normalizeEnvValue, resolveWebhookUrl } from "./env";
import { tgCall } from "./telegram";
import type { Env } from "./types";

const setupCache = new Map<string, Promise<void>>();

export async function configureTelegram(env: Env): Promise<void> {
  const webhookUrl = resolveWebhookUrl(env);
  await tgCall(env, "setMyCommands", { commands: BOT_COMMANDS });

  if (webhookUrl) {
    await tgCall(env, "setWebhook", {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET || undefined,
      drop_pending_updates: false
    });
  }
}

export async function ensureConfigured(env: Env): Promise<void> {
  const key = `${env.BOT_TOKEN}:${resolveWebhookUrl(env) || "no-webhook"}`;

  if (!setupCache.has(key)) {
    setupCache.set(
      key,
      configureTelegram(env).catch((error) => {
        setupCache.delete(key);
        throw error;
      })
    );
  }

  await setupCache.get(key);
}

export async function getWorkerStatus(env: Env): Promise<Record<string, unknown>> {
  const me = await tgCall<{ id: number; username?: string; supports_inline_queries?: boolean }>(env, "getMe");
  const webhookInfo = await tgCall<Record<string, unknown>>(env, "getWebhookInfo");
  const expectedWebhookUrl = resolveWebhookUrl(env) || null;
  const normalizedSupabaseUrl = normalizeEnvValue(env.SUPABASE_URL, "SUPABASE_URL");
  const normalizedServiceRoleKey = normalizeEnvValue(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  const dbStatus: Record<string, unknown> = { ok: true };

  try {
    const client = getSupabase(env);

    try {
      const { count: photosCount, error: photosError } = await client.from("photos").select("id", { count: "exact", head: true }).limit(1);

      if (photosError) {
        dbStatus.ok = false;
        dbStatus.photosError = photosError.message;
      } else {
        dbStatus.photosCount = Number(photosCount || 0);
      }
    } catch (error) {
      dbStatus.ok = false;
      dbStatus.photosError = String(error);
    }

    try {
      const { count: sessionsCount, error: sessionsError } = await client
        .from("bot_sessions")
        .select("user_id", { count: "exact", head: true })
        .limit(1);

      if (sessionsError) {
        dbStatus.ok = false;
        dbStatus.sessionsError = sessionsError.message;
      } else {
        dbStatus.sessionsCount = Number(sessionsCount || 0);
      }
    } catch (error) {
      dbStatus.ok = false;
      dbStatus.sessionsError = String(error);
    }
  } catch (error) {
    dbStatus.ok = false;
    dbStatus.error = String(error);
  }

  return {
    ok: true,
    mode: "cloudflare_worker_webhook",
    botId: me.id,
    botUsername: me.username || "unknown",
    supportsInlineQueries: Boolean(me.supports_inline_queries),
    expectedWebhookUrl,
    envDebug: {
      supabaseUrl: maskValue(normalizedSupabaseUrl),
      serviceRolePrefix: normalizedServiceRoleKey ? normalizedServiceRoleKey.slice(0, 12) : null
    },
    webhookInfo,
    dbStatus
  };
}

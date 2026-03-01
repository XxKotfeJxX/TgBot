import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./types";

export function normalizeEnvValue(value: string | undefined, name: string): string {
  let normalized = (value || "").trim();
  if (normalized.startsWith(`${name}=`)) {
    normalized = normalized.slice(name.length + 1).trim();
  }

  const hasDoubleQuotes = normalized.startsWith('"') && normalized.endsWith('"');
  const hasSingleQuotes = normalized.startsWith("'") && normalized.endsWith("'");
  if (hasDoubleQuotes || hasSingleQuotes) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

export function maskValue(value: string): string {
  if (!value) return "(empty)";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.length <= 12) return "***";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function getWebhookPath(env: Env): string {
  const path = (env.WEBHOOK_PATH || "/telegram/webhook").trim();
  if (!path) return "/telegram/webhook";
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveWebhookUrl(env: Env): string | undefined {
  const raw = (env.WEBHOOK_URL || "").trim();
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  const requiredPath = getWebhookPath(env);
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = requiredPath;
  }

  return parsed.toString();
}

export function getSupabase(env: Env): SupabaseClient {
  const supabaseUrl = normalizeEnvValue(env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = normalizeEnvValue(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");

  if (!/^https?:\/\//i.test(supabaseUrl)) {
    throw new Error(
      `Invalid SUPABASE_URL format. Expected https://<project-ref>.supabase.co, received: ${maskValue(supabaseUrl)}`
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        "X-Client-Info": "tg-photo-bot-worker"
      }
    }
  });
}

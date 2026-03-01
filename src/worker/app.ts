import { getWebhookPath } from "./env";
import { handleUpdate } from "./handlers";
import { ensureConfigured, getWorkerStatus } from "./setup";
import type { Env, TelegramUpdate } from "./types";

export const workerApp = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const webhookPath = getWebhookPath(env);

    if (request.method === "GET" && url.pathname === "/") {
      try {
        await ensureConfigured(env);
        return new Response(
          JSON.stringify({
            ok: true,
            mode: "cloudflare_worker_webhook",
            webhookPath,
            configured: true
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: String(error) }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/status") {
      try {
        await ensureConfigured(env);
        const status = await getWorkerStatus(env);
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: String(error) }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
    }

    const isWebhookRequestPath = url.pathname === webhookPath || url.pathname === "/";
    if (!isWebhookRequestPath) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (env.WEBHOOK_SECRET) {
      const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (incomingSecret !== env.WEBHOOK_SECRET) {
        console.warn(`Webhook secret mismatch for ${url.pathname}`);
        return new Response("Forbidden", { status: 403 });
      }
    }

    try {
      ensureConfigured(env).catch((error) => {
        console.warn("ensureConfigured failed (non-blocking in webhook path)", String(error));
      });

      const update = (await request.json()) as TelegramUpdate;
      const updateKind = update.inline_query
        ? "inline_query"
        : update.chosen_inline_result
          ? "chosen_inline_result"
          : update.callback_query
            ? "callback_query"
            : update.message
              ? "message"
              : "unknown";
      console.log(`Webhook update received: ${updateKind} path=${url.pathname}`);

      await handleUpdate(env, update);
      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error("Worker update error", error);
      return new Response("error", { status: 500 });
    }
  }
};

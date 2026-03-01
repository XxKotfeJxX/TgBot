import { normalizeMediaType, type PhotoRow } from "../core";
import type { Env } from "./types";

export async function tgCall<T = unknown>(
  env: Env,
  method: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = (await response.json()) as { ok: boolean; description?: string; result?: T };

  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data.result as T;
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<{ message_id: number }> {
  return tgCall<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

export async function sendPhoto(
  env: Env,
  chatId: number,
  photo: string,
  caption?: string,
  replyMarkup?: Record<string, unknown>
): Promise<{ message_id: number }> {
  return tgCall<{ message_id: number }>(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    ...(caption ? { caption } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

export async function sendAsset(
  env: Env,
  chatId: number,
  row: PhotoRow,
  caption?: string,
  replyMarkup?: Record<string, unknown>
): Promise<{ message_id: number }> {
  const mediaType = normalizeMediaType(row.media_type);

  if (mediaType === "video") {
    return tgCall<{ message_id: number }>(env, "sendVideo", {
      chat_id: chatId,
      video: row.file_id,
      ...(caption ? { caption } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  }

  if (mediaType === "gif") {
    return tgCall<{ message_id: number }>(env, "sendAnimation", {
      chat_id: chatId,
      animation: row.file_id,
      ...(caption ? { caption } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  }

  return sendPhoto(env, chatId, row.file_id, caption, replyMarkup);
}

export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await tgCall(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
}

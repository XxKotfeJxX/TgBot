import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface Env {
  BOT_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WEBHOOK_SECRET?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_PATH?: string;
}

type SessionMode = "idle" | "await_photo" | "await_description" | "await_delete_number";

interface PendingPhoto {
  fileId: string;
  fileUniqueId: string;
}

interface BotSession {
  userId: number;
  chatId: number;
  mode: SessionMode;
  pendingPhotos: PendingPhoto[];
  galleryPage: number;
  gallerySelected: number;
  galleryMessageId: number | null;
}

interface PhotoRow {
  id: number;
  file_id: string;
  description: string;
  file_unique_id?: string;
}

interface InsertBatchResult {
  saved: number;
  skipped: number;
}

interface TelegramUser {
  id: number;
}

interface TelegramChat {
  id: number;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  photo?: TelegramPhotoSize[];
  media_group_id?: string;
}

interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  inline_query?: TelegramInlineQuery;
  callback_query?: TelegramCallbackQuery;
}

const PAGE_SIZE = 10;
const INLINE_FETCH_LIMIT = 400;
const INLINE_RESULT_LIMIT = 50;

const BUTTON_ADD = "Додати фото";
const BUTTON_VIEW = "Переглянути фото";
const BUTTON_DELETE = "Видалити фото";

const MAIN_MENU = {
  keyboard: [[{ text: BUTTON_ADD }, { text: BUTTON_VIEW }], [{ text: BUTTON_DELETE }]],
  resize_keyboard: true
};

const BOT_COMMANDS = [
  { command: "start", description: "Відкрити меню" },
  { command: "menu", description: "Показати меню" },
  { command: "add", description: "Додати фото" },
  { command: "gallery", description: "Переглянути фото" },
  { command: "delete", description: "Видалити фото за номером" },
  { command: "inline", description: "Вставити фото через @бота" },
  { command: "diag", description: "Перевірка inline і БД" }
];

const setupCache = new Map<string, Promise<void>>();

function getWebhookPath(env: Env): string {
  const path = (env.WEBHOOK_PATH || "/telegram/webhook").trim();
  if (!path) return "/telegram/webhook";
  return path.startsWith("/") ? path : `/${path}`;
}

function getSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: {
      headers: {
        "X-Client-Info": "tg-photo-bot-worker"
      }
    }
  });
}

function normalizePendingPhotos(photos: PendingPhoto[]): PendingPhoto[] {
  const seen = new Set<string>();
  const unique: PendingPhoto[] = [];

  for (const photo of photos) {
    if (seen.has(photo.fileUniqueId)) continue;
    seen.add(photo.fileUniqueId);
    unique.push(photo);
  }

  return unique;
}

function trimCaption(text: string, max = 980): string {
  const value = (text || "").trim();
  if (!value) return "(без опису)";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function normalizeSearchText(value: string): string {
  return (value || "").toLocaleLowerCase("uk-UA").replace(/\s+/g, " ").trim();
}

function filterRowsByQuery(rows: PhotoRow[], query: string): PhotoRow[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return rows;

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (!tokens.length) return rows;

  return rows.filter((row) => {
    const description = normalizeSearchText(row.description);
    return tokens.every((token) => description.includes(token));
  });
}

function pickLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize {
  return photos[photos.length - 1];
}

function defaultSession(userId: number, chatId: number): BotSession {
  return {
    userId,
    chatId,
    mode: "idle",
    pendingPhotos: [],
    galleryPage: 0,
    gallerySelected: 0,
    galleryMessageId: null
  };
}

function parsePendingPhotos(raw: unknown): PendingPhoto[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      const row = item as Partial<PendingPhoto>;
      if (!row.fileId || !row.fileUniqueId) return null;
      return { fileId: String(row.fileId), fileUniqueId: String(row.fileUniqueId) };
    })
    .filter(Boolean) as PendingPhoto[];
}

async function loadSession(client: SupabaseClient, userId: number, chatId: number): Promise<BotSession> {
  const { data, error } = await client
    .from("bot_sessions")
    .select("user_id,chat_id,mode,pending_photos,gallery_page,gallery_selected,gallery_message_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`loadSession failed: ${error.message}`);
  }

  if (!data) {
    return defaultSession(userId, chatId);
  }

  return {
    userId: Number(data.user_id),
    chatId: Number(data.chat_id),
    mode: (data.mode as SessionMode) || "idle",
    pendingPhotos: parsePendingPhotos(data.pending_photos),
    galleryPage: Number(data.gallery_page || 0),
    gallerySelected: Number(data.gallery_selected || 0),
    galleryMessageId: data.gallery_message_id ? Number(data.gallery_message_id) : null
  };
}

async function saveSession(client: SupabaseClient, session: BotSession): Promise<void> {
  const payload = {
    user_id: session.userId,
    chat_id: session.chatId,
    mode: session.mode,
    pending_photos: session.pendingPhotos,
    gallery_page: session.galleryPage,
    gallery_selected: session.gallerySelected,
    gallery_message_id: session.galleryMessageId,
    updated_at: new Date().toISOString()
  };

  const { error } = await client.from("bot_sessions").upsert(payload, { onConflict: "user_id" });
  if (error) {
    throw new Error(`saveSession failed: ${error.message}`);
  }
}

async function getPhotosCount(client: SupabaseClient, userId: number): Promise<number> {
  const { count, error } = await client
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (error) {
    throw new Error(`getPhotosCount failed: ${error.message}`);
  }

  return Number(count || 0);
}

async function getPhotosPage(client: SupabaseClient, userId: number, limit: number, offset: number): Promise<PhotoRow[]> {
  const { data, error } = await client
    .from("photos")
    .select("id,file_id,description")
    .eq("user_id", userId)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`getPhotosPage failed: ${error.message}`);
  }

  return (data || []).map((row) => ({
    id: Number(row.id),
    file_id: String(row.file_id),
    description: String(row.description || "")
  }));
}

async function getPhotoByNumber(client: SupabaseClient, userId: number, offset: number): Promise<PhotoRow | undefined> {
  const { data, error } = await client
    .from("photos")
    .select("id,file_id,description")
    .eq("user_id", userId)
    .order("id", { ascending: true })
    .range(offset, offset)
    .maybeSingle();

  if (error) {
    throw new Error(`getPhotoByNumber failed: ${error.message}`);
  }

  if (!data) return undefined;

  return {
    id: Number(data.id),
    file_id: String(data.file_id),
    description: String(data.description || "")
  };
}

async function deletePhotoById(client: SupabaseClient, userId: number, photoId: number): Promise<void> {
  const { error } = await client.from("photos").delete().eq("id", photoId).eq("user_id", userId);
  if (error) {
    throw new Error(`deletePhotoById failed: ${error.message}`);
  }
}

async function getRecentPhotos(client: SupabaseClient, userId: number, limit: number): Promise<PhotoRow[]> {
  const { data, error } = await client
    .from("photos")
    .select("id,file_id,description")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`getRecentPhotos failed: ${error.message}`);
  }

  return (data || []).map((row) => ({
    id: Number(row.id),
    file_id: String(row.file_id),
    description: String(row.description || "")
  }));
}

async function insertPhotosWithDescription(
  client: SupabaseClient,
  userId: number,
  photos: PendingPhoto[],
  description: string
): Promise<InsertBatchResult> {
  const uniquePhotos = normalizePendingPhotos(photos);
  if (!uniquePhotos.length) return { saved: 0, skipped: 0 };

  const uniqueIds = uniquePhotos.map((p) => p.fileUniqueId);

  const { data: existing, error: existingError } = await client
    .from("photos")
    .select("file_unique_id")
    .eq("user_id", userId)
    .in("file_unique_id", uniqueIds);

  if (existingError) {
    throw new Error(`insertPhotosWithDescription(existing) failed: ${existingError.message}`);
  }

  const existingSet = new Set((existing || []).map((row: any) => String(row.file_unique_id)));
  const toInsert = uniquePhotos.filter((p) => !existingSet.has(p.fileUniqueId));

  if (toInsert.length) {
    const rows = toInsert.map((p) => ({
      user_id: userId,
      file_id: p.fileId,
      file_unique_id: p.fileUniqueId,
      description
    }));

    const { error: insertError } = await client.from("photos").insert(rows);
    if (insertError) {
      throw new Error(`insertPhotosWithDescription(insert) failed: ${insertError.message}`);
    }
  }

  return {
    saved: toInsert.length,
    skipped: uniquePhotos.length - toInsert.length
  };
}

async function tgCall<T = unknown>(env: Env, method: string, payload: Record<string, unknown> = {}): Promise<T> {
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

async function sendMessage(env: Env, chatId: number, text: string, replyMarkup?: Record<string, unknown>) {
  return tgCall<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function sendPhoto(
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

async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await tgCall(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
}

function buildGalleryReplyMarkup(userId: number, page: number, totalPages: number, itemsOnPage: number) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  const numberButtons = Array.from({ length: itemsOnPage }, (_, index) => {
    const number = page * PAGE_SIZE + index + 1;
    return {
      text: String(number),
      callback_data: `gallery_pick:${userId}:${page}:${index}`
    };
  });

  for (let i = 0; i < numberButtons.length; i += 5) {
    rows.push(numberButtons.slice(i, i + 5));
  }

  if (totalPages > 1) {
    const navButtons: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) {
      navButtons.push({ text: "⬅️", callback_data: `gallery_page:${userId}:${page - 1}` });
    }
    if (page < totalPages - 1) {
      navButtons.push({ text: "➡️", callback_data: `gallery_page:${userId}:${page + 1}` });
    }
    if (navButtons.length) {
      rows.push(navButtons);
    }
  }

  return { inline_keyboard: rows };
}

function buildGalleryCaption(row: PhotoRow, absoluteNumber: number, total: number, page: number, totalPages: number): string {
  return [`#${absoluteNumber}`, trimCaption(row.description), "", `Сторінка ${page + 1}/${totalPages} • Усього: ${total}`].join(
    "\n"
  );
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = String(error || "").toLowerCase();
  return message.includes("message is not modified");
}

async function renderEmptyGalleryMessage(env: Env, chatId: number, messageId: number | null): Promise<void> {
  if (!messageId) {
    await sendMessage(env, chatId, "Галерея порожня.");
    return;
  }

  try {
    await tgCall(env, "editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: "Галерея порожня."
    });
    return;
  } catch {
    // ignore and fallback
  }

  try {
    await tgCall(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "Галерея порожня."
    });
  } catch {
    await sendMessage(env, chatId, "Галерея порожня.");
  }
}

async function showMenu(env: Env, chatId: number, text = "Оберіть дію:") {
  await sendMessage(env, chatId, text, MAIN_MENU);
}

async function showGalleryPage(
  env: Env,
  client: SupabaseClient,
  session: BotSession,
  requestedPage = 0,
  messageId: number | null = null,
  requestedSelectedIndexInPage = 0
): Promise<BotSession> {
  const total = await getPhotosCount(client, session.userId);

  if (!total) {
    await renderEmptyGalleryMessage(env, session.chatId, messageId);
    session.galleryMessageId = null;
    session.galleryPage = 0;
    session.gallerySelected = 0;
    await saveSession(client, session);
    return session;
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const offset = page * PAGE_SIZE;

  const rows = await getPhotosPage(client, session.userId, PAGE_SIZE, offset);
  const selectedIndexInPage = Math.max(0, Math.min(requestedSelectedIndexInPage, rows.length - 1));
  const selectedRow = rows[selectedIndexInPage];
  const absoluteNumber = offset + selectedIndexInPage + 1;

  const caption = buildGalleryCaption(selectedRow, absoluteNumber, total, page, totalPages);
  const replyMarkup = buildGalleryReplyMarkup(session.userId, page, totalPages, rows.length);

  let finalMessageId = messageId;

  if (messageId) {
    try {
      await tgCall(env, "editMessageMedia", {
        chat_id: session.chatId,
        message_id: messageId,
        media: {
          type: "photo",
          media: selectedRow.file_id,
          caption
        },
        reply_markup: replyMarkup
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        const sent = await sendPhoto(env, session.chatId, selectedRow.file_id, caption, replyMarkup);
        finalMessageId = sent.message_id;
      }
    }
  } else {
    const sent = await sendPhoto(env, session.chatId, selectedRow.file_id, caption, replyMarkup);
    finalMessageId = sent.message_id;
  }

  session.galleryPage = page;
  session.gallerySelected = selectedIndexInPage;
  session.galleryMessageId = finalMessageId;

  await saveSession(client, session);
  return session;
}

async function startAddFlow(env: Env, client: SupabaseClient, session: BotSession): Promise<void> {
  session.mode = "await_photo";
  session.pendingPhotos = [];
  await saveSession(client, session);
  await sendMessage(env, session.chatId, "Надішли одне фото або альбом (кілька фото за раз).");
}

async function startDeleteFlow(env: Env, client: SupabaseClient, session: BotSession): Promise<void> {
  const total = await getPhotosCount(client, session.userId);
  if (!total) {
    session.mode = "idle";
    session.pendingPhotos = [];
    await saveSession(client, session);
    await sendMessage(env, session.chatId, "Немає фото для видалення.", MAIN_MENU);
    return;
  }

  session.mode = "await_delete_number";
  session.pendingPhotos = [];

  await showGalleryPage(env, client, session, session.galleryPage, session.galleryMessageId, session.gallerySelected);
  await sendMessage(env, session.chatId, `Введи номер фото для видалення (1-${total}).`);
}

async function handleCommand(
  env: Env,
  client: SupabaseClient,
  session: BotSession,
  command: string,
  chatId: number
): Promise<void> {
  if (command === "/start") {
    session.mode = "idle";
    session.pendingPhotos = [];
    session.chatId = chatId;
    await saveSession(client, session);
    await showMenu(env, chatId, "Меню фото-бота:");
    return;
  }

  if (command === "/menu") {
    session.mode = "idle";
    session.pendingPhotos = [];
    session.chatId = chatId;
    await saveSession(client, session);
    await showMenu(env, chatId);
    return;
  }

  if (command === "/add") {
    await startAddFlow(env, client, session);
    return;
  }

  if (command === "/gallery") {
    session.mode = "idle";
    session.pendingPhotos = [];
    await saveSession(client, session);
    await showGalleryPage(env, client, session, session.galleryPage, session.galleryMessageId, session.gallerySelected);
    return;
  }

  if (command === "/delete") {
    await startDeleteFlow(env, client, session);
    return;
  }

  if (command === "/inline") {
    const total = await getPhotosCount(client, session.userId);
    if (!total) {
      await sendMessage(env, session.chatId, "У тебе ще немає збережених фото. Додай хоча б одне через «Додати фото».", MAIN_MENU);
      return;
    }

    await sendMessage(env, session.chatId, "Натисни кнопку нижче, щоб вставити фото через inline-режим:", {
      inline_keyboard: [
        [{ text: "Вставити в цей чат", switch_inline_query_current_chat: "" }],
        [{ text: "Вибрати інший чат", switch_inline_query: "" }]
      ]
    });
    return;
  }

  if (command === "/diag") {
    const total = await getPhotosCount(client, session.userId);
    const me = await tgCall<{ username?: string; supports_inline_queries?: boolean }>(env, "getMe");

    await sendMessage(
      env,
      session.chatId,
      [
        `user_id: ${session.userId}`,
        `saved_photos: ${total}`,
        `bot_username: @${me.username || "unknown"}`,
        `supports_inline_queries: ${me.supports_inline_queries ? "true" : "false"}`,
        "storage: supabase_postgres",
        "mode: cloudflare_worker_webhook"
      ].join("\n")
    );
  }
}

async function handleTextMessage(
  env: Env,
  client: SupabaseClient,
  session: BotSession,
  text: string,
  chatId: number
): Promise<void> {
  const normalized = text.trim();
  if (!normalized) return;

  if (normalized === BUTTON_ADD) {
    await startAddFlow(env, client, session);
    return;
  }

  if (normalized === BUTTON_VIEW) {
    session.mode = "idle";
    session.pendingPhotos = [];
    await saveSession(client, session);
    await showGalleryPage(env, client, session, session.galleryPage, session.galleryMessageId, session.gallerySelected);
    return;
  }

  if (normalized === BUTTON_DELETE) {
    await startDeleteFlow(env, client, session);
    return;
  }

  if (session.mode === "await_photo") {
    await sendMessage(env, chatId, "Зараз очікую саме фото.");
    return;
  }

  if (session.mode === "await_description") {
    const description = normalized;

    if (!description) {
      await sendMessage(env, chatId, "Опис порожній. Введи текст або смайлики.");
      return;
    }

    if (!session.pendingPhotos.length) {
      session.mode = "await_photo";
      await saveSession(client, session);
      await sendMessage(env, chatId, "Спочатку надішли фото.");
      return;
    }

    const totalInBatch = session.pendingPhotos.length;
    const result = await insertPhotosWithDescription(client, session.userId, session.pendingPhotos, description);

    session.mode = "idle";
    session.pendingPhotos = [];
    await saveSession(client, session);

    if (!result.saved) {
      await sendMessage(env, chatId, "Усі фото з цієї пачки вже були в базі. Надішли інші фото.", MAIN_MENU);
      return;
    }

    if (result.skipped > 0) {
      await sendMessage(
        env,
        chatId,
        `Збережено ${result.saved} з ${totalInBatch}. Пропущено дублікатів: ${result.skipped}.`,
        MAIN_MENU
      );
      return;
    }

    await sendMessage(env, chatId, `Фото з описом збережено ✅ (${result.saved})`, MAIN_MENU);
    return;
  }

  if (session.mode === "await_delete_number") {
    const total = await getPhotosCount(client, session.userId);

    if (!total) {
      session.mode = "idle";
      session.pendingPhotos = [];
      if (session.galleryMessageId) {
        await renderEmptyGalleryMessage(env, session.chatId, session.galleryMessageId);
        session.galleryMessageId = null;
      }
      await saveSession(client, session);
      await sendMessage(env, chatId, "Галерея вже порожня.", MAIN_MENU);
      return;
    }

    const number = Number.parseInt(normalized, 10);

    if (!Number.isInteger(number) || number < 1) {
      await sendMessage(env, chatId, `Введи коректний номер від 1 до ${total}.`);
      return;
    }

    if (number > total) {
      await sendMessage(env, chatId, `Немає фото з номером ${number}. Доступні: 1-${total}.`);
      return;
    }

    const row = await getPhotoByNumber(client, session.userId, number - 1);
    if (!row) {
      await sendMessage(env, chatId, `Немає фото з номером ${number}.`);
      return;
    }

    await deletePhotoById(client, session.userId, row.id);

    session.mode = "idle";
    session.pendingPhotos = [];

    const remaining = await getPhotosCount(client, session.userId);
    if (remaining > 0) {
      const targetAbsoluteIndex = Math.min(number - 1, remaining - 1);
      const targetPage = Math.floor(targetAbsoluteIndex / PAGE_SIZE);
      const targetIndexInPage = targetAbsoluteIndex - targetPage * PAGE_SIZE;
      await showGalleryPage(env, client, session, targetPage, session.galleryMessageId, targetIndexInPage);
    } else if (session.galleryMessageId) {
      await renderEmptyGalleryMessage(env, session.chatId, session.galleryMessageId);
      session.galleryMessageId = null;
      await saveSession(client, session);
    }

    await sendMessage(env, chatId, `Фото #${number} видалено. Нумерація оновлена.`, MAIN_MENU);
  }
}

async function handlePhotoMessage(
  env: Env,
  client: SupabaseClient,
  session: BotSession,
  message: TelegramMessage
): Promise<void> {
  const chatId = message.chat.id;

  if (session.mode !== "await_photo" && session.mode !== "await_description") {
    await sendMessage(env, chatId, "Щоб додати фото, обери «Додати фото» або команду /add.", MAIN_MENU);
    return;
  }

  if (!message.photo || !message.photo.length) {
    await sendMessage(env, chatId, "Не бачу фото в цьому повідомленні.");
    return;
  }

  const picked = pickLargestPhoto(message.photo);
  const photo: PendingPhoto = {
    fileId: picked.file_id,
    fileUniqueId: picked.file_unique_id
  };

  const beforeCount = session.pendingPhotos.length;
  session.pendingPhotos = normalizePendingPhotos([...session.pendingPhotos, photo]);
  const added = session.pendingPhotos.length > beforeCount;
  session.mode = "await_description";

  await saveSession(client, session);

  if (!added) {
    await sendMessage(env, chatId, "Це фото вже додане в поточну пачку. Введи опис для збереження.");
    return;
  }

  if (message.media_group_id) {
    await sendMessage(env, chatId, `Фото з альбому додано (${session.pendingPhotos.length}). Після альбому введи один опис для всієї пачки.`);
    return;
  }

  await sendMessage(env, chatId, `Фото додано (${session.pendingPhotos.length}). Тепер введи один опис для всієї пачки.`);
}

async function handleCallbackQuery(env: Env, client: SupabaseClient, query: TelegramCallbackQuery): Promise<void> {
  if (!query.data || !query.message) {
    await answerCallbackQuery(env, query.id);
    return;
  }

  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const session = await loadSession(client, userId, chatId);
  session.chatId = chatId;

  const pageMatch = query.data.match(/^gallery_page:(\d+):(\d+)$/);
  if (pageMatch) {
    const ownerId = Number(pageMatch[1]);
    const page = Number(pageMatch[2]);

    if (ownerId !== userId) {
      await answerCallbackQuery(env, query.id, "Це не твоя галерея.");
      return;
    }

    try {
      await showGalleryPage(env, client, session, page, query.message.message_id, session.gallerySelected);
      await answerCallbackQuery(env, query.id);
    } catch (error) {
      console.error("gallery_page callback error", error);
      await answerCallbackQuery(env, query.id, "Помилка при перемиканні сторінки.");
    }
    return;
  }

  const pickMatch = query.data.match(/^gallery_pick:(\d+):(\d+):(\d+)$/);
  if (pickMatch) {
    const ownerId = Number(pickMatch[1]);
    const page = Number(pickMatch[2]);
    const selectedIndex = Number(pickMatch[3]);

    if (ownerId !== userId) {
      await answerCallbackQuery(env, query.id, "Це не твоя галерея.");
      return;
    }

    try {
      await showGalleryPage(env, client, session, page, query.message.message_id, selectedIndex);
      await answerCallbackQuery(env, query.id);
    } catch (error) {
      console.error("gallery_pick callback error", error);
      await answerCallbackQuery(env, query.id, "Помилка відкриття фото.");
    }
    return;
  }

  await answerCallbackQuery(env, query.id);
}

async function handleInlineQuery(env: Env, client: SupabaseClient, query: TelegramInlineQuery): Promise<void> {
  const userId = query.from.id;
  const q = (query.query || "").trim();

  const sourceRows = await getRecentPhotos(client, userId, INLINE_FETCH_LIMIT);
  const rows = filterRowsByQuery(sourceRows, q).slice(0, INLINE_RESULT_LIMIT);

  if (!rows.length) {
    await tgCall(env, "answerInlineQuery", {
      inline_query_id: query.id,
      results: [],
      cache_time: 0,
      is_personal: true,
      switch_pm_text: "Немає фото. Додати в боті",
      switch_pm_parameter: "inline_empty"
    });
    return;
  }

  const results = rows.map((row) => ({
    type: "photo",
    id: String(row.id),
    photo_file_id: row.file_id
  }));

  await tgCall(env, "answerInlineQuery", {
    inline_query_id: query.id,
    results,
    cache_time: 0,
    is_personal: true
  });
}

async function handleMessage(env: Env, client: SupabaseClient, message: TelegramMessage): Promise<void> {
  if (!message.from) return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const session = await loadSession(client, userId, chatId);
  session.chatId = chatId;

  if (message.text?.trim().startsWith("/")) {
    const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
    await handleCommand(env, client, session, command, chatId);
    return;
  }

  if (message.photo?.length) {
    await handlePhotoMessage(env, client, session, message);
    return;
  }

  if (typeof message.text === "string") {
    await handleTextMessage(env, client, session, message.text, chatId);
  }
}

async function configureTelegram(env: Env): Promise<void> {
  await tgCall(env, "setMyCommands", { commands: BOT_COMMANDS });

  if (env.WEBHOOK_URL) {
    await tgCall(env, "setWebhook", {
      url: env.WEBHOOK_URL,
      secret_token: env.WEBHOOK_SECRET || undefined,
      drop_pending_updates: false
    });
  }
}

async function ensureConfigured(env: Env): Promise<void> {
  const key = `${env.BOT_TOKEN}:${env.WEBHOOK_URL || "no-webhook"}`;

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

async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const client = getSupabase(env);

  if (update.inline_query) {
    await handleInlineQuery(env, client, update.inline_query);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(env, client, update.callback_query);
    return;
  }

  if (update.message) {
    await handleMessage(env, client, update.message);
  }
}

export default {
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
        return new Response(
          JSON.stringify({ ok: false, error: String(error) }),
          {
            status: 500,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }

    if (url.pathname !== webhookPath) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (env.WEBHOOK_SECRET) {
      const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (incomingSecret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    try {
      const update = (await request.json()) as TelegramUpdate;
      await handleUpdate(env, update);
      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error("Worker update error", error);
      return new Response("error", { status: 500 });
    }
  }
};

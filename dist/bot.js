"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const telegraf_1 = require("telegraf");
const pg_1 = require("pg");
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN)
    throw new Error("Set BOT_TOKEN env var");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL)
    throw new Error("Set DATABASE_URL env var (Supabase Postgres URL)");
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
if (Number.isNaN(PORT) || PORT <= 0) {
    throw new Error("PORT must be a positive integer");
}
const bot = new telegraf_1.Telegraf(BOT_TOKEN);
const db = new pg_1.Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
});
const PAGE_SIZE = 10;
const INLINE_FETCH_LIMIT = 400;
const INLINE_RESULT_LIMIT = 50;
const BUTTON_ADD = "Додати фото";
const BUTTON_VIEW = "Переглянути фото";
const BUTTON_DELETE = "Видалити фото";
const MAIN_MENU = telegraf_1.Markup.keyboard([[BUTTON_ADD, BUTTON_VIEW], [BUTTON_DELETE]]).resize();
const BOT_COMMANDS = [
    { command: "start", description: "Відкрити меню" },
    { command: "menu", description: "Показати меню" },
    { command: "add", description: "Додати фото" },
    { command: "gallery", description: "Переглянути фото" },
    { command: "delete", description: "Видалити фото за номером" },
    { command: "inline", description: "Вставити фото через @бота" },
    { command: "diag", description: "Перевірка inline і БД" }
];
const userState = new Map();
const galleryState = new Map();
const albumBuffer = new Map();
async function initDb() {
    await db.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL,
      file_id TEXT NOT NULL,
      file_unique_id TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_photos_user_unique UNIQUE (user_id, file_unique_id)
    );
  `);
    await db.query(`
    CREATE INDEX IF NOT EXISTS idx_photos_user_id
    ON photos(user_id);
  `);
    await db.query(`
    CREATE INDEX IF NOT EXISTS idx_photos_user_description
    ON photos(user_id, description);
  `);
}
function getSessionKey(chatId, userId) {
    return `${chatId}:${userId}`;
}
function pickLargestPhoto(photos) {
    return photos[photos.length - 1];
}
function getOrCreateUserState(chatId, userId) {
    const key = getSessionKey(chatId, userId);
    if (!userState.has(key)) {
        userState.set(key, { mode: "idle", pendingPhotos: [] });
    }
    return userState.get(key);
}
function resetUserState(chatId, userId) {
    userState.set(getSessionKey(chatId, userId), { mode: "idle", pendingPhotos: [] });
}
function normalizePendingPhotos(photos) {
    const seen = new Set();
    const unique = [];
    for (const photo of photos) {
        if (seen.has(photo.fileUniqueId))
            continue;
        seen.add(photo.fileUniqueId);
        unique.push(photo);
    }
    return unique;
}
function addPendingPhoto(state, photo) {
    if (state.pendingPhotos.some((p) => p.fileUniqueId === photo.fileUniqueId)) {
        return false;
    }
    state.pendingPhotos.push(photo);
    return true;
}
function trimCaption(text, max = 980) {
    const value = (text || "").trim();
    if (!value)
        return "(без опису)";
    if (value.length <= max)
        return value;
    return `${value.slice(0, max - 1)}…`;
}
function normalizeSearchText(value) {
    return (value || "").toLocaleLowerCase("uk-UA").replace(/\s+/g, " ").trim();
}
function filterRowsByQuery(rows, query) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery)
        return rows;
    const tokens = normalizedQuery.split(" ").filter(Boolean);
    if (!tokens.length)
        return rows;
    return rows.filter((row) => {
        const description = normalizeSearchText(row.description);
        return tokens.every((token) => description.includes(token));
    });
}
function buildGalleryReplyMarkup(userId, page, totalPages, itemsOnPage) {
    const rows = [];
    const numberButtons = Array.from({ length: itemsOnPage }, (_, index) => {
        const number = page * PAGE_SIZE + index + 1;
        return telegraf_1.Markup.button.callback(String(number), `gallery_pick:${userId}:${page}:${index}`);
    });
    for (let i = 0; i < numberButtons.length; i += 5) {
        rows.push(numberButtons.slice(i, i + 5));
    }
    if (totalPages > 1) {
        const navButtons = [];
        if (page > 0) {
            navButtons.push(telegraf_1.Markup.button.callback("⬅️", `gallery_page:${userId}:${page - 1}`));
        }
        if (page < totalPages - 1) {
            navButtons.push(telegraf_1.Markup.button.callback("➡️", `gallery_page:${userId}:${page + 1}`));
        }
        if (navButtons.length) {
            rows.push(navButtons);
        }
    }
    return telegraf_1.Markup.inlineKeyboard(rows).reply_markup;
}
function buildGalleryCaption(row, absoluteNumber, total, page, totalPages) {
    return [`#${absoluteNumber}`, trimCaption(row.description), "", `Сторінка ${page + 1}/${totalPages} • Усього: ${total}`].join("\n");
}
function isMessageNotModifiedError(error) {
    const message = String(error?.response?.description || error?.description || error?.message || "").toLowerCase();
    return message.includes("message is not modified");
}
async function renderEmptyGalleryMessage(ctx, messageId) {
    if (!messageId) {
        await ctx.reply("Галерея порожня.");
        return;
    }
    try {
        await bot.telegram.editMessageCaption(ctx.chat.id, messageId, undefined, "Галерея порожня.", {
            reply_markup: undefined
        });
    }
    catch {
        try {
            await bot.telegram.editMessageText(ctx.chat.id, messageId, undefined, "Галерея порожня.");
        }
        catch {
            await ctx.reply("Галерея порожня.");
        }
    }
}
async function getPhotosCount(userId) {
    const result = await db.query(`
      SELECT COUNT(*)::int AS total
      FROM photos
      WHERE user_id = $1
    `, [userId]);
    return Number(result.rows[0]?.total || 0);
}
async function getPhotosPage(userId, limit, offset) {
    const result = await db.query(`
      SELECT id, file_id, description
      FROM photos
      WHERE user_id = $1
      ORDER BY id ASC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);
    return result.rows.map((row) => ({
        id: Number(row.id),
        file_id: row.file_id,
        description: row.description
    }));
}
async function getPhotoByNumber(userId, offset) {
    const result = await db.query(`
      SELECT id, file_id, description
      FROM photos
      WHERE user_id = $1
      ORDER BY id ASC
      LIMIT 1 OFFSET $2
    `, [userId, offset]);
    const row = result.rows[0];
    if (!row)
        return undefined;
    return {
        id: Number(row.id),
        file_id: row.file_id,
        description: row.description
    };
}
async function getRecentPhotos(userId, limit) {
    const result = await db.query(`
      SELECT id, file_id, description
      FROM photos
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT $2
    `, [userId, limit]);
    return result.rows.map((row) => ({
        id: Number(row.id),
        file_id: row.file_id,
        description: row.description
    }));
}
async function deletePhotoById(photoId, userId) {
    await db.query(`
      DELETE FROM photos
      WHERE id = $1 AND user_id = $2
    `, [photoId, userId]);
}
async function insertPhotosWithDescription(userId, photos, description) {
    const uniquePhotos = normalizePendingPhotos(photos);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        let saved = 0;
        let skipped = 0;
        for (const photo of uniquePhotos) {
            const result = await client.query(`
          INSERT INTO photos (user_id, file_id, file_unique_id, description)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, file_unique_id) DO NOTHING
        `, [userId, photo.fileId, photo.fileUniqueId, description]);
            if ((result.rowCount || 0) > 0) {
                saved += 1;
            }
            else {
                skipped += 1;
            }
        }
        await client.query("COMMIT");
        return { saved, skipped };
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
async function finalizeAlbumBuffer(bufferKey) {
    const buffer = albumBuffer.get(bufferKey);
    if (!buffer)
        return;
    albumBuffer.delete(bufferKey);
    const state = getOrCreateUserState(buffer.chatId, buffer.userId);
    if (state.mode !== "await_photo")
        return;
    const photos = normalizePendingPhotos(buffer.photos);
    if (!photos.length)
        return;
    state.pendingPhotos = photos;
    state.mode = "await_description";
    await bot.telegram.sendMessage(buffer.chatId, `Отримав ${photos.length} фото. Тепер введи один опис для всіх цих фото (текст або смайлики).`);
}
async function showMenu(ctx, text = "Оберіть дію:") {
    await ctx.reply(text, MAIN_MENU);
}
async function showGalleryPage(ctx, requestedPage = 0, messageId = null, requestedSelectedIndexInPage = 0) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const key = getSessionKey(chatId, userId);
    const total = await getPhotosCount(userId);
    if (!total) {
        galleryState.delete(key);
        await renderEmptyGalleryMessage(ctx, messageId);
        return;
    }
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
    const offset = page * PAGE_SIZE;
    const rows = await getPhotosPage(userId, PAGE_SIZE, offset);
    const selectedIndexInPage = Math.max(0, Math.min(requestedSelectedIndexInPage, rows.length - 1));
    const selectedRow = rows[selectedIndexInPage];
    const absoluteNumber = offset + selectedIndexInPage + 1;
    const caption = buildGalleryCaption(selectedRow, absoluteNumber, total, page, totalPages);
    const replyMarkup = buildGalleryReplyMarkup(userId, page, totalPages, rows.length);
    let finalMessageId = messageId;
    if (messageId) {
        try {
            await bot.telegram.editMessageMedia(chatId, messageId, undefined, { type: "photo", media: selectedRow.file_id, caption }, { reply_markup: replyMarkup });
        }
        catch (error) {
            if (isMessageNotModifiedError(error)) {
                galleryState.set(key, { messageId, page, selectedIndexInPage });
                return;
            }
            const message = await ctx.replyWithPhoto(selectedRow.file_id, { caption, reply_markup: replyMarkup });
            finalMessageId = message.message_id;
        }
    }
    else {
        const message = await ctx.replyWithPhoto(selectedRow.file_id, { caption, reply_markup: replyMarkup });
        finalMessageId = message.message_id;
    }
    galleryState.set(key, { messageId: finalMessageId, page, selectedIndexInPage });
}
async function startAddFlow(ctx) {
    const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);
    state.mode = "await_photo";
    state.pendingPhotos = [];
    await ctx.reply("Надішли одне фото або альбом (кілька фото за раз).");
}
async function startDeleteFlow(ctx) {
    const total = await getPhotosCount(ctx.from.id);
    if (!total) {
        resetUserState(ctx.chat.id, ctx.from.id);
        await ctx.reply("Немає фото для видалення.", MAIN_MENU);
        return;
    }
    const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);
    state.mode = "await_delete_number";
    state.pendingPhotos = [];
    const existingGallery = galleryState.get(getSessionKey(ctx.chat.id, ctx.from.id));
    await showGalleryPage(ctx, existingGallery?.page ?? 0, existingGallery?.messageId ?? null, existingGallery?.selectedIndexInPage ?? 0);
    await ctx.reply(`Введи номер фото для видалення (1-${total}).`);
}
bot.start(async (ctx) => {
    resetUserState(ctx.chat.id, ctx.from.id);
    await showMenu(ctx, "Меню фото-бота:");
});
bot.command("menu", async (ctx) => {
    resetUserState(ctx.chat.id, ctx.from.id);
    await showMenu(ctx);
});
bot.command("add", startAddFlow);
bot.command("gallery", async (ctx) => {
    resetUserState(ctx.chat.id, ctx.from.id);
    const existingGallery = galleryState.get(getSessionKey(ctx.chat.id, ctx.from.id));
    await showGalleryPage(ctx, existingGallery?.page ?? 0, existingGallery?.messageId ?? null, existingGallery?.selectedIndexInPage ?? 0);
});
bot.command("delete", startDeleteFlow);
bot.command("inline", async (ctx) => {
    const total = await getPhotosCount(ctx.from.id);
    if (!total) {
        await ctx.reply("У тебе ще немає збережених фото. Додай хоча б одне через «Додати фото».", MAIN_MENU);
        return;
    }
    await ctx.reply("Натисни кнопку нижче, щоб вставити фото через inline-режим:", telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.switchToCurrentChat("Вставити в цей чат", "")],
        [telegraf_1.Markup.button.switchToChat("Вибрати інший чат", "")]
    ]));
});
bot.command("diag", async (ctx) => {
    const total = await getPhotosCount(ctx.from.id);
    const me = bot.botInfo || (await bot.telegram.getMe());
    const inlineEnabled = Boolean(me.supports_inline_queries);
    await ctx.reply([
        `user_id: ${ctx.from.id}`,
        `saved_photos: ${total}`,
        `bot_username: @${me.username || "unknown"}`,
        `supports_inline_queries: ${inlineEnabled ? "true" : "false"}`,
        `storage: supabase_postgres`,
        `mode: ${WEBHOOK_URL ? "webhook" : "polling"}`
    ].join("\n"));
});
bot.action(/^gallery_page:(\d+):(\d+)$/, async (ctx) => {
    const ownerId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    if (ctx.from.id !== ownerId) {
        await ctx.answerCbQuery("Це не твоя галерея.");
        return;
    }
    const messageId = ctx.callbackQuery.message?.message_id || null;
    try {
        const state = galleryState.get(getSessionKey(ctx.chat.id, ctx.from.id));
        const selectedIndexInPage = state?.selectedIndexInPage ?? 0;
        await showGalleryPage(ctx, page, messageId, selectedIndexInPage);
        await ctx.answerCbQuery();
    }
    catch (error) {
        console.error("Gallery callback error:", error);
        await ctx.answerCbQuery("Помилка при перемиканні сторінки.");
    }
});
bot.action(/^gallery_pick:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const ownerId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const selectedIndexInPage = Number(ctx.match[3]);
    if (ctx.from.id !== ownerId) {
        await ctx.answerCbQuery("Це не твоя галерея.");
        return;
    }
    const messageId = ctx.callbackQuery.message?.message_id || null;
    try {
        await showGalleryPage(ctx, page, messageId, selectedIndexInPage);
        await ctx.answerCbQuery();
    }
    catch (error) {
        console.error("Gallery pick callback error:", error);
        await ctx.answerCbQuery("Помилка відкриття фото.");
    }
});
bot.on("photo", async (ctx) => {
    const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);
    if (state.mode === "await_description") {
        const p = pickLargestPhoto(ctx.message.photo);
        const added = addPendingPhoto(state, { fileId: p.file_id, fileUniqueId: p.file_unique_id });
        if (!added) {
            await ctx.reply("Це фото вже додане в поточну пачку. Введи опис для збереження.");
            return;
        }
        await ctx.reply(`Додав ще фото (${state.pendingPhotos.length}). Тепер введи один опис для всієї пачки.`);
        return;
    }
    if (state.mode !== "await_photo") {
        await ctx.reply("Щоб додати фото, обери «Додати фото» або команду /add.", MAIN_MENU);
        return;
    }
    if (ctx.message.media_group_id) {
        const albumKey = `${ctx.chat.id}:${ctx.from.id}:${ctx.message.media_group_id}`;
        const p = pickLargestPhoto(ctx.message.photo);
        if (!albumBuffer.has(albumKey)) {
            albumBuffer.set(albumKey, {
                chatId: ctx.chat.id,
                userId: ctx.from.id,
                photos: [],
                timer: null
            });
        }
        const buffer = albumBuffer.get(albumKey);
        buffer.photos.push({ fileId: p.file_id, fileUniqueId: p.file_unique_id });
        if (buffer.timer) {
            clearTimeout(buffer.timer);
        }
        buffer.timer = setTimeout(() => {
            finalizeAlbumBuffer(albumKey).catch((error) => {
                console.error("Album finalize error:", error);
            });
        }, 700);
        return;
    }
    const p = pickLargestPhoto(ctx.message.photo);
    state.pendingPhotos = [{ fileId: p.file_id, fileUniqueId: p.file_unique_id }];
    state.mode = "await_description";
    await ctx.reply("Тепер введи опис (текст або смайлики). Без опису фото не збережеться.");
});
bot.on("text", async (ctx) => {
    const text = (ctx.message.text || "").trim();
    if (!text)
        return;
    if (text.startsWith("/"))
        return;
    if (text === BUTTON_ADD) {
        await startAddFlow(ctx);
        return;
    }
    if (text === BUTTON_VIEW) {
        resetUserState(ctx.chat.id, ctx.from.id);
        const existingGallery = galleryState.get(getSessionKey(ctx.chat.id, ctx.from.id));
        await showGalleryPage(ctx, existingGallery?.page ?? 0, existingGallery?.messageId ?? null, existingGallery?.selectedIndexInPage ?? 0);
        return;
    }
    if (text === BUTTON_DELETE) {
        await startDeleteFlow(ctx);
        return;
    }
    const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);
    if (state.mode === "await_photo") {
        await ctx.reply("Зараз очікую саме фото.");
        return;
    }
    if (state.mode === "await_description") {
        const description = text.trim();
        if (!description) {
            await ctx.reply("Опис порожній. Введи текст або смайлики.");
            return;
        }
        if (!state.pendingPhotos.length) {
            state.mode = "await_photo";
            await ctx.reply("Спочатку надішли фото.");
            return;
        }
        const result = await insertPhotosWithDescription(ctx.from.id, state.pendingPhotos, description);
        const totalInBatch = state.pendingPhotos.length;
        resetUserState(ctx.chat.id, ctx.from.id);
        if (!result.saved) {
            await ctx.reply("Усі фото з цієї пачки вже були в базі. Надішли інші фото.", MAIN_MENU);
            return;
        }
        if (result.skipped > 0) {
            await ctx.reply(`Збережено ${result.saved} з ${totalInBatch}. Пропущено дублікатів: ${result.skipped}.`, MAIN_MENU);
            return;
        }
        await ctx.reply(`Фото з описом збережено ✅ (${result.saved})`, MAIN_MENU);
        return;
    }
    if (state.mode === "await_delete_number") {
        const sessionKey = getSessionKey(ctx.chat.id, ctx.from.id);
        const gallery = galleryState.get(sessionKey);
        const total = await getPhotosCount(ctx.from.id);
        if (!total) {
            resetUserState(ctx.chat.id, ctx.from.id);
            if (gallery) {
                await renderEmptyGalleryMessage(ctx, gallery.messageId);
                galleryState.delete(sessionKey);
            }
            await ctx.reply("Галерея вже порожня.", MAIN_MENU);
            return;
        }
        const number = Number.parseInt(text, 10);
        if (!Number.isInteger(number) || number < 1) {
            await ctx.reply(`Введи коректний номер від 1 до ${total}.`);
            return;
        }
        if (number > total) {
            await ctx.reply(`Немає фото з номером ${number}. Доступні: 1-${total}.`);
            return;
        }
        const row = await getPhotoByNumber(ctx.from.id, number - 1);
        if (!row) {
            await ctx.reply(`Немає фото з номером ${number}.`);
            return;
        }
        await deletePhotoById(row.id, ctx.from.id);
        resetUserState(ctx.chat.id, ctx.from.id);
        const remaining = await getPhotosCount(ctx.from.id);
        if (remaining > 0) {
            const targetAbsoluteIndex = Math.min(number - 1, remaining - 1);
            const targetPage = Math.floor(targetAbsoluteIndex / PAGE_SIZE);
            const targetIndexInPage = targetAbsoluteIndex - targetPage * PAGE_SIZE;
            await showGalleryPage(ctx, targetPage, gallery?.messageId ?? null, targetIndexInPage);
        }
        else if (gallery) {
            await renderEmptyGalleryMessage(ctx, gallery.messageId);
            galleryState.delete(sessionKey);
        }
        await ctx.reply(`Фото #${number} видалено. Нумерація оновлена.`, MAIN_MENU);
    }
});
bot.on("inline_query", async (ctx) => {
    const q = (ctx.inlineQuery.query || "").trim();
    const userId = ctx.from.id;
    const sourceRows = await getRecentPhotos(userId, INLINE_FETCH_LIMIT);
    const rows = filterRowsByQuery(sourceRows, q).slice(0, INLINE_RESULT_LIMIT);
    console.log(`[inline_query] user=${userId} query="${q}" results=${rows.length}`);
    if (!rows.length) {
        await ctx.answerInlineQuery([], {
            cache_time: 0,
            is_personal: true,
            switch_pm_text: "Немає фото. Додати в боті",
            switch_pm_parameter: "inline_empty"
        });
        return;
    }
    const results = rows.map((r) => ({
        type: "photo",
        id: String(r.id),
        photo_file_id: r.file_id
    }));
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
});
function parseWebhookUrl(rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") {
        throw new Error("WEBHOOK_URL must start with https://");
    }
    const path = url.pathname && url.pathname !== "/" ? url.pathname : "/telegram/webhook";
    return { domain: url.host, path };
}
async function startBot() {
    console.log("Starting bot...");
    await withTimeout(initDb(), 20000, "Database init timeout");
    console.log("Database ready (Supabase Postgres)");
    const me = await withTimeout(bot.telegram.getMe(), 15000, "Telegram getMe timeout");
    bot.botInfo = me;
    console.log(`Telegram auth OK: @${me.username || "unknown"} (${me.id})`);
    console.log(`Inline enabled: ${me.supports_inline_queries ? "yes" : "no"}`);
    try {
        await withTimeout(bot.telegram.setMyCommands(BOT_COMMANDS), 15000, "setMyCommands timeout");
        console.log("Bot commands updated");
    }
    catch (error) {
        console.error("Failed to set commands:", error);
    }
    if (WEBHOOK_URL) {
        const { domain, path } = parseWebhookUrl(WEBHOOK_URL);
        console.log(`Starting webhook mode: ${WEBHOOK_URL}`);
        bot
            .launch({
            dropPendingUpdates: true,
            webhook: {
                domain,
                path,
                host: HOST,
                port: PORT,
                secretToken: WEBHOOK_SECRET
            }
        }, () => {
            console.log(`Bot started (webhook) on ${HOST}:${PORT}${path}`);
        })
            .catch((error) => {
            console.error("Failed during webhook launch:", error);
            process.exit(1);
        });
        return;
    }
    console.log("Starting long polling...");
    bot
        .launch({ dropPendingUpdates: true }, () => {
        console.log("Bot started (long polling)");
    })
        .catch((error) => {
        console.error("Failed during long polling:", error);
        process.exit(1);
    });
}
function withTimeout(promise, timeoutMs, label) {
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
async function shutdown(signal) {
    console.log(`${signal} received. Stopping bot...`);
    try {
        bot.stop(signal);
    }
    catch {
        // bot may not be running yet
    }
    try {
        await db.end();
    }
    catch (error) {
        console.error("Failed to close DB pool:", error);
    }
}
startBot().catch((error) => {
    console.error("Failed to start bot:", error);
    process.exit(1);
});
process.once("SIGINT", () => {
    shutdown("SIGINT").finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
    shutdown("SIGTERM").finally(() => process.exit(0));
});

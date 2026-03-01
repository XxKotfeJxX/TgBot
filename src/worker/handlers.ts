import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BUTTON_ADD,
  BUTTON_DELETE,
  BUTTON_VIEW,
  INLINE_FETCH_LIMIT,
  INLINE_RESULT_LIMIT,
  MAIN_MENU_REPLY_MARKUP,
  PAGE_SIZE,
  buildFavoriteToggleReplyMarkup,
  buildGalleryCaption,
  buildGalleryReplyMarkup,
  buildInlineResult,
  buildInlineResultReplyMarkup,
  buildInputMedia,
  filterRowsByQuery,
  getErrorText,
  isInvalidPhotoReferenceError,
  isMessageNotModifiedError,
  normalizePendingPhotos,
  parseInlineQueryFilters,
  pickLargestPhoto,
  sortInlineRows,
  type PendingPhoto
} from "../core";
import { getSupabase } from "./env";
import {
  applyFavoriteFlags,
  deletePhotoById,
  getPhotoByNumber,
  getPhotosCount,
  getPhotosPage,
  getRankedInlineRows,
  getRecentPhotos,
  insertPhotosWithDescription,
  loadSession,
  saveSession,
  toggleFavorite,
  trackChosenInlineResult
} from "./repository";
import { answerCallbackQuery, sendAsset, sendMessage, tgCall } from "./telegram";
import type {
  BotSession,
  Env,
  TelegramCallbackQuery,
  TelegramInlineQuery,
  TelegramMessage,
  TelegramUpdate
} from "./types";

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
  await sendMessage(env, chatId, text, MAIN_MENU_REPLY_MARKUP);
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

  const rawRows = await getPhotosPage(client, session.userId, PAGE_SIZE, offset);
  if (!rawRows.length) {
    await renderEmptyGalleryMessage(env, session.chatId, messageId);
    session.galleryMessageId = null;
    session.galleryPage = 0;
    session.gallerySelected = 0;
    await saveSession(client, session);
    return session;
  }

  const rows = await applyFavoriteFlags(client, session.userId, rawRows);
  const selectedIndexInPage = Math.max(0, Math.min(requestedSelectedIndexInPage, rows.length - 1));
  const candidateIndexes = [selectedIndexInPage, ...rows.map((_, index) => index).filter((index) => index !== selectedIndexInPage)];
  let finalMessageId = messageId;
  let renderedIndex: number | null = null;
  let lastInvalidPhotoError: unknown = null;

  for (const candidateIndex of candidateIndexes) {
    const row = rows[candidateIndex];
    const absoluteNumber = offset + candidateIndex + 1;
    const caption = buildGalleryCaption(row, absoluteNumber, total, page, totalPages);
    const replyMarkup = buildGalleryReplyMarkup(session.userId, page, totalPages, rows, candidateIndex);

    try {
      if (messageId) {
        try {
          await tgCall(env, "editMessageMedia", {
            chat_id: session.chatId,
            message_id: messageId,
            media: buildInputMedia(row, caption),
            reply_markup: replyMarkup
          });

          renderedIndex = candidateIndex;
          break;
        } catch (error) {
          if (isMessageNotModifiedError(error)) {
            renderedIndex = candidateIndex;
            break;
          }

          if (isInvalidPhotoReferenceError(error)) {
            lastInvalidPhotoError = error;
            continue;
          }

          const sent = await sendAsset(env, session.chatId, row, caption, replyMarkup);
          finalMessageId = sent.message_id;
          renderedIndex = candidateIndex;
          break;
        }
      } else {
        const sent = await sendAsset(env, session.chatId, row, caption, replyMarkup);
        finalMessageId = sent.message_id;
        renderedIndex = candidateIndex;
        break;
      }
    } catch (error) {
      if (isInvalidPhotoReferenceError(error)) {
        lastInvalidPhotoError = error;
        continue;
      }
      throw error;
    }
  }

  if (renderedIndex === null) {
    console.error("gallery render failed: no valid file_id on page", {
      userId: session.userId,
      page,
      items: rows.length,
      error: getErrorText(lastInvalidPhotoError)
    });

    await sendMessage(
      env,
      session.chatId,
      "Не вдалося показати фото на цій сторінці. Схоже, збережені file_id вже невалідні. Видали ці фото та завантаж заново."
    );
    return session;
  }

  session.galleryPage = page;
  session.gallerySelected = renderedIndex;
  session.galleryMessageId = finalMessageId;

  await saveSession(client, session);
  return session;
}

async function startAddFlow(env: Env, client: SupabaseClient, session: BotSession): Promise<void> {
  session.mode = "await_photo";
  session.pendingPhotos = [];
  await saveSession(client, session);
  await sendMessage(env, session.chatId, "Надішли фото, відео або GIF. Також можна надіслати альбом фото.");
}

async function startDeleteFlow(env: Env, client: SupabaseClient, session: BotSession): Promise<void> {
  const total = await getPhotosCount(client, session.userId);
  if (!total) {
    session.mode = "idle";
    session.pendingPhotos = [];
    await saveSession(client, session);
    await sendMessage(env, session.chatId, "Немає фото для видалення.", MAIN_MENU_REPLY_MARKUP);
    return;
  }

  session.mode = "await_delete_number";
  session.pendingPhotos = [];

  await showGalleryPage(env, client, session, session.galleryPage, null, session.gallerySelected);
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
    await showGalleryPage(env, client, session, session.galleryPage, null, session.gallerySelected);
    return;
  }

  if (command === "/delete") {
    await startDeleteFlow(env, client, session);
    return;
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
    await showGalleryPage(env, client, session, session.galleryPage, null, session.gallerySelected);
    return;
  }

  if (normalized === BUTTON_DELETE) {
    await startDeleteFlow(env, client, session);
    return;
  }

  if (session.mode === "await_photo") {
    await sendMessage(env, chatId, "Зараз очікую медіа: фото, відео або GIF.");
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
      await sendMessage(env, chatId, "Усі фото з цієї пачки вже були в базі. Надішли інші фото.", MAIN_MENU_REPLY_MARKUP);
      return;
    }

    const firstSavedAsset = result.savedAssets[0];
    if (firstSavedAsset) {
      try {
        await sendAsset(
          env,
          chatId,
          {
            id: firstSavedAsset.id,
            file_id: firstSavedAsset.fileId,
            description: "",
            media_type: firstSavedAsset.mediaType
          },
          "Картку додано. За бажанням додай в улюблені:",
          buildFavoriteToggleReplyMarkup(session.userId, firstSavedAsset.id, false)
        );
      } catch {
        await sendMessage(
          env,
          chatId,
          "Картку додано. За бажанням додай в улюблені:",
          buildFavoriteToggleReplyMarkup(session.userId, firstSavedAsset.id, false)
        );
      }
    }

    if (result.skipped > 0) {
      await sendMessage(
        env,
        chatId,
        `Збережено ${result.saved} з ${totalInBatch}. Пропущено дублікатів: ${result.skipped}.`,
        MAIN_MENU_REPLY_MARKUP
      );
      return;
    }

    await sendMessage(env, chatId, `Фото з описом збережено ✅ (${result.saved})`, MAIN_MENU_REPLY_MARKUP);
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
      await sendMessage(env, chatId, "Галерея вже порожня.", MAIN_MENU_REPLY_MARKUP);
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

    await sendMessage(env, chatId, `Фото #${number} видалено. Нумерація оновлена.`, MAIN_MENU_REPLY_MARKUP);
  }
}

async function handleMediaMessage(
  env: Env,
  client: SupabaseClient,
  session: BotSession,
  message: TelegramMessage,
  asset: PendingPhoto
): Promise<void> {
  const chatId = message.chat.id;

  if (session.mode !== "await_photo" && session.mode !== "await_description") {
    await sendMessage(env, chatId, "Щоб додати медіа, обери «Додати фото» або команду /add.", MAIN_MENU_REPLY_MARKUP);
    return;
  }

  const beforeCount = session.pendingPhotos.length;
  session.pendingPhotos = normalizePendingPhotos([...session.pendingPhotos, asset]);
  const added = session.pendingPhotos.length > beforeCount;
  session.mode = "await_description";

  await saveSession(client, session);

  if (!added) {
    await sendMessage(env, chatId, "Це медіа вже додане в поточну пачку. Введи опис для збереження.");
    return;
  }

  if (message.media_group_id) {
    await sendMessage(env, chatId, `Медіа з альбому додано (${session.pendingPhotos.length}). Після альбому введи один опис для всієї пачки.`);
    return;
  }

  await sendMessage(env, chatId, `Медіа додано (${session.pendingPhotos.length}). Тепер введи один опис для всієї пачки.`);
}

async function handleCallbackQuery(env: Env, client: SupabaseClient, query: TelegramCallbackQuery): Promise<void> {
  if (!query.data) {
    await answerCallbackQuery(env, query.id);
    return;
  }

  const inlineFavoriteMatch = query.data.match(/^inline_fav:(\d+):(\d+)$/);
  if (inlineFavoriteMatch) {
    const ownerId = Number(inlineFavoriteMatch[1]);
    const assetId = Number(inlineFavoriteMatch[2]);
    const actorId = query.from.id;

    if (ownerId !== actorId) {
      await answerCallbackQuery(env, query.id, "Це не твоя картка.");
      return;
    }

    try {
      const isFavorite = await toggleFavorite(client, actorId, assetId);
      const updatedMarkup = buildInlineResultReplyMarkup(ownerId, assetId, isFavorite);

      if (query.inline_message_id) {
        await tgCall(env, "editMessageReplyMarkup", {
          inline_message_id: query.inline_message_id,
          reply_markup: updatedMarkup
        });
      } else if (query.message) {
        await tgCall(env, "editMessageReplyMarkup", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: updatedMarkup
        });
      }

      await answerCallbackQuery(env, query.id, isFavorite ? "Додано в улюблені" : "Видалено з улюблених");
    } catch (error) {
      const errorText = getErrorText(error).toLowerCase();
      if (errorText.includes("favorites schema is missing")) {
        await answerCallbackQuery(env, query.id, "Онови схему БД: таблиця favorites відсутня.");
        return;
      }
      if (errorText.includes("asset not found")) {
        await answerCallbackQuery(env, query.id, "Картку не знайдено.");
        return;
      }

      console.error("inline_fav callback error", error);
      await answerCallbackQuery(env, query.id, "Помилка зміни улюблених.");
    }
    return;
  }

  const inlineNavMatch = query.data.match(/^inline_nav:(\d+):(\d+):(prev|next)$/);
  if (inlineNavMatch) {
    const ownerId = Number(inlineNavMatch[1]);
    const assetId = Number(inlineNavMatch[2]);
    const direction = inlineNavMatch[3];
    const actorId = query.from.id;

    if (ownerId !== actorId) {
      await answerCallbackQuery(env, query.id, "Це не твоя картка.");
      return;
    }

    try {
      const rankedRows = await getRankedInlineRows(client, ownerId);
      if (!rankedRows.length) {
        await answerCallbackQuery(env, query.id, "Немає медіа.");
        return;
      }

      const currentIndex = rankedRows.findIndex((row) => row.id === assetId);
      if (currentIndex < 0) {
        await answerCallbackQuery(env, query.id, "Картку не знайдено.");
        return;
      }

      const step = direction === "prev" ? -1 : 1;
      const nextIndex = (currentIndex + step + rankedRows.length) % rankedRows.length;
      const nextRow = rankedRows[nextIndex];
      const replyMarkup = buildInlineResultReplyMarkup(ownerId, nextRow.id, Boolean(nextRow.is_favorite));

      if (query.inline_message_id) {
        await tgCall(env, "editMessageMedia", {
          inline_message_id: query.inline_message_id,
          media: buildInputMedia(nextRow),
          reply_markup: replyMarkup
        });
      } else if (query.message) {
        await tgCall(env, "editMessageMedia", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          media: buildInputMedia(nextRow),
          reply_markup: replyMarkup
        });
      }

      await answerCallbackQuery(env, query.id);
    } catch (error) {
      console.error("inline_nav callback error", error);
      await answerCallbackQuery(env, query.id, "Помилка перегортання.");
    }
    return;
  }

  const favoriteMatch = query.data.match(/^fav_toggle:(\d+):(\d+)$/);
  if (favoriteMatch) {
    const ownerId = Number(favoriteMatch[1]);
    const assetId = Number(favoriteMatch[2]);
    const actorId = query.from.id;

    if (ownerId !== actorId) {
      await answerCallbackQuery(env, query.id, "Це не твоя картка.");
      return;
    }

    try {
      const isFavorite = await toggleFavorite(client, actorId, assetId);
      const updatedMarkup = buildFavoriteToggleReplyMarkup(ownerId, assetId, isFavorite);

      if (query.inline_message_id) {
        await tgCall(env, "editMessageReplyMarkup", {
          inline_message_id: query.inline_message_id,
          reply_markup: updatedMarkup
        });
      } else if (query.message) {
        await tgCall(env, "editMessageReplyMarkup", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: updatedMarkup
        });
      }

      await answerCallbackQuery(env, query.id, isFavorite ? "Додано в улюблені" : "Видалено з улюблених");
    } catch (error) {
      const errorText = getErrorText(error).toLowerCase();
      if (errorText.includes("favorites schema is missing")) {
        await answerCallbackQuery(env, query.id, "Онови схему БД: таблиця favorites відсутня.");
        return;
      }
      if (errorText.includes("asset not found")) {
        await answerCallbackQuery(env, query.id, "Картку не знайдено.");
        return;
      }

      console.error("favorite toggle callback error", error);
      await answerCallbackQuery(env, query.id, "Помилка зміни улюблених.");
    }
    return;
  }

  if (!query.message) {
    await answerCallbackQuery(env, query.id);
    return;
  }

  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const session = await loadSession(client, userId, chatId);
  session.chatId = chatId;

  const galleryFavoriteMatch = query.data.match(/^gallery_fav:(\d+):(\d+):(\d+):(\d+)$/);
  if (galleryFavoriteMatch) {
    const ownerId = Number(galleryFavoriteMatch[1]);
    const page = Number(galleryFavoriteMatch[2]);
    const selectedIndex = Number(galleryFavoriteMatch[3]);
    const assetId = Number(galleryFavoriteMatch[4]);

    if (ownerId !== userId) {
      await answerCallbackQuery(env, query.id, "Це не твоя галерея.");
      return;
    }

    try {
      const isFavorite = await toggleFavorite(client, userId, assetId);
      await showGalleryPage(env, client, session, page, query.message.message_id, selectedIndex);
      await answerCallbackQuery(env, query.id, isFavorite ? "Додано в улюблені" : "Видалено з улюблених");
    } catch (error) {
      const errorText = getErrorText(error).toLowerCase();
      if (errorText.includes("favorites schema is missing")) {
        await answerCallbackQuery(env, query.id, "Онови схему БД: таблиця favorites відсутня.");
        return;
      }
      if (errorText.includes("asset not found")) {
        await answerCallbackQuery(env, query.id, "Картку не знайдено.");
        return;
      }

      console.error("gallery_fav callback error", error);
      await answerCallbackQuery(env, query.id, "Помилка зміни улюблених.");
    }
    return;
  }

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
  const filters = parseInlineQueryFilters(query.query || "");

  const sourceRows = await getRecentPhotos(client, userId, INLINE_FETCH_LIMIT);
  const rowsWithFavorites = await applyFavoriteFlags(client, userId, sourceRows);
  const rows = sortInlineRows(filterRowsByQuery(rowsWithFavorites, filters), filters.searchText).slice(0, INLINE_RESULT_LIMIT);

  if (!rows.length) {
    await tgCall(env, "answerInlineQuery", {
      inline_query_id: query.id,
      results: [],
      cache_time: 0,
      is_personal: true
    });
    return;
  }

  const results = rows.map((row) => buildInlineResult(row, userId));

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
    const picked = pickLargestPhoto(message.photo);
    await handleMediaMessage(env, client, session, message, {
      fileId: picked.file_id,
      fileUniqueId: picked.file_unique_id,
      mediaType: "photo"
    });
    return;
  }

  if (message.video) {
    await handleMediaMessage(env, client, session, message, {
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      mediaType: "video"
    });
    return;
  }

  if (message.animation) {
    await handleMediaMessage(env, client, session, message, {
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id,
      mediaType: "gif"
    });
    return;
  }

  if (typeof message.text === "string") {
    await handleTextMessage(env, client, session, message.text, chatId);
  }
}

export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const client = getSupabase(env);

  if (update.inline_query) {
    await handleInlineQuery(env, client, update.inline_query);
    return;
  }

  if (update.chosen_inline_result) {
    await trackChosenInlineResult(client, update.chosen_inline_result);
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

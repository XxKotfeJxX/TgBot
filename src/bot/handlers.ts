import type { Telegraf } from "telegraf";
import {
  BUTTON_ADD,
  BUTTON_DELETE,
  BUTTON_VIEW,
  INLINE_FETCH_LIMIT,
  INLINE_RESULT_LIMIT,
  MAIN_MENU_REPLY_MARKUP,
  PAGE_SIZE,
  addPendingPhoto,
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
  normalizeMediaType,
  parseInlineQueryFilters,
  pickLargestPhoto,
  sortInlineRows,
  type PendingPhoto,
  type PhotoRow
} from "../core";
import type { BotRepository } from "./repository";
import {
  deleteAlbumBuffer,
  deleteGallerySession,
  getAlbumBuffer,
  getGallerySession,
  getOrCreateUserState,
  getSessionKey,
  normalizeAlbumPhotos,
  resetUserState,
  setAlbumBuffer,
  setGallerySession
} from "./state";

const MAIN_MENU = { reply_markup: MAIN_MENU_REPLY_MARKUP };

async function sendAssetMessage(ctx: any, row: PhotoRow, caption?: string, replyMarkup?: any): Promise<{ message_id: number }> {
  const mediaType = normalizeMediaType(row.media_type);

  if (mediaType === "video") {
    return ctx.replyWithVideo(row.file_id, {
      ...(caption ? { caption } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  }

  if (mediaType === "gif") {
    return ctx.replyWithAnimation(row.file_id, {
      ...(caption ? { caption } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
  }

  return ctx.replyWithPhoto(row.file_id, {
    ...(caption ? { caption } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function renderEmptyGalleryMessage(bot: Telegraf, ctx: any, messageId: number | null): Promise<void> {
  if (!messageId) {
    await ctx.reply("Галерея порожня.");
    return;
  }

  try {
    await bot.telegram.editMessageCaption(ctx.chat.id, messageId, undefined, "Галерея порожня.", {
      reply_markup: undefined
    });
  } catch {
    try {
      await bot.telegram.editMessageText(ctx.chat.id, messageId, undefined, "Галерея порожня.");
    } catch {
      await ctx.reply("Галерея порожня.");
    }
  }
}

async function showMenu(ctx: any, text = "Оберіть дію:"): Promise<void> {
  await ctx.reply(text, MAIN_MENU);
}

async function showGalleryPage(
  bot: Telegraf,
  repo: BotRepository,
  ctx: any,
  requestedPage = 0,
  messageId: number | null = null,
  requestedSelectedIndexInPage = 0
): Promise<void> {
  const chatId = ctx.chat.id as number;
  const userId = ctx.from.id as number;

  const total = await repo.getPhotosCount(userId);

  if (!total) {
    deleteGallerySession(chatId, userId);
    await renderEmptyGalleryMessage(bot, ctx, messageId);
    return;
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const offset = page * PAGE_SIZE;
  const rawRows = await repo.getPhotosPage(userId, PAGE_SIZE, offset);
  if (!rawRows.length) {
    deleteGallerySession(chatId, userId);
    await renderEmptyGalleryMessage(bot, ctx, messageId);
    return;
  }

  const rows = await repo.applyFavoriteFlags(userId, rawRows);
  const selectedIndexInPage = Math.max(0, Math.min(requestedSelectedIndexInPage, rows.length - 1));
  const candidateIndexes = [selectedIndexInPage, ...rows.map((_, index) => index).filter((index) => index !== selectedIndexInPage)];
  let finalMessageId = messageId;
  let renderedIndex: number | null = null;
  let lastInvalidPhotoError: unknown = null;

  for (const candidateIndex of candidateIndexes) {
    const row = rows[candidateIndex];
    const absoluteNumber = offset + candidateIndex + 1;
    const caption = buildGalleryCaption(row, absoluteNumber, total, page, totalPages);
    const replyMarkup = buildGalleryReplyMarkup(userId, page, totalPages, rows, candidateIndex);

    try {
      if (messageId) {
        try {
          await bot.telegram.editMessageMedia(chatId, messageId, undefined, buildInputMedia(row, caption) as any, {
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

          const message = await sendAssetMessage(ctx, row, caption, replyMarkup);
          finalMessageId = message.message_id;
          renderedIndex = candidateIndex;
          break;
        }
      } else {
        const message = await sendAssetMessage(ctx, row, caption, replyMarkup);
        finalMessageId = message.message_id;
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
    console.error("Gallery render failed: no valid file_id on page", {
      userId,
      page,
      items: rows.length,
      error: getErrorText(lastInvalidPhotoError)
    });
    await ctx.reply("Не вдалося показати фото на цій сторінці. Видали ці фото і завантаж заново.");
    return;
  }

  setGallerySession(chatId, userId, {
    messageId: finalMessageId!,
    page,
    selectedIndexInPage: renderedIndex
  });
}

async function startAddFlow(ctx: any): Promise<void> {
  const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);
  state.mode = "await_photo";
  state.pendingPhotos = [];

  await ctx.reply("Надішли фото, відео або GIF. Також можна надіслати альбом фото.");
}

async function handleIncomingAsset(ctx: any, asset: PendingPhoto): Promise<void> {
  const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);

  if (state.mode === "await_description") {
    const nextPhotos = addPendingPhoto(state.pendingPhotos, asset);
    const added = nextPhotos.length > state.pendingPhotos.length;
    state.pendingPhotos = nextPhotos;
    if (!added) {
      await ctx.reply("Це медіа вже додане в поточну пачку. Введи опис для збереження.");
      return;
    }

    await ctx.reply(`Додав ще медіа (${state.pendingPhotos.length}). Тепер введи один опис для всієї пачки.`);
    return;
  }

  if (state.mode !== "await_photo") {
    await ctx.reply("Щоб додати медіа, обери «Додати фото» або команду /add.", MAIN_MENU);
    return;
  }

  state.pendingPhotos = [asset];
  state.mode = "await_description";

  await ctx.reply("Тепер введи опис (текст або смайлики). Без опису медіа не збережеться.");
}

async function finalizeAlbumBuffer(bot: Telegraf, bufferKey: string): Promise<void> {
  const buffer = getAlbumBuffer(bufferKey);
  if (!buffer) return;
  deleteAlbumBuffer(bufferKey);

  const state = getOrCreateUserState(buffer.chatId, buffer.userId);
  if (state.mode !== "await_photo") return;

  const photos = normalizeAlbumPhotos(buffer.photos);
  if (!photos.length) return;

  state.pendingPhotos = photos;
  state.mode = "await_description";

  await bot.telegram.sendMessage(
    buffer.chatId,
    `Отримав ${photos.length} фото. Тепер введи один опис для всіх цих фото (текст або смайлики).`
  );
}

async function startDeleteFlow(bot: Telegraf, repo: BotRepository, ctx: any): Promise<void> {
  const total = await repo.getPhotosCount(ctx.from.id);
  if (!total) {
    resetUserState(ctx.chat.id, ctx.from.id);
    await ctx.reply("Немає фото для видалення.", MAIN_MENU);
    return;
  }

  const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);
  state.mode = "await_delete_number";
  state.pendingPhotos = [];

  const existingGallery = getGallerySession(ctx.chat.id, ctx.from.id);
  await showGalleryPage(bot, repo, ctx, existingGallery?.page ?? 0, null, existingGallery?.selectedIndexInPage ?? 0);
  await ctx.reply(`Введи номер фото для видалення (1-${total}).`);
}

async function handleTextFlow(bot: Telegraf, repo: BotRepository, ctx: any, text: string): Promise<void> {
  if (text === BUTTON_ADD) {
    await startAddFlow(ctx);
    return;
  }

  if (text === BUTTON_VIEW) {
    resetUserState(ctx.chat.id, ctx.from.id);
    const existingGallery = getGallerySession(ctx.chat.id, ctx.from.id);
    await showGalleryPage(bot, repo, ctx, existingGallery?.page ?? 0, null, existingGallery?.selectedIndexInPage ?? 0);
    return;
  }

  if (text === BUTTON_DELETE) {
    await startDeleteFlow(bot, repo, ctx);
    return;
  }

  const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);

  if (state.mode === "await_photo") {
    await ctx.reply("Зараз очікую медіа: фото, відео або GIF.");
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

    const result = await repo.insertPhotosWithDescription(ctx.from.id, state.pendingPhotos, description);
    const totalInBatch = state.pendingPhotos.length;

    resetUserState(ctx.chat.id, ctx.from.id);

    if (!result.saved) {
      await ctx.reply("Усі фото з цієї пачки вже були в базі. Надішли інші фото.", MAIN_MENU);
      return;
    }

    const firstSavedAsset = result.savedAssets[0];
    if (firstSavedAsset) {
      try {
        await sendAssetMessage(
          ctx,
          {
            id: firstSavedAsset.id,
            file_id: firstSavedAsset.fileId,
            description: "",
            media_type: firstSavedAsset.mediaType
          },
          "Картку додано. За бажанням додай в улюблені:",
          buildFavoriteToggleReplyMarkup(ctx.from.id, firstSavedAsset.id, false)
        );
      } catch {
        await ctx.reply("Картку додано. За бажанням додай в улюблені:", {
          reply_markup: buildFavoriteToggleReplyMarkup(ctx.from.id, firstSavedAsset.id, false)
        });
      }
    }

    if (result.skipped > 0) {
      await ctx.reply(`Збережено ${result.saved} з ${totalInBatch}. Пропущено дублікатів: ${result.skipped}.`, MAIN_MENU);
      return;
    }

    await ctx.reply(`Фото з описом збережено ✅ (${result.saved})`, MAIN_MENU);
    return;
  }

  if (state.mode === "await_delete_number") {
    const gallery = getGallerySession(ctx.chat.id, ctx.from.id);
    const total = await repo.getPhotosCount(ctx.from.id);

    if (!total) {
      resetUserState(ctx.chat.id, ctx.from.id);
      if (gallery) {
        await renderEmptyGalleryMessage(bot, ctx, gallery.messageId);
        deleteGallerySession(ctx.chat.id, ctx.from.id);
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

    const row = await repo.getPhotoByNumber(ctx.from.id, number - 1);
    if (!row) {
      await ctx.reply(`Немає фото з номером ${number}.`);
      return;
    }

    await repo.deletePhotoById(row.id, ctx.from.id);
    resetUserState(ctx.chat.id, ctx.from.id);

    const remaining = await repo.getPhotosCount(ctx.from.id);
    if (remaining > 0) {
      const targetAbsoluteIndex = Math.min(number - 1, remaining - 1);
      const targetPage = Math.floor(targetAbsoluteIndex / PAGE_SIZE);
      const targetIndexInPage = targetAbsoluteIndex - targetPage * PAGE_SIZE;
      await showGalleryPage(bot, repo, ctx, targetPage, gallery?.messageId ?? null, targetIndexInPage);
    } else if (gallery) {
      await renderEmptyGalleryMessage(bot, ctx, gallery.messageId);
      deleteGallerySession(ctx.chat.id, ctx.from.id);
    }

    await ctx.reply(`Фото #${number} видалено. Нумерація оновлена.`, MAIN_MENU);
  }
}

export function registerBotHandlers(bot: Telegraf, repo: BotRepository): void {
  bot.start(async (ctx: any) => {
    resetUserState(ctx.chat.id, ctx.from.id);
    await showMenu(ctx, "Меню фото-бота:");
  });

  bot.command("menu", async (ctx: any) => {
    resetUserState(ctx.chat.id, ctx.from.id);
    await showMenu(ctx);
  });

  bot.command("add", startAddFlow);

  bot.command("gallery", async (ctx: any) => {
    resetUserState(ctx.chat.id, ctx.from.id);
    const existingGallery = getGallerySession(ctx.chat.id, ctx.from.id);
    await showGalleryPage(bot, repo, ctx, existingGallery?.page ?? 0, null, existingGallery?.selectedIndexInPage ?? 0);
  });

  bot.command("delete", async (ctx: any) => {
    await startDeleteFlow(bot, repo, ctx);
  });

  bot.action(/^fav_toggle:(\d+):(\d+)$/, async (ctx: any) => {
    const ownerId = Number(ctx.match[1]);
    const assetId = Number(ctx.match[2]);
    const actorId = Number(ctx.from.id);

    if (actorId !== ownerId) {
      await ctx.answerCbQuery("Це не твоя картка.");
      return;
    }

    try {
      const isFavorite = await repo.toggleFavorite(actorId, assetId);
      const updatedMarkup = buildFavoriteToggleReplyMarkup(ownerId, assetId, isFavorite);
      const inlineMessageId = (ctx.callbackQuery as any)?.inline_message_id;

      if (inlineMessageId) {
        await bot.telegram.editMessageReplyMarkup(undefined, undefined, inlineMessageId, updatedMarkup);
      } else if (ctx.chat && ctx.callbackQuery.message?.message_id) {
        await bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, updatedMarkup);
      }

      await ctx.answerCbQuery(isFavorite ? "Додано в улюблені" : "Видалено з улюблених");
    } catch (error) {
      const message = getErrorText(error).toLowerCase();
      if (message.includes("asset not found")) {
        await ctx.answerCbQuery("Картку не знайдено.");
        return;
      }

      console.error("Favorite toggle callback error:", error);
      await ctx.answerCbQuery("Помилка зміни улюблених.");
    }
  });

  bot.action(/^inline_fav:(\d+):(\d+)$/, async (ctx: any) => {
    const ownerId = Number(ctx.match[1]);
    const assetId = Number(ctx.match[2]);
    const actorId = Number(ctx.from.id);

    if (actorId !== ownerId) {
      await ctx.answerCbQuery("Це не твоя картка.");
      return;
    }

    try {
      const isFavorite = await repo.toggleFavorite(actorId, assetId);
      const updatedMarkup = buildInlineResultReplyMarkup(ownerId, assetId, isFavorite);
      const inlineMessageId = (ctx.callbackQuery as any)?.inline_message_id;

      if (inlineMessageId) {
        await bot.telegram.editMessageReplyMarkup(undefined, undefined, inlineMessageId, updatedMarkup);
      } else if (ctx.chat && ctx.callbackQuery.message?.message_id) {
        await bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, updatedMarkup);
      }

      await ctx.answerCbQuery(isFavorite ? "Додано в улюблені" : "Видалено з улюблених");
    } catch (error) {
      const message = getErrorText(error).toLowerCase();
      if (message.includes("asset not found")) {
        await ctx.answerCbQuery("Картку не знайдено.");
        return;
      }

      console.error("Inline favorite callback error:", error);
      await ctx.answerCbQuery("Помилка зміни улюблених.");
    }
  });

  bot.action(/^inline_nav:(\d+):(\d+):(prev|next)$/, async (ctx: any) => {
    const ownerId = Number(ctx.match[1]);
    const assetId = Number(ctx.match[2]);
    const direction = String(ctx.match[3]);
    const actorId = Number(ctx.from.id);

    if (actorId !== ownerId) {
      await ctx.answerCbQuery("Це не твоя картка.");
      return;
    }

    try {
      const rankedRows = await repo.getRankedInlineRows(ownerId);
      if (!rankedRows.length) {
        await ctx.answerCbQuery("Немає медіа.");
        return;
      }

      const currentIndex = rankedRows.findIndex((row) => row.id === assetId);
      if (currentIndex < 0) {
        await ctx.answerCbQuery("Картку не знайдено.");
        return;
      }

      const step = direction === "prev" ? -1 : 1;
      const nextIndex = (currentIndex + step + rankedRows.length) % rankedRows.length;
      const nextRow = rankedRows[nextIndex];
      const replyMarkup = buildInlineResultReplyMarkup(ownerId, nextRow.id, Boolean(nextRow.is_favorite));
      const inlineMessageId = (ctx.callbackQuery as any)?.inline_message_id;

      if (inlineMessageId) {
        await bot.telegram.editMessageMedia(undefined, undefined, inlineMessageId, buildInputMedia(nextRow, undefined) as any, {
          reply_markup: replyMarkup
        });
      } else if (ctx.chat && ctx.callbackQuery.message?.message_id) {
        await bot.telegram.editMessageMedia(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          undefined,
          buildInputMedia(nextRow, undefined) as any,
          { reply_markup: replyMarkup }
        );
      }

      await ctx.answerCbQuery();
    } catch (error) {
      console.error("Inline nav callback error:", error);
      await ctx.answerCbQuery("Помилка перегортання.");
    }
  });

  bot.action(/^gallery_fav:(\d+):(\d+):(\d+):(\d+)$/, async (ctx: any) => {
    const ownerId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const selectedIndexInPage = Number(ctx.match[3]);
    const assetId = Number(ctx.match[4]);
    const actorId = Number(ctx.from.id);

    if (actorId !== ownerId) {
      await ctx.answerCbQuery("Це не твоя галерея.");
      return;
    }

    const messageId = ctx.callbackQuery.message?.message_id || null;

    try {
      const isFavorite = await repo.toggleFavorite(actorId, assetId);
      await showGalleryPage(bot, repo, ctx, page, messageId, selectedIndexInPage);
      await ctx.answerCbQuery(isFavorite ? "Додано в улюблені" : "Видалено з улюблених");
    } catch (error) {
      const message = getErrorText(error).toLowerCase();
      if (message.includes("asset not found")) {
        await ctx.answerCbQuery("Картку не знайдено.");
        return;
      }

      console.error("Gallery favorite callback error:", error);
      await ctx.answerCbQuery("Помилка зміни улюблених.");
    }
  });

  bot.action(/^gallery_page:(\d+):(\d+)$/, async (ctx: any) => {
    const ownerId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);

    if (ctx.from.id !== ownerId) {
      await ctx.answerCbQuery("Це не твоя галерея.");
      return;
    }

    const messageId = ctx.callbackQuery.message?.message_id || null;

    try {
      const state = getGallerySession(ctx.chat.id, ctx.from.id);
      const selectedIndexInPage = state?.selectedIndexInPage ?? 0;
      await showGalleryPage(bot, repo, ctx, page, messageId, selectedIndexInPage);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error("Gallery callback error:", error);
      await ctx.answerCbQuery("Помилка при перемиканні сторінки.");
    }
  });

  bot.action(/^gallery_pick:(\d+):(\d+):(\d+)$/, async (ctx: any) => {
    const ownerId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const selectedIndexInPage = Number(ctx.match[3]);

    if (ctx.from.id !== ownerId) {
      await ctx.answerCbQuery("Це не твоя галерея.");
      return;
    }

    const messageId = ctx.callbackQuery.message?.message_id || null;

    try {
      await showGalleryPage(bot, repo, ctx, page, messageId, selectedIndexInPage);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error("Gallery pick callback error:", error);
      await ctx.answerCbQuery("Помилка відкриття фото.");
    }
  });

  bot.on("photo", async (ctx: any) => {
    const state = getOrCreateUserState(ctx.chat.id, ctx.from.id);
    const p = pickLargestPhoto(ctx.message.photo);

    if (state.mode === "await_description") {
      await handleIncomingAsset(ctx, {
        fileId: p.file_id,
        fileUniqueId: p.file_unique_id,
        mediaType: "photo"
      });
      return;
    }

    if (state.mode !== "await_photo") {
      await ctx.reply("Щоб додати медіа, обери «Додати фото» або команду /add.", MAIN_MENU);
      return;
    }

    if (ctx.message.media_group_id) {
      const albumKey = `${ctx.chat.id}:${ctx.from.id}:${ctx.message.media_group_id}`;

      if (!getAlbumBuffer(albumKey)) {
        setAlbumBuffer(albumKey, {
          chatId: ctx.chat.id,
          userId: ctx.from.id,
          photos: [],
          timer: null
        });
      }

      const buffer = getAlbumBuffer(albumKey)!;
      buffer.photos.push({ fileId: p.file_id, fileUniqueId: p.file_unique_id, mediaType: "photo" });

      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }

      buffer.timer = setTimeout(() => {
        finalizeAlbumBuffer(bot, albumKey).catch((error) => {
          console.error("Album finalize error:", error);
        });
      }, 700);

      return;
    }

    await handleIncomingAsset(ctx, {
      fileId: p.file_id,
      fileUniqueId: p.file_unique_id,
      mediaType: "photo"
    });
  });

  bot.on("video", async (ctx: any) => {
    const video = ctx.message.video;
    await handleIncomingAsset(ctx, {
      fileId: video.file_id,
      fileUniqueId: video.file_unique_id,
      mediaType: "video"
    });
  });

  bot.on("animation", async (ctx: any) => {
    const animation = ctx.message.animation;
    await handleIncomingAsset(ctx, {
      fileId: animation.file_id,
      fileUniqueId: animation.file_unique_id,
      mediaType: "gif"
    });
  });

  bot.on("text", async (ctx: any) => {
    const text = (ctx.message.text || "").trim();

    if (!text) return;
    if (text.startsWith("/")) return;

    await handleTextFlow(bot, repo, ctx, text);
  });

  bot.on("inline_query", async (ctx: any) => {
    const rawQuery = ctx.inlineQuery.query || "";
    const filters = parseInlineQueryFilters(rawQuery);
    const userId = ctx.from.id;

    const sourceRows = await repo.getRecentPhotos(userId, INLINE_FETCH_LIMIT);
    const rowsWithFavorites = await repo.applyFavoriteFlags(userId, sourceRows);
    const rows = sortInlineRows(filterRowsByQuery(rowsWithFavorites, filters), filters.searchText).slice(0, INLINE_RESULT_LIMIT);

    console.log(`[inline_query] user=${userId} query="${rawQuery}" results=${rows.length}`);

    if (!rows.length) {
      await ctx.answerInlineQuery([], {
        cache_time: 0,
        is_personal: true
      });
      return;
    }

    const results = rows.map((r) => buildInlineResult(r, userId));

    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
  });

  bot.on("chosen_inline_result", async (ctx: any) => {
    const resultId = String(ctx.chosenInlineResult?.result_id || "");
    const query = String(ctx.chosenInlineResult?.query || "");
    const userId = Number(ctx.from?.id || 0);

    if (!resultId || !userId) return;

    try {
      await repo.trackChosenInlineResult(userId, resultId, query);
    } catch (error) {
      console.error("Failed to track chosen_inline_result:", error);
    }
  });
}


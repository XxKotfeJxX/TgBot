import { PAGE_SIZE } from "./constants";
import { buildInlineResultId } from "./inline-id";
import { normalizeMediaType, toEditMediaType } from "./media";
import { trimCaption } from "./text";
import type { MediaType, PhotoRow } from "./types";

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

type InlineKeyboard = InlineKeyboardButton[][];

export function buildInputMedia(row: PhotoRow, caption?: string): Record<string, unknown> {
  return {
    type: toEditMediaType(normalizeMediaType(row.media_type)),
    media: row.file_id,
    ...(caption ? { caption } : {})
  };
}

export function buildFavoriteToggleReplyMarkup(ownerId: number, assetId: number, isFavorite: boolean): { inline_keyboard: InlineKeyboard } {
  return {
    inline_keyboard: [
      [
        {
          text: isFavorite ? "✅ В улюблених" : "★ Додати",
          callback_data: `fav_toggle:${ownerId}:${assetId}`
        }
      ]
    ]
  };
}

export function buildInlineResultReplyMarkup(ownerId: number, assetId: number, isFavorite: boolean): { inline_keyboard: InlineKeyboard } {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: `inline_nav:${ownerId}:${assetId}:prev` },
        { text: isFavorite ? "✅" : "★", callback_data: `inline_fav:${ownerId}:${assetId}` },
        { text: "➡️", callback_data: `inline_nav:${ownerId}:${assetId}:next` }
      ]
    ]
  };
}

export function buildInlineResult(row: PhotoRow, ownerId: number): Record<string, unknown> {
  const mediaType = normalizeMediaType(row.media_type);
  const id = buildInlineResultId(mediaType, row.id);
  void ownerId;

  if (mediaType === "video") {
    return {
      type: "video",
      id,
      video_file_id: row.file_id,
      title: trimCaption(row.description, 60)
    };
  }

  if (mediaType === "gif") {
    return {
      type: "gif",
      id,
      gif_file_id: row.file_id
    };
  }

  return {
    type: "photo",
    id,
    photo_file_id: row.file_id
  };
}

export function buildGalleryReplyMarkup(
  userId: number,
  page: number,
  totalPages: number,
  rowsOnPage: PhotoRow[],
  selectedIndexInPage: number,
  pageSize = PAGE_SIZE
): { inline_keyboard: InlineKeyboard } {
  const rows: InlineKeyboard = [];
  const selectedRow = rowsOnPage[selectedIndexInPage];

  if (selectedRow) {
    rows.push([
      {
        text: selectedRow.is_favorite ? "✅ В улюблених" : "★ Додати в улюблені",
        callback_data: `gallery_fav:${userId}:${page}:${selectedIndexInPage}:${selectedRow.id}`
      }
    ]);
  }

  const numberButtons = Array.from({ length: rowsOnPage.length }, (_, index) => {
    const number = page * pageSize + index + 1;
    return {
      text: String(number),
      callback_data: `gallery_pick:${userId}:${page}:${index}`
    };
  });

  for (let i = 0; i < numberButtons.length; i += 5) {
    rows.push(numberButtons.slice(i, i + 5));
  }

  if (totalPages > 1) {
    const navButtons: InlineKeyboardButton[] = [];
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

export function buildGalleryCaption(
  row: PhotoRow,
  absoluteNumber: number,
  total: number,
  page: number,
  totalPages: number
): string {
  return [`#${absoluteNumber}`, trimCaption(row.description), "", `Сторінка ${page + 1}/${totalPages} • Усього: ${total}`].join(
    "\n"
  );
}

export function toSendMethod(mediaType: MediaType): "sendPhoto" | "sendVideo" | "sendAnimation" {
  if (mediaType === "video") return "sendVideo";
  if (mediaType === "gif") return "sendAnimation";
  return "sendPhoto";
}

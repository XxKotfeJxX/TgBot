import type { BotCommandDefinition, MediaType } from "./types";

export const PAGE_SIZE = 10;
export const INLINE_FETCH_LIMIT = 400;
export const INLINE_RESULT_LIMIT = 50;
export const INLINE_RECENT_BLOCK_SIZE = 3;
export const POP_SCORE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export const MEDIA_TYPES: MediaType[] = ["photo", "video", "gif"];

export const BUTTON_ADD = "Додати фото";
export const BUTTON_VIEW = "Переглянути фото";
export const BUTTON_DELETE = "Видалити фото";

export const MAIN_MENU_REPLY_MARKUP = {
  keyboard: [[{ text: BUTTON_ADD }, { text: BUTTON_VIEW }], [{ text: BUTTON_DELETE }]],
  resize_keyboard: true
};

export const BOT_COMMANDS: BotCommandDefinition[] = [
  { command: "start", description: "Відкрити меню" },
  { command: "menu", description: "Показати меню" },
  { command: "add", description: "Додати фото" },
  { command: "gallery", description: "Переглянути фото" },
  { command: "delete", description: "Видалити фото за номером" }
];

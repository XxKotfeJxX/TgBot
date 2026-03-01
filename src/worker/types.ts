import type { PendingPhoto, SessionMode } from "../core";

export interface Env {
  BOT_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WEBHOOK_SECRET?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_PATH?: string;
}

export interface BotSession {
  userId: number;
  chatId: number;
  mode: SessionMode;
  pendingPhotos: PendingPhoto[];
  galleryPage: number;
  gallerySelected: number;
  galleryMessageId: number | null;
}

export interface TelegramUser {
  id: number;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
}

export interface TelegramFileMedia {
  file_id: string;
  file_unique_id: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramFileMedia;
  animation?: TelegramFileMedia;
  media_group_id?: string;
}

export interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
}

export interface TelegramChosenInlineResult {
  result_id: string;
  from: TelegramUser;
  query?: string;
  inline_message_id?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  inline_message_id?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  message?: TelegramMessage;
  inline_query?: TelegramInlineQuery;
  chosen_inline_result?: TelegramChosenInlineResult;
  callback_query?: TelegramCallbackQuery;
}

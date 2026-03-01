import type { MediaType } from "./types";

export interface TelegramFileSize {
  file_id: string;
  file_unique_id: string;
}

export function normalizeMediaType(value: unknown): MediaType {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "video") return "video";
  if (normalized === "gif") return "gif";
  return "photo";
}

export function pickLargestPhoto<T extends TelegramFileSize>(photos: T[]): T {
  return photos[photos.length - 1];
}

export function toEditMediaType(mediaType: MediaType): "photo" | "video" | "animation" {
  if (mediaType === "video") return "video";
  if (mediaType === "gif") return "animation";
  return "photo";
}

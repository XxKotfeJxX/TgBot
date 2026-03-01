import type { MediaType } from "./types";

export function buildInlineResultId(mediaType: MediaType, assetId: number): string {
  return `${mediaType}:${assetId}`;
}

export function parseMediaTypeFromInlineResultId(resultId: string): MediaType {
  const prefix = String(resultId || "").split(":")[0].toLowerCase();
  if (prefix === "video") return "video";
  if (prefix === "gif") return "gif";
  return "photo";
}

export function parseAssetIdFromInlineResultId(resultId: string): number | null {
  const raw = String(resultId || "").split(":")[1] || "";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

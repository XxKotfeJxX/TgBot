import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INLINE_FETCH_LIMIT,
  computeDecayedPopScore,
  normalizeMediaType,
  normalizePendingPhotos,
  parseAssetIdFromInlineResultId,
  parseMediaTypeFromInlineResultId,
  sortInlineRows,
  type InsertBatchResult,
  type PendingPhoto,
  type PhotoRow,
  type SessionMode
} from "../core";
import type { BotSession, TelegramChosenInlineResult } from "./types";

export function defaultSession(userId: number, chatId: number): BotSession {
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
      return {
        fileId: String(row.fileId),
        fileUniqueId: String(row.fileUniqueId),
        mediaType: normalizeMediaType((row as any).mediaType)
      };
    })
    .filter(Boolean) as PendingPhoto[];
}

export async function loadSession(client: SupabaseClient, userId: number, chatId: number): Promise<BotSession> {
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

export async function saveSession(client: SupabaseClient, session: BotSession): Promise<void> {
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

function isMissingColumnError(error: unknown, columnName: string): boolean {
  const message = String((error as { message?: string })?.message || error || "").toLowerCase();
  return message.includes(columnName.toLowerCase()) && message.includes("does not exist");
}

function isMissingMediaTypeColumnError(error: unknown): boolean {
  return isMissingColumnError(error, "media_type");
}

function isMissingUsageColumnsError(error: unknown): boolean {
  return isMissingColumnError(error, "pop_score") || isMissingColumnError(error, "last_used_at");
}

function isMissingFavoritesTableError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error || "").toLowerCase();
  return message.includes("favorites") && message.includes("does not exist");
}

export async function getPhotosCount(client: SupabaseClient, userId: number): Promise<number> {
  const { count, error } = await client
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (error) {
    throw new Error(`getPhotosCount failed: ${error.message}`);
  }

  return Number(count || 0);
}

export async function getPhotosPage(
  client: SupabaseClient,
  userId: number,
  limit: number,
  offset: number
): Promise<PhotoRow[]> {
  const withType = await client
    .from("photos")
    .select("id,file_id,description,media_type")
    .eq("user_id", userId)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (!withType.error) {
    return (withType.data || []).map((row) => ({
      id: Number(row.id),
      file_id: String(row.file_id),
      description: String(row.description || ""),
      media_type: normalizeMediaType((row as any).media_type)
    }));
  }

  if (!isMissingMediaTypeColumnError(withType.error)) {
    throw new Error(`getPhotosPage failed: ${withType.error.message}`);
  }

  const legacy = await client
    .from("photos")
    .select("id,file_id,description")
    .eq("user_id", userId)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (legacy.error) {
    throw new Error(`getPhotosPage failed: ${legacy.error.message}`);
  }

  return (legacy.data || []).map((row) => ({
    id: Number(row.id),
    file_id: String(row.file_id),
    description: String(row.description || ""),
    media_type: "photo",
    pop_score: 0,
    last_used_at: null
  }));
}

export async function getPhotoByNumber(client: SupabaseClient, userId: number, offset: number): Promise<PhotoRow | undefined> {
  const withType = await client
    .from("photos")
    .select("id,file_id,description,media_type")
    .eq("user_id", userId)
    .order("id", { ascending: true })
    .range(offset, offset)
    .maybeSingle();

  if (!withType.error) {
    const data = withType.data;
    if (!data) return undefined;
    return {
      id: Number(data.id),
      file_id: String(data.file_id),
      description: String(data.description || ""),
      media_type: normalizeMediaType((data as any).media_type)
    };
  }

  if (!isMissingMediaTypeColumnError(withType.error)) {
    throw new Error(`getPhotoByNumber failed: ${withType.error.message}`);
  }

  const legacy = await client
    .from("photos")
    .select("id,file_id,description")
    .eq("user_id", userId)
    .order("id", { ascending: true })
    .range(offset, offset)
    .maybeSingle();

  if (legacy.error) {
    throw new Error(`getPhotoByNumber failed: ${legacy.error.message}`);
  }

  if (!legacy.data) return undefined;

  return {
    id: Number(legacy.data.id),
    file_id: String(legacy.data.file_id),
    description: String(legacy.data.description || ""),
    media_type: "photo"
  };
}

export async function deletePhotoById(client: SupabaseClient, userId: number, photoId: number): Promise<void> {
  const { error } = await client.from("photos").delete().eq("id", photoId).eq("user_id", userId);
  if (error) {
    throw new Error(`deletePhotoById failed: ${error.message}`);
  }
}

export async function loadFavoriteAssetIdSet(
  client: SupabaseClient,
  userId: number,
  assetIds: number[]
): Promise<Set<number>> {
  if (!assetIds.length) return new Set<number>();

  const { data, error } = await client.from("favorites").select("asset_id").eq("user_id", userId).in("asset_id", assetIds);
  if (error) {
    if (isMissingFavoritesTableError(error)) {
      console.warn("favorites table is missing; favorites are disabled until schema migration");
      return new Set<number>();
    }
    throw new Error(`loadFavoriteAssetIdSet failed: ${error.message}`);
  }

  return new Set((data || []).map((row: any) => Number(row.asset_id)));
}

export async function applyFavoriteFlags(client: SupabaseClient, userId: number, rows: PhotoRow[]): Promise<PhotoRow[]> {
  const favoriteIds = await loadFavoriteAssetIdSet(
    client,
    userId,
    rows.map((row) => row.id)
  );

  return rows.map((row) => ({
    ...row,
    is_favorite: favoriteIds.has(row.id)
  }));
}

export async function toggleFavorite(client: SupabaseClient, userId: number, assetId: number): Promise<boolean> {
  const { data: ownedAsset, error: ownedAssetError } = await client
    .from("photos")
    .select("id")
    .eq("id", assetId)
    .eq("user_id", userId)
    .maybeSingle();

  if (ownedAssetError) {
    throw new Error(`toggleFavorite(ownedAsset) failed: ${ownedAssetError.message}`);
  }

  if (!ownedAsset) {
    throw new Error("Asset not found");
  }

  const { data: existing, error: existingError } = await client
    .from("favorites")
    .select("asset_id")
    .eq("user_id", userId)
    .eq("asset_id", assetId)
    .maybeSingle();

  if (existingError) {
    if (isMissingFavoritesTableError(existingError)) {
      throw new Error("Favorites schema is missing");
    }
    throw new Error(`toggleFavorite(existing) failed: ${existingError.message}`);
  }

  if (existing) {
    const { error: deleteError } = await client
      .from("favorites")
      .delete()
      .eq("user_id", userId)
      .eq("asset_id", assetId);

    if (deleteError) {
      throw new Error(`toggleFavorite(delete) failed: ${deleteError.message}`);
    }
    return false;
  }

  const { error: insertError } = await client.from("favorites").insert({
    user_id: userId,
    asset_id: assetId
  });

  if (insertError) {
    if (isMissingFavoritesTableError(insertError)) {
      throw new Error("Favorites schema is missing");
    }
    throw new Error(`toggleFavorite(insert) failed: ${insertError.message}`);
  }

  return true;
}

export async function getRecentPhotos(client: SupabaseClient, userId: number, limit: number): Promise<PhotoRow[]> {
  const withType = await client
    .from("photos")
    .select("id,file_id,description,media_type,pop_score,last_used_at")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(limit);

  if (!withType.error) {
    return (withType.data || []).map((row) => ({
      id: Number(row.id),
      file_id: String(row.file_id),
      description: String(row.description || ""),
      media_type: normalizeMediaType((row as any).media_type),
      pop_score: Number((row as any).pop_score || 0),
      last_used_at: ((row as any).last_used_at as string | null) || null
    }));
  }

  if (!isMissingMediaTypeColumnError(withType.error) && !isMissingUsageColumnsError(withType.error)) {
    throw new Error(`getRecentPhotos failed: ${withType.error.message}`);
  }

  const legacy = await client
    .from("photos")
    .select("id,file_id,description")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(limit);

  if (legacy.error) {
    throw new Error(`getRecentPhotos failed: ${legacy.error.message}`);
  }

  return (legacy.data || []).map((row) => ({
    id: Number(row.id),
    file_id: String(row.file_id),
    description: String(row.description || ""),
    media_type: "photo"
  }));
}

export async function getRankedInlineRows(client: SupabaseClient, userId: number): Promise<PhotoRow[]> {
  const sourceRows = await getRecentPhotos(client, userId, INLINE_FETCH_LIMIT);
  const rowsWithFavorites = await applyFavoriteFlags(client, userId, sourceRows);
  return sortInlineRows(rowsWithFavorites, "");
}

export async function insertPhotosWithDescription(
  client: SupabaseClient,
  userId: number,
  photos: PendingPhoto[],
  description: string
): Promise<InsertBatchResult> {
  const uniquePhotos = normalizePendingPhotos(photos);
  if (!uniquePhotos.length) return { saved: 0, skipped: 0, savedAssets: [] };

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
      media_type: p.mediaType,
      description
    }));

    const { data: inserted, error: insertError } = await client.from("photos").insert(rows).select("id,file_id,media_type");
    if (insertError) {
      if (isMissingMediaTypeColumnError(insertError)) {
        throw new Error("DB schema is outdated: run migration to add photos.media_type");
      }
      throw new Error(`insertPhotosWithDescription(insert) failed: ${insertError.message}`);
    }

    return {
      saved: toInsert.length,
      skipped: uniquePhotos.length - toInsert.length,
      savedAssets: (inserted || []).map((row: any) => ({
        id: Number(row.id),
        fileId: String(row.file_id),
        mediaType: normalizeMediaType((row as any).media_type)
      }))
    };
  }

  return {
    saved: 0,
    skipped: uniquePhotos.length,
    savedAssets: []
  };
}

async function applyInlineUsageToAsset(client: SupabaseClient, userId: number, assetId: number): Promise<void> {
  const { data, error } = await client
    .from("photos")
    .select("id,pop_score,last_used_at")
    .eq("id", assetId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (isMissingUsageColumnsError(error)) {
      console.warn("usage columns are missing; pop_score update skipped");
      return;
    }
    throw new Error(`applyInlineUsageToAsset(select) failed: ${error.message}`);
  }

  if (!data) {
    return;
  }

  const nowIso = new Date().toISOString();
  const newScore = computeDecayedPopScore(Number((data as any).pop_score || 0), (data as any).last_used_at || null);

  const { error: updateError } = await client
    .from("photos")
    .update({
      pop_score: newScore,
      last_used_at: nowIso
    })
    .eq("id", assetId)
    .eq("user_id", userId);

  if (updateError) {
    if (isMissingUsageColumnsError(updateError)) {
      console.warn("usage columns are missing; pop_score update skipped");
      return;
    }
    throw new Error(`applyInlineUsageToAsset(update) failed: ${updateError.message}`);
  }
}

export async function trackChosenInlineResult(
  client: SupabaseClient,
  chosenInlineResult: TelegramChosenInlineResult
): Promise<void> {
  const resultId = String(chosenInlineResult.result_id || "");
  const userId = chosenInlineResult.from.id;
  const assetId = parseAssetIdFromInlineResultId(resultId);

  if (assetId) {
    await applyInlineUsageToAsset(client, userId, assetId);
  }

  const payload = {
    user_id: userId,
    result_id: resultId,
    media_type: parseMediaTypeFromInlineResultId(resultId),
    query: String(chosenInlineResult.query || "")
  };

  const { error } = await client.from("inline_usage").insert(payload);
  if (error) {
    const message = String(error.message || "");
    if (message.toLowerCase().includes("inline_usage") && message.toLowerCase().includes("does not exist")) {
      console.warn("inline_usage table is missing; chosen_inline_result is not persisted");
      return;
    }
    throw new Error(`trackChosenInlineResult failed: ${error.message}`);
  }
}

export type SessionMode = "idle" | "await_photo" | "await_description" | "await_delete_number";
export type MediaType = "photo" | "video" | "gif";

export interface PendingPhoto {
  fileId: string;
  fileUniqueId: string;
  mediaType: MediaType;
}

export interface PhotoRow {
  id: number;
  file_id: string;
  description: string;
  media_type?: MediaType;
  is_favorite?: boolean;
  pop_score?: number;
  last_used_at?: string | null;
  file_unique_id?: string;
}

export interface SavedAsset {
  id: number;
  fileId: string;
  mediaType: MediaType;
}

export interface InsertBatchResult {
  saved: number;
  skipped: number;
  savedAssets: SavedAsset[];
}

export interface InlineQueryFilters {
  searchText: string;
  mediaTypes: Set<MediaType>;
}

export interface BotCommandDefinition {
  command: string;
  description: string;
}

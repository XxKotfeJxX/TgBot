import { normalizePendingPhotos, type PendingPhoto, type SessionMode } from "../core";

export interface UserSession {
  mode: SessionMode;
  pendingPhotos: PendingPhoto[];
}

export interface GallerySession {
  messageId: number;
  page: number;
  selectedIndexInPage: number;
}

export interface AlbumBufferSession {
  chatId: number;
  userId: number;
  photos: PendingPhoto[];
  timer: NodeJS.Timeout | null;
}

const userState = new Map<string, UserSession>();
const galleryState = new Map<string, GallerySession>();
const albumBuffer = new Map<string, AlbumBufferSession>();

export function getSessionKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function getOrCreateUserState(chatId: number, userId: number): UserSession {
  const key = getSessionKey(chatId, userId);
  if (!userState.has(key)) {
    userState.set(key, { mode: "idle", pendingPhotos: [] });
  }
  return userState.get(key)!;
}

export function resetUserState(chatId: number, userId: number): void {
  userState.set(getSessionKey(chatId, userId), { mode: "idle", pendingPhotos: [] });
}

export function getGallerySession(chatId: number, userId: number): GallerySession | undefined {
  return galleryState.get(getSessionKey(chatId, userId));
}

export function setGallerySession(chatId: number, userId: number, data: GallerySession): void {
  galleryState.set(getSessionKey(chatId, userId), data);
}

export function deleteGallerySession(chatId: number, userId: number): void {
  galleryState.delete(getSessionKey(chatId, userId));
}

export function getAlbumBuffer(albumKey: string): AlbumBufferSession | undefined {
  return albumBuffer.get(albumKey);
}

export function setAlbumBuffer(albumKey: string, value: AlbumBufferSession): void {
  albumBuffer.set(albumKey, value);
}

export function deleteAlbumBuffer(albumKey: string): void {
  albumBuffer.delete(albumKey);
}

export function normalizeAlbumPhotos(photos: PendingPhoto[]): PendingPhoto[] {
  return normalizePendingPhotos(photos);
}

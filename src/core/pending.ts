import type { PendingPhoto } from "./types";

export function normalizePendingPhotos(photos: PendingPhoto[]): PendingPhoto[] {
  const seen = new Set<string>();
  const unique: PendingPhoto[] = [];

  for (const photo of photos) {
    if (seen.has(photo.fileUniqueId)) continue;
    seen.add(photo.fileUniqueId);
    unique.push(photo);
  }

  return unique;
}

export function addPendingPhoto(photos: PendingPhoto[], photo: PendingPhoto): PendingPhoto[] {
  if (photos.some((item) => item.fileUniqueId === photo.fileUniqueId)) {
    return photos;
  }
  return [...photos, photo];
}

export function getErrorText(error: unknown): string {
  const value = error as { response?: { description?: string }; description?: string; message?: string };
  return String(value?.response?.description || value?.description || value?.message || error || "");
}

export function isMessageNotModifiedError(error: unknown): boolean {
  const message = getErrorText(error).toLowerCase();
  return message.includes("message is not modified");
}

export function isInvalidPhotoReferenceError(error: unknown): boolean {
  const message = getErrorText(error).toLowerCase();
  return (
    message.includes("wrong file identifier") ||
    message.includes("wrong remote file id specified") ||
    message.includes("invalid file id") ||
    message.includes("file reference expired")
  );
}

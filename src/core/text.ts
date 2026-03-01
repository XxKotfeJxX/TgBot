export function trimCaption(text: string, max = 980): string {
  const value = (text || "").trim();
  if (!value) return "(без опису)";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function normalizeSearchText(value: string): string {
  return (value || "").toLocaleLowerCase("uk-UA").replace(/\s+/g, " ").trim();
}

export function parseSearchTokens(searchText: string): string[] {
  return normalizeSearchText(searchText).split(" ").filter(Boolean);
}

export function extractNormalizedTags(text: string): string[] {
  const matches = String(text || "").match(/#[^\s#]+/g) || [];
  const tags = matches
    .map((tag) => normalizeSearchText(tag.replace(/^#/, "")))
    .filter(Boolean);
  return Array.from(new Set(tags));
}

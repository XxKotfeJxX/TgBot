import { INLINE_RECENT_BLOCK_SIZE, POP_SCORE_HALF_LIFE_MS } from "./constants";
import { normalizeMediaType } from "./media";
import { extractNormalizedTags, normalizeSearchText, parseSearchTokens } from "./text";
import type { InlineQueryFilters, PhotoRow } from "./types";

export function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getPopScore(row: PhotoRow): number {
  const score = Number(row.pop_score || 0);
  return Number.isFinite(score) ? score : 0;
}

export function computeDecayedPopScore(
  currentScore: number,
  lastUsedAt: string | null | undefined,
  nowMs = Date.now()
): number {
  if (!currentScore) return 1;
  const lastMs = toTimestamp(lastUsedAt);
  if (!lastMs || lastMs >= nowMs) return currentScore + 1;
  const deltaMs = nowMs - lastMs;
  const decayFactor = Math.pow(0.5, deltaMs / POP_SCORE_HALF_LIFE_MS);
  return currentScore * decayFactor + 1;
}

export function computeRelevanceScore(row: PhotoRow, searchText: string): number {
  const tokens = parseSearchTokens(searchText);
  if (!tokens.length) return 0;

  const description = normalizeSearchText(row.description);
  const tags = extractNormalizedTags(row.description);
  let score = 0;

  for (const token of tokens) {
    if (token.startsWith("#")) {
      const wantedTag = token.slice(1);
      const tagScore = tags.reduce((acc, tag) => {
        if (tag === wantedTag) return acc + 8;
        if (tag.includes(wantedTag)) return acc + 3;
        return acc;
      }, 0);
      score += tagScore;
      continue;
    }

    let fromDescription = 0;
    let fromIndex = 0;
    while (true) {
      const index = description.indexOf(token, fromIndex);
      if (index < 0) break;
      fromDescription += 1;
      fromIndex = index + token.length;
    }

    const fromTags = tags.reduce((acc, tag) => (tag.includes(token) ? acc + 2 : acc), 0);
    score += fromDescription + fromTags;
  }

  return score;
}

export function filterRowsByQuery(rows: PhotoRow[], filters: InlineQueryFilters): PhotoRow[] {
  const typeFilteredRows = rows.filter((row) => filters.mediaTypes.has(normalizeMediaType(row.media_type)));
  const normalizedQuery = normalizeSearchText(filters.searchText);
  if (!normalizedQuery) return typeFilteredRows;

  const tokens = parseSearchTokens(normalizedQuery);
  if (!tokens.length) return typeFilteredRows;

  return typeFilteredRows.filter((row) => {
    const description = normalizeSearchText(row.description);
    const tags = extractNormalizedTags(row.description);

    return tokens.every((token) => {
      if (token.startsWith("#")) {
        const wantedTag = token.slice(1);
        return tags.some((tag) => tag.includes(wantedTag));
      }

      return description.includes(token) || tags.some((tag) => tag.includes(token));
    });
  });
}

export function sortInlineRows(rows: PhotoRow[], searchText: string): PhotoRow[] {
  const recentRows = rows
    .filter((row) => toTimestamp(row.last_used_at) > 0)
    .sort((left, right) => toTimestamp(right.last_used_at) - toTimestamp(left.last_used_at))
    .slice(0, INLINE_RECENT_BLOCK_SIZE);
  const recentRank = new Map<number, number>(recentRows.map((row, index) => [row.id, index]));
  const relevance = new Map<number, number>(rows.map((row) => [row.id, computeRelevanceScore(row, searchText)]));

  return [...rows].sort((left, right) => {
    const favoriteDelta = Number(Boolean(right.is_favorite)) - Number(Boolean(left.is_favorite));
    if (favoriteDelta !== 0) return favoriteDelta;

    const leftRecent = recentRank.has(left.id);
    const rightRecent = recentRank.has(right.id);
    if (leftRecent !== rightRecent) return leftRecent ? -1 : 1;

    if (leftRecent && rightRecent) {
      const recentDelta = Number(recentRank.get(left.id)) - Number(recentRank.get(right.id));
      if (recentDelta !== 0) return recentDelta;
    }

    const popDelta = getPopScore(right) - getPopScore(left);
    if (popDelta !== 0) return popDelta;

    const usedDelta = toTimestamp(right.last_used_at) - toTimestamp(left.last_used_at);
    if (usedDelta !== 0) return usedDelta;

    const relevanceDelta = Number(relevance.get(right.id) || 0) - Number(relevance.get(left.id) || 0);
    if (relevanceDelta !== 0) return relevanceDelta;

    return right.id - left.id;
  });
}

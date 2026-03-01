import { MEDIA_TYPES } from "./constants";
import { normalizeSearchText } from "./text";
import type { InlineQueryFilters, MediaType } from "./types";

export function parseInlineQueryFilters(query: string): InlineQueryFilters {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  const explicitTypes = new Set<MediaType>();
  let cursor = 0;

  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === "-p") {
      explicitTypes.add("photo");
      cursor += 1;
      continue;
    }
    if (token === "-v") {
      explicitTypes.add("video");
      cursor += 1;
      continue;
    }
    if (token === "-g") {
      explicitTypes.add("gif");
      cursor += 1;
      continue;
    }
    break;
  }

  return {
    searchText: tokens.slice(cursor).join(" "),
    mediaTypes: explicitTypes.size ? explicitTypes : new Set<MediaType>(MEDIA_TYPES)
  };
}

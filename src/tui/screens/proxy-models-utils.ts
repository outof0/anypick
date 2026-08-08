const MAX_VISIBLE = 9;

/**
 * Rank + filter suggestions for autocomplete.
 *
 * Prefer prefix matches, then substring. Within a tier the *incoming* order
 * wins, because the suggestion list arrives newest-first (a catalog's
 * `roleFriendlyModels`, or a proxy's `/v1/models`). Sorting alphabetically
 * instead put `claude-opus-4-6` above `claude-opus-5`, so the fastest possible
 * keypress — type a prefix, press enter — picked the oldest matching model.
 */
export function filterModelSuggestions(suggestions: string[], draft: string): string[] {
  const q = draft.trim().toLowerCase();
  const rank = new Map(suggestions.map((s, i) => [s, i]));
  const byInput = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  if (!q) {
    // Bare ids before `vendor/slug` aliases; otherwise keep the given order.
    return [...suggestions]
      .toSorted((a, b) => {
        const as = a.includes('/') ? 1 : 0;
        const bs = b.includes('/') ? 1 : 0;
        return as !== bs ? as - bs : byInput(a, b);
      })
      .slice(0, MAX_VISIBLE);
  }

  const scored: Array<{ s: string; score: number }> = [];
  for (const s of suggestions) {
    const lower = s.toLowerCase();
    let score = -1;
    if (lower === q) {
      score = 0;
    } else if (lower.startsWith(q)) {
      score = 1;
    } else if (lower.includes(q)) {
      score = 2 + lower.indexOf(q) / 100;
    } else {
      const parts = lower.split(/[/._-]+/);
      if (parts.some((p) => p.startsWith(q) || p.includes(q))) {
        score = 3;
      }
    }
    if (score >= 0) {
      scored.push({ s, score });
    }
  }
  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : byInput(a.s, b.s)));
  return scored.slice(0, MAX_VISIBLE).map((x) => x.s);
}

/** Longest common prefix of strings. */
export function commonPrefix(items: string[]): string {
  if (items.length === 0) {
    return '';
  }
  let prefix = items[0];
  for (let i = 1; i < items.length; i++) {
    const s = items[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (!prefix) {
      break;
    }
  }
  return prefix;
}

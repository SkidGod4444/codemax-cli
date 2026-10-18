/**
 * Model menus list exactly what the agent offers, newest first: "Default" /
 * "Auto" stay on top, then models by the version in their name ("Opus 5.5"
 * before "Opus 4.6", "GPT-6.1" before "GPT-5.6"); equal versions keep the
 * agent's own order.
 */
export interface ModelEntry {
  id: string;
  name: string;
}

const PINNED = /^(default|auto)\b/i;

/** "Opus 5.5" → 5.5, "GPT-6.1-Sol" → 6.1, "claude-opus-4-7" → 4.7, "Sonnet 5" → 5; none → undefined. */
export function modelVersion(m: ModelEntry): number | undefined {
  for (const s of [m.name, m.id]) {
    // Skip date stamps like 20251001; a version is a small major with an optional minor.
    const hit = s.match(/(?:^|[^\d])(\d{1,2})(?:[.-](\d{1,2}))?(?=$|[^\d])/);
    if (hit) return Number(hit[1]) + (hit[2] ? Number(hit[2]) / 100 : 0);
  }
  return undefined;
}

export function sortModels<T extends ModelEntry>(models: T[]): T[] {
  return models
    .map((m, i) => ({ m, i, pinned: PINNED.test(m.name) || PINNED.test(m.id), v: modelVersion(m) }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.v !== b.v) return (b.v ?? -1) - (a.v ?? -1);
      return a.i - b.i;
    })
    .map((x) => x.m);
}

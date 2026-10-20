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

/**
 * The one way a model is shown anywhere in codemax: the agent's own display name
 * ("Opus 5.5"), never its id ("opus", "claude-opus-5-5"). When the agent's list
 * does not have the id (a model reported in usage, a saved side-agent model), a
 * Claude id is spelled out the same way ("claude-opus-5-5" → "Opus 5.5").
 */
export function displayModelName(id: string | undefined, models: ModelEntry[] = []): string {
  if (!id) return "Default";
  // Cursor appends settings in brackets: "claude-opus-5-5[context=300k,effort=medium]".
  const bare = id.replace(/\[.*\]$/, "").replace(/^(anthropic|openai|xai|google|opencode)\//, "");
  const listed = models.find((m) => m.id === id) ?? models.find((m) => m.id === bare);
  const tidy = (n: string) => n.replace(/\s*\((recommended|default)\)\s*$/i, "");
  if (listed && listed.name && listed.name !== listed.id) return tidy(listed.name);
  if (!bare || /^(default|auto)$/i.test(bare)) return bare.toLowerCase() === "auto" ? "Auto" : "Default";
  // "claude-opus-4-6" and the older order "claude-3-5-sonnet-20241022".
  const older = bare.match(/^claude-(\d{1,2})(?:[-.](\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8}|-latest)?$/i);
  const claude = older ? [bare, older[3]!, older[1]!, older[2]] as RegExpMatchArray : bare.match(/^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?:[-.](\d{1,2}))?)?(?:-\d{8})?$/i);
  if (claude) {
    const family = claude[1]![0]!.toUpperCase() + claude[1]!.slice(1).toLowerCase();
    if (claude[2]) return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
    // A bare alias ("opus"): the listed model of that family names its version.
    const sameFamily = sortModels(models).find((m) => new RegExp(`^${family}\\b`, "i").test(m.name));
    return sameFamily ? tidy(sameFamily.name) : family;
  }
  return listed?.name ?? bare;
}

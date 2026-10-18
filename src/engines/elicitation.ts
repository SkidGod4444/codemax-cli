import type { QuestionAnswer, QuestionField, QuestionRequest } from "./types.ts";

/**
 * ACP form elicitations → questions codemax can ask in its own dialog.
 *
 * Agents ask through a JSON-schema form (`requestedSchema`). The Claude
 * adapter uses it for AskUserQuestion: one `question_<n>` field per question
 * (a `oneOf` pick, or an array of `anyOf` picks for multi-select) followed by
 * a free-text `question_<n>_custom` "Other" field. MCP servers and other
 * agents may send any flat schema, so every property type is handled; an
 * unknown one is asked as text.
 */
export function parseElicitation(id: string, p: any): QuestionRequest {
  const schema = p?.requestedSchema ?? {};
  const props: Record<string, any> = schema.properties ?? {};
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const keys = Object.keys(props);
  const isSelect = (k: string) => !!props[k] && (opts(props[k]).length > 0 || props[k].type === "boolean");
  // `<key>_custom` (the adapter's per-question "Other" box) folds into its question.
  const companion = (k: string) => k.endsWith("_custom") && isSelect(k.slice(0, -"_custom".length)) && (props[k]?.type ?? "string") === "string";
  const fields: QuestionField[] = [];
  for (const key of keys) {
    if (companion(key)) continue;
    const s = props[key] ?? {};
    const options = opts(s);
    const kind: QuestionField["kind"] = s.type === "array" ? "multi" : s.type === "boolean" ? "boolean" : options.length ? "single" : s.type === "number" || s.type === "integer" ? "number" : "text";
    const other = keys.find((k) => k === `${key}_custom`);
    fields.push({
      key,
      title: str(s.title),
      question: str(s.description) ?? (keys.filter((k) => !companion(k)).length === 1 ? String(p?.message ?? "") : str(s.title) ?? key),
      kind,
      options: kind === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : options,
      otherKey: other && kind !== "boolean" ? other : undefined,
      required: required.has(key),
      integer: s.type === "integer" || undefined,
    });
  }
  return { id, message: String(p?.message ?? ""), fields, toolCallId: p?.toolCallId };
}

/** The ACP response for an answer (`content` keys are the schema's property names). */
export function elicitationResponse(a: QuestionAnswer): { action: string; content?: Record<string, unknown> } {
  return a.action === "accept" ? { action: "accept", content: a.content } : { action: a.action };
}

function opts(s: any): { value: string; label: string; description?: string }[] {
  const list = s?.oneOf ?? s?.anyOf ?? s?.items?.oneOf ?? s?.items?.anyOf;
  if (Array.isArray(list)) return list.filter((o) => o && o.const !== undefined).map((o) => ({ value: String(o.const), label: str(o.title) ?? String(o.const), description: str(o.description) }));
  const en = s?.enum ?? s?.items?.enum;
  if (Array.isArray(en)) {
    const names = s?.enumNames ?? s?.items?.enumNames;
    return en.map((v: unknown, i: number) => ({ value: String(v), label: Array.isArray(names) && names[i] ? String(names[i]) : String(v) }));
  }
  return [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

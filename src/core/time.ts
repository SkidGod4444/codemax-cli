/** Every time codemax shows is 12-hour, whatever the system locale: "7:25 PM", "Oct 18, 7:25 PM". */
export function fmtTime12(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function fmtDateTime12(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${fmtTime12(ts)}`;
}

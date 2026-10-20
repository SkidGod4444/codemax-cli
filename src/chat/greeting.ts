/**
 * The start-up card's hello: a greeting for the time of day (with your first name from git,
 * when it has one) and a small line that changes from day to day. Notices (keep-awake, update,
 * debug log…) are shown under the card, not in it.
 */

const LINES = [
  "your agents are ready when you are",
  "one terminal, every agent you pay for",
  "ship something small today",
  "when one agent runs out, the next one picks up",
  "tea, code, repeat",
  "every turn is saved; Esc twice rewinds",
  "go build the thing",
];

export function greeting(now = new Date(), name?: string): string {
  const h = now.getHours();
  const hello = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Up late";
  const mark = h >= 6 && h < 18 ? "☀" : "☾";
  // The same line all day, a different one tomorrow.
  const day = Math.floor(now.getTime() / 86_400_000);
  return `${mark} ${hello}${name ? `, ${name}` : ""} · ${LINES[day % LINES.length]}`;
}

/** Your first name, from git's user.name (never the login name). */
export function firstName(): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "config", "--get", "user.name"], { stdout: "pipe", stderr: "ignore", timeout: 2000 });
    const full = r.stdout.toString().trim();
    const first = full.split(/\s+/)[0];
    return first && /^[\p{L}][\p{L}'-]{0,30}$/u.test(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

/** Who makes codemax: shown on the card with a link. */
export const MAKER = { name: "Saidev Dhal", url: "https://saidev.codes", label: "saidev.codes" };

import { cacheLife } from "next/cache";

/**
 * How many times codemax has been downloaded, from the two places that count it:
 * - npm: every download of the `codemax-cli` package since its first day (npm's own figure). npm
 *   counts each fetch of the package file: people, but also the mirrors and scanners that fetch
 *   every new version. So the page says "downloads", never "users" or "installs".
 * - GitHub: every download of a release binary (the .sha256 checksum files next to them are
 *   not installs and are left out; GitHub's own "total" and badge services include them).
 * Installs through the one-line installer are a git clone, which nobody counts, so the real
 * number is higher than what is shown. Nothing here is rounded up or estimated.
 */

/** The package's first day on npm. */
const FIRST_DAY = "2026-10-18";
const PACKAGE = "codemax-cli";
const REPO = "SkidGod4444/codemax-cli";

/**
 * The figures on 2026-11-14, checked against npm's daily numbers and GitHub's release list.
 * A count only ever grows, so when a lookup fails (or answers less) these are still true.
 */
export const KNOWN: Downloads = { npm: 2170, npmWeek: 0, github: 28, total: 2198 };

export interface Downloads {
  /** npm downloads, all time. */
  npm: number;
  /** npm downloads in the last full week (0 when not known). */
  npmWeek: number;
  /** Release binaries downloaded from GitHub, all time. */
  github: number;
  total: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function json<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

/** npm answers for at most 18 months at a time, so the total is added up a year at a time. */
export async function npmDownloads(now = new Date()): Promise<number> {
  let total = 0;
  for (let from = new Date(`${FIRST_DAY}T00:00:00Z`); from <= now; ) {
    const to = new Date(Math.min(now.getTime(), from.getTime() + 364 * 86_400_000));
    const n = (await json<{ downloads?: unknown }>(`https://api.npmjs.org/downloads/point/${day(from)}:${day(to)}/${PACKAGE}`)).downloads;
    if (typeof n !== "number") throw new Error("npm gave no count");
    total += n;
    from = new Date(to.getTime() + 86_400_000);
  }
  return total;
}

async function npmLastWeek(): Promise<number> {
  const n = (await json<{ downloads?: unknown }>(`https://api.npmjs.org/downloads/point/last-week/${PACKAGE}`)).downloads;
  return typeof n === "number" ? n : 0;
}

/** Release binaries downloaded, over every page of releases. A token (GITHUB_TOKEN) only lifts GitHub's hourly limit for the lookup. */
export async function githubDownloads(): Promise<number> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let total = 0;
  for (let page = 1; page <= 20; page++) {
    const releases = await json<{ assets?: { name: string; download_count: number }[] }[]>(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, headers);
    if (!Array.isArray(releases)) throw new Error("GitHub gave no release list");
    total += countBinaries(releases);
    if (releases.length < 100) break;
  }
  return total;
}

/** Downloads of the binaries in a list of releases (checksum files are not installs). */
export function countBinaries(releases: { assets?: { name: string; download_count: number }[] }[]): number {
  return releases.flatMap((r) => r.assets ?? []).filter((a) => !a.name.endsWith(".sha256")).reduce((n, a) => n + (Number(a.download_count) || 0), 0);
}

/** The counts, looked up again about once an hour. A source that cannot be reached keeps its last checked figure. */
export async function downloads(): Promise<Downloads> {
  "use cache";
  cacheLife("hours");
  const [npm, week, github] = await Promise.all([npmDownloads().catch(() => KNOWN.npm), npmLastWeek().catch(() => 0), githubDownloads().catch(() => KNOWN.github)]);
  const n = Math.max(KNOWN.npm, npm);
  const g = Math.max(KNOWN.github, github);
  return { npm: n, npmWeek: week, github: g, total: n + g };
}

/** "2,198": the number as it is. */
export const count = (n: number) => n.toLocaleString("en-US");

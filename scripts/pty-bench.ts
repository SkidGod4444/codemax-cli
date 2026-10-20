/**
 * End-to-end typing latency on a real terminal renderer: runs scripts/pty-app.ts in a PTY,
 * types, and measures from each key to the first screen update after it.
 *
 *   ROWS=600 bun scripts/pty-bench.ts
 */
import { join } from "node:path";
let last = 0;
let bytes = 0;
const waiters: ((t: number) => void)[] = [];
let all = "";
const term = new Bun.Terminal({ cols: 120, rows: 40, data: (t, c) => {
  last = performance.now();
  bytes += c.length;
  const chunk = new TextDecoder().decode(c);
  // Answer the queries a real terminal answers (cursor position, device attributes, colours).
  if (chunk.includes("\x1b[6n")) t.write("\x1b[1;1R");
  if (chunk.includes("\x1b[c")) t.write("\x1b[?62;22c");
  if (chunk.includes("\x1b]11;?")) t.write("\x1b]11;rgb:1616/1616/1a1a\x07");
  if (chunk.includes("\x1b]10;?")) t.write("\x1b]10;rgb:e8e8/e3e3/e6e6\x07");
  all += chunk;
  const w = waiters.shift();
  w?.(last);
} });
const proc = Bun.spawn([process.env.BUN_BIN ?? "bun", join(import.meta.dir, "pty-app.ts")], { terminal: term, env: { ...process.env, TERM: "xterm-256color", ROWS: process.env.ROWS ?? "600" } });
// Whatever happens (a timeout, an error), the app in the PTY is stopped with us.
const stop = () => {
  try {
    proc.kill("SIGKILL");
  } catch {
    /* gone */
  }
};
process.on("exit", stop);
process.on("uncaughtException", (e) => {
  console.error(e);
  stop();
  process.exit(1);
});
const strip = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "\n").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b[P_][^\x1b]*\x1b\\/g, "");
const until = async (re: RegExp, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(strip(all))) return;
    await Bun.sleep(50);
  }
  throw new Error("timeout " + re);
};
await until(/new session/);
const send = (s: string) => term.write(s);
send("fill");
await Bun.sleep(200);
send("\r");
// Wait for the fill turn to end (the spinner goes away and output settles).
let quiet = 0;
while (quiet < 20) {
  const b = bytes;
  await Bun.sleep(100);
  quiet = bytes === b ? quiet + 1 : 0;
}
async function typeKeys(n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    waiters.length = 0;
    const t0 = performance.now();
    const p = new Promise<number>((r) => waiters.push(r));
    send(i % 30 === 29 ? " " : "a");
    const t = await Promise.race([p, Bun.sleep(1000).then(() => t0 + 1000)]);
    out.push(t - t0);
    await Bun.sleep(40);
  }
  return out;
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `p50 ${q(0.5).toFixed(1)}ms  p95 ${q(0.95).toFixed(1)}ms  max ${s.at(-1)!.toFixed(1)}ms`;
};
let b0 = bytes, tA = performance.now();
console.log(`idle      key → screen: ${stats(await typeKeys(100))} | output ${((bytes - b0) / 1024 / ((performance.now() - tA) / 1000)).toFixed(0)} KB/s`);
// The slash palette: "/" then letters, and back (on an empty prompt).
for (let i = 0; i < 150; i++) send("\x7f");
await Bun.sleep(500);
{
  const out: number[] = [];
  for (let r = 0; r < 6; r++) for (const k of ["/", "c", "o", "n", "f", "i", "g", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f"]) {
    waiters.length = 0;
    const t0 = performance.now();
    const p = new Promise<number>((res) => waiters.push(res));
    send(k);
    out.push((await Promise.race([p, Bun.sleep(1000).then(() => t0 + 1000)])) - t0);
    await Bun.sleep(40);
  }
  console.log(`/ palette key → screen: ${stats(out)}`);
  // Bytes the terminal must draw per key: plain typing vs typing into the open palette.
  const per = async (keys: string[]) => {
    const sizes: number[] = [];
    for (const k of keys) {
      await Bun.sleep(60);
      const b = bytes;
      send(k);
      await Bun.sleep(60);
      sizes.push(bytes - b);
    }
    return sizes;
  };
  const plain = await per(["a", "b", "c", "d", "\x7f", "\x7f", "\x7f", "\x7f"]);
  const pal = await per(["/", "c", "o", "n", "f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f"]);
  console.log(`bytes per key: plain ${plain.join(",")} | palette ${pal.join(",")}`);
  // Time until the screen stops changing after a key (the whole update, not its first byte).
  const settle = async (keys: string[]) => {
    const out: number[] = [];
    for (const k of keys) {
      await Bun.sleep(80);
      const t0 = performance.now();
      const b = bytes;
      send(k);
      let lastChange = t0, seen = bytes;
      while (performance.now() - lastChange < 40) {
        await Bun.sleep(1);
        if (bytes !== seen) { seen = bytes; lastChange = last; }
      }
      out.push(bytes === b ? 0 : lastChange - t0);
    }
    return out;
  };
  const sp = await settle(["a", "b", "c", "\x7f", "\x7f", "\x7f"]);
  const ss = await settle(["/", "c", "o", "n", "f", "i", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f"]);
  console.log(`screen settled after (ms): plain ${sp.map((x) => x.toFixed(0)).join(",")} | palette ${ss.map((x) => x.toFixed(0)).join(",")}`);
}
// Typing while the mouse moves over the window (any-motion tracking sends every move).
let mx = 0;
const mouse = setInterval(() => { mx = (mx + 1) % 100; send(`\x1b[<35;${10 + mx};${5 + (mx % 20)}M`); }, 8);
b0 = bytes; tA = performance.now();
console.log(`mouse moving key → screen: ${stats(await typeKeys(100))} | output ${((bytes - b0) / 1024 / ((performance.now() - tA) / 1000)).toFixed(0)} KB/s`);
clearInterval(mouse);
for (let i = 0; i < 200; i++) send("\x7f");
await Bun.sleep(300);
send("stream");
await Bun.sleep(100);
send("\r");
await Bun.sleep(300);
b0 = bytes; tA = performance.now();
console.log(`streaming key → screen: ${stats(await typeKeys(100))} | output ${((bytes - b0) / 1024 / ((performance.now() - tA) / 1000)).toFixed(0)} KB/s`);
b0 = bytes; tA = performance.now(); await Bun.sleep(2000);
console.log(`streaming, not typing: output ${((bytes - b0) / 1024 / ((performance.now() - tA) / 1000)).toFixed(0)} KB/s`);
// The palette open while the agent streams.
for (let i = 0; i < 150; i++) send("\x7f");
await Bun.sleep(300);
send("/co");
await Bun.sleep(300);
b0 = bytes; tA = performance.now(); await Bun.sleep(2000);
console.log(`streaming with the / palette open: output ${((bytes - b0) / 1024 / ((performance.now() - tA) / 1000)).toFixed(0)} KB/s`);
{
  const out: number[] = [];
  for (const k of ["n", "\x7f", "n", "\x7f", "n", "\x7f", "n", "\x7f", "n", "\x7f", "n", "\x7f"]) {
    waiters.length = 0;
    const t0 = performance.now();
    const p = new Promise<number>((res) => waiters.push(res));
    send(k);
    out.push((await Promise.race([p, Bun.sleep(1000).then(() => t0 + 1000)])) - t0);
    await Bun.sleep(40);
  }
  console.log(`streaming with the / palette open, key → screen: ${stats(out)}`);
}
stop();
process.exit(0);

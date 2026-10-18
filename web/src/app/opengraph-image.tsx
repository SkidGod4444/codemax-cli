import { ImageResponse } from "next/og";
import { googleFont } from "@/lib/og";
import { SITE } from "@/lib/site";

export const alt = "codemax — every AI coding plan you pay for, one terminal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const HEAD_1 = "Every AI coding plan";
const HEAD_2 = "you pay for. One terminal.";
const AGENTS = "Claude Code · Codex · OpenCode · Grok · Cursor";
const TAG = "FREE · OPEN SOURCE · NO API KEYS";

/** A tufted button where seams cross, matching the site. */
function Tuft({ x, y }: { x: number; y: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x - 8,
        top: y - 8,
        width: 16,
        height: 16,
        borderRadius: 999,
        background: "radial-gradient(circle at 38% 32%, rgba(255,255,255,0.95), #ff86ab 60%)",
        boxShadow: "0 0 0 1.5px rgba(150,12,62,0.4), 0 3px 5px rgba(90,8,40,0.3)",
      }}
    />
  );
}

export default async function Image() {
  const host = SITE.url.replace(/^https?:\/\//, "");
  const [serif, sans, bold, mono] = await Promise.all([
    googleFont("Instrument Serif", 400, HEAD_1 + HEAD_2),
    googleFont("Inter Tight", 500, AGENTS),
    googleFont("Inter Tight", 700, "codemax"),
    googleFont("JetBrains Mono", 500, TAG + host),
  ]);
  const fonts = [
    serif && { name: "Instrument Serif", data: serif, weight: 400 as const, style: "normal" as const },
    sans && { name: "Inter Tight", data: sans, weight: 500 as const, style: "normal" as const },
    bold && { name: "Inter Tight", data: bold, weight: 700 as const, style: "normal" as const },
    mono && { name: "JetBrains Mono", data: mono, weight: 500 as const, style: "normal" as const },
  ].filter(Boolean) as { name: string; data: ArrayBuffer; weight: 400 | 500 | 700; style: "normal" }[];

  const M = 34; // frame inset
  const W = size.width, H = size.height;

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", position: "relative", background: "#ff5c8d", color: "#ffffff" }}>
        {/* soft pillow light */}
        <div style={{ position: "absolute", inset: 0, display: "flex", background: "radial-gradient(90% 80% at 40% 30%, rgba(255,255,255,0.16), rgba(255,255,255,0) 70%)" }} />
        {/* frame, center seam and stitches */}
        <div style={{ position: "absolute", left: M, top: M, right: M, bottom: M, display: "flex", border: "1.5px solid rgba(255,255,255,0.4)" }} />
        <div style={{ position: "absolute", left: M + 10, top: M + 10, right: M + 10, bottom: M + 10, display: "flex", border: "1.5px dashed rgba(255,255,255,0.45)" }} />
        <Tuft x={M} y={M} />
        <Tuft x={W - M} y={M} />
        <Tuft x={M} y={H - M} />
        <Tuft x={W - M} y={H - M} />

        <div style={{ position: "absolute", left: M + 58, top: M + 52, right: M + 58, bottom: M + 48, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", fontFamily: "Inter Tight", fontWeight: 700, fontSize: 44, letterSpacing: -1.5 }}>codemax</div>
            <div style={{ display: "flex", fontFamily: "JetBrains Mono", fontSize: 16, letterSpacing: 3.5, color: "rgba(255,255,255,0.8)" }}>{TAG}</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", flexDirection: "column", fontFamily: "Instrument Serif", fontSize: 92, lineHeight: 1, letterSpacing: -1.5 }}>
              <div style={{ display: "flex" }}>{HEAD_1}</div>
              <div style={{ display: "flex" }}>{HEAD_2}</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: "Inter Tight", fontSize: 26, color: "rgba(255,255,255,0.92)" }}>
            <div style={{ display: "flex" }}>{AGENTS}</div>
            <div style={{ display: "flex", fontFamily: "JetBrains Mono", fontSize: 18, letterSpacing: 2, color: "rgba(255,255,255,0.75)" }}>{host}</div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: fonts.length ? fonts : undefined },
  );
}

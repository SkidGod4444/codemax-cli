import { MONOGRAM_ROWS, WORDMARK_ROWS } from "@/lib/wordmark";

/** Load a Google font as TTF for ImageResponse; undefined if offline (Geist is used instead). */
export async function googleFont(family: string, weight: number, text?: string): Promise<ArrayBuffer | undefined> {
  try {
    const q = `family=${family.replace(/ /g, "+")}:wght@${weight}${text ? `&text=${encodeURIComponent(text)}` : ""}`;
    const css = await (await fetch(`https://fonts.googleapis.com/css2?${q}`)).text();
    const src = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/)?.[1];
    if (!src) return undefined;
    const res = await fetch(src);
    return res.ok ? await res.arrayBuffer() : undefined;
  } catch {
    return undefined;
  }
}

/** The halftone wordmark (or "cm" monogram) as absolutely placed squares, for ImageResponse. */
export function HalftoneMark({ cell, color = "#ffffff", monogram = false }: { cell: number; color?: string; monogram?: boolean }) {
  const rows = monogram ? MONOGRAM_ROWS : WORDMARK_ROWS;
  const cols = rows[0]!.length;
  const squares: React.ReactElement[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < cols; x++) {
      const v = Number(row[x]);
      if (v < 2) continue;
      const s = cell * (0.28 + (0.62 * v) / 9);
      squares.push(
        <div
          key={`${x}-${y}`}
          style={{ position: "absolute", left: x * cell + (cell - s) / 2, top: y * cell + (cell - s) / 2, width: s, height: s, borderRadius: s * 0.12, background: color }}
        />,
      );
    }
  });
  return <div style={{ display: "flex", position: "relative", width: cols * cell, height: rows.length * cell }}>{squares}</div>;
}

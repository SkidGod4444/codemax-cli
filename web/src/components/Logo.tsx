import { MONOGRAM_ROWS, WORDMARK_ROWS } from "@/lib/wordmark";

/*
 * The codemax logo is the wordmark itself, set in halftone squares like the
 * artwork on the page: each cell of a 13-row grid becomes a square sized by
 * how much of the letter covers it.
 */
function Halftone({ rows, color, className, label }: { rows: readonly string[]; color: string; className?: string; label: string }) {
  const cols = rows[0]!.length;
  const squares: React.ReactElement[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < cols; x++) {
      const v = Number(row[x]);
      if (v < 2) continue;
      const s = 10 * (0.28 + (0.62 * v) / 9);
      squares.push(<rect key={`${x}-${y}`} x={x * 10 + 5 - s / 2} y={y * 10 + 5 - s / 2} width={s} height={s} rx={s * 0.12} fill={color} />);
    }
  });
  return (
    <svg viewBox={`0 0 ${cols * 10} ${rows.length * 10}`} className={className} role="img" aria-label={label}>
      {squares}
    </svg>
  );
}

/** The wordmark logo. Height drives the size; width follows (≈ 5.85 : 1). */
export function Logo({ className = "h-6 w-auto", color = "#ff4f86" }: { className?: string; color?: string }) {
  return <Halftone rows={WORDMARK_ROWS} color={color} className={className} label="codemax" />;
}

/** "cm" in the same halftone, for tight spaces. */
export function LogoMonogram({ className = "h-6 w-auto", color = "#ff4f86" }: { className?: string; color?: string }) {
  return <Halftone rows={MONOGRAM_ROWS} color={color} className={className} label="codemax" />;
}

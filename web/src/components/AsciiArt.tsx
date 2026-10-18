"use client";

import { useEffect, useRef } from "react";
import { SCENES_3D, shade, type Scene3DName, type View } from "@/lib/ascii/render3d";

/**
 * Halftone artwork: a ray-marched 3D scene sampled on a grid. Each cell is
 * drawn as a glyph from a small ASCII-like ramp (·  ▪  +  ■) sized by its
 * brightness. On first view the cells assemble in a sweep; afterwards the
 * scene turns slowly, the camera leans toward the pointer, and cells under
 * the cursor swell like a lens. Reduced motion gets a still frame.
 */
export default function AsciiArt({
  scene,
  cell = 10,
  ink = "255,255,255",
  className = "",
}: {
  scene: Scene3DName | "wordmark";
  cell?: number;
  /** Glyph colour as "r,g,b". White on pink bands, pink on white bands. */
  ink?: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const parent = canvas.parentElement!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const spins = scene !== "wordmark" && !reduce;
    let W = 0, H = 0, raf = 0, visible = false, last = 0, t = 4;
    let sample: Sampler | null = null;
    let seeds = new Float32Array(0);

    // interaction state, eased toward targets every frame
    const view: View = { yaw: 0, pitch: 0 };
    const aim = { yaw: 0, pitch: 0 };
    const lens = { x: -1e4, y: -1e4, k: 0, tk: 0 };
    let reveal = reduce ? 1 : 0;
    let revealStart = 0;

    const layout = () => {
      W = parent.clientWidth;
      H = parent.clientHeight;
      if (!W || !H) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sample = makeSampler(scene, W, H);
      const step = stepFor(W, cell);
      const n = Math.floor(W / step) * Math.floor(H / step);
      seeds = new Float32Array(n);
      for (let i = 0; i < n; i++) seeds[i] = hash(i);
      return true;
    };

    const paint = () => {
      if (!sample) return;
      ctx.clearRect(0, 0, W, H);
      const step = stepFor(W, cell);
      const cols = Math.floor(W / step), rows = Math.floor(H / step);
      const ox = (W - cols * step) / 2, oy = (H - rows * step) / 2;
      const lensR = Math.max(70, Math.min(W, H) * 0.22);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          // assemble: a diagonal sweep with a little jitter per cell
          let pop = 1;
          if (reveal < 1) {
            const th = (c / cols) * 0.55 + (1 - r / rows) * 0.2 + (seeds[i] ?? 0) * 0.25;
            pop = clamp01((reveal * 1.25 - th) / 0.18);
            if (pop <= 0) continue;
          }
          const cx = ox + c * step + step / 2, cy = oy + r * step + step / 2;
          let b = sample(cx, cy, t, view);
          if (lens.k > 0.01) {
            const d = Math.hypot(cx - lens.x, cy - lens.y) / lensR;
            if (d < 1) b = b > 0.02 ? Math.min(1, b + (1 - d * d) * 0.35 * lens.k) : b;
          }
          if (b <= 0.03) continue;
          const tone = Math.pow(b, 1.1);
          const a = (0.4 + 0.6 * tone) * pop;
          ctx.fillStyle = `rgba(${ink},${a.toFixed(3)})`;
          const s = step * (0.16 + 0.8 * tone) * (pop < 1 ? backOut(pop) : 1);
          if (tone > 0.6) {
            ctx.fillRect(cx - s / 2, cy - s / 2, s, s); // ■ solid light
          } else if (tone > 0.34) {
            const w = Math.max(1, s * 0.3); // + mid-tones read as ASCII
            ctx.fillRect(cx - s / 2, cy - w / 2, s, w);
            ctx.fillRect(cx - w / 2, cy - s / 2, w, s);
          } else if (tone > 0.14) {
            const q = s * 0.62; // ▪ small block
            ctx.fillRect(cx - q / 2, cy - q / 2, q, q);
          } else {
            ctx.fillRect(cx - 0.9, cy - 0.9, 1.8, 1.8); // · shadow dust
          }
        }
      }
    };

    const settle = () => {
      const ease = 0.08;
      view.yaw += (aim.yaw - view.yaw) * ease;
      view.pitch += (aim.pitch - view.pitch) * ease;
      lens.k += (lens.tk - lens.k) * 0.12;
      return Math.abs(aim.yaw - view.yaw) > 1e-3 || Math.abs(aim.pitch - view.pitch) > 1e-3 || Math.abs(lens.tk - lens.k) > 0.01;
    };

    const loop = (now: number) => {
      raf = 0;
      if (!visible) return;
      if (now - last >= 33) {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.033;
        last = now;
        if (spins) t += dt;
        if (reveal < 1) reveal = Math.min(1, (now - revealStart) / 1500);
        const moving = settle();
        paint();
        // static scenes stop once the reveal and any easing have finished
        if (!spins && reveal >= 1 && !moving) return;
      }
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (reduce || !visible || raf) return;
      if (!revealStart) revealStart = performance.now();
      last = 0;
      raf = requestAnimationFrame(loop);
    };

    const onPointer = (e: PointerEvent) => {
      if (reduce) return;
      const r = canvas.getBoundingClientRect();
      const nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const near = Math.abs(nx) < 1.6 && Math.abs(ny) < 1.6;
      aim.yaw = near ? clamp(nx, -1, 1) * 0.32 : 0;
      aim.pitch = near ? clamp(ny, -1, 1) * -0.16 : 0;
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      lens.x = e.clientX - r.left;
      lens.y = e.clientY - r.top;
      lens.tk = inside ? 1 : 0;
      start();
    };
    const onLeave = () => {
      aim.yaw = aim.pitch = 0;
      lens.tk = 0;
      start();
    };

    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      if (visible) start();
    }, { threshold: 0.15 });
    io.observe(canvas);
    const ro = new ResizeObserver(() => {
      if (layout()) paint();
    });
    ro.observe(parent);
    document.fonts?.ready.then(() => {
      if (layout()) paint();
    });
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else start();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    if (layout()) paint();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [scene, cell, ink]);

  return <canvas ref={ref} aria-hidden className={`pointer-events-none absolute inset-0 ${className}`} />;
}

const stepFor = (W: number, cell: number) => (W < 500 ? Math.max(6, cell - 1) : cell);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
/** Overshoot a touch, then settle: cells "pop" into place. */
const backOut = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
const hash = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

type Sampler = (x: number, y: number, t: number, view: View) => number;

/** Brightness at a canvas point for the named scene, fitted "contain" and centred. */
function makeSampler(scene: Scene3DName | "wordmark", W: number, H: number): Sampler {
  if (scene === "wordmark") {
    const c = document.createElement("canvas");
    c.width = Math.round(W);
    c.height = Math.round(H);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    let size = H * 0.9;
    g.font = `700 ${size}px "Inter Tight", system-ui, sans-serif`;
    const w = g.measureText("codemax").width;
    if (w > W * 0.94) size *= (W * 0.94) / w;
    g.font = `700 ${size}px "Inter Tight", system-ui, sans-serif`;
    g.fillText("codemax", W / 2, H / 2 + size * 0.04);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    return (x, y, _t, view) => {
      // the flat wordmark leans with the pointer too: a small shear
      const xs = x + (y - H / 2) * view.yaw * 0.25;
      const ys = y + (x - W / 2) * view.pitch * 0.12;
      const xi = xs | 0, yi = ys | 0;
      if (xi < 0 || yi < 0 || xi >= c.width || yi >= c.height) return 0;
      const a = data[(yi * c.width + xi) * 4 + 3]! / 255;
      return a * (0.62 + 0.38 * (1 - y / H)); // lighter at the top
    };
  }
  const S = SCENES_3D[scene];
  const fitW = Math.min(W, H * S.aspect), fitH = fitW / S.aspect;
  const x0 = (W - fitW) / 2, y0 = (H - fitH) / 2;
  return (x, y, t, view) => {
    const u = ((x - x0) / fitW) * 2 - 1, v = 1 - ((y - y0) / fitH) * 2;
    if (u < -1 || u > 1 || v < -1 || v > 1) return 0;
    return shade(S, u, v, t, view);
  };
}

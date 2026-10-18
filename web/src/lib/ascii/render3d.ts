/*
 * A tiny ray-marcher for halftone art. Scenes are signed-distance functions;
 * each grid cell casts one ray and gets a brightness in 0..1 from simple
 * lighting (key + fill + rim, soft ambient occlusion). 0 means background.
 */

export type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export function rotX(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
}
export function rotY(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
}
export function rotZ(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
}

export const sdTorus = (p: V3, R: number, r: number) => Math.hypot(Math.hypot(p[0], p[2]) - R, p[1]) - r;
export const sdSphere = (p: V3, r: number) => len(p) - r;
export function sdRoundBox(p: V3, b: V3, r: number) {
  const q: V3 = [Math.abs(p[0]) - b[0] + r, Math.abs(p[1]) - b[1] + r, Math.abs(p[2]) - b[2] + r];
  return len([Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)]) + Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0) - r;
}

export interface Scene3D {
  /** Width / height of the artwork. */
  aspect: number;
  /** Distance to the surface at p, at time t (seconds). */
  sdf: (p: V3, t: number) => number;
  camera: { pos: V3; target: V3; fov: number };
  light?: V3;
  /** Surface brightness multiplier at a hit point (lets parts read apart). */
  material?: (p: V3, t: number) => number;
  /** Light the surface gives off at a hit point, added after shading (pulses, shimmer). */
  glow?: (p: V3, t: number) => number;
  /** Bounding-sphere radius around the origin; rays that miss it are skipped. */
  bound: number;
}

/** Camera nudge from the pointer: orbit angles in radians around the target. */
export type View = { yaw: number; pitch: number };

function orbit(pos: V3, target: V3, view?: View): V3 {
  if (!view || (!view.yaw && !view.pitch)) return pos;
  let o = rotY(sub(pos, target), view.yaw);
  const right = norm(cross(norm(mul(o, -1)), [0, 1, 0]));
  // rotate about the camera's right axis (Rodrigues)
  const c = Math.cos(view.pitch), s = Math.sin(view.pitch);
  o = add(add(mul(o, c), mul(cross(right, o), s)), mul(right, dot(right, o) * (1 - c)));
  return add(target, o);
}

/** Brightness for a screen point (u, v in -1..1, v up) at time t. */
export function shade(scene: Scene3D, u: number, v: number, t0 = 0, view?: View): number {
  const { target, fov } = scene.camera;
  const pos = orbit(scene.camera.pos, target, view);
  const fwd = norm(sub(target, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const k = Math.tan((fov * Math.PI) / 360);
  const dir = norm(add(fwd, add(mul(right, u * k * scene.aspect), mul(up, v * k))));
  // skip rays that miss the bounding sphere entirely
  const b = dot(pos, dir), c = dot(pos, pos) - scene.bound * scene.bound;
  const disc = b * b - c;
  if (disc < 0) return 0;
  let t = Math.max(0, -b - Math.sqrt(disc));
  const tMax = -b + Math.sqrt(disc);
  let hit = false;
  const sdf = (q: V3) => scene.sdf(q, t0);
  for (let i = 0; i < 72; i++) {
    const d = sdf(add(pos, mul(dir, t)));
    if (d < 0.0015) { hit = true; break; }
    t += d * 0.92;
    if (t > tMax) break;
  }
  if (!hit) return 0;
  const p = add(pos, mul(dir, t));
  const e = 0.002;
  const n = norm([
    sdf(add(p, [e, 0, 0])) - sdf(sub(p, [e, 0, 0])),
    sdf(add(p, [0, e, 0])) - sdf(sub(p, [0, e, 0])),
    sdf(add(p, [0, 0, e])) - sdf(sub(p, [0, 0, e])),
  ]);
  const L = norm(scene.light ?? [-0.6, 0.8, -0.5]);
  const key = clamp(dot(n, L));
  const fill = clamp(dot(n, norm([0.7, 0.2, -0.4]))) * 0.25;
  const rim = Math.pow(1 - clamp(-dot(n, dir)), 3) * 0.45;
  let ao = 0;
  for (let i = 1; i <= 4; i++) {
    const h = 0.04 * i;
    ao += (h - sdf(add(p, mul(n, h)))) / Math.pow(2, i);
  }
  const occ = clamp(1 - ao * 4);
  const spec = Math.pow(clamp(dot(norm(sub(L, dir)), n)), 40) * 0.18;
  const m = scene.material?.(p, t0) ?? 1;
  const g = scene.glow?.(p, t0) ?? 0;
  return clamp((0.04 + key * 0.8 + fill + rim + spec) * (0.35 + 0.65 * occ) * m + g);
}

/* ------------------------------------------------------------- the scenes */

const ringSpace = (p: V3, t: number) => rotZ(rotY(p, 0.38 + Math.sin(t * 0.35) * 0.55), 0.14 + Math.sin(t * 0.5) * 0.06);

/** Five interlocked rings — five agents, one chain — turning slowly in space. */
export const rings: Scene3D = {
  aspect: 1.25,
  bound: 3.9,
  camera: { pos: [-1.4, 4.4, -7.4], target: [0, -0.1, 0], fov: 36 },
  light: [-0.55, 0.85, -0.6],
  // a pulse of light runs link to link: the task being handed down the chain
  glow(p, t) {
    const q = ringSpace(p, t);
    const x = -3.2 + ((t * 1.4) % 7.4);
    return 0.75 * Math.exp(-((q[0] - x) ** 2) / 0.28);
  },
  sdf(p, t) {
    const q = ringSpace(p, t);
    let d = 1e9;
    for (let i = 0; i < 5; i++) {
      const r: V3 = [q[0] - (i - 2) * 1.22, q[1] + Math.sin(t * 1.1 + i * 0.9) * 0.05, q[2]];
      // links alternate: lying flat and standing up, each through its neighbour
      d = Math.min(d, sdTorus(i % 2 ? r : rotX(r, Math.PI / 2), 0.74, 0.16));
    }
    return d;
  },
};

/** A ringed planet with five moons in orbit. */
export const planet: Scene3D = {
  aspect: 1,
  bound: 3.4,
  camera: { pos: [0, 3.4, -7.9], target: [0, -0.1, 0], fov: 42 },
  light: [-0.7, 0.6, -0.5],
  material(p) {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (r < 1.2) return 1;
    return r < 2.45 ? 0.85 : 1;
  },
  glow(p, t) {
    const q = rotZ(p, 0.28);
    const radial = Math.hypot(q[0], q[2]);
    if (radial < 1.5 || radial > 2.4) return 0;
    const a = Math.atan2(q[2], q[0]);
    return 0.55 * Math.pow(0.5 + 0.5 * Math.cos(2 * a - t * 0.9), 10);
  },
  sdf(p, t) {
    let d = sdSphere(p, 1.15);
    const q = rotZ(p, 0.28);
    const radial = Math.hypot(q[0], q[2]);
    d = Math.min(d, Math.max(Math.abs(radial - 1.95) - 0.38, Math.abs(q[1]) - 0.025));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.9 + t * (0.32 + i * 0.03);
      const c: V3 = rotZ([Math.cos(a) * 2.95, 0, Math.sin(a) * 2.95], -0.28);
      d = Math.min(d, sdSphere(sub(p, c), 0.2 + (i % 3) * 0.05));
    }
    return d;
  },
};

/** A 3×3×3 block of modules; the top corner module lifts out and snaps back in. */
const SLOT: V3 = [1, 1, -1];
const box = (p: V3) => sdRoundBox(p, [0.42, 0.42, 0.42], 0.05);
export const cubes: Scene3D = {
  aspect: 1,
  bound: 3.6,
  camera: { pos: [-6.2, 5.4, -6.2], target: [0, 0.35, 0], fov: 34 },
  light: [-0.85, 1.1, -0.15],
  sdf(p0, t) {
    const p = rotY(p0, Math.sin(t * 0.3) * 0.35);
    // lattice by domain repetition: O(1) whatever the cube count
    const cell: V3 = [clamp(Math.round(p[0]), -1, 1), clamp(Math.round(p[1]), -1, 1), clamp(Math.round(p[2]), -1, 1)];
    let d: number;
    if (cell[0] === SLOT[0] && cell[1] === SLOT[1] && cell[2] === SLOT[2]) {
      // empty slot: distance to the three neighbours instead
      d = Math.min(box(sub(p, [0, 1, -1])), box(sub(p, [1, 0, -1])), box(sub(p, [1, 1, 0])));
    } else d = box(sub(p, cell));
    // the moving module: rise, hover, ease back into its slot (6 s loop)
    return Math.min(d, box(sub(p, [SLOT[0], SLOT[1] + liftAt(t) * 1.15, SLOT[2]])));
  },
  glow(p0, t) {
    const p = rotY(p0, Math.sin(t * 0.3) * 0.35);
    const lift = liftAt(t);
    return box(sub(p, [SLOT[0], SLOT[1] + lift * 1.15, SLOT[2]])) < 0.02 ? 0.5 * lift : 0;
  },
};
/** Module lift over a 6 s loop: rise, hover, ease back into its slot. */
const liftAt = (t: number) => {
  const k = (t % 6) / 6;
  return k < 0.4 ? ease(k / 0.4) : k < 0.6 ? 1 : 1 - ease((k - 0.6) / 0.4);
};
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export const SCENES_3D = { rings, planet, cubes };
export type Scene3DName = keyof typeof SCENES_3D;

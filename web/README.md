# codemax landing page

Next.js 16 (App Router, Turbopack) with [coss ui](https://coss.com/ui) components on Base UI and Tailwind 4.

```sh
bun install
bun run dev      # http://localhost:3000
bun run build
```

- Design: pink grounds, white type, a hairline grid with `+` registration marks, and framed figures. Text never sits on artwork.
- `src/lib/ascii/render3d.ts`: three small 3D scenes (an interlocking chain, a ringed planet with moons, a block of modules) as signed-distance functions with simple lighting.
- `src/components/AsciiArt.tsx`: renders a scene as white halftone squares on a dot grid. Scenes move slowly while on screen (~30 fps), pause off screen and in background tabs, and hold still for `prefers-reduced-motion`. The closing wordmark is static.
- `src/components/TerminalDemo.tsx`: a still frame of a Claude-to-Codex handoff.
- `src/app/globals.css`: coss theme tokens mapped to the pink scale.
- Add coss components with `bunx shadcn@latest add @coss/<name>` (the registry is set in `components.json`).

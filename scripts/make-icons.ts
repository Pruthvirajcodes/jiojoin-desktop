// Renders the app and tray icons from inline SVG. Run with `bun run icons`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = join(import.meta.dirname, "..");
// Handset glyph on a 24-unit grid (Material Symbols "call", Apache-2.0).
const HANDSET =
  "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z";

function render(svg: string, size: number, file: string): void {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, png);
  console.log(`${file} (${size}px)`);
}

// macOS icon grid: an 824-unit rounded square centred on a 1024 canvas.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5fdc74"/><stop offset="1" stop-color="#1fae48"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#g)"/>
  <g transform="translate(512 512) scale(19.5) translate(-12 -12)"><path d="${HANDSET}" fill="#fff"/></g>
</svg>`;

const template = (missed: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
  <g transform="translate(9 9.2) scale(0.66) translate(-12 -12)"><path d="${HANDSET}" fill="#000"/></g>
  ${missed ? '<circle cx="14.2" cy="3.8" r="3" fill="#000"/>' : ""}
</svg>`;

const colour = (missed: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="15" fill="#25b34d"/>
  <g transform="translate(16 16) scale(0.78) translate(-12 -12)"><path d="${HANDSET}" fill="#fff"/></g>
  ${missed ? '<circle cx="25" cy="7" r="6.2" fill="#fff"/><circle cx="25" cy="7" r="4.8" fill="#ff3b30"/>' : ""}
</svg>`;

render(appIcon, 1024, "build/icon.png");
render(appIcon, 256, "resources/icon.png");
render(template(false), 18, "resources/trayTemplate.png");
render(template(false), 36, "resources/trayTemplate@2x.png");
render(template(true), 18, "resources/trayMissedTemplate.png");
render(template(true), 36, "resources/trayMissedTemplate@2x.png");
render(colour(false), 32, "resources/tray.png");
render(colour(true), 32, "resources/tray-missed.png");

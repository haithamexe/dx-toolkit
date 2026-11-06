// Draws Floppy for the dashboard as SVG, from the same pixel art the desktop Floppy uses:
// public/floppy.svg (the 16-pixel icon: favicon and logo) and public/floppy-idle.svg (the sprite).
// Run after `npm run build` whenever the art in core/src/tools/floppy.ts changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOPPY_MOODS, composeFloppy, floppyIcon16, gridToRgba } from "../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "packages", "web", "public");

/** Runs of one colour per row become one rect each, so the file stays small and every pixel stays square. */
function svg(grid, title) {
  const { width, height, data } = gridToRgba(grid, "navy");
  const rects = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < width && data.subarray((y * width + end) * 4, (y * width + end) * 4 + 4).every((v, k) => v === data[i + k])) end++;
      const hex = "#" + [0, 1, 2].map((k) => data[i + k].toString(16).padStart(2, "0")).join("");
      const alpha = data[i + 3] === 255 ? "" : ` fill-opacity="${(data[i + 3] / 255).toFixed(2)}"`;
      rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex}"${alpha}/>`);
      x = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><title>${title}</title>${rects.join("")}</svg>\n`;
}

fs.writeFileSync(path.join(out, "floppy.svg"), svg(floppyIcon16("idle", true), "dx"));
fs.writeFileSync(path.join(out, "floppy-idle.svg"), svg(composeFloppy(FLOPPY_MOODS[0].frames[0], true), "Floppy"));
console.log("Wrote floppy.svg and floppy-idle.svg");

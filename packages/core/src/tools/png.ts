import zlib from "node:zlib";

/**
 * A small PNG writer for dx's own pictures (Floppy's frames and icon). RGBA, 8 bits a channel,
 * no filtering, deflated with node:zlib, so core still needs nothing beyond Node.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, start = 0xffffffff): number {
  let c = start;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `rgba` holds width × height × 4 bytes, row by row. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("A PNG needs a whole width and height.");
  if (rgba.length !== width * height * 4) throw new Error(`Expected ${width * height * 4} bytes of RGBA, got ${rgba.length}.`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filtering method other than the standard one
  ihdr[12] = 0; // not interlaced
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico holding one PNG, which Windows reads since Vista (for a shortcut's icon). */
export function pngToIco(png: Buffer, width: number, height: number): Buffer {
  return iconFile([{ png, width, height }]);
}

/** An .ico holding several PNG images, one per size; Windows picks the one it needs. */
export function iconFile(images: { png: Buffer; width: number; height: number }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ png, width, height }) => {
    const entry = Buffer.alloc(16);
    entry[0] = width >= 256 ? 0 : width;
    entry[1] = height >= 256 ? 0 : height;
    entry[2] = 0; // no palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** The ICNS image types that hold a PNG, by pixel size (the @2x types repeat a size for Retina). */
export const ICNS_TYPES: [string, number][] = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["icp6", 64],
  ["ic12", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic13", 256],
  ["ic09", 512],
  ["ic14", 512],
  ["ic10", 1024],
];

/** A macOS .icns: "icns", its length, then each image as its type, its length and the PNG (all big-endian). */
export function icnsFile(images: { type: string; png: Buffer }[]): Buffer {
  const parts = images.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

/** "#00b000" or "rgba(0,0,0,0.28)" as four bytes. */
export function parseColor(css: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(css);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Math.round(Number(rgba[4]) * 255)];
  throw new Error(`Not a colour dx draws with: ${css}`);
}

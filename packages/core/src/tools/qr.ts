/**
 * A QR code encoder, for the "open on my phone" address: byte mode, error correction level M,
 * versions 1 to 10 (up to 213 bytes), the mask with the lowest penalty. Core has no
 * dependencies, so it's written here from the standard (ISO/IEC 18004).
 */

// Per version, level M: [error correction codewords per block, [blocks, data codewords per block]...].
const BLOCKS: Array<[number, Array<[number, number]>]> = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) with the polynomial 0x11D, for Reed-Solomon.
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsRemainder(data: number[], degree: number): number[] {
  // The generator polynomial for `degree` error correction codewords.
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= mul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

function bch(value: number, poly: number, bits: number): number {
  const degree = Math.floor(Math.log2(poly));
  let v = value << degree;
  for (let i = bits + degree - 1; i >= degree; i--) if (v & (1 << i)) v ^= poly << (i - degree);
  return (value << degree) | v;
}

/** The QR code for `text`, as rows of booleans (true is dark), without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, "utf8")];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const [, groups] = BLOCKS[v - 1];
    const capacity = groups.reduce((n, [b, d]) => n + b * d, 0);
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= capacity * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error("Too long for a QR code here (at most 213 bytes).");
  const [ecLen, groups] = BLOCKS[version - 1];
  const capacity = groups.reduce((n, [b, d]) => n + b * d, 0);

  // Data bits: byte mode, the count, the bytes, a terminator, padding.
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  // Blocks, their error correction, interleaved.
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, size] of groups)
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(at, at + size));
      at += size;
    }
  const ecs = blocks.map((b) => rsRemainder(b, ecLen));
  const codewords: number[] = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.length)); i++) for (const b of blocks) if (i < b.length) codewords.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) codewords.push(e[i]);

  const size = version * 4 + 17;
  const grid: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, dark: boolean) => {
    grid[r][c] = dark;
    fixed[r][c] = true;
  };
  // Finder patterns with their separators.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]])
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
      }
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Alignment patterns, except where they'd sit on a finder.
  const pos = ALIGN[version - 1];
  for (const r of pos)
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === pos.at(-1)) || (r === pos.at(-1) && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  // Room for format and version information, and the dark module.
  for (let i = 0; i < 9; i++) {
    if (!fixed[8][i]) set(8, i, false);
    if (!fixed[i][8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  set(size - 8, 8, true);
  if (version >= 7) {
    const v = bch(version, 0x1f25, 6);
    for (let i = 0; i < 18; i++) {
      const dark = ((v >> i) & 1) === 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), dark);
      set(size - 11 + (i % 3), Math.floor(i / 3), dark);
    }
  }

  // Data, in the zigzag from the bottom right, skipping the timing column.
  let bit = 0;
  const all = codewords.flatMap((cw) => Array.from({ length: 8 }, (_, i) => ((cw >>> (7 - i)) & 1) === 1));
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fixed[r][c]) continue;
        grid[r][c] = bit < all.length ? all[bit] : false;
        bit++;
      }
  }

  // The mask with the lowest penalty.
  const MASKS: Array<(r: number, c: number) => boolean> = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  let best: boolean[][] | undefined;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const g = grid.map((row, r) => row.map((v, c) => (fixed[r][c] ? !!v : !!v !== MASKS[m](r, c))));
    // Format information: level M (00) and the mask.
    const format = bch((0b00 << 3) | m, 0x537, 5) ^ 0x5412;
    const bitAt = (i: number) => ((format >> i) & 1) === 1;
    // Around the top-left finder…
    for (let i = 0; i <= 5; i++) g[i][8] = bitAt(i);
    g[7][8] = bitAt(6);
    g[8][8] = bitAt(7);
    g[8][7] = bitAt(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = bitAt(i);
    // …and again by the other two.
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bitAt(i);
    for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bitAt(i);
    g[size - 8][8] = true;
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best!;
}

function penalty(g: boolean[][]): number {
  const n = g.length;
  let score = 0;
  // Runs of five or more of the same colour, in rows and columns.
  for (let pass = 0; pass < 2; pass++)
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const same = pass ? g[b][a] === g[b - 1][a] : g[a][b] === g[a][b - 1];
        if (same) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  // 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) score += 3;
  // Patterns that look like a finder.
  const pat = [true, false, true, true, true, false, true];
  for (let r = 0; r < n; r++)
    for (let c = 0; c + 7 <= n; c++) {
      const row = pat.every((v, i) => g[r][c + i] === v);
      const col = pat.every((v, i) => g[c + i][r] === v);
      const quiet = (get: (i: number) => boolean | undefined) => [0, 1, 2, 3].every((i) => get(i) !== true);
      if (row && (quiet((i) => g[r][c - 1 - i]) || quiet((i) => g[r][c + 7 + i]))) score += 40;
      if (col && (quiet((i) => g[c - 1 - i]?.[r]) || quiet((i) => g[c + 7 + i]?.[r]))) score += 40;
    }
  // How far the dark share is from half.
  const dark = g.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** The code as an SVG path ("M x y h1 v1 h-1 z" per dark module), with a 4-module quiet zone, for a viewBox of size+8. */
export function qrPath(matrix: boolean[][]): { size: number; d: string } {
  const parts: string[] = [];
  matrix.forEach((row, r) => row.forEach((dark, c) => dark && parts.push(`M${c + 4} ${r + 4}h1v1h-1z`)));
  return { size: matrix.length + 8, d: parts.join("") };
}

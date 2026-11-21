// NIMBARA — a travel poster for a place that isn't there.
// Pure Node built-ins only. Draws the poster procedurally into an RGB
// pixel buffer and encodes the PNG by hand (zlib + chunk structure).
// Deterministic: fixed seed, no clock, no network, no unseeded randomness.
//
// The place: NIMBARA, where a river climbs out of its valley and up into
// the dawn sky. One landmark — the Upward River — and one small red-sailed
// boat riding the current uphill, past the clouds.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const W = 800;
const H = 800;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32, fixed seed)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261121);

// ---------------------------------------------------------------------------
// Pixel buffer + drawing primitives
// ---------------------------------------------------------------------------
type RGB = [number, number, number];

const buf = Buffer.alloc(W * H * 3);

function px(x: number, y: number): number {
  return (y * W + x) * 3;
}

function setPixel(x: number, y: number, c: RGB): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = px(x | 0, y | 0);
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}

function blend(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = px(x | 0, y | 0);
  buf[i] = Math.round(buf[i] * (1 - a) + c[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + c[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + c[2] * a);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) setPixel(x, y, c);
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  const r2 = r * r;
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(W - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(x, y, c);
    }
  }
}

// Soft disc: solid core fading to transparent at the rim.
function softDisc(cx: number, cy: number, r: number, c: RGB, core: number): void {
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(W - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / r;
      if (d >= 1) continue;
      const a = d <= core ? 1 : 1 - (d - core) / (1 - core);
      blend(x, y, c, a * 0.9);
    }
  }
}

// Filled polygon (scanline fill).
function fillPoly(points: [number, number][], c: RGB): void {
  let minY = H;
  let maxY = 0;
  for (const [, y] of points) {
    minY = Math.min(minY, Math.floor(y));
    maxY = Math.max(maxY, Math.ceil(y));
  }
  minY = Math.max(0, minY);
  maxY = Math.min(H - 1, maxY);
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) {
        setPixel(x, y, c);
      }
    }
  }
}

// Thick line as a stroked segment (drawn as a chain of discs).
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / (w * 0.4)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, c);
  }
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const SKY_TOP: RGB = [16, 54, 92]; // deep dawn indigo
const SKY_MID: RGB = [38, 122, 138]; // teal
const SKY_LOW: RGB = [242, 183, 84]; // warm gold at the horizon
const CREAM: RGB = [255, 246, 224];
const NAVY: RGB = [11, 43, 58];
const GOLD: RGB = [246, 196, 69];
const RIVER: RGB = [178, 226, 214]; // pale aqua water
const RIVER_DEEP: RGB = [94, 178, 178];
const FOAM: RGB = [255, 255, 250];
const SAIL: RGB = [228, 87, 46]; // coral red sail
const HULL: RGB = [74, 44, 28];
const CLIFF: RGB = [13, 48, 66];
const PINE: RGB = [16, 74, 58];

// ---------------------------------------------------------------------------
// 1. Sky — vertical dawn gradient
// ---------------------------------------------------------------------------
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  let c: RGB;
  if (t < 0.55) c = mix(SKY_TOP, SKY_MID, t / 0.55);
  else c = mix(SKY_MID, SKY_LOW, (t - 0.55) / 0.45);
  for (let x = 0; x < W; x++) setPixel(x, y, c);
}

// ---------------------------------------------------------------------------
// 2. Stars fading out near the top (only where the sky is still dark)
// ---------------------------------------------------------------------------
for (let i = 0; i < 90; i++) {
  const x = rand() * W;
  const y = rand() * 200;
  const s = rand();
  if (s < 0.6) setPixel(x, y, [255, 250, 230]);
  else fillCircle(x, y, 1.4, [255, 250, 230]);
}

// ---------------------------------------------------------------------------
// 3. Sun — low on the left, warm glow
// ---------------------------------------------------------------------------
softDisc(150, 268, 120, [255, 214, 120], 0.25);
softDisc(150, 268, 78, [255, 228, 150], 0.4);
fillCircle(150, 268, 46, [255, 233, 168]);

// ---------------------------------------------------------------------------
// 4. Clouds — soft cream ellipses, one bank where the river vanishes
// ---------------------------------------------------------------------------
function cloud(cx: number, cy: number, w: number, h: number, a: number): void {
  // Smooth flat-bottomed cloud: a filled ellipse body plus a row of
  // heavily overlapping puffs on top, so the silhouette reads as one
  // soft mass instead of a string of beads.
  const ya0 = Math.max(0, Math.floor(cy - h * 0.55));
  const yb0 = Math.min(H - 1, Math.ceil(cy + h * 0.55));
  for (let yy = ya0; yy <= yb0; yy++) {
    for (let xx = Math.max(0, Math.floor(cx - w / 2)); xx <= Math.min(W - 1, Math.ceil(cx + w / 2)); xx++) {
      const dx = (xx - cx) / (w / 2);
      const dy = (yy - cy) / (h * 0.55);
      if (dx * dx + dy * dy <= 1) blend(xx, yy, CREAM, a * 0.9);
    }
  }
  const n = 15;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = cx - w / 2 + t * w;
    const puff = Math.sin(t * Math.PI);
    const r = h * (0.5 + 0.5 * puff);
    const xa = Math.max(0, Math.floor(x - r));
    const xb = Math.min(W - 1, Math.ceil(x + r));
    const ya = Math.max(0, Math.floor(cy - r * 0.75));
    const yb = Math.min(H - 1, Math.ceil(cy + r * 0.3));
    for (let yy = ya; yy <= yb; yy++) {
      for (let xx = xa; xx <= xb; xx++) {
        const dx = (xx - x) / r;
        const dy = (yy - cy) / (r * 0.75);
        if (dx * dx + dy * dy <= 1) blend(xx, yy, CREAM, a);
      }
    }
  }
}
cloud(560, 330, 260, 34, 0.85);
cloud(330, 210, 200, 26, 0.6);
cloud(690, 205, 190, 26, 0.75);
cloud(120, 420, 220, 26, 0.5);
cloud(640, 470, 240, 30, 0.45);

// ---------------------------------------------------------------------------
// 5. Far ridge — dark teal silhouette along the horizon
// ---------------------------------------------------------------------------
const ridge: [number, number][] = [[0, 800]];
{
  const peaks: [number, number][] = [
    [0, 560], [90, 505], [170, 545], [260, 498], [350, 540],
    [430, 512], [520, 548], [620, 505], [700, 542], [800, 516],
  ];
  for (const p of peaks) ridge.push(p);
}
ridge.push([800, 800]);
fillPoly(ridge, [24, 84, 96]);

// ---------------------------------------------------------------------------
// 6. The Upward River — a band of water climbing from the valley floor
//    up into the clouds. Quadratic bezier centreline.
// ---------------------------------------------------------------------------
const P0: [number, number] = [95, 800];
const P1: [number, number] = [130, 430];
const P2: [number, number] = [690, 215];

function riverPoint(t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
    u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1],
  ];
}
function riverWidth(t: number): number {
  return lerp(190, 56, t * t);
}

// Water body: stamp overlapping discs along the centreline.
for (let i = 0; i <= 220; i++) {
  const t = i / 220;
  const [cx, cy] = riverPoint(t);
  const w = riverWidth(t);
  // Slight vertical shading: deeper aqua at the edges is faked by a
  // second, narrower, paler stamp on top.
  fillCircle(cx, cy, w / 2, RIVER_DEEP);
  fillCircle(cx, cy, w / 2 - 9, RIVER);
}
// Foam streaks down the middle of the current.
for (let i = 0; i < 160; i++) {
  const t = rand();
  const [cx, cy] = riverPoint(t);
  const w = riverWidth(t);
  const off = (rand() - 0.5) * w * 0.55;
  const len = 6 + rand() * 22;
  // Streaks run along the river direction: approximate with short
  // horizontal-ish dashes that follow the climb.
  const ang = -0.9 + t * 0.55;
  const dx = Math.cos(ang) * len;
  const dy = Math.sin(ang) * len;
  thickLine(cx + off - dx / 2, cy - dy / 2, cx + off + dx / 2, cy + dy / 2, 2.5, FOAM);
}
// Bright foam where the river leaves the valley floor: kept inside the
// river's own width so no pale patch escapes onto the ridge.
{
  const [fx, fy] = riverPoint(0.03);
  fillCircle(fx, fy, 74, FOAM);
  fillCircle(fx + 26, fy + 12, 52, RIVER);
}

// ---------------------------------------------------------------------------
// 7. The boat — a small red-sailed boat riding the current uphill.
//    Placed at t = 0.52 on the river, tilted with the climb.
// ---------------------------------------------------------------------------
{
  const [bx, by] = riverPoint(0.52);
  // Mast leans up the slope; sail billows toward the sky.
  const mastTop: [number, number] = [bx + 6, by - 118];
  const mastBase: [number, number] = [bx + 2, by - 6];
  // Main sail: big coral triangle.
  fillPoly(
    [
      [bx + 8, by - 112],
      [bx + 96, by - 22],
      [bx + 10, by - 14],
    ],
    SAIL,
  );
  // Sail shading stripe.
  fillPoly(
    [
      [bx + 8, by - 112],
      [bx + 52, by - 62],
      [bx + 10, by - 52],
    ],
    [240, 116, 74],
  );
  // Small white jib on the far side of the mast.
  fillPoly(
    [
      [bx + 2, by - 100],
      [bx - 52, by - 18],
      [bx + 0, by - 16],
    ],
    FOAM,
  );
  // Mast.
  thickLine(mastBase[0], mastBase[1], mastTop[0], mastTop[1], 5, HULL);
  // Hull: a curved little boat, tilted nose-up.
  fillPoly(
    [
      [bx - 58, by - 12],
      [bx + 62, by - 20],
      [bx + 44, by + 14],
      [bx - 38, by + 20],
    ],
    HULL,
  );
  fillPoly(
    [
      [bx - 58, by - 12],
      [bx + 62, by - 20],
      [bx + 56, by - 8],
      [bx - 50, by - 2],
    ],
    [110, 66, 40],
  );
  // Tiny sailor seated at the tiller, inside the hull's top edge.
  fillCircle(bx + 30, by - 22, 6, [30, 30, 34]);
  // Wake foam trailing downhill behind the boat.
  for (let i = 0; i < 26; i++) {
    const t = 0.52 - 0.012 - i * 0.004;
    if (t < 0) break;
    const [wx, wy] = riverPoint(t);
    fillCircle(wx + (rand() - 0.5) * 40, wy + (rand() - 0.5) * 14, 3 + rand() * 4, FOAM);
  }
}

// ---------------------------------------------------------------------------
// 8. Foreground cliffs framing the valley, with pines on the right.
// ---------------------------------------------------------------------------
fillPoly([[0, 800], [0, 700], [150, 640], [230, 700], [210, 800]], CLIFF);
fillPoly([[800, 800], [800, 690], [660, 640], [580, 700], [610, 800]], CLIFF);
// Pines on the right cliff.
function pine(x: number, y: number, s: number): void {
  fillPoly([[x, y - 3 * s], [x - 1.1 * s, y], [x + 1.1 * s, y]], PINE);
  fillPoly([[x, y - 2.2 * s], [x - 0.85 * s, y + 0.8 * s], [x + 0.85 * s, y + 0.8 * s]], PINE);
  fillRect(x - 0.12 * s, y + 0.8 * s, x + 0.12 * s, y + 1.5 * s, HULL);
}
pine(660, 668, 26);
pine(712, 676, 20);
pine(620, 682, 15);
pine(96, 690, 18);
pine(140, 700, 13);

// ---------------------------------------------------------------------------
// 9. Birds — a few small strokes high in the sky.
// ---------------------------------------------------------------------------
function bird(x: number, y: number, s: number): void {
  thickLine(x - s, y, x, y - s * 0.45, 2.5, NAVY);
  thickLine(x, y - s * 0.45, x + s, y, 2.5, NAVY);
}
bird(470, 235, 12);
bird(518, 212, 9);
bird(428, 208, 8);
bird(560, 255, 10);

// ---------------------------------------------------------------------------
// 10. The place name — NIMBARA, hand-authored 5x7 bitmap letters,
//     cream with a navy drop shadow, set across the clear dawn sky.
// ---------------------------------------------------------------------------
const GLYPHS: Record<string, string[]> = {
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
};

function drawGlyph(ch: string, ox: number, oy: number, cell: number, c: RGB): void {
  const g = GLYPHS[ch];
  if (!g) return;
  for (let r = 0; r < 7; r++) {
    for (let col = 0; col < 5; col++) {
      if (g[r][col] === "1") {
        fillRect(ox + col * cell, oy + r * cell, ox + (col + 1) * cell - 1.5, oy + (r + 1) * cell - 1.5, c);
      }
    }
  }
}

function drawName(text: string, cell: number, gap: number, y: number): void {
  const totalW = text.length * 5 * cell + (text.length - 1) * gap;
  let x = (W - totalW) / 2;
  for (const ch of text) {
    // Navy drop shadow, then cream face.
    drawGlyph(ch, x + 5, y + 6, cell, NAVY);
    drawGlyph(ch, x, y, cell, CREAM);
    x += 5 * cell + gap;
  }
  // Gold rule beneath the name, same width as the letters.
  const ruleY = y + 7 * cell + 16;
  fillRect((W - totalW) / 2 + 40, ruleY, (W + totalW) / 2 - 40, ruleY + 6, GOLD);
  // Small gold diamonds flanking the rule.
  fillPoly(
    [[(W - totalW) / 2 + 24, ruleY + 3], [(W - totalW) / 2 + 32, ruleY - 5], [(W - totalW) / 2 + 40, ruleY + 3], [(W - totalW) / 2 + 32, ruleY + 11]],
    GOLD,
  );
  fillPoly(
    [[(W + totalW) / 2 - 40, ruleY + 3], [(W + totalW) / 2 - 32, ruleY - 5], [(W + totalW) / 2 - 24, ruleY + 3], [(W + totalW) / 2 - 32, ruleY + 11]],
    GOLD,
  );
}

drawName("NIMBARA", 16, 14, 46);

// ---------------------------------------------------------------------------
// PNG encoding — hand-built chunks, per-row adaptive filter, zlib deflate.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function filterRow(filter: number, row: Buffer, prev: Buffer | null): Buffer {
  const out = Buffer.alloc(row.length);
  const bpp = 3;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let v: number;
    if (filter === 0) v = row[i];
    else if (filter === 1) v = row[i] - a;
    else if (filter === 2) v = row[i] - b;
    else {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      v = row[i] - pr;
    }
    out[i] = v & 0xff;
  }
  return out;
}

function scoreFiltered(f: Buffer): number {
  let s = 0;
  for (let i = 0; i < f.length; i++) {
    const v = f[i] < 128 ? f[i] : f[i] - 256;
    s += Math.abs(v);
  }
  return s;
}

function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts: Buffer[] = [];
  let prev: Buffer | null = null;
  for (let y = 0; y < H; y++) {
    const row = buf.subarray(y * W * 3, (y + 1) * W * 3);
    let bestFilter = 0;
    let best: Buffer | null = null;
    let bestScore = Infinity;
    for (const f of [0, 1, 2, 4]) {
      const cand = filterRow(f, row, prev);
      const sc = scoreFiltered(cand);
      if (sc < bestScore) {
        bestScore = sc;
        bestFilter = f;
        best = cand;
      }
    }
    parts.push(Buffer.from([bestFilter]));
    parts.push(best as Buffer);
    prev = row;
  }
  const raw = Buffer.concat(parts);
  const compressed = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const outDir = process.argv[2] ?? process.env.OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
const png = encodePNG();
writeFileSync(join(outDir, "entry.png"), png);

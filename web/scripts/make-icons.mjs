// Draws the Pythia mark (the laurel sprig on a lime tile) into web/public:
// pythia.svg (favicon) and the PWA / Home Screen PNGs, with no image
// dependencies. The sprig's numbers come from src/components/laurel.ts (Node
// 24 strips the types), so the in-app BrandMark, the favicon and the icons
// cannot drift apart. PNGs are rasterized with 4x4 supersampling as RGBA.
//   node web/scripts/make-icons.mjs
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { LEAVES, STEM, leafPath, leafTransform, stemPath } from '../src/components/laurel.ts'

// Same values as the accent and on-accent tokens in src/index.css.
const ACCENT_HEX = '#ccff00'
const INK_HEX = '#0f0f10'
const ACCENT = [0xcc, 0xff, 0x00]
const INK = [0x0f, 0x0f, 0x10]

const CORNER = 0.22 // rounded-square corner radius, as a share of the size

// ---- Geometry in the 64x64 sprig box ----

function cubic(p0, p1, p2, p3, steps) {
  const points = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
  return points
}

/** Each leaf as a polygon, already rotated and translated. */
function leafPolygon(leaf) {
  const [ax, ay] = leaf.c1
  const [bx, by] = leaf.c2
  const tip = [0, -leaf.length]
  const local = [[0, 0], ...cubic([0, 0], [ax, ay], [bx, by], tip, 24), ...cubic(tip, [-bx, by], [-ax, ay], [0, 0], 24)]
  const a = (leaf.angle * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return local.map(([x, y]) => [leaf.x + x * cos - y * sin, leaf.y + x * sin + y * cos])
}

/** Center and angles of the stem arc (SVG endpoint-to-center conversion, rx = ry, no rotation). */
function stemArc() {
  const [x1, y1] = STEM.from
  const [x2, y2] = STEM.to
  const r = STEM.radius
  const hx = (x1 - x2) / 2
  const hy = (y1 - y2) / 2
  const sign = 1 // large-arc 0, sweep 1: the flags differ
  const coef = sign * Math.sqrt(Math.max(0, (r * r - hx * hx - hy * hy) / (hx * hx + hy * hy)))
  const cx = coef * hy + (x1 + x2) / 2
  const cy = -coef * hx + (y1 + y2) / 2
  const start = Math.atan2(y1 - cy, x1 - cx)
  let sweep = Math.atan2(y2 - cy, x2 - cx) - start
  if (sweep < 0) sweep += 2 * Math.PI // sweep flag 1: angles increase
  return { cx, cy, r, start, sweep }
}

const polygons = LEAVES.map(leafPolygon)
const arc = stemArc()

function insidePolygon(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function onStem(x, y) {
  let a = Math.atan2(y - arc.cy, x - arc.cx) - arc.start
  while (a < 0) a += 2 * Math.PI
  const half = STEM.width / 2
  if (a <= arc.sweep) return Math.abs(Math.hypot(x - arc.cx, y - arc.cy) - arc.r) <= half
  // Round caps at both ends.
  return Math.hypot(x - STEM.from[0], y - STEM.from[1]) <= half || Math.hypot(x - STEM.to[0], y - STEM.to[1]) <= half
}

function inSprig(x, y) {
  return onStem(x, y) || polygons.some((poly) => insidePolygon(x, y, poly))
}

// Bounding box of the sprig, so the icons can center it.
function sprigBounds() {
  const xs = []
  const ys = []
  for (const poly of polygons) for (const [x, y] of poly) xs.push(x), ys.push(y)
  for (let i = 0; i <= 64; i++) {
    const a = arc.start + (arc.sweep * i) / 64
    xs.push(arc.cx + arc.r * Math.cos(a))
    ys.push(arc.cy + arc.r * Math.sin(a))
  }
  const pad = STEM.width / 2
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad }
}

const bounds = sprigBounds()

/** Maps the sprig into a unit square: its longer side becomes `share` of the icon, centered. */
function placement(share) {
  const w = bounds.maxX - bounds.minX
  const h = bounds.maxY - bounds.minY
  const scale = share / Math.max(w, h)
  return {
    scale,
    dx: 0.5 - ((bounds.minX + bounds.maxX) / 2) * scale,
    dy: 0.5 - ((bounds.minY + bounds.maxY) / 2) * scale,
  }
}

// ---- PNG ----

function colorAt(x, y, fullBleed, place) {
  if (!fullBleed) {
    // Rounded square: outside the corner arcs is transparent.
    const cx = Math.min(Math.max(x, CORNER), 1 - CORNER)
    const cy = Math.min(Math.max(y, CORNER), 1 - CORNER)
    if (Math.hypot(x - cx, y - cy) > CORNER) return null
  }
  return inSprig((x - place.dx) / place.scale, (y - place.dy) / place.scale) ? INK : ACCENT
}

function render(size, fullBleed) {
  // Maskable and Apple icons get cropped by the OS, so the sprig stays inside
  // the maskable safe zone (a centered circle of radius 0.40).
  const place = placement(fullBleed ? 0.56 : 0.7)
  const samples = 4
  const rows = []
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const color = colorAt((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size, fullBleed, place)
          if (color === null) continue
          r += color[0]
          g += color[1]
          b += color[2]
          a += 1
        }
      }
      const o = 1 + px * 4
      if (a > 0) {
        row[o] = Math.round(r / a)
        row[o + 1] = Math.round(g / a)
        row[o + 2] = Math.round(b / a)
      }
      row[o + 3] = Math.round((a / (samples * samples)) * 255)
    }
    rows.push(row)
  }
  return png(size, Buffer.concat(rows))
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- SVG favicon ----

function round(n) {
  return Number(n.toFixed(4))
}

function svg() {
  const place = placement(0.7)
  const s = round(place.scale * 64)
  const tx = round(place.dx * 64)
  const ty = round(place.dy * 64)
  const leaves = LEAVES.map((leaf) => `<path transform="${leafTransform(leaf)}" d="${leafPath(leaf)}"/>`).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${ACCENT_HEX}"/>` +
    `<g transform="translate(${tx} ${ty}) scale(${s})" fill="${INK_HEX}">` +
    `<path d="${stemPath()}" fill="none" stroke="${INK_HEX}" stroke-width="${STEM.width}" stroke-linecap="round"/>` +
    leaves +
    `</g></svg>\n`
  )
}

const out = new URL('../public/', import.meta.url)
writeFileSync(new URL('pythia.svg', out), svg())
console.log('wrote public/pythia.svg')
const icons = [
  ['pwa-192.png', 192, false],
  ['pwa-512.png', 512, false],
  // Maskable and Apple icons are full-bleed; the OS applies its own shape.
  ['pwa-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]
for (const [name, size, fullBleed] of icons) {
  writeFileSync(new URL(name, out), render(size, fullBleed))
  console.log(`wrote public/${name}`)
}

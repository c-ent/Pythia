// Draws the PWA and Home Screen PNG icons into web/public with no image
// dependencies: the mark is two circles, rasterized with 4x4 supersampling
// and written as RGBA PNGs. Same mark as public/pythia.svg.
//   node web/scripts/make-icons.mjs
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const CANVAS = [0x0e, 0x10, 0x14]
const ACCENT = [0x8a, 0xb4, 0xf8]
const INK = [0xe6, 0xe8, 0xeb]

// Normalized to the icon size. The ring's outer edge (0.30) stays inside the
// maskable safe zone (a circle of radius 0.40).
const RING_OUTER = 0.3
const RING_INNER = 0.22
const DOT = 0.1
const CORNER = 0.22

function colorAt(x, y, fullBleed) {
  if (!fullBleed) {
    // Rounded square: outside the corner arcs is transparent.
    const cx = Math.min(Math.max(x, CORNER), 1 - CORNER)
    const cy = Math.min(Math.max(y, CORNER), 1 - CORNER)
    if (Math.hypot(x - cx, y - cy) > CORNER) return null
  }
  const r = Math.hypot(x - 0.5, y - 0.5)
  if (r <= DOT) return INK
  if (r >= RING_INNER && r <= RING_OUTER) return ACCENT
  return CANVAS
}

function render(size, fullBleed) {
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
          const color = colorAt((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size, fullBleed)
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

const out = new URL('../public/', import.meta.url)
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

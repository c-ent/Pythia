/**
 * The Pythia mark: the laurel sprig from docs/agent/mockups/Main.dc.html, in
 * a 64x64 box. BrandMark draws it as SVG and scripts/make-icons.mjs rasterizes
 * the same numbers into the PWA icons, so change the mark here only, then
 * rerun `node web/scripts/make-icons.mjs` and update public/pythia.svg.
 */

/** The curved stem: an SVG arc (small arc, sweep 1) stroked with round caps. */
export const STEM = {
  from: [36.05, 54.22],
  to: [36.05, 9.78],
  radius: 23,
  width: 2.6,
} as const

/**
 * One leaf: a symmetric pointed shape from (0, 0) to (0, -length), with
 * cubic control points (c1, c2) on the right half mirrored to the left,
 * then translated to (x, y) and rotated by `angle` degrees.
 */
export type Leaf = {
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly c1: readonly [number, number]
  readonly c2: readonly [number, number]
  readonly length: number
}

const BIG = { c1: [4.37, -3.25], c2: [3.45, -10.14], length: 13 } as const
const WIDE = { c1: [4.56, -3.25], c2: [3.6, -10.14], length: 13 } as const
const MID = { c1: [4.37, -3.12], c2: [3.45, -9.75], length: 12.5 } as const
const SMALL = { c1: [3.8, -2.75], c2: [3, -8.58], length: 11 } as const
const TIP = { c1: [3.61, -2.5], c2: [2.85, -7.8], length: 10 } as const

export const LEAVES: readonly Leaf[] = [
  { x: 28.81, y: 50.84, angle: -105, ...BIG },
  { x: 28.81, y: 50.84, angle: -5, ...BIG },
  { x: 21.15, y: 41.72, angle: -75, ...WIDE },
  { x: 21.15, y: 41.72, angle: 25, ...WIDE },
  { x: 19.09, y: 30, angle: -45, ...WIDE },
  { x: 19.09, y: 30, angle: 55, ...WIDE },
  { x: 23.16, y: 18.81, angle: -15, ...MID },
  { x: 23.16, y: 18.81, angle: 85, ...MID },
  { x: 30.5, y: 12.08, angle: 10, ...SMALL },
  { x: 30.5, y: 12.08, angle: 110, ...SMALL },
  { x: 36.05, y: 9.78, angle: 75, ...TIP },
]

export function stemPath(): string {
  const { from, to, radius } = STEM
  return `M${from[0]} ${from[1]}A${radius} ${radius} 0 0 1 ${to[0]} ${to[1]}`
}

export function leafPath(leaf: Leaf): string {
  const [ax, ay] = leaf.c1
  const [bx, by] = leaf.c2
  return `M0 0C${ax} ${ay} ${bx} ${by} 0 ${-leaf.length}C${-bx} ${by} ${-ax} ${ay} 0 0Z`
}

export function leafTransform(leaf: Leaf): string {
  return `translate(${leaf.x} ${leaf.y}) rotate(${leaf.angle})`
}

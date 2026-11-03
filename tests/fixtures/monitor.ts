import sharp from "sharp"

export type MonitorOptions = {
  sys: number | string
  dia: number | string
  pul: number | string
  scale?: number
  rotation?: number
  background?: string
  labelSize?: number
}

const WIDTH = 1200
const HEIGHT = 1600
const SEGMENT_WIDTH = 68
const SEGMENT_HEIGHT = 132
const SEGMENT_THICKNESS = 16
const CELL_GAP = 17

const activeSegments: Record<string, string[]> = {
  "0": ["top", "upperLeft", "upperRight", "lowerLeft", "lowerRight", "bottom"],
  "1": ["upperRight", "lowerRight"],
  "2": ["top", "upperRight", "middle", "lowerLeft", "bottom"],
  "3": ["top", "upperRight", "middle", "lowerRight", "bottom"],
  "4": ["upperLeft", "upperRight", "middle", "lowerRight"],
  "5": ["top", "upperLeft", "middle", "lowerRight", "bottom"],
  "6": ["top", "upperLeft", "middle", "lowerLeft", "lowerRight", "bottom"],
  "7": ["top", "upperRight", "lowerRight"],
  "8": ["top", "upperLeft", "upperRight", "middle", "lowerLeft", "lowerRight", "bottom"],
  "9": ["top", "upperLeft", "upperRight", "middle", "lowerRight", "bottom"],
  E: ["top", "upperLeft", "middle", "lowerLeft", "bottom"],
}

type Segment = "top" | "upperLeft" | "upperRight" | "middle" | "lowerLeft" | "lowerRight" | "bottom"

function polygon(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ")
}

function segmentPoints(segment: Segment): Array<[number, number]> {
  const w = SEGMENT_WIDTH
  const h = SEGMENT_HEIGHT
  const t = SEGMENT_THICKNESS
  const middle = h / 2

  switch (segment) {
    case "top":
      return [[t, 0], [w - t, 0], [w, t / 2], [w - t, t], [t, t], [0, t / 2]]
    case "middle":
      return [[t, middle - t / 2], [w - t, middle - t / 2], [w, middle], [w - t, middle + t / 2], [t, middle + t / 2], [0, middle]]
    case "bottom":
      return [[t, h - t], [w - t, h - t], [w, h - t / 2], [w - t, h], [t, h], [0, h - t / 2]]
    case "upperLeft":
      return [[0, t / 2], [t, 0], [t, middle - t / 2], [t / 2, middle], [0, middle - t / 2]]
    case "upperRight":
      return [[w - t, 0], [w, t / 2], [w, middle - t / 2], [w - t / 2, middle], [w - t, middle - t / 2]]
    case "lowerLeft":
      return [[0, middle + t / 2], [t / 2, middle], [t, middle + t / 2], [t, h], [0, h - t / 2]]
    case "lowerRight":
      return [[w - t, middle + t / 2], [w - t / 2, middle], [w, middle + t / 2], [w, h - t / 2], [w - t, h]]
  }
}

function digitMarkup(value: string, x: number, y: number): string {
  const active = activeSegments[value.toUpperCase()]
  if (!active) throw new Error(`Unsupported monitor display character: ${value}`)
  return active.map((segment) => {
    const points = polygon(segmentPoints(segment as Segment))
    return `<polygon points="${points}" transform="translate(${x} ${y})" fill="#263640" opacity="0.84"/>`
  }).join("")
}

function readingMarkup(value: number | string, x: number, y: number): string {
  const text = String(value).toUpperCase()
  if (!/^\d{2,3}$/.test(text) && !/^E\d{1,2}$/.test(text)) {
    throw new Error("Monitor readings must contain two or three digits (pulse may also be E1)")
  }

  const digits = [...text]
  const slotCount = 3
  const totalWidth = slotCount * SEGMENT_WIDTH + (slotCount - 1) * CELL_GAP
  const right = x + totalWidth
  return digits.map((digit, index) => {
    const cellX = right - (digits.length - index) * (SEGMENT_WIDTH + CELL_GAP) + CELL_GAP
    return digitMarkup(digit, cellX, y)
  }).join("")
}

/** Make a local JPEG monitor image with labels and separately drawn LCD segments. */
export async function makeMonitor(options: MonitorOptions): Promise<Buffer> {
  const scale = options.scale ?? 1
  const rotation = options.rotation ?? 0
  const labelSize = options.labelSize ?? 45
  const background = options.background ?? "#eeeae1"
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1.2) throw new Error("Scale must be between 0 and 1.2")
  if (!Number.isFinite(rotation) || Math.abs(rotation) > 12) throw new Error("Rotation must be between -12 and 12 degrees")
  if (!Number.isFinite(labelSize) || labelSize < 24 || labelSize > 64) throw new Error("Label size must be between 24 and 64 pixels")
  if (!/^#[0-9a-f]{6}$/i.test(background)) throw new Error("Background must be a six-digit hex color")

  const rows = [
    { name: "SYS", value: options.sys, top: 382 },
    { name: "DIA", value: options.dia, top: 562 },
    { name: "PUL", value: options.pul, top: 742 },
  ]
  const digitsX = 470
  const labelX = 755
  const rowMarkup = rows.map(({ name, value, top }) => {
    return readingMarkup(value, digitsX, top) +
      `<text x="${labelX}" y="${top + SEGMENT_HEIGHT * 0.63}" font-family="Arial, Helvetica, sans-serif" font-size="${labelSize}" font-weight="500" letter-spacing="1.5" fill="#293640">${name}</text>` +
      `<text x="${labelX + 2}" y="${top + SEGMENT_HEIGHT * 0.63 + 34}" font-family="Arial, Helvetica, sans-serif" font-size="23" fill="#4c5960">${name === "PUL" ? "/min" : "mmHg"}</text>`
  }).join("")

  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <linearGradient id="case" x1="0" y1="0" x2="0.9" y2="1">
        <stop offset="0" stop-color="#fffefa"/>
        <stop offset="1" stop-color="#d9d6ce"/>
      </linearGradient>
      <linearGradient id="screen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#c3c8c5"/>
        <stop offset="1" stop-color="#abb2b0"/>
      </linearGradient>
      <filter id="shadow" x="-15%" y="-10%" width="130%" height="125%">
        <feGaussianBlur stdDeviation="15"/>
      </filter>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
    <ellipse cx="600" cy="1400" rx="360" ry="58" fill="#5d5b54" opacity="0.18" filter="url(#shadow)"/>
    <g transform="translate(${WIDTH * (1 - scale) / 2} ${HEIGHT * (1 - scale) / 2}) scale(${scale})">
      <rect x="112" y="100" width="976" height="1400" rx="100" fill="url(#case)" stroke="#c9c6be" stroke-width="5"/>
      <rect x="195" y="204" width="810" height="1120" rx="70" fill="#f4f2ed" stroke="#d5d2c9" stroke-width="4"/>
      <text x="600" y="290" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700" fill="#47535a">A&amp;D MEDICAL</text>
      <rect x="270" y="336" width="660" height="620" rx="22" fill="#747d7b" opacity="0.25"/>
      <rect x="285" y="346" width="630" height="600" rx="18" fill="url(#screen)" stroke="#8e9794" stroke-width="3"/>
      <rect x="297" y="357" width="606" height="578" rx="12" fill="none" stroke="#d4d8d4" stroke-width="2" opacity="0.45"/>
      ${rowMarkup}
      <rect x="405" y="1080" width="390" height="250" rx="120" fill="#203d62"/>
      <text x="600" y="1187" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="44" fill="#f8f8f8">START</text>
      <circle cx="600" cy="1250" r="24" fill="none" stroke="#f8f8f8" stroke-width="7"/>
    </g>
  </svg>`)

  return sharp(svg)
    .rotate(rotation, { background })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer()
}

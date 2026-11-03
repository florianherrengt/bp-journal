import { join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { createWorker, OEM, PSM, type Block, type Worker } from "tesseract.js"

export type RecognizedReading = { sys: number; dia: number; pul: number }

const labels = ["SYS", "DIA", "PUL"] as const
const digitSegments: Record<number, number[][]> = {
  0: [[1, 1, 1, 0, 1, 1, 1]],
  1: [[0, 0, 1, 0, 0, 1, 0]],
  2: [[1, 0, 1, 1, 1, 0, 1]],
  3: [[1, 0, 1, 1, 0, 1, 1]],
  4: [[0, 1, 1, 1, 0, 1, 0]],
  5: [[1, 1, 0, 1, 0, 1, 1]],
  6: [[1, 1, 0, 1, 1, 1, 1]],
  7: [[1, 0, 1, 0, 0, 1, 0], [1, 1, 1, 0, 0, 1, 0]],
  8: [[1, 1, 1, 1, 1, 1, 1]],
  9: [[1, 1, 1, 1, 0, 1, 1]],
}

let workerPromise: Promise<Worker> | undefined

const root = fileURLToPath(new URL("../..", import.meta.url))

function worker(): Promise<Worker> {
  workerPromise ??= createWorker("eng", OEM.LSTM_ONLY, {
    langPath: join(root, "assets", "tessdata"),
    cacheMethod: "none",
    gzip: true,
  }).then(async (instance) => {
    await instance.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    return instance
  })
  return workerPromise
}

type Image = { data: Buffer; width: number; height: number }
type Box = { x0: number; y0: number; x1: number; y1: number }

const segmentSampleRects: Array<[number, number, number, number]> = [
  [0.28, 0.06, 0.72, 0.22], // top
  [0.06, 0.20, 0.30, 0.43], // upper left
  [0.70, 0.20, 0.94, 0.43], // upper right
  [0.28, 0.42, 0.72, 0.58], // middle
  [0.06, 0.57, 0.30, 0.80], // lower left
  [0.70, 0.57, 0.94, 0.80], // lower right
  [0.28, 0.78, 0.72, 0.94], // bottom
]

function darkRatio(image: Image, box: Box, rect: [number, number, number, number], isInk: (x: number, y: number) => boolean): number {
  const x0 = Math.max(0, box.x0 + Math.floor((box.x1 - box.x0) * rect[0]))
  const y0 = Math.max(0, box.y0 + Math.floor((box.y1 - box.y0) * rect[1]))
  const x1 = Math.min(image.width, box.x0 + Math.ceil((box.x1 - box.x0) * rect[2]))
  const y1 = Math.min(image.height, box.y0 + Math.ceil((box.y1 - box.y0) * rect[3]))
  let dark = 0
  let count = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (isInk(x, y)) dark++
    count++
  }
  return count ? dark / count : 0
}

function readDigits(image: Image, row: Box, label: Box): number {
  const labelHeight = (label.y1 - label.y0)
  const rowHeight = row.y1 - row.y0
  const leftPadding = labelHeight / rowHeight > 0.25 ? labelHeight * 4.3 : labelHeight * 10
  const roi: Box = {
    x0: Math.max(0, Math.floor(label.x0 - leftPadding)),
    y0: Math.max(0, Math.floor(row.y0 + labelHeight * 0.3)),
    x1: Math.min(image.width, Math.floor(label.x0 - labelHeight * 0.25)),
    y1: Math.min(image.height, Math.ceil(row.y1 + labelHeight * 0.3)),
  }
  const minRun = Math.max(3, Math.round(labelHeight * 0.1))
  const minColumnInk = Math.round((roi.y1 - roi.y0) * 0.035)
  const scanRuns = (isInk: (x: number, y: number) => boolean): Array<[number, number]> => {
    const found: Array<[number, number]> = []
    let runStart = -1
    let lastInk = -1
    for (let x = roi.x0; x < roi.x1; x++) {
      let dark = 0
      for (let y = roi.y0; y < roi.y1; y++) if (isInk(x, y)) dark++
      if (dark >= minColumnInk) {
        if (runStart < 0) runStart = x
        lastInk = x
      } else if (runStart >= 0 && x - lastInk > minRun) {
        if (lastInk - runStart + 1 >= minRun) found.push([runStart, lastInk])
        runStart = -1
      }
    }
    if (runStart >= 0 && lastInk - runStart + 1 >= minRun) found.push([runStart, lastInk])
    return found
  }
  const fixedIsInk = (x: number, y: number): boolean => image.data[y * image.width + x]! <= 85
  const fixedRuns = scanRuns(fixedIsInk)
  let backgroundPixels = 0
  for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
    if (image.data[y * image.width + x]! <= 85) backgroundPixels++
  }
  // JPEG compression can split the ink run without changing the dark-background condition.
  const adaptiveThreshold = backgroundPixels / ((roi.x1 - roi.x0) * (roi.y1 - roi.y0)) > 0.5
  const columnThreshold = new Array<number>(roi.x1 - roi.x0)
  const rowColumnThreshold = new Array<number>(roi.x1 - roi.x0)
  for (let x = roi.x0; x < roi.x1; x++) {
    if (adaptiveThreshold) {
      const column = Array.from({ length: roi.y1 - roi.y0 }, (_, offset) => image.data[(roi.y0 + offset) * image.width + x]!).sort((a, b) => a - b)
      columnThreshold[x - roi.x0] = Math.min(85, column[Math.floor(column.length * 0.8)]! - 40)
      rowColumnThreshold[x - roi.x0] = Math.min(85, column[Math.floor(column.length * 0.8)]! - 45)
    } else {
      columnThreshold[x - roi.x0] = 85
      rowColumnThreshold[x - roi.x0] = 85
    }
  }
  const adaptiveIsInk = (x: number, y: number): boolean =>
    image.data[y * image.width + x]! < columnThreshold[x - roi.x0]!
  const isInk = adaptiveThreshold ? adaptiveIsInk : fixedIsInk
  const isRowInk = (x: number, y: number): boolean =>
    image.data[y * image.width + x]! < rowColumnThreshold[x - roi.x0]!
  const rawRuns = adaptiveThreshold ? scanRuns(adaptiveIsInk) : fixedRuns
  const runs = rawRuns.filter(([start, end]) => end - start + 1 >= labelHeight * (adaptiveThreshold ? 0.2 : 0.25))
  if (runs.length > 3) throw new Error("Could not isolate the display digits")

  const digits: number[] = []
  for (const [x0, x1] of runs) {
    const width = x1 - x0 + 1
    const glyph: Box = { x0, y0: roi.y0, x1: x1 + 1, y1: roi.y1 }
    const rowInk = new Array<number>(glyph.y1 - glyph.y0).fill(0)
    for (let y = glyph.y0; y < glyph.y1; y++) {
      let ink = 0
      for (let x = glyph.x0; x < glyph.x1; x++) if (isRowInk(x, y)) ink++
      rowInk[y - glyph.y0] = ink
    }
    const rowThreshold = Math.max(2, width * 0.2)
    const y0 = rowInk.findIndex((ink) => ink >= rowThreshold)
    const y1 = rowInk.findLastIndex((ink) => ink >= rowThreshold)
    if (y0 < 0 || y1 <= y0) throw new Error("Could not isolate a display digit")
    glyph.y0 = y0 + roi.y0
    glyph.y1 = y1 + roi.y0 + 1
    const glyphHeight = glyph.y1 - glyph.y0
    const narrowOne = adaptiveThreshold ? width / glyphHeight < 0.25 : width < rowHeight * 0.3
    if (narrowOne) {
      const minimumOneHeight = adaptiveThreshold ? labelHeight * 1.1 : rowHeight * 0.5
      if (glyphHeight < minimumOneHeight) throw new Error("Could not confidently read a display digit")
      digits.push(1)
      continue
    }
    const activeThresholds = [0.32, 0.16, 0.16, 0.4, 0.16, 0.16, 0.34]
    const segmentInk = adaptiveThreshold ? fixedIsInk : isInk
    const observed = segmentSampleRects.map((rect, index) => Number(darkRatio(image, glyph, rect, segmentInk) >= activeThresholds[index]!))
    const match = Object.entries(digitSegments)
      .map(([digit, segments]) => ({
        digit: Number(digit),
        errors: Math.min(...segments.map((pattern) =>
          pattern.reduce((sum, active, index) => sum + Number(active !== observed[index]), 0),
        )),
      }))
      .sort((a, b) => a.errors - b.errors)
    if (match[0]!.errors !== 0 || match[1]!.errors === 0) throw new Error("Could not confidently read a display digit")
    digits.push(match[0]!.digit)
  }
  if (digits.length < 2 || digits.length > 3) throw new Error("Could not find a complete display reading")
  return Number(digits.join(""))
}

function labelWords(blocks: Block[] | null): Map<typeof labels[number], Box> {
  const found = new Map<typeof labels[number], Box>()
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = word.text.toUpperCase().replace(/[^A-Z]/g, "")
          const label = labels.find((candidate) => candidate === text)
          if (!label || word.confidence < 35) continue
          found.set(label, word.bbox)
        }
      }
    }
  }
  return found
}

export async function recognizeReading(input: Buffer): Promise<RecognizedReading> {
  const { data, info } = await sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const image: Image = { data: Buffer.from(data), width: info.width, height: info.height }
  const textSharp = sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
  const textImage = await textSharp.toBuffer()
  const textSize = await sharp(textImage).metadata()
  const result = await (await worker()).recognize(textImage, undefined, { blocks: true })
  const labelsFound = labelWords(result.data.blocks)
  if (labelsFound.size !== labels.length) throw new Error("Could not locate all three blood-pressure readings in the photo")

  const scale = info.height / textSize.height!
  const labelBoxes = labels.map((label) => {
    const box = labelsFound.get(label)!
    return {
      x0: box.x0 * scale,
      y0: box.y0 * scale,
      x1: box.x1 * scale,
      y1: box.y1 * scale,
    }
  })
  const labelCenters = labelBoxes.map((box) => (box.y0 + box.y1) / 2)
  const rowBands = labelCenters.map((center, index) => ({
    y0: index === 0 ? center - (labelCenters[index + 1]! - center) / 2 : (labelCenters[index - 1]! + center) / 2,
    y1: index === labelCenters.length - 1 ? center + (center - labelCenters[index - 1]!) / 2 : (center + labelCenters[index + 1]!) / 2,
  }))
  const readField = (label: typeof labels[number]): number => {
    const index = labels.indexOf(label)
    const row = rowBands[index]!
    try {
      return readDigits(image, { x0: 0, y0: row.y0, x1: image.width, y1: row.y1 }, labelBoxes[index]!)
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unreadable digits"
      throw new Error(`Could not read the ${label} value: ${detail}`)
    }
  }

  const reading = {
    sys: readField("SYS"),
    dia: readField("DIA"),
    pul: readField("PUL"),
  }
  if (Object.values(reading).some((value) => !Number.isInteger(value) || value < 1 || value > 999)) {
    throw new Error("The photo contains an invalid display reading")
  }
  return reading
}

export async function closeOcr(): Promise<void> {
  const pending = workerPromise
  workerPromise = undefined
  if (pending) await (await pending).terminate()
}

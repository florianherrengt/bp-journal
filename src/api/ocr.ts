import { join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { createWorker, OEM, PSM, type Block, type Worker } from "tesseract.js"

export type RecognizedReading = { sys: number; dia: number; pul: number }

export class PhotoRecognitionError extends Error {}

const labels = ["SYS", "DIA", "PUL"] as const
const labelNames = { SYS: "systolic", DIA: "diastolic", PUL: "pulse" } as const
const displayPhotoTip = "Try a closer photo with the full display visible."
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
type Label = typeof labels[number]

const displayBands: Record<Label, readonly [above: number, below: number]> = {
  SYS: [0.2, 0.63],
  DIA: [0.42, 0.55],
  PUL: [0.5, 0.23],
}

const segmentSampleRects: Array<[number, number, number, number]> = [
  [0.28, 0.02, 0.72, 0.18], // top
  [0.06, 0.20, 0.30, 0.43], // upper left
  [0.70, 0.20, 0.94, 0.43], // upper right
  [0.28, 0.42, 0.72, 0.58], // middle
  [0.06, 0.57, 0.30, 0.80], // lower left
  [0.70, 0.57, 0.94, 0.80], // lower right
  [0.28, 0.82, 0.72, 0.98], // bottom
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

function localDisplayInk(image: Image, crop: Box, labelHeight: number, straighten: boolean): (x: number, y: number) => boolean {
  const radius = Math.round(labelHeight / 2)
  const width = crop.x1 - crop.x0
  const pixels = new Uint8Array(width * (crop.y1 - crop.y0))
  const gray = (x: number, y: number): number => image.data[
    Math.max(0, Math.min(image.height - 1, y)) * image.width + Math.max(0, Math.min(image.width - 1, x))
  ]!
  const index = (x: number, y: number): number => (y - crop.y0) * width + x - crop.x0
  for (let y = crop.y0; y < crop.y1; y++) {
    // Straighten the slanted LCD glyphs for column projection.
    const slant = straighten ? Math.round(0.05 * (y - (crop.y0 + crop.y1) / 2)) : 0
    for (let x = crop.x0; x < crop.x1; x++) {
      const sourceX = x - slant
      const pixel = gray(sourceX, y)
      let left = pixel, right = pixel, above = pixel, below = pixel
      for (let offset = 1; offset <= radius; offset++) {
        left = Math.max(left, gray(sourceX - offset, y))
        right = Math.max(right, gray(sourceX + offset, y))
        above = Math.max(above, gray(sourceX, y - offset))
        below = Math.max(below, gray(sourceX, y + offset))
      }
      // A segment is darker than its surroundings on both sides of one axis.
      // A change in the LCD background by itself doesn't meet that condition.
      const background = Math.max(Math.min(left, right), Math.min(above, below))
      const minimumContrast = Math.max(10, Math.min(18, background / 2))
      pixels[index(x, y)] = Number(background - pixel >= minimumContrast)
    }
  }
  return (x, y) => pixels[index(x, y)] === 1
}

function readDigits(image: Image, row: Box, label: Box, contrastRetry?: Label): number {
  const labelHeight = label.y1 - label.y0
  const rowHeight = row.y1 - row.y0
  const largeLabel = labelHeight / rowHeight > 0.25
  const leftPadding = labelHeight * (largeLabel ? (contrastRetry === "SYS" ? 5.3 : 4.3) : 10)
  const center = (label.y0 + label.y1) / 2
  // On this display the pressure labels sit above center and pulse digits are smaller.
  const relativeBand = contrastRetry && largeLabel ? displayBands[contrastRetry] : undefined
  const roi: Box = {
    x0: Math.max(0, Math.floor(label.x0 - leftPadding)),
    y0: Math.max(0, Math.floor(relativeBand ? center - rowHeight * relativeBand[0] : row.y0 + labelHeight * 0.3)),
    x1: Math.min(image.width, Math.floor(label.x0 - labelHeight * (contrastRetry ? 0.5 : 0.25))),
    y1: Math.min(image.height, Math.ceil(relativeBand ? center + rowHeight * relativeBand[1] : row.y1 + labelHeight * 0.3)),
  }
  if (roi.x1 <= roi.x0 || roi.y1 <= roi.y0) throw new Error("Could not isolate the display digits")
  const minRun = Math.max(3, Math.round(labelHeight * 0.1))
  const maxGap = contrastRetry ? 2 : minRun
  const minColumnInk = Math.round((roi.y1 - roi.y0) * (contrastRetry ? (contrastRetry === "PUL" ? 0.07 : 0.1) : 0.035))
  const scanRuns = (isInk: (x: number, y: number) => boolean): Array<[number, number]> => {
    const found: Array<[number, number]> = []
    let runStart = -1
    let lastInk = -1
    for (let x = roi.x0; x < roi.x1; x++) {
      let dark = 0
      let continuousInk = 0
      let longestInk = 0
      for (let y = roi.y0; y < roi.y1; y++) {
        if (isInk(x, y)) {
          dark++
          continuousInk++
          longestInk = Math.max(longestInk, continuousInk)
        } else {
          continuousInk = 0
        }
      }
      // Scattered reflection pixels can meet the column total without forming a stroke.
      if (dark >= minColumnInk && (!contrastRetry || longestInk >= minRun)) {
        if (runStart < 0) runStart = x
        lastInk = x
      } else if (runStart >= 0 && x - lastInk > maxGap) {
        if (lastInk - runStart + 1 >= minRun) found.push([runStart, lastInk])
        runStart = -1
      }
    }
    if (runStart >= 0 && lastInk - runStart + 1 >= minRun) found.push([runStart, lastInk])
    return found
  }
  const fixedIsInk = contrastRetry
    ? localDisplayInk(image, roi, labelHeight, true)
    : (x: number, y: number): boolean => image.data[y * image.width + x]! <= 85
  let fixedRuns = scanRuns(fixedIsInk)
  // A narrow run at the crop boundary can be a clipped leading one.
  if (!contrastRetry && fixedRuns[0]?.[0] === roi.x0 && fixedRuns[0][1] - fixedRuns[0][0] + 1 < labelHeight * 0.25) {
    roi.x0 = Math.max(0, Math.floor(roi.x0 - labelHeight))
    fixedRuns = scanRuns(fixedIsInk)
  }
  let darkBackground = false
  if (!contrastRetry) {
    let backgroundPixels = 0
    for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
      if (fixedIsInk(x, y)) backgroundPixels++
    }
    darkBackground = backgroundPixels * 2 > (roi.x1 - roi.x0) * (roi.y1 - roi.y0)
  }
  const ink = darkBackground ? localDisplayInk(image, roi, labelHeight, false) : fixedIsInk
  const rawRuns = darkBackground ? scanRuns(ink) : fixedRuns
  const runs = rawRuns.filter(([start, end]) => end - start + 1 >= labelHeight * (contrastRetry ? 0.18 : darkBackground ? 0.2 : 0.25))
  if (runs.length > 3) throw new Error("Could not isolate the display digits")

  const digits: number[] = []
  for (const [x0, x1] of runs) {
    const width = x1 - x0 + 1
    const glyph: Box = { x0, y0: roi.y0, x1: x1 + 1, y1: roi.y1 }
    // Light LCD strokes need a local threshold, while keeping separation from
    // the background and preserving the existing reader for shadowed displays.
    let threshold = 85
    if (!darkBackground && !contrastRetry) {
      const pixels: number[] = []
      for (let y = glyph.y0; y < glyph.y1; y++) for (let x = glyph.x0; x < glyph.x1; x++) pixels.push(image.data[y * image.width + x]!)
      pixels.sort((a, b) => a - b)
      threshold = Math.max(85, Math.min(
        pixels[Math.floor(pixels.length * 0.1)]! + 20,
        pixels[Math.floor(pixels.length * 0.8)]! - 40,
      ))
    }
    const glyphInk = darkBackground || contrastRetry ? ink : (x: number, y: number): boolean => image.data[y * image.width + x]! <= threshold
    const rowInk = new Array<number>(glyph.y1 - glyph.y0).fill(0)
    for (let y = glyph.y0; y < glyph.y1; y++) {
      let ink = 0
      for (let x = glyph.x0; x < glyph.x1; x++) if (glyphInk(x, y)) ink++
      rowInk[y - glyph.y0] = ink
    }
    const rowThreshold = Math.max(2, width * 0.15)
    // Ignore isolated screen edges rather than stretching a digit to include them.
    const minRowRun = Math.max(3, Math.round(labelHeight * 0.2))
    const hasInkRun = (_ink: number, index: number): boolean =>
      index + minRowRun <= rowInk.length && rowInk.slice(index, index + minRowRun).every((ink) => ink >= rowThreshold)
    const y0 = rowInk.findIndex(hasInkRun)
    const y1 = rowInk.findLastIndex(hasInkRun) + minRowRun - 1
    if (y0 < 0 || y1 <= y0) throw new Error("Could not isolate a display digit")
    glyph.y0 = y0 + roi.y0
    glyph.y1 = y1 + roi.y0 + 1
    const glyphHeight = glyph.y1 - glyph.y0
    if (glyphHeight <= width) throw new Error("Could not confidently read a display digit")
    const minimumOneHeight = darkBackground ? labelHeight * 1.1 : rowHeight * 0.5
    // A half-erased one is too short and narrow to be a complete wide digit.
    if (width / glyphHeight < 0.35 && glyphHeight < minimumOneHeight) {
      throw new Error("Could not confidently read a display digit")
    }
    const narrowOne = width / glyphHeight < (contrastRetry ? 0.31 : 0.25)
    if (narrowOne) {
      digits.push(1)
      continue
    }
    const activeThresholds = [0.32, 0.16, 0.16, 0.4, 0.16, 0.16, 0.34]
    const observed = segmentSampleRects.map((rect, index) => Number(darkRatio(image, glyph, rect, glyphInk) >= activeThresholds[index]!))
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

function labelWords(blocks: Block[] | null): Map<Label, Box> {
  const found = new Map<Label, Box>()
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

function missingDisplayLabels(found: ReturnType<typeof labelWords>): PhotoRecognitionError {
  const missing = labels.filter((label) => !found.has(label))
  const names = new Intl.ListFormat("en").format(missing)
  const noun = missing.length === 1 ? "label" : "labels"
  return new PhotoRecognitionError(`BP Journal couldn't locate the ${names} ${noun} on the monitor display. ${displayPhotoTip}`)
}

export async function recognizeReading(input: Buffer): Promise<RecognizedReading> {
  const { data, info } = await sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch((cause: unknown) => {
      throw new PhotoRecognitionError("BP Journal couldn't open the JPEG to read it. Try a new copy of the photo.", { cause })
    })

  const image: Image = { data: Buffer.from(data), width: info.width, height: info.height }
  const textSharp = sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
  const firstTextImage = await textSharp.clone()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const textImage = attempt === 0
        ? firstTextImage
        : await textSharp.clone().resize({ width: 2400, height: 2400, fit: "inside" }).png().toBuffer()
      const result = await (await worker()).recognize(textImage, undefined, { blocks: true })
      const labelsFound = labelWords(result.data.blocks)
      const textSize = await sharp(textImage).metadata()
      const scale = info.height / textSize.height!
      const boxHeight = (box: Box): number => box.y1 - box.y0
      if (labelsFound.size === labels.length) {
        // Tesseract can join a label to neighboring text into one oversized word.
        const heights = labels.map((label) => boxHeight(labelsFound.get(label)!))
        const outlier = heights.findIndex((height, index) =>
          heights.every((other, otherIndex) => index === otherIndex || height > 2 * other),
        )
        if (outlier >= 0) labelsFound.delete(labels[outlier]!)
      }
      const labelBoxes = labels.map((label) => {
        const box = labelsFound.get(label)
        return box && { x0: box.x0 * scale, y0: box.y0 * scale, x1: box.x1 * scale, y1: box.y1 * scale }
      })

      if (labelsFound.size !== labels.length) {
        if (attempt === 0 || labelsFound.size !== 2) throw missingDisplayLabels(labelsFound)
        const missing = labelBoxes.findIndex((box) => !box)
        const [first, second] = labelBoxes.flatMap((box, index) => box ? [{ box, index }] : [])
        if (!first || !second) throw missingDisplayLabels(labelsFound)
        const ratio = (missing - first.index) / (second.index - first.index)
        const from = first.box
        const to = second.box
        const centerX = (from.x0 + from.x1 + ratio * (to.x0 + to.x1 - from.x0 - from.x1)) / 2
        const centerY = (from.y0 + from.y1 + ratio * (to.y0 + to.y1 - from.y0 - from.y1)) / 2
        const halfWidth = (from.x1 - from.x0 + to.x1 - to.x0) * 0.3
        const halfHeight = (boxHeight(from) + boxHeight(to)) * 0.375
        const left = Math.max(0, Math.floor(centerX - halfWidth))
        const top = Math.max(0, Math.floor(centerY - halfHeight))
        const width = Math.min(image.width, Math.ceil(centerX + halfWidth)) - left
        const height = Math.min(image.height, Math.ceil(centerY + halfHeight)) - top
        if (width <= 0 || height <= 0) throw missingDisplayLabels(labelsFound)
        const focusedImage = await textSharp.clone()
          .extract({ left, top, width, height })
          .resize({ width: width * 3, height: height * 3 })
          .png()
          .toBuffer()
        const focusedResult = await (await worker()).recognize(focusedImage, undefined, { blocks: true })
        const box = labelWords(focusedResult.data.blocks).get(labels[missing]!)
        if (!box) throw missingDisplayLabels(labelsFound)
        labelBoxes[missing] = {
          x0: left + box.x0 / 3,
          y0: top + box.y0 / 3,
          x1: left + box.x1 / 3,
          y1: top + box.y1 / 3,
        }
      }

      const labelCenters = labelBoxes.map((box) => (box!.y0 + box!.y1) / 2)
      const rowBands = labelCenters.map((center, index) => ({
        y0: index === 0 ? center - (labelCenters[index + 1]! - center) / 2 : (labelCenters[index - 1]! + center) / 2,
        y1: index === labelCenters.length - 1 ? center + (center - labelCenters[index - 1]!) / 2 : (center + labelCenters[index + 1]!) / 2,
      }))
      const readField = (label: Label): number => {
        const index = labels.indexOf(label)
        const row = rowBands[index]!
        const band = { x0: 0, y0: row.y0, x1: image.width, y1: row.y1 }
        try {
          try {
            return readDigits(image, band, labelBoxes[index]!)
          } catch {
            return readDigits(image, band, labelBoxes[index]!, label)
          }
        } catch (cause) {
          throw new PhotoRecognitionError(
            `BP Journal found the ${label} label but couldn't read the ${labelNames[label]} number. ${displayPhotoTip}`,
            { cause },
          )
        }
      }

      const reading = {
        sys: readField("SYS"),
        dia: readField("DIA"),
        pul: readField("PUL"),
      }
      if (Object.values(reading).some((value) => !Number.isInteger(value) || value < 1 || value > 999)) {
        throw new PhotoRecognitionError("BP Journal read a number outside the range it can save (1 to 999). Check the monitor display and try again.")
      }
      return reading
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

export async function closeOcr(): Promise<void> {
  const pending = workerPromise
  workerPromise = undefined
  if (pending) await (await pending).terminate()
}

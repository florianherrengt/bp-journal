import { afterAll, describe, expect, it, vi } from "vitest"
import sharp from "sharp"
import { makeMonitor } from "../../tests/fixtures/monitor.ts"
import { closeOcr, recognizeReading } from "./ocr.ts"

async function monitorWithUa611SevenStyle(): Promise<Buffer> {
  const photo = await makeMonitor({ sys: 128, dia: 76, pul: 61 })
  const upperLeftSegment = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><polygon points="640,570 656,562 656,619 648,628 640,620" fill="#263640" opacity="0.84"/></svg>`)
  return sharp(photo).composite([{ input: upperLeftSegment }]).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer()
}

async function monitorWithDamagedOnes(half: "upper" | "lower"): Promise<Buffer> {
  const photo = await makeMonitor({ sys: 111, dia: 111, pul: 111 })
  const y = half === "upper" ? 382 : 448
  const erasedHalf = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect x="470" y="${y}" width="238" height="66" fill="#f4f2ed"/></svg>`)
  return sharp(photo).composite([{ input: erasedHalf }]).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer()
}

async function monitorWithDimLcd(sys: number | string, dia: number | string, pul: number | string): Promise<Buffer> {
  const photo = await makeMonitor({ sys, dia, pul })
  const { data, info } = await sharp(photo).raw().toBuffer({ resolveWithObject: true })
  const dimmed = Buffer.from(data)
  for (let y = 742; y < 874; y++) for (let x = 470; x < 708; x++) {
    const index = (y * info.width + x) * info.channels
    const luma = (data[index]! * 0.299) + (data[index + 1]! * 0.587) + (data[index + 2]! * 0.114)
    const value = luma > 60 ? 74 : 20
    dimmed[index] = value
    dimmed[index + 1] = value
    dimmed[index + 2] = value
  }
  return sharp(dimmed, { raw: info }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer()
}

async function monitorWithReflection(
  reading: { sys: number; dia: number; pul: number | string },
  shadowStart: number,
): Promise<Buffer> {
  const photo = await makeMonitor(reading)
  const { data, info } = await sharp(photo).raw().toBuffer({ resolveWithObject: true })
  for (let y = 360; y < 920; y++) for (let x = 300; x < 740; x++) {
    const index = (y * info.width + x) * info.channels
    const isDigit = data[index + 1]! < 90
    const inShadow = y > shadowStart
    const level = isDigit ? (inShadow ? 24 : 48) : (inShadow ? 68 : 132)
    data.fill(level, index, index + info.channels)
  }
  return sharp(data, { raw: info }).jpeg({ quality: 85 }).toBuffer()
}

async function browserCompressed(photo: Buffer): Promise<Buffer> {
  const source = await sharp(photo).resize({ width: 2400, height: 3200, fit: "inside" }).jpeg({ quality: 95 }).toBuffer()
  return sharp(source)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
}

describe("local blood-pressure photo recognition", () => {
  afterAll(async () => closeOcr())

  it.each(["888", "456", "789", "101", "116", "967", "990"])(
    "reads three digit monitor values containing %s",
    async (value) => {
      const photo = await makeMonitor({ sys: value, dia: value, pul: value })
      const expected = Number(value)
      await expect(recognizeReading(photo)).resolves.toEqual({ sys: expected, dia: expected, pul: expected })
    },
  )

  it("reads an original generated monitor JPEG", async () => {
    const photo = await makeMonitor({ sys: 128, dia: 76, pul: 61 })
    await expect(recognizeReading(photo)).resolves.toEqual({ sys: 128, dia: 76, pul: 61 })
  })

  it("reads a generated monitor JPEG after browser-style compression", async () => {
    const photo = await browserCompressed(await makeMonitor({ sys: 128, dia: 76, pul: 61 }))
    await expect(recognizeReading(photo)).resolves.toEqual({ sys: 128, dia: 76, pul: 61 })
  })

  it.each([0.6, 0.8])("locates labels on a more distant monitor at scale %s", async (scale) => {
    const photo = await makeMonitor({ sys: 119, dia: 83, pul: 63, scale })
    await expect(recognizeReading(photo)).resolves.toEqual({ sys: 119, dia: 83, pul: 63 })
  })

  it("reads pulse digits that are smaller than the pressure digits", async () => {
    const photo = await makeMonitor({ sys: 119, dia: 83, pul: 63 })
    const pulse = await sharp(photo).extract({ left: 470, top: 742, width: 238, height: 132 })
      .resize({ width: 155 }).png().toBuffer()
    const erasedPulse = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect x="470" y="742" width="238" height="132" fill="#b2b9b7"/></svg>`)
    const smallerPulse = await sharp(photo)
      .composite([{ input: erasedPulse }, { input: pulse, left: 553, top: 765 }])
      .jpeg({ quality: 85 }).toBuffer()
    await expect(recognizeReading(smallerPulse)).resolves.toEqual({ sys: 119, dia: 83, pul: 63 })
  })

  it("ignores a thin display edge above the pressure digits", async () => {
    const photo = await makeMonitor({ sys: 119, dia: 83, pul: 63 })
    const edge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect x="470" y="367" width="238" height="2" fill="#263640"/></svg>`)
    const withEdge = await sharp(photo).composite([{ input: edge }]).jpeg({ quality: 85 }).toBuffer()
    await expect(recognizeReading(withEdge)).resolves.toEqual({ sys: 119, dia: 83, pul: 63 })
  })

  it.each([
    { shadowStart: 477, reading: { sys: 130, dia: 70, pul: 63 } },
    { shadowStart: 500, reading: { sys: 118, dia: 82, pul: 65 } },
  ])("reads complete digits when a reflection darkens the display after row $shadowStart", async ({ shadowStart, reading }) => {
    await expect(recognizeReading(await monitorWithReflection(reading, shadowStart))).resolves.toEqual(reading)
  })

  it("rejects an error display under a reflection without mistaking its strokes for ones", async () => {
    const photo = await monitorWithReflection({ sys: 118, dia: 82, pul: "E1" }, 500)
    await expect(recognizeReading(photo)).rejects.toThrow("couldn't read the pulse number")
  })

  it.each([
    { sys: 116, dia: 67, pul: 61, expected: { sys: 116, dia: 67, pul: 61 } },
    { sys: 98, dia: 58, pul: 104, expected: { sys: 98, dia: 58, pul: 104 } },
  ])("reads mixed two and three digit values", async ({ sys, dia, pul, expected }) => {
    await expect(recognizeReading(await makeMonitor({ sys, dia, pul }))).resolves.toEqual(expected)
  })

  it("reads a resized, slightly rotated photo", async () => {
    const photo = await makeMonitor({ sys: 116, dia: 67, pul: 61, scale: 0.8, rotation: 3 })
    await expect(recognizeReading(photo)).resolves.toEqual({ sys: 116, dia: 67, pul: 61 })
  })

  it("reads a browser-sized JPEG recompressed at quality 85", async () => {
    const photo = await browserCompressed(await monitorWithUa611SevenStyle())
    await expect(recognizeReading(photo)).resolves.toEqual({ sys: 128, dia: 76, pul: 61 })
  })

  it("keeps adaptive digit isolation when compression leaves only short background runs", async () => {
    const photo = await makeMonitor({ sys: 116, dia: 67, pul: 61 })
    const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600">
      <rect x="425" y="735" width="61" height="176" fill="#4a4a4a"/>
      <rect x="491" y="735" width="55" height="176" fill="#4a4a4a"/>
      <rect x="629" y="735" width="55" height="176" fill="#4a4a4a"/>
      <rect x="713" y="735" width="31" height="176" fill="#4a4a4a"/>
    </svg>`)
    const withDarkBackground = await sharp(photo)
      .composite([{ input: background }])
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      .toBuffer()
    await expect(recognizeReading(await browserCompressed(withDarkBackground)))
      .resolves.toEqual({ sys: 116, dia: 67, pul: 61 })
  })

  it("recognizes the UA611 Plus seven segment seven with its upper-left bar", async () => {
    await expect(recognizeReading(await monitorWithUa611SevenStyle())).resolves.toEqual({ sys: 128, dia: 76, pul: 61 })
  })

  it("rejects a monitor error display instead of treating it as a pulse reading", async () => {
    const photo = await makeMonitor({ sys: 116, dia: 67, pul: "E1" })
    await expect(recognizeReading(photo)).rejects.toThrow("couldn't read the pulse number")
  })

  it("rejects an error display against a dim LCD background", async () => {
    await expect(recognizeReading(await monitorWithDimLcd(116, 67, "E1"))).rejects.toThrow("couldn't read the pulse number")
  })

  it.each(["upper", "lower"] as const)("rejects a %s-half damaged 111 against a dim LCD background", async (half) => {
    const photo = await monitorWithDamagedOnes(half)
    const { data, info } = await sharp(photo).raw().toBuffer({ resolveWithObject: true })
    const dimmed = Buffer.from(data)
    for (let y = 382; y < 874; y++) for (let x = 470; x < 708; x++) {
      const index = (y * info.width + x) * info.channels
      const luma = data[index]! * 0.299 + data[index + 1]! * 0.587 + data[index + 2]! * 0.114
      const value = luma > 60 ? 74 : 20
      dimmed[index] = value
      dimmed[index + 1] = value
      dimmed[index + 2] = value
    }
    const dimmedPhoto = await sharp(dimmed, { raw: info }).jpeg({ quality: 90 }).toBuffer()
    await expect(recognizeReading(dimmedPhoto)).rejects.toThrow("couldn't read the systolic number")
  })

  it.each(["upper", "lower"] as const)("rejects ones with the %s half erased", async (half) => {
    await expect(recognizeReading(await monitorWithDamagedOnes(half))).rejects.toThrow("couldn't read the systolic number")
  })

  it("rejects an unreadable or non-monitor image without returning guessed values", async () => {
    await expect(recognizeReading(Buffer.from("not a jpeg"))).rejects.toThrow()
  })
})

describe("focused OCR label retry", () => {
  it.each([
    { problem: "low-confidence DIA", sys: [94, 630, 690], dia: [6, 900, 960], label: "DIA", y0: 33, y1: 153 },
    { problem: "missing SYS", sys: [0, 630, 690], dia: [94, 900, 960], label: "SYS", y0: 48, y1: 168 },
    { problem: "oversized SYS", sys: [94, 580, 760], dia: [94, 900, 960], label: "SYS", y0: 48, y1: 168 },
  ])("recovers $problem from a crop positioned by the other two labels", async ({ sys, dia, label, y0, y1 }) => {
    const fakeWord = (text: string, confidence: number, x0: number, y0: number, x1: number, y1: number) => ({
      text,
      confidence,
      bbox: { x0, y0, x1, y1 },
    })
    const resultWithWords = (words: ReturnType<typeof fakeWord>[]) => ({
      data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] },
    })
    const mockRecognize = vi.fn(async (input: Buffer) => {
      const { height } = await sharp(input).metadata()
      if (height === 1200) {
        return resultWithWords([fakeWord("PUL", 96, 566, 585, 626, 620)])
      }
      if (height === 2400) {
        return resultWithWords([
          fakeWord("SYS", sys[0]!, 1132, sys[1]!, 1252, sys[2]!),
          fakeWord("DIA", dia[0]!, 1132, dia[1]!, 1252, dia[2]!),
          fakeWord("PUL", 93, 1132, 1170, 1252, 1239),
        ])
      }
      return resultWithWords([fakeWord(label, 95, 26, y0, 266, y1)])
    })
    const mockCreateWorker = vi.fn(async () => ({
      setParameters: vi.fn(),
      terminate: vi.fn(),
      recognize: mockRecognize,
    }))

    vi.doMock("tesseract.js", () => ({
      createWorker: mockCreateWorker,
      OEM: { LSTM_ONLY: 1 },
      PSM: { SPARSE_TEXT: 11 },
    }))
    vi.resetModules()
    const { closeOcr: closeFocusedOcr, recognizeReading: recognizeFocusedReading } = await import("./ocr.ts")
    try {
      const photo = await makeMonitor({ sys: 119, dia: 83, pul: 63 })
      await expect(recognizeFocusedReading(photo)).resolves.toEqual({ sys: 119, dia: 83, pul: 63 })
      expect(mockRecognize).toHaveBeenCalledTimes(3)
    } finally {
      await closeFocusedOcr()
      vi.doUnmock("tesseract.js")
      vi.resetModules()
    }
  })

  it("retries at full resolution when a first-pass label box cannot isolate digits", async () => {
    const fakeWord = (text: string, confidence: number, x0: number, y0: number, x1: number, y1: number) => ({
      text,
      confidence,
      bbox: { x0, y0, x1, y1 },
    })
    const resultWithWords = (words: ReturnType<typeof fakeWord>[]) => ({
      data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] },
    })
    const mockRecognize = vi.fn(async (input: Buffer) => {
      const { height } = await sharp(input).metadata()
      if (height === 1200) {
        return resultWithWords([
          fakeWord("SYS", 48, 475, 286, 635, 385),
          fakeWord("DIA", 96, 569, 459, 625, 484),
          fakeWord("PUL", 96, 568, 594, 633, 620),
        ])
      }
      return resultWithWords([
        fakeWord("SYS", 93, 1136, 648, 1270, 700),
        fakeWord("DIA", 95, 1138, 918, 1250, 968),
        fakeWord("PUL", 96, 1136, 1188, 1266, 1240),
      ])
    })
    const mockCreateWorker = vi.fn(async () => ({
      setParameters: vi.fn(),
      terminate: vi.fn(),
      recognize: mockRecognize,
    }))

    vi.doMock("tesseract.js", () => ({
      createWorker: mockCreateWorker,
      OEM: { LSTM_ONLY: 1 },
      PSM: { SPARSE_TEXT: 11 },
    }))
    vi.resetModules()
    const { closeOcr: closeFocusedOcr, recognizeReading: recognizeFocusedReading } = await import("./ocr.ts")
    try {
      const photo = await makeMonitor({ sys: 116, dia: 67, pul: 61 })
      await expect(recognizeFocusedReading(photo)).resolves.toEqual({ sys: 116, dia: 67, pul: 61 })
      expect(mockRecognize).toHaveBeenCalledTimes(2)
    } finally {
      await closeFocusedOcr()
      vi.doUnmock("tesseract.js")
      vi.resetModules()
    }
  })
})

import { afterAll, describe, expect, it } from "vitest"
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
    await expect(recognizeReading(photo)).rejects.toThrow("Could not read the PUL value")
  })

  it("rejects an error display against a dim LCD background", async () => {
    await expect(recognizeReading(await monitorWithDimLcd(116, 67, "E1"))).rejects.toThrow("Could not read the PUL value")
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
    await expect(recognizeReading(dimmedPhoto)).rejects.toThrow("Could not read the SYS value")
  })

  it.each(["upper", "lower"] as const)("rejects ones with the %s half erased", async (half) => {
    await expect(recognizeReading(await monitorWithDamagedOnes(half))).rejects.toThrow("Could not read the SYS value")
  })

  it("rejects an unreadable or non-monitor image without returning guessed values", async () => {
    await expect(recognizeReading(Buffer.from("not a jpeg"))).rejects.toThrow()
  })
})

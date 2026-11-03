import ExifReader from "exifreader"
import moment from "moment"

const EXIF_DATE = "YYYY:MM:DD HH:mm:ss"

function tagDescription(
  tags: unknown,
  name: string,
): string | undefined {
  if (typeof tags !== "object" || tags === null) return undefined
  const value = (tags as Record<string, unknown>)[name]
  if (typeof value === "object" && value !== null && "description" in value) {
    const description = (value as { description?: unknown }).description
    if (typeof description === "string") return description.trim()
  }
  return undefined
}

async function capturedTime(file: File): Promise<string | undefined> {
  try {
    const tags: unknown = await ExifReader.load(file, { async: true })
    const original = tagDescription(tags, "DateTimeOriginal")
    if (!original) return undefined

    const offset = tagDescription(tags, "OffsetTimeOriginal")
    if (offset && /^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(offset)) {
      const parsed = moment.parseZone(`${original}${offset}`, `${EXIF_DATE}Z`, true)
      return parsed.isValid() ? parsed.toISOString() : undefined
    }

    // Cameras often omit their timezone. In that case, interpret the image's
    // wall-clock time in the browser's local timezone.
    const parsed = moment(original, EXIF_DATE, true)
    return parsed.isValid() ? parsed.toISOString() : undefined
  } catch {
    // A missing or malformed EXIF date falls back to the server's upload time.
    return undefined
  }
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function resizedJpeg(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      const longest = Math.max(image.naturalWidth, image.naturalHeight)
      if (!longest) {
        reject(new Error("The photo could not be read. Choose another JPEG."))
        return
      }

      const scale = Math.min(1, 1600 / longest)
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext("2d")
      if (!context) {
        reject(new Error("Your browser could not prepare this photo."))
        return
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        (blob) => blob
          ? resolve(blob)
          : reject(new Error("Your browser could not prepare this photo.")),
        "image/jpeg",
        0.85,
      )
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("This JPEG could not be opened. Try another photo."))
    }
    image.src = url
  })
}

export type PreparedPhoto = {
  image: Blob
  capturedAt?: string
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const signature = new Uint8Array(await file.slice(0, 3).arrayBuffer())
  if (!hasJpegSignature(signature)) {
    throw new Error("Choose a JPEG photo to record a reading.")
  }

  // Read the camera's date before re-encoding, because image re-encoding drops EXIF.
  const timestamp = await capturedTime(file)
  return { image: await resizedJpeg(file), capturedAt: timestamp }
}

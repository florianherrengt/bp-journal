import { randomUUID, timingSafeEqual, createHash } from "node:crypto"

import { getConnInfo } from "@hono/node-server/conninfo"
import { Hono, type Context, type Next } from "hono"
import { bodyLimit } from "hono/body-limit"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { sign, verify } from "hono/jwt"
import moment from "moment"

import type { Arm, Reading, UploadJob } from "../shared.ts"
import type { AppConfig } from "./config.ts"
import { recognizeReading } from "./ocr.ts"
import { createCsvStore } from "./store.ts"

const COOKIE_NAME = "bp_session"
const SESSION_SECONDS = 60 * 60 * 24 * 7
const MAX_ACTIVE_UPLOADS = 20
const MAX_RETAINED_JOBS = 50
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_ATTEMPTS = 8
const MAX_LOGIN_BODY_BYTES = 16 * 1024

type Recognizer = (image: Buffer) => Promise<{
  sys: number
  dia: number
  pul: number
}>

export type AppOptions = {
  recognize?: Recognizer
  now?: () => Date
}

type QueuedUpload = { job: UploadJob; image: Buffer; capturedAt: string; arm: Arm }

function isArm(value: unknown): value is Arm {
  return value === "left" || value === "right" || value === "unknown"
}

function isSameOrigin(request: Request, configuredOrigin: string): boolean {
  const origin = request.headers.get("origin")
  return origin !== null && origin === configuredOrigin
}

function passwordMatches(candidate: unknown, password: string): boolean {
  if (typeof candidate !== "string") return false
  const expected = createHash("sha256").update(password).digest()
  const actual = createHash("sha256").update(candidate).digest()
  return timingSafeEqual(expected, actual)
}

function csvResponse(csv: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="blood-pressure-readings.csv"',
      "Cache-Control": "no-store",
    },
  })
}

export function createApp(config: AppConfig, options: AppOptions = {}) {
  const app = new Hono()
  const store = createCsvStore(config.csvPath)
  const recognize = options.recognize ?? recognizeReading
  const now = options.now ?? (() => new Date())
  const jobs = new Map<string, UploadJob>()
  const uploadQueue: QueuedUpload[] = []
  const failedLogins = new Map<string, { attempts: number; expiresAt: number }>()
  let processingQueue = false

  app.use("/api/*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })

  async function authenticated(c: Context) {
    const token = getCookie(c, COOKIE_NAME)
    if (!token) return false
    try {
      const session = await verify(token, config.sessionSecret, "HS256")
      return session.sub === "bp-owner" && typeof session.exp === "number"
    } catch {
      return false
    }
  }

  const requireLogin = async (c: Context, next: Next) => {
    if (!(await authenticated(c))) return c.json({ error: "Sign in to continue." }, 401)
    await next()
  }

  async function processUploads(): Promise<void> {
    if (processingQueue) return
    processingQueue = true

    while (uploadQueue.length > 0) {
      const upload = uploadQueue.shift()!
      try {
        let reading: Reading
        try {
          const values = await recognize(upload.image)
          for (const value of [values.sys, values.dia, values.pul]) {
            if (!Number.isSafeInteger(value) || value <= 0) {
              throw new Error("OCR returned invalid measurement")
            }
          }

          reading = {
            id: upload.job.id,
            capturedAt: upload.capturedAt,
            sys: values.sys,
            dia: values.dia,
            pul: values.pul,
            arm: upload.arm,
          }
        } catch (error) {
          console.error(`Upload ${upload.job.id} could not be read:`, error)
          upload.job.status = "error"
          upload.job.error = "Couldn't read this photo. Try a clearer, closer image."
          continue
        }

        try {
          await store.append(reading)
        } catch (error) {
          console.error(`Reading from upload ${upload.job.id} could not be saved:`, error)
          upload.job.status = "error"
          upload.job.error = "Reading could not be saved. Check server storage and try again."
          continue
        }

        upload.job.status = "saved"
        upload.job.reading = reading
      } finally {
        // Dropping the only image reference discards the original photo after reading.
        upload.image = Buffer.alloc(0)
      }
    }

    processingQueue = false
  }

  function addJob(job: UploadJob): void {
    jobs.set(job.id, job)
    if (jobs.size > MAX_RETAINED_JOBS) {
      for (const [id, retained] of jobs) {
        if (retained.status !== "processing") jobs.delete(id)
        if (jobs.size <= MAX_RETAINED_JOBS) break
      }
    }
  }

  async function checkOrigin(c: Context, next: Next) {
    if (!isSameOrigin(c.req.raw, config.appOrigin)) {
      return c.json({ error: "Request origin is not allowed." }, 403)
    }
    await next()
  }

  app.onError((error, c) => {
    console.error("API request failed:", error)
    return c.json({ error: "The request could not be completed." }, 500)
  })

  app.use("/api/login", bodyLimit({
    maxSize: MAX_LOGIN_BODY_BYTES,
    onError: (c) => c.json({ error: "The login request is too large." }, 413),
  }))

  app.post("/api/login", checkOrigin, async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Enter the installation password." }, 400)
    }

    let remote = "unknown"
    try {
      remote = getConnInfo(c as never).remote.address ?? remote
    } catch {
      // Hono's in-memory request helper has no network connection metadata.
    }

    const time = now().getTime()
    for (const [address, attempts] of failedLogins) {
      if (attempts.expiresAt <= time) failedLogins.delete(address)
    }
    const locked = failedLogins.get(remote)
    if (locked && locked.attempts >= LOGIN_ATTEMPTS && locked.expiresAt > time) {
      c.header("Retry-After", String(Math.ceil((locked.expiresAt - time) / 1000)))
      return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429)
    }

    const password = body !== null && typeof body === "object" && "password" in body
      ? body.password
      : undefined
    if (!passwordMatches(password, config.password)) {
      const entry = locked && locked.expiresAt > time
        ? locked
        : { attempts: 0, expiresAt: time + LOGIN_WINDOW_MS }
      entry.attempts += 1
      failedLogins.set(remote, entry)
      return c.json({ error: "The password is incorrect." }, 401)
    }

    failedLogins.delete(remote)
    const token = await sign({
      sub: "bp-owner",
      iat: Math.floor(time / 1000),
      exp: Math.floor(time / 1000) + SESSION_SECONDS,
    }, config.sessionSecret)
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_SECONDS,
    })
    return c.json({ ok: true })
  })

  app.get("/api/session", async (c) =>
    c.json({ authenticated: await authenticated(c) }),
  )

  app.post("/api/logout", checkOrigin, (c) => {
    deleteCookie(c, COOKIE_NAME, {
      path: "/",
      secure: config.secureCookies,
      sameSite: "Strict",
      httpOnly: true,
    })
    return c.json({ ok: true })
  })

  app.use("/api/readings", requireLogin)
  app.use("/api/readings/*", requireLogin)
  app.use("/api/readings.csv", requireLogin)
  app.use("/api/uploads", requireLogin)
  app.use("/api/uploads/*", requireLogin)
  app.use("/api/uploads", bodyLimit({
    maxSize: config.maxUploadBytes + 64 * 1024,
    onError: (c) => c.json({ error: "This photo is too large to upload." }, 413),
  }))

  app.get("/api/readings", async (c) => {
    try {
      return c.json({ readings: await store.read() })
    } catch {
      return c.json({ error: "The readings file could not be read." }, 500)
    }
  })

  app.get("/api/readings.csv", async (c) => {
    try {
      const readings = await store.read()
      const rows = [
        "id,captured_at,sys,dia,pul,arm",
        ...readings.map((row) => [
          row.id,
          row.capturedAt,
          row.sys,
          row.dia,
          row.pul,
          row.arm,
        ].join(",")),
      ]
      return csvResponse(`${rows.join("\n")}\n`)
    } catch {
      return c.json({ error: "The readings file could not be read." }, 500)
    }
  })

  app.get("/api/uploads", (c) =>
    c.json({ uploads: [...jobs.values()].map((job) => ({ ...job })) }),
  )

  app.get("/api/uploads/:id", (c) => {
    const job = jobs.get(c.req.param("id"))
    if (!job) return c.json({ error: "Upload not found." }, 404)
    return c.json({ ...job })
  })

  app.post("/api/uploads", checkOrigin, async (c) => {
    let form: Record<string, string | File | (string | File)[] | undefined>
    try {
      form = await c.req.parseBody()
    } catch {
      return c.json({ error: "Choose a JPEG photo to upload." }, 400)
    }

    const photo = form.photo
    if (!(photo instanceof File)) {
      return c.json({ error: "Choose a JPEG photo to upload." }, 400)
    }
    if (photo.size < 3 || photo.size > config.maxUploadBytes) {
      return c.json({ error: "This photo is empty or too large." }, 413)
    }

    const image = Buffer.from(await photo.arrayBuffer())
    if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
      return c.json({ error: "Please upload a JPEG photo." }, 415)
    }

    const arm = form.arm === undefined || form.arm === "" ? "unknown" : form.arm
    if (!isArm(arm)) return c.json({ error: "Choose a valid arm." }, 400)

    let capturedAt = now().toISOString()
    const suppliedTime = form.capturedAt
    if (typeof suppliedTime === "string" && suppliedTime.length > 0) {
      if (!moment(suppliedTime, moment.ISO_8601, true).isValid()) {
        return c.json({ error: "The photo's capture date is invalid." }, 400)
      }
      capturedAt = moment(suppliedTime).toISOString()
    }

    if (uploadQueue.length >= MAX_ACTIVE_UPLOADS) {
      return c.json({ error: "The upload queue is full. Try again shortly." }, 429)
    }

    const id = randomUUID()
    const job: UploadJob = {
      id,
      status: "processing",
      uploadedAt: now().toISOString(),
    }
    addJob(job)
    uploadQueue.push({ job, image, capturedAt, arm })
    queueMicrotask(() => void processUploads())

    return c.json({ id, status: "processing" }, 202)
  })

  return app
}

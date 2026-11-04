import { randomUUID, timingSafeEqual, createHash } from "node:crypto"
import { join } from "node:path"

import { getConnInfo } from "@hono/node-server/conninfo"
import { Hono, type Context, type Next } from "hono"
import { bodyLimit } from "hono/body-limit"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { sign, verify } from "hono/jwt"
import moment from "moment"

import type { Arm, Reading, UploadJob } from "../shared.ts"
import type { AppConfig } from "./config.ts"
import { PhotoRecognitionError, recognizeReading } from "./ocr.ts"
import { createCsvStore } from "./store.ts"

const COOKIE_NAME = "bp_session"
const SESSION_SECONDS = 60 * 60 * 24 * 365
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

type AppEnv = { Variables: { username: string } }
type UserJob = { username: string; job: UploadJob }
type QueuedUpload = UserJob & { image: Buffer; capturedAt: string; arm: Arm }

function isUsername(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,251}$/.test(value)
}

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

function csvResponse(csv: string, username: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${username}.csv"`,
      "Cache-Control": "no-store",
    },
  })
}

export function createApp(config: AppConfig, options: AppOptions = {}) {
  const app = new Hono<AppEnv>()
  const stores = new Map<string, ReturnType<typeof createCsvStore>>()
  const recognize = options.recognize ?? recognizeReading
  const now = options.now ?? (() => new Date())
  const jobs = new Map<string, UserJob>()
  const uploadQueue: QueuedUpload[] = []
  const failedLogins = new Map<string, { attempts: number; expiresAt: number }>()
  let processingQueue = false

  function userStore(username: string) {
    let store = stores.get(username)
    if (!store) {
      store = createCsvStore(join(config.dataDir, `${username}.csv`))
      stores.set(username, store)
    }
    return store
  }

  app.use("/api/*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })

  async function authenticatedUser(c: Context<AppEnv>): Promise<string | null> {
    const token = getCookie(c, COOKIE_NAME)
    if (!token) return null
    try {
      const session = await verify(token, config.sessionSecret, "HS256")
      return session.sub === "bp-user" && isUsername(session.username) && typeof session.exp === "number"
        ? session.username
        : null
    } catch {
      return null
    }
  }

  async function issueSession(c: Context<AppEnv>, username: string, time: number) {
    const issuedAt = Math.floor(time / 1000)
    const token = await sign({
      sub: "bp-user",
      username,
      iat: issuedAt,
      exp: issuedAt + SESSION_SECONDS,
    }, config.sessionSecret)
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_SECONDS,
    })
  }

  const requireLogin = async (c: Context<AppEnv>, next: Next) => {
    const username = await authenticatedUser(c)
    if (!username) return c.json({ error: "Sign in to continue." }, 401)
    c.set("username", username)
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

          for (const [metric, value, min, max, unit] of [
            ["systolic pressure", values.sys, 60, 279, "mmHg"],
            ["diastolic pressure", values.dia, 40, 200, "mmHg"],
            ["pulse", values.pul, 40, 180, "bpm"],
          ] as const) {
            if (value < min || value > max) {
              throw new PhotoRecognitionError(
                `BP Journal read a ${metric} of ${value} ${unit}. The UA-611Plus supports ${min}–${max} ${unit}. Check the display and try a clearer photo.`,
              )
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
          const reason = error instanceof PhotoRecognitionError
            ? error.message
            : "BP Journal hit an internal error while reading the photo. Try uploading it again."
          upload.job.error = `Photo uploaded. ${reason} No reading was saved.`
          continue
        }

        try {
          await userStore(upload.username).append(reading)
        } catch (error) {
          console.error(`Reading from upload ${upload.job.id} could not be saved:`, error)
          upload.job.status = "error"
          upload.job.error = "Photo uploaded and the numbers were read, but the server couldn't save the reading to the journal. Check server storage and try again."
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

  function addJob(username: string, job: UploadJob): void {
    jobs.set(job.id, { username, job })
    if (jobs.size > MAX_RETAINED_JOBS) {
      for (const [id, retained] of jobs) {
        if (retained.job.status !== "processing") jobs.delete(id)
        if (jobs.size <= MAX_RETAINED_JOBS) break
      }
    }
  }

  async function checkOrigin(c: Context<AppEnv>, next: Next) {
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
      return c.json({ error: "Enter your username and the installation password." }, 400)
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

    const username = body !== null && typeof body === "object" && "username" in body && typeof body.username === "string"
      ? body.username.toLowerCase()
      : undefined
    if (!isUsername(username)) {
      return c.json({ error: "Use a username with letters, numbers, hyphens or underscores (up to 251 characters)." }, 400)
    }

    failedLogins.delete(remote)
    await issueSession(c, username, time)
    return c.json({ ok: true, username })
  })

  app.get("/api/session", async (c) => {
    const username = await authenticatedUser(c)
    if (username) await issueSession(c, username, now().getTime())
    return c.json({ authenticated: username !== null, username })
  })

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
      return c.json({ readings: await userStore(c.get("username")).read() })
    } catch {
      return c.json({ error: "The readings file could not be read." }, 500)
    }
  })

  app.get("/api/readings.csv", async (c) => {
    try {
      const username = c.get("username")
      const readings = await userStore(username).read()
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
      return csvResponse(`${rows.join("\n")}\n`, username)
    } catch {
      return c.json({ error: "The readings file could not be read." }, 500)
    }
  })

  app.get("/api/uploads", (c) => c.json({
    uploads: [...jobs.values()]
      .filter((entry) => entry.username === c.get("username"))
      .map((entry) => ({ ...entry.job })),
  }))

  app.get("/api/uploads/:id", (c) => {
    const entry = jobs.get(c.req.param("id"))
    if (!entry || entry.username !== c.get("username")) return c.json({ error: "Upload not found." }, 404)
    return c.json({ ...entry.job })
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
    const username = c.get("username")
    addJob(username, job)
    uploadQueue.push({ username, job, image, capturedAt, arm })
    queueMicrotask(() => void processUploads())

    return c.json({ id, status: "processing" }, 202)
  })

  return app
}

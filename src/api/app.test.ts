import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import sharp from "sharp"

import { createApp } from "./app.ts"
import type { AppConfig } from "./config.ts"
import { closeOcr } from "./ocr.ts"
import { makeMonitor } from "../../tests/fixtures/monitor.ts"
import { sign } from "hono/jwt"

const directories: string[] = []
const origin = "https://bp.example.test"
const password = "safe-shared-install-password"
const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
async function setup(options: Parameters<typeof createApp>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bp-tracker-api-"))
  directories.push(directory)
  const config: AppConfig = {
    password,
    sessionSecret: "x".repeat(43),
    appOrigin: origin,
    dataDir: directory,
    secureCookies: true,
    maxUploadBytes: 8 * 1024 * 1024,
    host: "127.0.0.1",
    port: 3000,
  }
  const app = createApp(config, options)

  async function signIn(username = "florian") {
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    expect(response.status).toBe(200)
    return response.headers.get("set-cookie")!.split(";")[0]!
  }

  return { app, config, signIn, directory }
}

async function uploadReading(app: ReturnType<typeof createApp>, cookie: string, expectedStatus: "saved" | "error" = "saved") {
  const form = new FormData()
  form.set("photo", new File([imageBytes], "reading.jpg", { type: "image/jpeg" }))
  const response = await app.request("/api/uploads", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
    body: form,
  })
  expect(response.status).toBe(202)
  const { id } = await response.json() as { id: string }
  const deadline = Date.now() + 2_000
  let job: { id: string; status: string } | undefined
  while (Date.now() < deadline) {
    job = await (await app.request(`/api/uploads/${id}`, { headers: { Cookie: cookie } })).json() as typeof job
    if (job?.status !== "processing") break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(job?.status).toBe(expectedStatus)
  return id
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

afterAll(async () => closeOcr())

describe("BP Tracker API", () => {
  it("saves a generated monitor photo through real local OCR", async () => {
    const { app, config, signIn } = await setup()
    const cookie = await signIn()
    const form = new FormData()
    const photoBytes = await makeMonitor({ sys: 128, dia: 76, pul: 61 })
    form.set("photo", new File([new Uint8Array(photoBytes)], "reading.jpg", { type: "image/jpeg" }))
    form.set("capturedAt", "2025-04-15T09:30:00.000Z")

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    })
    expect(response.status).toBe(202)
    const { id } = await response.json() as { id: string }
    const deadline = Date.now() + 4_000
    let job: { status: string; reading?: object } | undefined
    while (Date.now() < deadline) {
      job = await (await app.request(`/api/uploads/${id}`, { headers: { Cookie: cookie } })).json() as typeof job
      if (job?.status !== "processing") break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(job?.status).toBe("saved")
    expect(job?.reading).toEqual({
      id,
      capturedAt: "2025-04-15T09:30:00.000Z",
      sys: 128,
      dia: 76,
      pul: 61,
      arm: "unknown",
    })
    const saved = await (await app.request("/api/readings", { headers: { Cookie: cookie } })).json() as { readings: unknown[] }
    expect(saved.readings).toEqual([job?.reading])
    expect(await readFile(join(config.dataDir, "florian.csv"), "utf8")).toContain(`${id},2025-04-15T09:30:00.000Z,128,76,61,unknown`)
  })

  it("keeps readings private until the shared password succeeds", async () => {
    const { app } = await setup()
    expect((await app.request("/api/session")).status).toBe(200)
    expect(await (await app.request("/api/session")).json()).toEqual({ authenticated: false, username: null })
    expect((await app.request("/api/readings")).status).toBe(401)
    expect((await app.request("/api/readings.csv")).status).toBe(401)

    const wrongPassword = await app.request("/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "not-the-password" }),
    })
    expect(wrongPassword.status).toBe(401)

    const crossOrigin = await app.request("/api/login", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
    expect(crossOrigin.status).toBe(403)

    const cookie = await (async () => {
      const response = await app.request("/api/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "florian", password }),
      })
      expect(response.headers.get("set-cookie")).toContain("HttpOnly")
      expect(response.headers.get("set-cookie")).toContain("Secure")
      return response.headers.get("set-cookie")!.split(";")[0]!
    })()

    expect(await (await app.request("/api/session", { headers: { Cookie: cookie } })).json()).toEqual({ authenticated: true, username: "florian" })
    const readingsResponse = await app.request("/api/readings", { headers: { Cookie: cookie } })
    expect(readingsResponse.status).toBe(200)
    expect(readingsResponse.headers.get("cache-control")).toBe("no-store")
    const csvDownload = await app.request("/api/readings.csv", { headers: { Cookie: cookie } })
    expect(csvDownload.status).toBe(200)
    expect(csvDownload.headers.get("cache-control")).toBe("no-store")

    const loggedOut = await app.request("/api/logout", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    })
    expect(loggedOut.status).toBe(200)
    expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0")
  })

  it("normalizes usernames and keeps each user's CSV and downloads separate across app restarts", async () => {
    const recognize = async () => ({ sys: 128, dia: 76, pul: 61 })
    const { app, config, signIn } = await setup({ recognize })
    const aliceCookie = await signIn("ALIce")
    const bobCookie = await signIn("bob_2")

    expect(await (await app.request("/api/session", { headers: { Cookie: aliceCookie } })).json())
      .toEqual({ authenticated: true, username: "alice" })
    expect(await (await app.request("/api/readings", { headers: { Cookie: aliceCookie } })).json())
      .toEqual({ readings: [] })

    const aliceId = await uploadReading(app, aliceCookie)
    const bobId = await uploadReading(app, bobCookie)
    expect(aliceId).not.toBe(bobId)
    expect(await readdir(config.dataDir)).toEqual(["alice.csv", "bob_2.csv"])

    const aliceCsv = await app.request("/api/readings.csv", { headers: { Cookie: aliceCookie } })
    expect(aliceCsv.headers.get("content-disposition")).toContain('filename="alice.csv"')
    expect(await aliceCsv.text()).toContain(aliceId)
    const bobCsv = await app.request("/api/readings.csv", { headers: { Cookie: bobCookie } })
    expect(bobCsv.headers.get("content-disposition")).toContain('filename="bob_2.csv"')
    expect(await bobCsv.text()).toContain(bobId)

    const restarted = createApp(config, { recognize })
    const aliceAgain = await (async () => {
      const response = await restarted.request("/api/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password }),
      })
      expect(response.status).toBe(200)
      return response.headers.get("set-cookie")!.split(";", 1)[0]!
    })()
    const bobAgain = await (async () => {
      const response = await restarted.request("/api/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "bob_2", password }),
      })
      expect(response.status).toBe(200)
      return response.headers.get("set-cookie")!.split(";", 1)[0]!
    })()
    expect((await (await restarted.request("/api/readings", { headers: { Cookie: aliceAgain } })).json() as { readings: { id: string }[] }).readings.map(({ id }) => id))
      .toEqual([aliceId])
    expect((await (await restarted.request("/api/readings", { headers: { Cookie: bobAgain } })).json() as { readings: { id: string }[] }).readings.map(({ id }) => id))
      .toEqual([bobId])
  })

  it("keeps a queued upload and its status private to the user who submitted it", async () => {
    let beginRecognition!: () => void
    let releaseRecognition!: () => void
    const started = new Promise<void>((resolve) => { beginRecognition = resolve })
    const processing = new Promise<void>((resolve) => { releaseRecognition = resolve })
    const { app, config, signIn } = await setup({
      recognize: async () => {
        beginRecognition()
        await processing
        return { sys: 128, dia: 76, pul: 61 }
      },
    })
    const aliceCookie = await signIn("alice")
    const form = new FormData()
    form.set("photo", new File([imageBytes], "reading.jpg", { type: "image/jpeg" }))
    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: aliceCookie },
      body: form,
    })
    expect(response.status).toBe(202)
    const { id: aliceId } = await response.json() as { id: string }
    await started

    await app.request("/api/logout", { method: "POST", headers: { Origin: origin, Cookie: aliceCookie } })
    const bobCookie = await signIn("bob")
    expect(await (await app.request("/api/uploads", { headers: { Cookie: bobCookie } })).json()).toEqual({ uploads: [] })
    expect((await app.request(`/api/uploads/${aliceId}`, { headers: { Cookie: bobCookie } })).status).toBe(404)

    const bobForm = new FormData()
    bobForm.set("photo", new File([imageBytes], "reading.jpg", { type: "image/jpeg" }))
    const bobResponse = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: bobCookie },
      body: bobForm,
    })
    expect(bobResponse.status).toBe(202)
    const { id: bobId } = await bobResponse.json() as { id: string }
    releaseRecognition()

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const aliceJob = await app.request(`/api/uploads/${aliceId}`, { headers: { Cookie: aliceCookie } })
      const bobJob = await app.request(`/api/uploads/${bobId}`, { headers: { Cookie: bobCookie } })
      if ((await aliceJob.json() as { status: string }).status === "saved" &&
        (await bobJob.json() as { status: string }).status === "saved") break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(await readFile(join(config.dataDir, "alice.csv"), "utf8")).toContain(aliceId)
    expect(await readFile(join(config.dataDir, "bob.csv"), "utf8")).toContain(bobId)
    expect(await (await app.request("/api/uploads", { headers: { Cookie: bobCookie } })).json())
      .toMatchObject({ uploads: [{ id: bobId, status: "saved" }] })
  })

  it("rejects path-like usernames and old or malformed session identities", async () => {
    const { app, config } = await setup()
    for (const username of ["", "../escape", "a/b", ".", "x".repeat(252)]) {
      const response = await app.request("/api/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      expect(response.status).toBe(400)
    }
    expect(await readdir(config.dataDir)).toEqual([])

    const expiredAt = Math.floor(Date.now() / 1000) + 3600
    for (const claims of [
      { sub: "bp-owner", exp: expiredAt },
      { sub: "bp-user", username: "../escape", exp: expiredAt },
    ]) {
      const token = await sign(claims, config.sessionSecret)
      const response = await app.request("/api/session", { headers: { Cookie: `bp_session=${token}` } })
      expect(await response.json()).toEqual({ authenticated: false, username: null })
    }
    expect(await readdir(config.dataDir)).toEqual([])
  })

  it("expires sessions after one year and resets expiry on a later sign-in", async () => {
    vi.useFakeTimers()
    try {
      const firstSignIn = new Date("2025-01-01T12:00:00.000Z")
      vi.setSystemTime(firstSignIn)
      const { app } = await setup()

      async function signIn() {
        return app.request("/api/login", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ username: "florian", password }),
        })
      }

      function sessionFrom(response: Response) {
        const serialized = response.headers.get("set-cookie")!
        const cookie = serialized.split(";", 1)[0]!
        const token = cookie.slice("bp_session=".length)
        const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
          username: string
          iat: number
          exp: number
        }
        return { cookie, claims, maxAge: Number(serialized.match(/Max-Age=(\d+)/)?.[1]) }
      }

      const firstLogin = await signIn()
      expect(firstLogin.status).toBe(200)
      const firstSession = sessionFrom(firstLogin)
      const yearInSeconds = 365 * 24 * 60 * 60
      expect(firstSession.claims.username).toBe("florian")
      expect(firstSession.claims.iat).toBe(Math.floor(firstSignIn.getTime() / 1000))
      expect(firstSession.claims.exp - firstSession.claims.iat).toBe(yearInSeconds)
      expect(firstSession.maxAge).toBe(yearInSeconds)

      const renewalTime = new Date(firstSignIn.getTime() + 180 * 24 * 60 * 60 * 1000)
      vi.setSystemTime(renewalTime)
      const renewal = await signIn()
      expect(renewal.status).toBe(200)
      const renewedSession = sessionFrom(renewal)
      expect(renewedSession.claims.iat).toBe(Math.floor(renewalTime.getTime() / 1000))
      expect(renewedSession.claims.exp - renewedSession.claims.iat).toBe(yearInSeconds)
      expect(renewedSession.maxAge).toBe(yearInSeconds)

      const isAuthenticated = async (cookie: string) => {
        const response = await app.request("/api/readings", { headers: { Cookie: cookie } })
        expect(response.headers.get("set-cookie")).toBeNull()
        return response.status === 200
      }
      const firstExpiry = new Date(firstSession.claims.exp * 1000)
      vi.setSystemTime(firstExpiry.getTime() - 1000)
      expect(await isAuthenticated(firstSession.cookie)).toBe(true)
      expect(await isAuthenticated(renewedSession.cookie)).toBe(true)

      vi.setSystemTime(firstExpiry)
      expect(await isAuthenticated(firstSession.cookie)).toBe(false)
      expect(await isAuthenticated(renewedSession.cookie)).toBe(true)

      const renewedExpiry = new Date(renewedSession.claims.exp * 1000)
      vi.setSystemTime(renewedExpiry.getTime() - 1000)
      expect(await isAuthenticated(renewedSession.cookie)).toBe(true)
      vi.setSystemTime(renewedExpiry)
      expect(await isAuthenticated(renewedSession.cookie)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("renews valid sessions on visits and rejects missing, invalid, or expired cookies", async () => {
    vi.useFakeTimers()
    try {
      const signInTime = new Date("2025-01-01T12:00:00.000Z")
      vi.setSystemTime(signInTime)
      const { app } = await setup()
      const firstLogin = await app.request("/api/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "florian", password }),
      })
      const getSession = (cookie?: string) => app.request("/api/session", {
        headers: cookie ? { Cookie: cookie } : {},
      })
      const sessionFrom = (response: Response) => {
        const serialized = response.headers.get("set-cookie")!
        const cookie = serialized.split(";", 1)[0]!
        const token = cookie.slice("bp_session=".length)
        const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
          username: string
          iat: number
          exp: number
        }
        return { cookie, claims, serialized }
      }
      const authenticated = async (cookie: string) =>
        (await app.request("/api/readings", { headers: { Cookie: cookie } })).status === 200

      expect(firstLogin.status).toBe(200)
      const firstSession = sessionFrom(firstLogin)
      const anonymous = await getSession()
      expect(await anonymous.json()).toEqual({ authenticated: false, username: null })
      expect(anonymous.headers.get("set-cookie")).toBeNull()

      const token = firstSession.cookie.slice("bp_session=".length)
      const signatureStart = token.lastIndexOf(".") + 1
      const firstCharacter = token[signatureStart] === "a" ? "b" : "a"
      const tamperedCookie = `bp_session=${token.slice(0, signatureStart)}${firstCharacter}${token.slice(signatureStart + 1)}`
      const tampered = await getSession(tamperedCookie)
      expect(await tampered.json()).toEqual({ authenticated: false, username: null })
      expect(tampered.headers.get("set-cookie")).toBeNull()

      const yearInMilliseconds = 365 * 24 * 60 * 60 * 1000
      const renewalTime = new Date(signInTime.getTime() + 180 * 24 * 60 * 60 * 1000)
      vi.setSystemTime(renewalTime)
      const renewal = await getSession(firstSession.cookie)
      expect(await renewal.json()).toEqual({ authenticated: true, username: "florian" })
      const renewedSession = sessionFrom(renewal)
      expect(renewedSession.claims.iat).toBe(Math.floor(renewalTime.getTime() / 1000))
      expect(renewedSession.claims.exp - renewedSession.claims.iat).toBe(yearInMilliseconds / 1000)
      expect(renewedSession.serialized).toContain("Max-Age=31536000")
      expect(renewedSession.serialized).toContain("HttpOnly")
      expect(renewedSession.serialized).toContain("Secure")
      expect(renewedSession.serialized).toContain("SameSite=Strict")

      const originalExpiry = new Date(firstSession.claims.exp * 1000)
      vi.setSystemTime(originalExpiry)
      const expired = await getSession(firstSession.cookie)
      expect(await expired.json()).toEqual({ authenticated: false, username: null })
      expect(expired.headers.get("set-cookie")).toBeNull()
      expect(await authenticated(firstSession.cookie)).toBe(false)
      expect(await authenticated(renewedSession.cookie)).toBe(true)

      const renewedExpiry = new Date(renewedSession.claims.exp * 1000)
      vi.setSystemTime(renewedExpiry.getTime() - 1000)
      expect(await authenticated(renewedSession.cookie)).toBe(true)
      vi.setSystemTime(renewedExpiry)
      const expiredRenewal = await getSession(renewedSession.cookie)
      expect(await expiredRenewal.json()).toEqual({ authenticated: false, username: null })
      expect(expiredRenewal.headers.get("set-cookie")).toBeNull()
      expect(await authenticated(renewedSession.cookie)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("throttles repeated wrong passwords without trusting forwarded headers", async () => {
    const { app } = await setup()
    const request = () => app.request("/api/login", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.10",
      },
      body: JSON.stringify({ password: "not-the-password" }),
    })

    for (let attempt = 0; attempt < 8; attempt += 1) expect((await request()).status).toBe(401)
    const blocked = await request()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("retry-after")).toBeTruthy()
  })

  it("rejects oversized login bodies before parsing JSON", async () => {
    const { app } = await setup()
    const response = await app.request("/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(17 * 1024) }),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "The login request is too large." })
  })

  it("acknowledges a JPEG before recognition finishes and stores it after the page is gone", async () => {
    let beginRecognition!: () => void
    let releaseRecognition!: () => void
    const started = new Promise<void>((resolve) => { beginRecognition = resolve })
    const processing = new Promise<void>((resolve) => { releaseRecognition = resolve })
    const { app, config, signIn } = await setup({
      recognize: async (image) => {
        expect(image.subarray(0, 3)).toEqual(Buffer.from(imageBytes.subarray(0, 3)))
        beginRecognition()
        await processing
        return { sys: 128, dia: 76, pul: 61 }
      },
    })
    const cookie = await signIn()
    const form = new FormData()
    form.set("photo", new File([imageBytes], "reading.jpg", { type: "image/jpeg" }))
    form.set("capturedAt", "2025-04-15T09:30:00.000Z")
    form.set("arm", "left")

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    })
    expect(response.status).toBe(202)
    const created = await response.json() as { id: string; status: string }
    expect(created.status).toBe("processing")
    await started

    // No browser request is made while recognition runs.
    releaseRecognition()
    const deadline = Date.now() + 2_000
    let upload: { id: string; status: string; reading?: object } | undefined
    while (Date.now() < deadline) {
      const status = await app.request(`/api/uploads/${created.id}`, { headers: { Cookie: cookie } })
      upload = await status.json() as typeof upload
      if (upload?.status === "saved") break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(upload?.status).toBe("saved")
    expect(upload?.reading).toEqual({
      id: created.id,
      capturedAt: "2025-04-15T09:30:00.000Z",
      sys: 128,
      dia: 76,
      pul: 61,
      arm: "left",
    })
    const saved = await (await app.request("/api/readings", { headers: { Cookie: cookie } })).json() as { readings: unknown[] }
    expect(saved.readings).toEqual([upload?.reading])
    const csv = await app.request("/api/readings.csv", { headers: { Cookie: cookie } })
    expect(await csv.text()).toContain(`${created.id},2025-04-15T09:30:00.000Z,128,76,61,left`)
    expect(await readFile(join(config.dataDir, "florian.csv"), "utf8")).toContain("captured_at,sys,dia,pul,arm")
  })

  it("uses server upload time and Unknown when a photo has no metadata or arm selection", async () => {
    const uploadTime = new Date().toISOString()
    const { app, signIn } = await setup({
      now: () => new Date(uploadTime),
      recognize: async () => ({ sys: 121, dia: 78, pul: 72 }),
    })
    const cookie = await signIn()
    const form = new FormData()
    form.set("photo", new File([imageBytes], "reading.jpg", { type: "image/jpeg" }))

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    })
    expect(response.status).toBe(202)
    const { id } = await response.json() as { id: string }
    const deadline = Date.now() + 2_000
    let status: { status: string; reading?: { capturedAt: string; arm: string } } | undefined
    while (Date.now() < deadline) {
      status = await (await app.request(`/api/uploads/${id}`, { headers: { Cookie: cookie } })).json() as typeof status
      if (status?.status === "saved") break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(status?.reading).toMatchObject({ capturedAt: uploadTime, arm: "unknown" })
  })

  it.each([
    {
      scenario: "a display with a pulse of 743 bpm",
      photo: () => makeMonitor({ sys: 116, dia: 67, pul: 743 }),
      message: "Photo uploaded. BP Journal read a pulse of 743 bpm. The UA-611Plus supports 40–180 bpm. Check the display and try a clearer photo. No reading was saved.",
    },
    {
      scenario: "a labeled display with an unreadable diastolic number",
      photo: () => makeMonitor({ sys: 116, dia: "E1", pul: 61 }),
      message: "Photo uploaded. BP Journal found the DIA label but couldn't read the diastolic number. Try a closer photo with the full display visible. No reading was saved.",
    },
    {
      scenario: "a JPEG without a monitor display",
      photo: () => sharp({ create: { width: 200, height: 200, channels: 3, background: "white" } }).jpeg().toBuffer(),
      message: "Photo uploaded. BP Journal couldn't locate the SYS, DIA, and PUL labels on the monitor display. Try a closer photo with the full display visible. No reading was saved.",
    },
    {
      scenario: "a JPEG the server cannot decode",
      photo: async () => imageBytes,
      message: "Photo uploaded. BP Journal couldn't open the JPEG to read it. Try a new copy of the photo. No reading was saved.",
    },
  ])("explains why no reading was saved from $scenario", async ({ photo, message }) => {
    const { app, signIn } = await setup()
    const cookie = await signIn()
    const form = new FormData()
    form.set("photo", new File([new Uint8Array(await photo())], "reading.jpg", { type: "image/jpeg" }))

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    })
    expect(response.status).toBe(202)
    const { id } = await response.json() as { id: string }

    await expect.poll(async () => {
      return (await app.request(`/api/uploads/${id}`, { headers: { Cookie: cookie } })).json()
    }, { timeout: 4_000 }).toMatchObject({ id, status: "error", error: message })
    expect(await (await app.request("/api/readings", { headers: { Cookie: cookie } })).json())
      .toEqual({ readings: [] })
  })

  it.each([
    { sys: 60, dia: 40, pul: 40, status: "saved" },
    { sys: 279, dia: 200, pul: 180, status: "saved" },
    { sys: 59, dia: 67, pul: 61, status: "error" },
    { sys: 280, dia: 67, pul: 61, status: "error" },
    { sys: 116, dia: 39, pul: 61, status: "error" },
    { sys: 250, dia: 201, pul: 61, status: "error" },
    { sys: 116, dia: 67, pul: 39, status: "error" },
    { sys: 116, dia: 67, pul: 181, status: "error" },
  ] as const)("reports $status for UA-611Plus readings $sys/$dia with pulse $pul", async ({ status, ...values }) => {
    const { app, signIn } = await setup({ recognize: async () => values })
    const cookie = await signIn()
    const id = await uploadReading(app, cookie, status)
    const { readings } = await (await app.request("/api/readings", { headers: { Cookie: cookie } })).json()
    expect(readings).toEqual(status === "saved" ? [expect.objectContaining({ id, ...values })] : [])
  })

  it("reports a storage failure separately and preserves malformed CSV bytes", async () => {
    const { app, config, signIn } = await setup({
      recognize: async () => ({ sys: 116, dia: 67, pul: 61 }),
    })
    const original = "wrong,header\nkept,data\n"
    await writeFile(join(config.dataDir, "florian.csv"), original)
    const cookie = await signIn()
    const form = new FormData()
    form.set("photo", new File([imageBytes], "reading.jpg", { type: "image/jpeg" }))

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    })
    expect(response.status).toBe(202)
    const { id } = await response.json() as { id: string }
    const deadline = Date.now() + 2_000
    let status: { status: string; error?: string } | undefined
    while (Date.now() < deadline) {
      status = await (await app.request(`/api/uploads/${id}`, { headers: { Cookie: cookie } })).json() as typeof status
      if (status?.status === "error") break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(status).toEqual({
      id,
      status: "error",
      uploadedAt: expect.any(String),
      error: "Photo uploaded and the numbers were read, but the server couldn't save the reading to the journal. Check server storage and try again.",
    })
    expect(await readFile(join(config.dataDir, "florian.csv"), "utf8")).toBe(original)
  })

  it("rejects non-JPEG uploads and bad capture dates", async () => {
    const { app, signIn } = await setup({ recognize: async () => ({ sys: 120, dia: 80, pul: 70 }) })
    const cookie = await signIn()

    const badPhoto = new FormData()
    badPhoto.set("photo", new File(["hello"], "photo.png", { type: "image/png" }))
    const wrongType = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: badPhoto,
    })
    expect(wrongType.status).toBe(415)

    const invalidDate = new FormData()
    invalidDate.set("photo", new File([imageBytes], "reading.jpg", { type: "image/jpeg" }))
    invalidDate.set("capturedAt", "not-a-date")
    const invalid = await app.request("/api/uploads", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body: invalidDate,
    })
    expect(invalid.status).toBe(400)
  })
})

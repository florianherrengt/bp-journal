import { describe, expect, it } from "vitest"

import { readConfig } from "./config.ts"

const password = "safe-shared-install-password"

describe("runtime configuration", () => {
  it("needs only the shared password on first run and supplies local defaults", () => {
    const config = readConfig({ APP_PASSWORD: password })
    expect(config.password).toBe(password)
    expect(config.appOrigin).toBe("http://localhost:3000")
    expect(config.secureCookies).toBe(false)
    expect(config.maxUploadBytes).toBe(8 * 1024 * 1024)
    expect(config.port).toBe(3000)
    expect(config.host).toBe("0.0.0.0")
    expect(config.sessionSecret).toHaveLength(43)
  })

  it("requires a shared password and a safe configured session key", () => {
    expect(() => readConfig({})).toThrow("APP_PASSWORD")
    expect(() => readConfig({ APP_PASSWORD: "" })).toThrow("APP_PASSWORD")
    expect(() => readConfig({ APP_PASSWORD: password, SESSION_SECRET: "too-short" })).toThrow("SESSION_SECRET")
  })

  it.each(["x", "short"])("accepts the non-empty password %s without a minimum length", (value) => {
    expect(readConfig({ APP_PASSWORD: value }).password).toBe(value)
  })

  it("treats an empty Docker-provided session key as omitted", () => {
    expect(readConfig({ APP_PASSWORD: password, SESSION_SECRET: "" }).sessionSecret).toHaveLength(43)
  })

  it.each([
    "https://tracker.example/login",
    "https://user:secret@tracker.example",
    "https://tracker.example?unsafe=true",
    "https://tracker.example#fragment",
  ])("requires APP_URL to be a plain site origin (%s)", (APP_URL) => {
    expect(() => readConfig({ APP_PASSWORD: password, APP_URL })).toThrow("APP_URL")
  })

  it("uses Secure cookies whenever the configured app origin is HTTPS", () => {
    expect(readConfig({ APP_PASSWORD: password, APP_URL: "https://tracker.example" }).secureCookies).toBe(true)
    expect(readConfig({ APP_PASSWORD: password, APP_URL: "https://tracker.example", COOKIE_SECURE: "false" }).secureCookies).toBe(true)
    expect(readConfig({ APP_PASSWORD: password, APP_URL: "http://tracker.example" }).secureCookies).toBe(false)
  })

  it("validates configuration values with their own setting names", () => {
    expect(() => readConfig({ APP_PASSWORD: password, MAX_UPLOAD_BYTES: "0" })).toThrow("MAX_UPLOAD_BYTES")
    expect(() => readConfig({ APP_PASSWORD: password, PORT: "0" })).toThrow("PORT")
    expect(() => readConfig({ APP_PASSWORD: password, PORT: "65536" })).toThrow("PORT")
    expect(() => readConfig({ APP_PASSWORD: password, PORT: "3000.5" })).toThrow("PORT")
  })
})

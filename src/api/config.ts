import { randomBytes } from "node:crypto"
import { resolve } from "node:path"

export type AppConfig = {
  password: string
  sessionSecret: string
  appOrigin: string
  csvPath: string
  secureCookies: boolean
  maxUploadBytes: number
  host: string
  port: number
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`)
  }
  return parsed
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const password = env.APP_PASSWORD
  if (!password || password.length < 12) {
    throw new Error("APP_PASSWORD is required and must be at least 12 characters")
  }

  const providedSessionSecret = env.SESSION_SECRET?.trim()
    ? env.SESSION_SECRET
    : undefined
  if (providedSessionSecret !== undefined && providedSessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters")
  }

  let appOrigin: string
  try {
    const url = new URL(env.APP_URL || "http://localhost:3000")
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.pathname !== "/" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("APP_URL must be an HTTP(S) origin without a path")
    }
    appOrigin = url.origin
  } catch {
    throw new Error("APP_URL must be a valid HTTP(S) origin, such as https://bp.example.com")
  }

  return {
    password,
    // A generated session key keeps a fresh local install to one required setting.
    // Set SESSION_SECRET to keep existing sessions valid after a server restart.
    sessionSecret: providedSessionSecret || randomBytes(32).toString("base64url"),
    appOrigin,
    csvPath: resolve(env.DATA_FILE || "data/readings.csv"),
    secureCookies: appOrigin.startsWith("https://"),
    maxUploadBytes: positiveInteger(env.MAX_UPLOAD_BYTES, 8 * 1024 * 1024, "MAX_UPLOAD_BYTES"),
    host: env.HOST || "0.0.0.0",
    port: positiveInteger(env.PORT, 3000, "PORT", 65_535),
  }
}

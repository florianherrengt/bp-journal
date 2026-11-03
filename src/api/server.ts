import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { fileURLToPath } from "node:url"

import { createApp } from "./app.ts"
import { readConfig } from "./config.ts"
import { closeOcr } from "./ocr.ts"

const config = readConfig()
const app = createApp(config)
const dist = fileURLToPath(new URL("../../dist/", import.meta.url))

// Keep API misses as JSON responses rather than serving the app shell.
app.all("/api/*", (c) => c.json({ error: "Not found." }, 404))
app.use("*", serveStatic({ root: dist }))
app.get("*", serveStatic({ root: dist, path: "index.html" }))

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
}, (info) => {
  console.log(`BP Tracker is listening at ${config.appOrigin} on port ${info.port}`)
})

let closing = false
function shutdown(): void {
  if (closing) return
  closing = true
  server.close(() => {
    void closeOcr().finally(() => process.exit(0))
  })
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

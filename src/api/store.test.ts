import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { Reading } from "../shared.ts"
import { createCsvStore } from "./store.ts"

const temporaryDirectories: string[] = []

async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "bp-tracker-store-"))
  temporaryDirectories.push(directory)
  return { path: join(directory, "readings.csv"), store: createCsvStore(join(directory, "readings.csv")) }
}

function reading(id: string, capturedAt = "2025-04-15T09:30:00.000Z"): Reading {
  return { id, capturedAt, sys: 128, dia: 76, pul: 61, arm: "left" }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("CSV storage", () => {
  it("appends readings once and reloads them from the CSV", async () => {
    const { path, store } = await makeStore()
    const first = "00000000-0000-4000-8000-000000000001"
    const second = "00000000-0000-4000-8000-000000000002"
    await store.append(reading(first))
    await store.append(reading(first))
    await store.append(reading(second, "2025-04-15T17:00:00.000Z"))

    expect(await store.read()).toEqual([reading(first), reading(second, "2025-04-15T17:00:00.000Z")])
    expect(await readFile(path, "utf8")).toBe(
      "id,captured_at,sys,dia,pul,arm\n" +
      `${first},2025-04-15T09:30:00.000Z,128,76,61,left\n` +
      `${second},2025-04-15T17:00:00.000Z,128,76,61,left\n`,
    )
  })

  it("treats a pre-created empty CSV as an empty store and adds the header on first append", async () => {
    const { path, store } = await makeStore()
    await writeFile(path, "")
    const first = reading("00000000-0000-4000-8000-000000000001")

    expect(await store.read()).toEqual([])
    await store.append(first)

    expect(await store.read()).toEqual([first])
    expect(await readFile(path, "utf8")).toBe(
      "id,captured_at,sys,dia,pul,arm\n" +
        `${first.id},${first.capturedAt},${first.sys},${first.dia},${first.pul},${first.arm}\n`,
    )
  })

  it("serializes simultaneous appends without losing readings", async () => {
    const { store } = await makeStore()
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.append(reading(`00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`)),
    ))

    const saved = await store.read()
    expect(saved).toHaveLength(20)
    expect(new Set(saved.map(({ id }) => id)).size).toBe(20)
  })

  it("refuses to append to a malformed file without changing it", async () => {
    const { path, store } = await makeStore()
    await writeFile(path, "wrong,header\nkept,data\n")

    await expect(store.read()).rejects.toThrow("Invalid CSV")
    await expect(store.append(reading("new"))).rejects.toThrow("Invalid CSV")
    expect(await readFile(path, "utf8")).toBe("wrong,header\nkept,data\n")
  })

  it("appends a new row cleanly when a valid CSV is missing its final newline", async () => {
    const { path, store } = await makeStore()
    const previous = reading("00000000-0000-4000-8000-000000000001")
    await writeFile(
      path,
      "id,captured_at,sys,dia,pul,arm\n" +
        `${previous.id},${previous.capturedAt},${previous.sys},${previous.dia},${previous.pul},${previous.arm}`,
    )
    const next = reading("00000000-0000-4000-8000-000000000002", "2025-04-15T17:00:00.000Z")

    await store.append(next)
    expect(await store.read()).toEqual([previous, next])
  })
})

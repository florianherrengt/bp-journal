import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { Reading } from "../shared.ts"

const HEADER = ["id", "captured_at", "sys", "dia", "pul", "arm"]
const ARMS = new Set(["left", "right", "unknown"])

function readReading(row: string[]): Reading {
  if (row.length !== HEADER.length) throw new Error("Invalid CSV: incorrect column count")
  const [id, capturedAt, sysText, diaText, pulText, arm] = row
  const sys = Number(sysText)
  const dia = Number(diaText)
  const pul = Number(pulText)

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id!) ||
    !capturedAt ||
    !Number.isFinite(Date.parse(capturedAt)) ||
    !Number.isSafeInteger(sys) ||
    !Number.isSafeInteger(dia) ||
    !Number.isSafeInteger(pul) ||
    sys <= 0 ||
    dia <= 0 ||
    pul <= 0 ||
    !ARMS.has(arm!)
  ) {
    throw new Error("Invalid CSV: invalid reading")
  }

  return { id, capturedAt, sys, dia, pul, arm: arm as Reading["arm"] }
}

function parseCsv(contents: string): Reading[] {
  if (contents.length === 0) return []
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === "") lines.pop()
  if (lines.length === 0 || lines[0] !== HEADER.join(",")) {
    throw new Error("Invalid CSV: expected BP tracker header")
  }

  return lines.slice(1).filter((line) => line.length > 0).map((line) => readReading(line.split(",")))
}

export function createCsvStore(filePath: string) {
  let writeQueue: Promise<void> = Promise.resolve()

  async function read(): Promise<Reading[]> {
    let contents: string
    try {
      contents = await readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return parseCsv(contents)
  }

  function append(reading: Reading): Promise<void> {
    const operation = async () => {
      let contents: string | undefined
      try {
        contents = await readFile(filePath, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const existing = contents === undefined ? [] : parseCsv(contents)
      if (existing.some((row) => row.id === reading.id)) return

      await mkdir(dirname(filePath), { recursive: true })
      const line = [
        reading.id,
        reading.capturedAt,
        reading.sys,
        reading.dia,
        reading.pul,
        reading.arm,
      ].join(",")
      const prefix = contents === undefined || contents.length === 0
        ? `${HEADER.join(",")}\n`
        : !contents.endsWith("\n")
        ? "\n"
        : ""
      await appendFile(filePath, `${prefix}${line}\n`, { encoding: "utf8", flag: "a" })
    }

    writeQueue = writeQueue.then(operation, operation)
    return writeQueue
  }

  return { read, append }
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { FormEvent } from "react"
import { Anchor, Button, Container, FileButton, Group, PasswordInput, Progress, Stack, Text, Title } from "@mantine/core"
import moment from "moment"
import type { Arm, Reading, UploadJob } from "../shared.ts"
import { preparePhoto } from "./image.ts"

type ResponseError = { error?: string }

class RequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function jsonFetch<T>(
  url: string,
  init?: RequestInit,
  unauthorizedMessage = "Your session has expired. Sign in again.",
): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ResponseError
    if (response.status === 401) throw new RequestError(body.error ?? unauthorizedMessage, response.status)
    throw new RequestError(body.error ?? "Something went wrong. Please try again.", response.status)
  }
  return response.json() as Promise<T>
}

function Login({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await onLogin(password)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not sign in.")
      setBusy(false)
    }
  }

  return (
    <Container size={420} className="login-layout">
      <form onSubmit={submit} aria-labelledby="login-title">
        <Stack gap="md">
          <Title id="login-title" order={1} size="h2">BP Journal</Title>
          <PasswordInput label="Password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} required />
          {error && <Text c="red" role="alert" size="sm">{error}</Text>}
          <Button type="submit" loading={busy}>Sign in</Button>
        </Stack>
      </form>
    </Container>
  )
}

const SERIES = [
  { key: "sys", name: "SYS", unit: "mmHg", color: "#197f71" },
  { key: "dia", name: "DIA", unit: "mmHg", color: "#a76b32" },
  { key: "pul", name: "PUL", unit: "bpm", color: "#546d94" },
] as const

function TrendChart({ readings }: { readings: Reading[] }) {
  const chartRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(780)
  const points = useMemo(
    () => [...readings].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt)),
    [readings],
  )

  useLayoutEffect(() => {
    const container = chartRef.current
    if (!container) return

    const updateWidth = () => {
      const nextWidth = Math.round(container.getBoundingClientRect().width)
      if (nextWidth > 0) setWidth((current) => current === nextWidth ? current : nextWidth)
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [points.length > 0])

  if (points.length === 0) {
    return (
      <Text size="sm" c="dimmed" py="md">No readings yet.</Text>
    )
  }

  const height = Math.min(285, Math.max(220, width * 0.66))
  const left = 34
  const right = 14
  const top = 18
  const bottom = 42
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const peak = Math.max(20, ...points.flatMap((point) => [point.sys, point.dia, point.pul]))
  const yMax = Math.ceil(peak / 20) * 20
  const firstTime = Date.parse(points[0].capturedAt)
  const lastTime = Date.parse(points[points.length - 1].capturedAt)
  const span = Math.max(1, lastTime - firstTime)
  const x = (index: number) => points.length === 1
    ? left + chartWidth / 2
    : left + ((Date.parse(points[index].capturedAt) - firstTime) / span) * chartWidth
  const y = (value: number) => top + chartHeight - (value / yMax) * chartHeight
  const tickCount = 4
  const daySpan = moment(lastTime).startOf("day").diff(moment(firstTime).startOf("day"), "days")

  function seriesPath(key: "sys" | "dia" | "pul") {
    return points.map((point, index) => (index === 0 ? "M " : "L ") + x(index) + " " + y(point[key])).join(" ")
  }

  const accessibleSummary = points.map((point) => {
    return moment(point.capturedAt).format("D MMM YYYY, HH:mm") +
      ": SYS " + point.sys + ", DIA " + point.dia + ", pulse " + point.pul
  }).join(". ")

  return (
    <div className="chart-wrap" ref={chartRef}>
      <svg
        className="trend-chart"
        width={width}
        height={height}
        viewBox={"0 0 " + width + " " + height}
        role="img"
        aria-label={"Blood pressure and pulse readings over time. " + accessibleSummary}
      >
        {Array.from({ length: tickCount + 1 }, (_, index) => {
          const value = (yMax / tickCount) * index
          return (
            <g key={index}>
              <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="chart-grid" />
              <text x={left - 10} y={y(value) + 4} textAnchor="end" className="chart-label">{Math.round(value)}</text>
            </g>
          )
        })}
        {Array.from({ length: Math.min(4, points.length) }, (_, index) => {
          const itemIndex = points.length <= 1
            ? 0
            : Math.round((index * (points.length - 1)) / (Math.min(4, points.length) - 1))
          return (
            <g key={index}>
              <line x1={x(itemIndex)} x2={x(itemIndex)} y1={top} y2={height - bottom} className="chart-guide" />
              <text x={x(itemIndex)} y={height - 16} textAnchor="middle" className="chart-label">
                {moment(points[itemIndex].capturedAt).format(daySpan >= 1 ? "D MMM" : "HH:mm")}
              </text>
            </g>
          )
        })}
        {SERIES.map((series) => (
          <path
            key={series.key}
            d={seriesPath(series.key)}
            fill="none"
            stroke={series.color}
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {SERIES.flatMap((series) => points.map((point, index) => (
          <circle
            key={series.key + point.id}
            cx={x(index)}
            cy={y(point[series.key])}
            r="4.5"
            fill={series.color}
            stroke="white"
            strokeWidth="2"
          >
            <title>{moment(point.capturedAt).format("D MMM YYYY, HH:mm") + " · " + series.name + " " + point[series.key] + " " + series.unit}</title>
          </circle>
        )))}
      </svg>
      <ul className="chart-legend" aria-label="Chart legend">
        {SERIES.map((series) => (
          <li key={series.key}>
            <span style={{ backgroundColor: series.color }} aria-hidden="true" />
            <strong>{series.name}</strong>
            <small>{series.unit}</small>
          </li>
        ))}
      </ul>
    </div>
  )
}

function armLabel(arm: Arm | null) {
  return arm ?? "unknown"
}

function UploadStatus({ jobs }: { jobs: UploadJob[] }) {
  const recent = [...jobs]
    .sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt))
    .slice(0, 3)
    .filter((job, index) => job.status !== "saved" || index === 0)
  if (!recent.length) return null
  return (
    <section className="activity" aria-live="polite" aria-label="Recent uploads">
      {recent.map((job) => (
        <Text key={job.id} size="sm" c={job.status === "error" ? "red" : undefined} role={job.status === "error" ? "alert" : undefined}>
          {job.status === "processing" && "Reading photo… You can close this page."}
          {job.status === "saved" && (job.reading ? `Saved · ${moment(job.reading.capturedAt).format("D MMM, HH:mm")} · SYS ${job.reading.sys} / DIA ${job.reading.dia} · PUL ${job.reading.pul}` : "Reading saved.")}
          {job.status === "error" && `Couldn’t save reading: ${job.error ?? "Please try again."}`}
        </Text>
      ))}
    </section>
  )
}

function Application() {
  const [session, setSession] = useState<boolean | null>(null)
  const [readings, setReadings] = useState<Reading[]>([])
  const [jobs, setJobs] = useState<UploadJob[]>([])
  const [arm, setArm] = useState<"left" | "right" | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const [notice, setNotice] = useState("")
  const [pageError, setPageError] = useState("")
  const resetFileRef = useRef<(() => void) | null>(null)
  const sessionRef = useRef(false)
  const mountedRef = useRef(false)
  const refreshedJobIds = useRef(new Set<string>())

  const refreshReadings = useCallback(async () => {
    const result = await jsonFetch<{ readings: Reading[] }>("/api/readings")
    if (mountedRef.current && sessionRef.current) setReadings(result.readings)
  }, [])

  const refreshJobs = useCallback(async () => {
    const result = await jsonFetch<{ uploads: UploadJob[] }>("/api/uploads")
    if (!mountedRef.current || !sessionRef.current) return []

    setJobs(result.uploads)
    const newlySaved = result.uploads.filter((job) =>
      job.status === "saved" && !refreshedJobIds.current.has(job.id),
    )
    for (const job of newlySaved) refreshedJobIds.current.add(job.id)
    if (newlySaved.length > 0) await refreshReadings()
    return result.uploads
  }, [refreshReadings])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const result = await jsonFetch<{ authenticated: boolean }>("/api/session")
        if (!active) return
        sessionRef.current = result.authenticated
        setSession(result.authenticated)
        if (result.authenticated) {
          const [history, uploads] = await Promise.all([
            jsonFetch<{ readings: Reading[] }>("/api/readings"),
            jsonFetch<{ uploads: UploadJob[] }>("/api/uploads"),
          ])
          if (active && sessionRef.current) {
            for (const job of uploads.uploads) {
              if (job.status === "saved") refreshedJobIds.current.add(job.id)
            }
            setReadings(history.readings)
            setJobs(uploads.uploads)
          }
        }
      } catch (problem) {
        if (active && mountedRef.current) {
          sessionRef.current = false
          setPageError(problem instanceof Error ? problem.message : "Could not connect to the tracker.")
          setSession(false)
        }
      }
    }
    void load()
    return () => { active = false }
  }, [])

  const hasProcessing = jobs.some((job) => job.status === "processing")
  useEffect(() => {
    if (!session || !hasProcessing) return
    let active = true
    let polling = false
    const timer = window.setInterval(() => {
      if (polling || !sessionRef.current) return
      polling = true
      void refreshJobs().catch((problem: unknown) => {
        if (active && sessionRef.current) {
          setPageError(problem instanceof Error ? problem.message : "Could not refresh the latest readings.")
          if (problem instanceof RequestError && problem.status === 401) {
            sessionRef.current = false
            setSession(false)
            setReadings([])
            setJobs([])
          }
        }
      }).finally(() => { polling = false })
    }, 1800)
    return () => { active = false; window.clearInterval(timer) }
  }, [session, hasProcessing, refreshJobs])

  async function login(value: string) {
    await jsonFetch<{ ok: true }>("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: value }),
    }, "The password is incorrect.")
    const [history, uploads] = await Promise.all([
      jsonFetch<{ readings: Reading[] }>("/api/readings"),
      jsonFetch<{ uploads: UploadJob[] }>("/api/uploads"),
    ])
    for (const job of uploads.uploads) {
      if (job.status === "saved") refreshedJobIds.current.add(job.id)
    }
    sessionRef.current = true
    setPageError("")
    setSession(true)
    setReadings(history.readings)
    setJobs(uploads.uploads)
  }

  async function logout() {
    sessionRef.current = false
    setSession(false)
    setReadings([])
    setJobs([])
    try {
      await jsonFetch<{ ok: true }>("/api/logout", { method: "POST" })
    } catch (problem) {
      setPageError(problem instanceof Error ? problem.message : "Could not sign out.")
    }
  }

  function upload(file: File, selectedArm: "left" | "right" | null) {
    setUploading(true)
    setUploadPercent(0)
    setNotice("Preparing photo…")
    setPageError("")

    void preparePhoto(file).then((photo) => new Promise<void>((resolve, reject) => {
      const body = new FormData()
      body.append("photo", photo.image, "reading.jpg")
      body.append("arm", armLabel(selectedArm))
      if (photo.capturedAt) body.append("capturedAt", photo.capturedAt)

      const request = new XMLHttpRequest()
      request.open("POST", "/api/uploads")
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) setUploadPercent(Math.min(99, Math.round(event.loaded / event.total * 100)))
      }
      request.onerror = () => reject(new Error("Upload interrupted. Check your connection and try again."))
      request.onabort = () => reject(new Error("Upload interrupted. Check your connection and try again."))
      request.onload = () => {
        let payload: (UploadJob & { status?: string }) | ResponseError
        try { payload = JSON.parse(request.responseText) as typeof payload }
        catch { payload = {} }
        if (request.status !== 202) {
          reject(new Error(("error" in payload ? payload.error : undefined) ?? "Could not send that photo. Please try again."))
          return
        }
        if (!("id" in payload) || !payload.id) {
          reject(new Error("The server received the photo but did not return a tracking status."))
          return
        }
        if (mountedRef.current && sessionRef.current) {
          const uploadedJob: UploadJob = {
            ...(payload as UploadJob),
            id: payload.id,
            status: payload.status ?? "processing",
            uploadedAt: payload.uploadedAt ?? new Date().toISOString(),
          }
          setJobs((current) => [uploadedJob, ...current.filter((job) => job.id !== payload.id)])
          setNotice("")
          setUploadPercent(100)
          void refreshJobs().catch((problem: unknown) => {
            if (mountedRef.current && sessionRef.current) {
              setPageError(problem instanceof Error ? problem.message : "Could not refresh the latest readings.")
            }
          })
        }
        resolve()
      }
      request.send(body)
    })).catch((problem: unknown) => {
      if (mountedRef.current && sessionRef.current) {
        setPageError(problem instanceof Error ? problem.message : "Could not process this photo.")
        setNotice("")
      }
    }).finally(() => {
      setUploading(false)
      setUploadPercent(0)
      resetFileRef.current?.()
    })
  }

  if (session === null) {
    return <Container size={640} className="app-shell"><Text c="dimmed">Opening your journal…</Text></Container>
  }
  if (!session) {
    return <>
      {pageError && <Text className="connection-error" c="red" role="alert">{pageError}</Text>}
      <Login onLogin={login} />
    </>
  }

  return (
    <Container size={640} className="app-shell">
      <Stack gap="lg" component="main">
        <Group justify="space-between" align="center">
          <Title order={1} size="h2">BP Journal</Title>
          <Group gap="md">
            <Anchor href="/api/readings.csv" download="blood-pressure-readings.csv" size="sm">CSV</Anchor>
            <Anchor component="button" type="button" onClick={() => void logout()} size="sm">Sign out</Anchor>
          </Group>
        </Group>

        {pageError && <Text c="red" size="sm" role="alert">{pageError}</Text>}

        <Group justify="space-between" align="flex-end" gap="md" className="upload-controls">
          <Stack gap={4} aria-label="Choose arm">
            <Text size="sm">Arm (optional)</Text>
            <Group gap="xs">
              {(["left", "right"] as const).map((value) => (
                <Button key={value} type="button" variant={arm === value ? "filled" : "default"} aria-pressed={arm === value} disabled={uploading} onClick={() => setArm((current) => current === value ? null : value)}>
                  {value === "left" ? "Left" : "Right"}
                </Button>
              ))}
            </Group>
          </Stack>
          <FileButton resetRef={resetFileRef} onChange={(file) => { if (file) upload(file, arm) }} accept="image/jpeg" inputProps={{ id: "photo-input", disabled: uploading }}>
            {(props) => <Button className="upload-button" {...props} disabled={uploading}>{uploading ? "Uploading photo…" : "Upload photo"}</Button>}
          </FileButton>
        </Group>
        {uploading && uploadPercent > 0 && <Progress value={uploadPercent} aria-label="Photo upload progress" />}
        {(notice || (uploading && uploadPercent > 0)) && <Text size="sm" role="status">{uploading && uploadPercent > 0 ? `Uploading photo · ${uploadPercent}%` : notice}</Text>}

        <section aria-label="Blood pressure and pulse chart">
          <TrendChart readings={readings} />
        </section>
        <UploadStatus jobs={jobs} />
      </Stack>
    </Container>
  )
}

export default function App() { return <Application /> }

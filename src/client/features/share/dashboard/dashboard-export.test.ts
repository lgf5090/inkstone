// @vitest-environment jsdom
/**
 * The export and the screen, held to one set of numbers.
 *
 * A file that leaves the app is only worth having if it is the reading the reader was looking at, so
 * these cases take the figures off the rendered cards and compare them with the rows the CSV writes: the
 * same window, the same filters, the same counts, and every breakdown row the card was given rather than
 * the handful that fits a panel.
 */
import { act, createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ShareGlobalAnalytics } from "@shared/share-hub"
import { initI18n, t } from "../../../lib/i18n"
import { renderElement, type RenderedElement } from "../../../lib/test-render"
import { useUi } from "../../../store/ui"
import { ShareDashboardView } from "./dashboard-view"
import { kpiLabels } from "./dashboard-format"

const service = vi.hoisted(() => ({
  params: [] as Array<Record<string, unknown>>,
  payload: null as ShareGlobalAnalytics | null,
}))

const downloads = vi.hoisted(() => ({ files: [] as Array<{ filename: string; text: string }> }))

vi.mock("../../../lib/api-share-hub", () => ({
  shareHubApi: {
    analytics: {
      global: async (params: Record<string, unknown> = {}) => {
        service.params.push(params)
        return service.payload
      },
      ackExpired: async () => ({ ok: true }),
    },
    batch: { setEnabled: async () => ({ ok: true, count: 0 }) },
  },
}))

vi.mock("../../../lib/export-note", () => ({
  downloadTextFile: (filename: string, text: string) => {
    downloads.files.push({ filename, text })
  },
}))

let view: RenderedElement | null = null

function fixture(): ShareGlobalAnalytics {
  return {
    range: "7d",
    totalShares: 12,
    activeShares: 9,
    totalViews: 120,
    totalVisitors: 34,
    viewsDelta: 15,
    visitorsDelta: -4,
    viewsPerDay: 17,
    viewsPerDayDelta: 3,
    timeline: [{ label: "Mon", timestamp: 1_700_000_000_000, views: 40, visitors: 12 }],
    topNotes: [{ noteId: "note-one", noteTitle: "Shared note", slug: "abc123", views: 80, visitors: 20 }],
    topCountries: [{ name: "US", count: 45, percentage: 32 }],
    topReferrers: [{ name: "Direct", count: 20, percentage: 14 }],
    devices: [{ name: "desktop", count: 30, percentage: 21 }],
    osList: Array.from({ length: 6 }, (_, index) => ({ name: `os-${index}`, count: 6 - index, percentage: 10 })),
    browsers: [{ name: "Chrome", count: 25, percentage: 18 }],
    channels: [{ name: "newsletter", count: 12, percentage: 9 }],
    recentVisits: [],
    staleLinks: { thresholdDays: 90, total: 3, neverViewed: 1, items: [] },
    filterStats: { bots: 12, selfReferrals: 3, owner: 5 },
    expiredLinks: { acknowledgedAt: null, total: 0, items: [] },
  }
}

function click(element: HTMLElement | undefined): void {
  if (!element) throw new Error("the control the test asked for is not on screen")
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
}

function pressExport(): void {
  click([...view!.container.querySelectorAll<HTMLElement>("button")].find(
    (element) => element.getAttribute("aria-label") === t("share.dashboard.export_csv"),
  ))
}

async function flush(): Promise<void> {
  await act(async () => {})
}

/** One rendered tile's number, read the way a reader reads it. */
function tileValue(root: HTMLElement, label: string): string {
  const tile = [...root.querySelectorAll("div")].find((element) => element.firstElementChild?.firstElementChild?.textContent === label)
  return tile?.querySelector("span.font-mono")?.textContent?.trim() ?? ""
}

/**
 * The written file, parsed rather than split on commas: a value that is itself a sentence carries
 * commas, and a field that carries a comma is quoted per RFC 4180.
 */
/** The mark the export writes, stripped before parsing. */
const BOM = "\uFEFF"

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let index = text.startsWith(BOM) ? 1 : 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += "\""; index += 1 }
      else if (char === "\"") quoted = false
      else field += char
      continue
    }
    if (char === "\"") quoted = true
    else if (char === ",") { row.push(field); field = "" }
    else if (char === "\r") { /* a CRLF pair; the LF half ends the row */ }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = "" }
    else field += char
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function rowFor(rows: string[][], item: string): string[] | undefined {
  return rows.find((row) => row[1] === item)
}

beforeEach(async () => {
  localStorage.clear()
  service.params = []
  service.payload = fixture()
  downloads.files = []
  await initI18n()
})

afterEach(() => {
  view?.unmount()
  view = null
  useUi.setState({ toasts: [] } as never)
  document.body.innerHTML = ""
})

describe("the dashboard export", () => {
  it("writes the numbers the cards are showing, for the window the header names", async () => {
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    pressExport()
    expect(downloads.files).toHaveLength(1)
    const rows = parseCsv(downloads.files[0]!.text)
    const labels = kpiLabels()

    expect(downloads.files[0]!.filename).toMatch(/^inkstone-share-analytics-7d-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(rowFor(rows, labels.pv)?.[2]).toBe(tileValue(view.container, labels.pv))
    expect(rowFor(rows, labels.uv)?.[2]).toBe(tileValue(view.container, labels.uv))
    expect(rowFor(rows, labels.viewsPerDay)?.[2]).toBe(tileValue(view.container, labels.viewsPerDay))
    expect(rowFor(rows, labels.activeShares)?.[2]).toBe("9 / 12")
    expect(tileValue(view.container, labels.activeShares)).toContain("9 / 12")

    // Both series of the trend, whichever one the card was drawing.
    expect(rowFor(rows, `Mon · ${t("share.dashboard.metric_pv")}`)?.[2]).toBe("40")
    expect(rowFor(rows, `Mon · ${t("share.dashboard.metric_uv")}`)?.[2]).toBe("12")

    expect(rowFor(rows, t("share.dashboard.range_label"))?.[2]).toBe("7d")
    expect(rowFor(rows, t("share.dashboard.filter_traffic_title"))?.[2]).toBe(t("share.dashboard.filter_real_visitors"))
    // The preset keeps self-referrals, so the sentence the file writes counts none of them out — and it
    // is the same sentence the banner above the cards is showing.
    const excluded = t("share.dashboard.filter_summary", { bots: 12, self: 0, owner: 5 })
    expect(rowFor(rows, t("share.dashboard.export_excluded"))?.[2]).toBe(excluded)
    expect(view.container.textContent).toContain(excluded)
  })

  it("exports every breakdown row the card was given, not the rows that fit", async () => {
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    pressExport()
    const rows = parseCsv(downloads.files[0]!.text)
    const section = t("share.dashboard.card_devices")
    const environmentRows = rows.filter((row) => row[0] === section).map((row) => row[1])

    expect(environmentRows).toEqual([
      `${t("share.dashboard.device_type")} · ${t("share.dashboard.device_desktop")}`,
      ...Array.from({ length: 6 }, (_, index) => `${t("share.dashboard.operating_system")} · os-${index}`),
    ])
  })

  it("keeps the export out of reach while the screen holds no window", async () => {
    service.payload = null
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    const exportButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.getAttribute("aria-label") === t("share.dashboard.export_csv"),
    )
    expect(exportButton?.disabled).toBe(true)
    expect(downloads.files).toHaveLength(0)
  })
})

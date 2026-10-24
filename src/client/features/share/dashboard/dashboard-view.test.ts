// @vitest-environment jsdom
/**
 * The dashboard's own contract with the window it reads.
 *
 * The requests are the load-bearing part: a control that changes a label and re-slices the last answer
 * looks right on a fixture while answering a different question in the product, so each case here reads
 * what the fake hub service was actually asked for. The three states of a fetched surface, the exact
 * triple the real-visitor switch is defined as, the rows a card must not throw away, and the notice's
 * dismiss-then-refetch cycle are the rest.
 */
import { act, createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ShareGlobalAnalytics } from "@shared/share-hub"
import { initI18n, t } from "../../../lib/i18n"
import { fullTime } from "../../../lib/time"
import { renderElement, type RenderedElement } from "../../../lib/test-render"
import { useUi } from "../../../store/ui"
import { ShareDashboardView } from "./dashboard-view"
import { ALL_TRAFFIC_FILTERS, DEFAULT_TIMELINE_RANGE, REAL_VISITOR_FILTERS } from "./constants"

const service = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  ackCalls: 0,
  failNext: false,
  hold: false,
  waiting: [] as Array<() => void>,
  payload: null as ShareGlobalAnalytics | null,
}))

vi.mock("../../../lib/api-share-hub", () => ({
  shareHubApi: {
    analytics: {
      global: async (params: Record<string, unknown> = {}) => {
        service.calls.push(params)
        if (service.hold) await new Promise<void>((resolve) => service.waiting.push(resolve))
        if (service.failNext) {
          service.failNext = false
          throw new Error("analytics unavailable")
        }
        return service.payload
      },
      ackExpired: async () => {
        service.ackCalls++
        return { ok: true as const }
      },
    },
    batch: { setEnabled: async () => ({ ok: true as const, count: 0 }) },
  },
}))

let view: RenderedElement | null = null

/** A window with traffic in it, shaped the way the route shapes it. */
function analyticsFixture(overrides: Partial<ShareGlobalAnalytics> = {}): ShareGlobalAnalytics {
  return {
    range: DEFAULT_TIMELINE_RANGE,
    totalShares: 12,
    activeShares: 9,
    totalViews: 120,
    totalVisitors: 34,
    viewsDelta: 15,
    visitorsDelta: -4,
    viewsPerDay: 17,
    viewsPerDayDelta: 3,
    timeline: [
      { label: "Mon", timestamp: 1_700_000_000_000, views: 40, visitors: 12 },
      { label: "Tue", timestamp: 1_700_086_400_000, views: 80, visitors: 22 },
    ],
    topNotes: [{ noteId: "note-one", noteTitle: "Shared note", slug: "abc123", views: 80, visitors: 20 }],
    topCountries: [{ name: "US", count: 45, percentage: 32 }],
    topReferrers: [{ name: "Direct", count: 20, percentage: 14 }],
    devices: [{ name: "desktop", count: 30, percentage: 21 }],
    osList: Array.from({ length: 6 }, (_, index) => ({ name: `os-${index}`, count: 6 - index, percentage: 1 })),
    browsers: [{ name: "Chrome", count: 25, percentage: 18 }],
    channels: [{ name: "newsletter", count: 12, percentage: 1 }],
    recentVisits: [],
    staleLinks: { thresholdDays: 0, total: 0, neverViewed: 0, items: [] },
    filterStats: { bots: 12, selfReferrals: 3, owner: 5 },
    ...overrides,
  }
}

/**
 * The controls on screen, in document order. A native `button` carries no `role` attribute, so the
 * selector has to read both the element and the ARIA role a drawn control wears.
 */
function controls(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button, [role=\"button\"], [role=\"switch\"], [role=\"radio\"], [role=\"status\"]")]
}

/** The control announced by this accessible name — the way a screen reader would find it. */
function byAriaLabel(root: HTMLElement, name: string): HTMLElement | undefined {
  return controls(root).find((element) => element.getAttribute("aria-label") === name)
}

/** The control whose only words are this label. */
function byText(root: HTMLElement, text: string): HTMLElement | undefined {
  return controls(root).find((element) => element.textContent?.trim() === text)
}

function click(element: HTMLElement | undefined): void {
  if (!element) throw new Error("the control the test asked for is not on screen")
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
}

async function flush(): Promise<void> {
  await act(async () => {})
}

/** The first request the fake service saw, with the fields a test is arguing about. */
function firstCall(): Record<string, unknown> {
  return service.calls[0] ?? {}
}

function kpiValue(root: HTMLElement, label: string): string {
  const tile = [...root.querySelectorAll("div")].find((element) => {
    const caption = element.firstElementChild?.firstElementChild
    return caption?.textContent === label
  })
  return tile?.querySelector("span.font-mono")?.textContent?.trim() ?? ""
}

beforeEach(async () => {
  localStorage.clear()
  service.calls = []
  service.ackCalls = 0
  service.failNext = false
  service.hold = false
  service.waiting = []
  service.payload = analyticsFixture()
  await initI18n()
})

afterEach(() => {
  view?.unmount()
  view = null
  useUi.setState({ toasts: [] } as never)
  document.body.innerHTML = ""
})

describe("the dashboard's requests", () => {
  it("asks for the default window, and for the one the range control selects", async () => {
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    expect(firstCall().range).toBe(DEFAULT_TIMELINE_RANGE)

    const thirtyDays = controls(view.container).find((element) => element.getAttribute("role") === "radio" && element.textContent === "30d")
    click(thirtyDays)
    await flush()

    expect(service.calls).toHaveLength(2)
    expect(service.calls[1]?.range).toBe("30d")
  })

  it("sends the real-visitor triple the server's visit filter reads, and nothing but that triple", async () => {
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    // The hub's query spells the third flag `excludeSelf`; the shared contract spells it
    // `excludeSelfReferrers`, and bots and the owner are out while self-referrals stay.
    expect(firstCall()).toMatchObject({
      range: DEFAULT_TIMELINE_RANGE,
      excludeBots: true,
      excludeSelf: false,
      excludeOwner: true,
    })

    // The preset is one exported triple, and the switch is defined as exactly that triple: bots and
    // the owner out, self-referrals in, and no fourth flag anywhere.
    expect(REAL_VISITOR_FILTERS).toEqual({ excludeBots: true, excludeOwner: true, excludeSelfReferrers: false })
    expect(ALL_TRAFFIC_FILTERS).toEqual({ excludeBots: false, excludeOwner: false, excludeSelfReferrers: false })

    click(byAriaLabel(view.container, t("share.dashboard.filter_traffic_title")))
    click(byAriaLabel(document.body, t("share.dashboard.real_visitors")))
    await flush()
    expect(service.calls[1]).toMatchObject({
      excludeBots: false,
      excludeSelf: false,
      excludeOwner: false,
    })
  })

  it("hands a note row's drill-down to the shell with that note's id", async () => {
    const onOpenVisitLog = vi.fn()
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog }))
    await flush()

    click(byAriaLabel(view.container, t("share.dashboard.open_note_log", { title: "Shared note" })))

    expect(onOpenVisitLog).toHaveBeenCalledWith("note-one")
  })
})

describe("the three states of a fetched surface", () => {
  it("draws placeholders until the first answer arrives, then the cards", async () => {
    service.hold = true
    service.payload = analyticsFixture()
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    expect(view.container.querySelector('[role="status"][aria-busy="true"]')?.textContent).toBe(t("common.loading"))
    expect(view.container.querySelector("h3")).toBeNull()

    service.hold = false
    service.waiting.forEach((release) => release())
    await flush()

    expect(view.container.querySelector("h3")?.textContent).toBe(t("share.dashboard.card_timeline"))
  })

  it("says the reading failed, and reads again when asked", async () => {
    service.failNext = true
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    expect(view.container.textContent).toContain(t("share.dashboard.load_failed"))

    click(byText(view.container, t("common.retry")))
    await flush()

    expect(view.container.querySelector("h3")?.textContent).toBe(t("share.dashboard.card_timeline"))
  })

  it("distinguishes an empty window from a zero, and still shows the window's shape", async () => {
    service.payload = analyticsFixture({
      totalViews: 0,
      totalVisitors: 0,
      viewsPerDay: 0,
      topNotes: [],
      topCountries: [],
      topReferrers: [],
      devices: [],
      osList: [],
      browsers: [],
      channels: [],
      timeline: [],
    })
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    expect(kpiValue(view.container, t("share.dashboard.kpi_unique_visitors"))).toBe("—")
    expect(view.container.textContent).toContain(t("share.dashboard.no_visits_in_range"))
    expect(view.container.textContent).toContain(t("share.dashboard.no_data_yet"))
    expect(view.container.textContent).toContain(t("share.dashboard.no_visits_yet"))
  })
})

describe("what a card draws", () => {
  it("renders every operating system the response carried, with no client-side cap", async () => {
    service.payload = analyticsFixture()
    view = renderElement(createElement(ShareDashboardView, { onOpenVisitLog: vi.fn() }))
    await flush()

    const devicesCard = [...view.container.querySelectorAll("section")].find(
      (section) => section.getAttribute("aria-label") === t("share.dashboard.card_devices"),
    )
    const names = [...(devicesCard?.querySelectorAll("span.truncate") ?? [])].map((node) => node.textContent)

    expect(names).toEqual(expect.arrayContaining(Array.from({ length: 6 }, (_, index) => `os-${index}`)))
  })
})

describe("the expiry notice", () => {
  it("lists each lapsed link, then stamps the dismissal and re-reads the window", async () => {
    service.payload = analyticsFixture({
      expiredLinks: {
        acknowledgedAt: null,
        total: 2,
        items: [{ noteId: "note-one", noteTitle: "Shared note", slug: "abc123", expiresAt: 1_700_000_000_000 }],
      },
    })
    const onViewExpiredCategory = vi.fn()
    view = renderElement(createElement(ShareDashboardView, {
      onOpenVisitLog: vi.fn(),
      onViewExpiredCategory,
    }))
    await flush()

    const notice = controls(view.container).find((element) => element.tagName === "SECTION")
    expect(notice?.textContent).toContain("/s/abc123")
    expect(notice?.textContent).toContain(fullTime(1_700_000_000_000))
    expect(notice?.textContent).toContain(t("share.dashboard.expired_more", { count: 1 }))

    click(byText(view.container, t("share.dashboard.expired_dismiss")))
    await flush()

    expect(service.ackCalls).toBe(1)
    expect(service.calls).toHaveLength(2)

    click(byText(view.container, t("share.dashboard.expired_view_category")))
    expect(onViewExpiredCategory).toHaveBeenCalled()
  })
})

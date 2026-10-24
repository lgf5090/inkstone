import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ReactNode, RefObject } from "react"
import { createPortal } from "react-dom"
import { ShieldAlert, ShieldCheck } from "lucide-react"
import type { VisitTrafficFilters } from "@shared/share-selection"
import { Button } from "../../../components/primitives"
import { SettingRow, Switch } from "../../../components/form"
import { useClickOutside, useDialogFocus, useEscape } from "../../../components/overlay"
import { usePanelPlacement, type PanelPlacement } from "../../../components/popover-placement"
import { cn } from "../../../lib/cn"
import { t } from "../../../lib/i18n"
import { FILTER_PANEL_HEIGHT_ESTIMATE, FILTER_PANEL_WIDTH, isRealVisitorFilters } from "./constants"
import { trafficFilterLabel } from "./dashboard-format"

/**
 * The traffic filters, as a dialog anchored to the control that opens it.
 *
 * The panel is portaled and placed by the shared panel math rather than pinned with `absolute right-0
 * top-full`: it is 320px wide and its control can sit anywhere in a wrapping header, so on a narrow
 * phone the naive rule draws its first field off screen.
 *
 * The keyboard contract is a non-modal dialog's, and it comes from the app's own `useDialogFocus`: the
 * panel takes the focus when it opens, Escape or a press outside closes it, and the focus goes back to
 * the control that opened it.
 *
 * The switches are the three flags the server's visit filter reads — nothing more. The "real visitors"
 * switch is not a fourth flag: it is the preset that sets all three at once, and it reports on whether
 * they still stand where the preset left them.
 */
export function TrafficFilterPopover({ filters, onFiltersChange, onRealVisitorsChange }: {
  filters: VisitTrafficFilters
  onFiltersChange: (patch: Partial<VisitTrafficFilters>) => void
  onRealVisitorsChange: (enabled: boolean) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelHeight, setPanelHeight] = useState(FILTER_PANEL_HEIGHT_ESTIMATE)
  const size = useMemo(() => ({ width: FILTER_PANEL_WIDTH, height: panelHeight }), [panelHeight])
  const [placement, setPlacement] = useState<PanelPlacement | null>(null)
  const apply = useCallback((next: PanelPlacement) => setPlacement(next), [])

  usePanelPlacement(isOpen, { anchor: triggerRef, size, align: "end", apply })
  useMeasuredHeight(isOpen, panelRef, panelHeight, setPanelHeight)
  useEscape(isOpen, () => setIsOpen(false))
  useClickOutside([triggerRef, panelRef], isOpen, () => setIsOpen(false))
  useDialogFocus(isOpen, panelRef)
  const label = trafficFilterLabel(filters)
  const isReal = isRealVisitorFilters(filters)

  return (
    <>
      <Button
        ref={triggerRef}
        size="sm"
        variant="ghost"
        icon={isReal ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
        onClick={() => setIsOpen((previous) => !previous)}
        aria-label={t("share.dashboard.filter_traffic_title")}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className={cn("gap-[var(--sp-1-5)] rounded-[var(--r-md)] border text-[length:var(--text-12)] font-medium", triggerTone(isReal))}
      >
        <span className="hidden sm:inline">{label}</span>
      </Button>

      {isOpen && <FilterPanelSurface panelRef={panelRef} placement={placement} width={size.width}>
        <div className="flex items-center gap-[var(--sp-2)] pb-[var(--sp-1)] text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          <ShieldCheck size={16} className="text-[var(--accent)]" aria-hidden />
          {t("share.dashboard.filter_traffic_title")}
        </div>
        <p className="pb-[var(--sp-2)] text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
          {t("share.dashboard.filter_traffic_desc")}
        </p>

        <SettingRow title={t("share.dashboard.real_visitors")} description={t("share.dashboard.real_visitors_desc")}>
          <Switch
            checked={isReal}
            onChange={onRealVisitorsChange}
            label={t("share.dashboard.real_visitors")}
          />
        </SettingRow>
        <SettingRow title={t("share.dashboard.filter_bots")} description={t("share.dashboard.filter_bots_desc")}>
          <Switch checked={filters.excludeBots === true} onChange={(checked) => onFiltersChange({ excludeBots: checked })} label={t("share.dashboard.filter_bots")} />
        </SettingRow>
        <SettingRow title={t("share.dashboard.filter_self")} description={t("share.dashboard.filter_self_desc")}>
          <Switch checked={filters.excludeSelfReferrers === true} onChange={(checked) => onFiltersChange({ excludeSelfReferrers: checked })} label={t("share.dashboard.filter_self")} />
        </SettingRow>
        <SettingRow title={t("share.dashboard.filter_owner")} description={t("share.dashboard.filter_owner_desc")}>
          <Switch checked={filters.excludeOwner === true} onChange={(checked) => onFiltersChange({ excludeOwner: checked })} label={t("share.dashboard.filter_owner")} />
        </SettingRow>

        <p className="flex items-start gap-[var(--sp-1-5)] pt-[var(--sp-2)] text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
          {t("share.dashboard.filter_persist_hint")}
        </p>
      </FilterPanelSurface>}
    </>
  )
}

/**
 * The height the panel really turned out to be. The placement math decides whether the panel fits below
 * its control, so an assumed height that comes out wrong has to be corrected before a clipped panel is
 * left on screen. A measurement of nothing is ignored, which is what a layout-free test host reports.
 */
function useMeasuredHeight(
  isOpen: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
  height: number,
  onMeasured: (height: number) => void,
): void {
  useLayoutEffect(() => {
    if (!isOpen) return
    const measured = panelRef.current?.offsetHeight
    if (measured && measured !== height) onMeasured(measured)
  }, [isOpen, height, panelRef, onMeasured])
}

/** The colour the closed control wears, read off the three switches it stands for. */
function triggerTone(isReal: boolean): string {
  return isReal
    ? "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--success)] hover:bg-[var(--bg-hover)]"
    : "border-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)] hover:bg-[var(--bg-hover)]"
}

/** The panel itself, portaled to the document so `fixed` placement measures against the page. */
function FilterPanelSurface({ panelRef, placement, width, children }: {
  panelRef: RefObject<HTMLDivElement | null>
  placement: PanelPlacement | null
  width: number
  children: ReactNode
}) {
  // A panel whose placement has not been measured yet is drawn hidden and parked off screen: the first
  // frame has no position to claim, and `invisible` is what keeps it from flashing in the corner.
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("share.dashboard.filter_traffic_title")}
      tabIndex={-1}
      style={{ width, top: placement?.top ?? -9999, left: placement?.left ?? -9999, transformOrigin: placement?.origin }}
      className={cn(
        "anim-pop fixed z-[var(--z-popover)] overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-[var(--sp-4)] shadow-[var(--shadow-pop)] outline-none",
        !placement && "invisible",
      )}
    >
      {children}
    </div>,
    document.body,
  )
}

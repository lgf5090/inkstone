import { Compass, Globe2, Laptop, MousePointerClick, Tag } from "lucide-react"
import { isReservedChannelName } from "@shared/share-channel"
import type { ShareBreakdownItem } from "@shared/share-hub"
import { localeTag, t } from "../../../lib/i18n"
import { BreakdownRow, CardEmpty, CardSectionLabel, DashboardCard } from "./card-shell"
import {
  countryFlag,
  countryNameLocalized,
  localizeChannelName,
  localizeDeviceName,
  localizeEnvName,
  localizeReferrerName,
} from "./dashboard-format"

/**
 * The four breakdown cards.
 *
 * Each draws exactly the rows the response carries — no client-side cap. The server caps a breakdown at
 * the number of rows a card can hold and sends that, and the export writes the same rows: three
 * different truncations of one list is how a screen, a file and an API end up describing three
 * different sets of visits.
 */
type BreakdownRows = ShareBreakdownItem[]

/** Where the visitors came from, by country. */
export function CountriesCard({ items }: { items: BreakdownRows }) {
  const locale = localeTag()
  return (
    <DashboardCard
      icon={<Globe2 size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_countries")}
      badge={t("share.dashboard.card_countries_badge")}
    >
      <BreakdownList rows={items} nameOf={(item) => countryNameLocalized(item.name, locale)} flagOf={(item) => countryFlag(item.name)} />
    </DashboardCard>
  )
}

/**
 * How the traffic found the link, and — under it — which copy of the link it came from. The two sit in
 * one card because they answer one question at two levels: the referrer says where the browser was, the
 * channel says which link was followed, and neither can stand in for the other.
 */
export function ReferrersCard({ items, channels, onOpenChannelLogs }: {
  items: BreakdownRows
  channels: BreakdownRows
  onOpenChannelLogs?: (channel: string) => void
}) {
  return (
    <DashboardCard
      icon={<Compass size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_referrers")}
      badge={t("share.dashboard.card_referrers_badge")}
    >
      <BreakdownList rows={items} nameOf={(item) => localizeReferrerName(item.name)} />
      {channels.length > 0 && <ChannelSplit rows={channels} onOpenLogs={onOpenChannelLogs} />}
    </DashboardCard>
  )
}

/** Devices and operating systems as one card — both read the same visit fingerprint. */
export function DevicesCard({ devices, systems }: { devices: BreakdownRows; systems: BreakdownRows }) {
  return (
    <DashboardCard
      icon={<Laptop size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_devices")}
      badge={t("share.dashboard.card_devices_badge")}
    >
      {devices.length === 0 && systems.length === 0 ? (
        <CardEmpty label={t("share.dashboard.no_data_yet")} />
      ) : (
        <div className="space-y-[var(--sp-2)] pt-[var(--sp-3)]">
          <CardSectionLabel>{t("share.dashboard.device_type")}</CardSectionLabel>
          <BreakdownList rows={devices} nameOf={(item) => localizeDeviceName(item.name)} />
          <CardSectionLabel>{t("share.dashboard.operating_system")}</CardSectionLabel>
          <BreakdownList rows={systems} nameOf={(item) => localizeEnvName(item.name)} />
        </div>
      )}
    </DashboardCard>
  )
}

/** Which browsers read the links — the same fingerprint's third reading. */
export function BrowsersCard({ items }: { items: BreakdownRows }) {
  return (
    <DashboardCard
      icon={<MousePointerClick size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_browsers")}
      badge={t("share.dashboard.card_browsers_badge")}
    >
      <BreakdownList rows={items} nameOf={(item) => localizeEnvName(item.name)} />
    </DashboardCard>
  )
}

/** One list of counts as labelled rows, or the card's empty line when the window holds none. */
function BreakdownList({ rows, nameOf, flagOf }: {
  rows: BreakdownRows
  nameOf: (item: ShareBreakdownItem) => string
  flagOf?: (item: ShareBreakdownItem) => string
}) {
  if (rows.length === 0) return <CardEmpty label={t("share.dashboard.no_data_yet")} />
  return (
    <div className="space-y-[var(--sp-2-5)] pt-[var(--sp-3)]">
      {rows.map((item) => (
        <BreakdownRow
          key={item.name}
          name={nameOf(item)}
          flag={flagOf?.(item)}
          count={item.count}
          percentage={item.percentage ?? 0}
        />
      ))}
    </div>
  )
}

/**
 * The channel split. The hint only appears while no marker has ever come back: that is the moment the
 * owner needs to learn the feature exists, and printing it afterwards is noise on every account that
 * already uses it. A row with a way down into the log is a native button, so the drill-down stays on the
 * keyboard.
 */
function ChannelSplit({ rows, onOpenLogs }: { rows: BreakdownRows; onOpenLogs?: (channel: string) => void }) {
  const hasMarker = rows.some((row) => !isReservedChannelName(row.name))
  return (
    <div className="mt-[var(--sp-3)] space-y-[var(--sp-2-5)] border-t border-[var(--border-subtle)] pt-[var(--sp-3)]">
      <p className="flex items-center gap-[var(--sp-1-5)] text-[length:var(--text-11)] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)]">
        <Tag size={12} aria-hidden />
        {t("share.dashboard.card_channels")}
      </p>
      {rows.map((row) => {
        const name = localizeChannelName(row.name, row.label)
        if (!onOpenLogs) return <BreakdownRow key={row.name} name={name} count={row.count} percentage={row.percentage ?? 0} />
        return (
          <button
            key={row.name}
            type="button"
            onClick={() => onOpenLogs(row.name)}
            aria-label={t("share.dashboard.channel_drilldown_aria", { channel: name })}
            className="w-full rounded-[var(--r-md)] text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            <BreakdownRow name={name} count={row.count} percentage={row.percentage ?? 0} />
          </button>
        )
      })}
      {!hasMarker && (
        <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t("share.dashboard.channel_hint")}</p>
      )}
    </div>
  )
}

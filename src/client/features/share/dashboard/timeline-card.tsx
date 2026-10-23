import { useMemo } from "react"
import type { ChartConfiguration } from "chart.js"
import { TrendingUp } from "lucide-react"
import type { ShareTimelinePoint, ShareTimelineRange } from "@shared/share-hub"
import { ChartCanvas, withAlpha, type ChartColors } from "../../../components/chart-canvas"
import { Segmented } from "../../../components/form"
import { formatNumber } from "../../../lib/time"
import { t } from "../../../lib/i18n"
import { CardEmpty, DashboardCard } from "./card-shell"
import { TIMELINE_CHART_HEIGHT, type TimelineMetric } from "./constants"
import { rangeLabel } from "./dashboard-format"

/**
 * The window's shape over time, as one series the reader switches between.
 *
 * The trend is drawn by the app's one chart component: the library already ships for note charts, it
 * arrives only when a chart is actually on screen, and it reads the theme's palette rather than a colour
 * of its own. The switch changes which series is drawn, not what was asked for — both series come back
 * in the same reading.
 */
export function TimelineCard({ points, metric, onMetricChange, range }: {
  points: ShareTimelinePoint[]
  metric: TimelineMetric
  onMetricChange: (metric: TimelineMetric) => void
  range: ShareTimelineRange
}) {
  const values = points.map((point) => (metric === "views" ? point.views : point.visitors))
  const total = values.reduce((sum, value) => sum + value, 0)
  const peakIndex = values.reduce((best, value, index) => (value > values[best] ? index : best), 0)
  const rangeName = rangeLabel(range)
  const build = useMemo(
    () => (colors: ChartColors): ChartConfiguration<"line"> => ({
      type: "line",
      data: {
        labels: points.map((point) => point.label),
        datasets: [{
          label: metric === "views" ? metricLabels().pv : metricLabels().uv,
          data: points.map((point) => (metric === "views" ? point.views : point.visitors)),
          borderColor: colors.palette[0],
          backgroundColor: withAlpha(colors.palette[0] ?? "", 0.18),
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, precision: 0 }, grid: { color: colors.grid } },
        },
      },
    }),
    [points, metric],
  )

  return (
    <DashboardCard
      icon={<TrendingUp size={15} className="text-[var(--accent)]" />}
      title={t("share.dashboard.card_timeline")}
      action={
        <Segmented
          size="sm"
          label={t("share.dashboard.metric_label")}
          value={metric}
          onChange={(next) => onMetricChange(next)}
          options={[
            { value: "views", label: metricLabels().pv },
            { value: "visitors", label: metricLabels().uv },
          ]}
        />
      }
    >
      <p className="pt-[var(--sp-2)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {metric === "views" ? t("share.dashboard.timeline_pv_desc", { range: rangeName }) : t("share.dashboard.timeline_uv_desc", { range: rangeName })}
      </p>
      {points.length === 0 ? (
        <CardEmpty label={t("share.dashboard.no_data_yet")} />
      ) : (
        <div className={TIMELINE_CHART_HEIGHT}>
          <ChartCanvas
            height="h-full"
            label={t("share.dashboard.timeline_chart_aria", {
              metric: metric === "views" ? metricLabels().pv : metricLabels().uv,
              range: rangeName,
              total: formatNumber(total),
              peak: formatNumber(values[peakIndex] ?? 0),
              at: points[peakIndex]?.label ?? "",
            })}
            build={build}
          />
        </div>
      )}
    </DashboardCard>
  )
}

/** The two series names, resolved where they are drawn rather than at import. */
function metricLabels(): { pv: string; uv: string } {
  return { pv: t("share.dashboard.metric_pv"), uv: t("share.dashboard.metric_uv") }
}

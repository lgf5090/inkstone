/**
 * What the assistant has been spending.
 *
 * Two views of one screen. The detail view answers "where did this window's money go" — the totals, a cost
 * chart grouped by model or by key, and each busy model's own trend — and it is the one the range control
 * and the model and key filters act on. The account view answers "what has this cost me in total", which is
 * a question about the whole history and so belongs in a view of its own rather than in a filter of this
 * one.
 *
 * Cost is shown per currency and never added across them. A model the reader has not priced is reported
 * as unpriced — "no price" and "free" are different claims, and a total that confused them would be a
 * number nobody could act on. The cost chart draws one currency at a time for the same reason.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Coins, RefreshCw } from 'lucide-react'
import type { AssistantStats } from '@shared/assistant'
import { t, useLocale } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, Spinner } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { Menu, type MenuItem } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { AppUsage } from './AppUsage'
import { CostBars, ModelTrend } from './UsageCharts'
import { compact, money } from './usage-format'
import { Group } from './assistant-settings-shared'

const RANGES = ['7', '30', 'all'] as const
type Range = (typeof RANGES)[number]

const VIEWS = ['detail', 'account'] as const
type View = (typeof VIEWS)[number]

/** Which dimension the cost chart's bars are stacked by. */
type Grouping = 'model' | 'key'

/** How many models get their own pair of charts: the ones with the most usage, and no further. */
const MAX_MODEL_SECTIONS = 4

/**
 * One filter chip.
 *
 * A menu rather than a `<select>` so it can carry the "all" row, a tick on the choice in force and a
 * search box once the list is long — the same control the composer's own pickers use.
 */
function FilterMenu({ label, value, options, onChange }: {
  label: string
  value: string | null
  options: Array<{ id: string, label: string }>
  onChange: (id: string | null) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.id === value)
  const items: MenuItem[] = [
    { id: 'all', label: t('assistant.stats.filter_all'), checked: value === null, onSelect: () => onChange(null) },
    ...options.map((option) => ({
      id: option.id,
      label: option.label,
      checked: value === option.id,
      onSelect: () => onChange(option.id),
    })),
  ]
  return (
    <>
      <Button
        ref={ref}
        size="sm"
        variant={value ? 'secondary' : 'ghost'}
        icon={<ChevronDown size={13} />}
        onClick={() => setOpen((next) => !next)}
      >
        {current ? current.label : label}
      </Button>
      <Menu
        anchor={ref}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        align="end"
        width={220}
        searchable={options.length > 8}
        label={label}
      />
    </>
  )
}

/** Where the window's money went: the totals, the cost chart, and each busy model's own trend. */
function UsageDetail() {
  const [range, setRange] = useState<Range>('7')
  const [model, setModel] = useState<string | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [group, setGroup] = useState<Grouping>('model')
  const [stats, setStats] = useState<AssistantStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  useLocale()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api.assistant.stats(range, { model: model ?? undefined, key: key ?? undefined }).then((result) => {
      if (cancelled) return
      setStats(result)
    }).catch(() => {
      if (!cancelled) setStats(null)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [range, reload, model, key])

  // The currency the cost chart draws: the one the window was mostly billed in. A window priced in two is
  // two bills, and one stacked bar of both would be adding different money together.
  const mainSpend = useMemo(
    () => [...(stats?.spend ?? [])].sort((left, right) => right.amount - left.amount)[0] ?? null,
    [stats],
  )

  // The options come from the key breakdown, which the server leaves unfiltered, so choosing one filter
  // never empties the other dropdown: a model list narrowed to the key already picked would strand the
  // reader with no way back.
  const modelOptions = useMemo(
    () => (stats?.modelOptions ?? []).map((label) => ({ id: label, label })),
    [stats],
  )

  const keyOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const entry of stats?.keys ?? []) {
      const id = `${entry.providerId}:${entry.keyId}`
      if (!seen.has(id)) seen.set(id, entry.keyId ? `${entry.providerLabel} · ${entry.keyLabel}` : entry.providerLabel)
    }
    return [...seen].map(([id, label]) => ({ id, label }))
  }, [stats])

  return (
    <Group title={t('assistant.stats.title')}>
      <div className="flex flex-wrap items-center gap-2 py-2">
        <Segmented
          size="sm"
          label={t('assistant.stats.range')}
          value={range}
          onChange={(next) => setRange(next as Range)}
          options={RANGES.map((entry) => ({ value: entry, label: t(`assistant.stats.range_${entry}`) }))}
        />
        <FilterMenu label={t('assistant.stats.filter_model')} value={model} options={modelOptions} onChange={setModel} />
        <FilterMenu label={t('assistant.stats.filter_key')} value={key} options={keyOptions} onChange={setKey} />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>
          <RefreshCw size={13} />
          {t('common.refresh')}
        </Button>
      </div>

      {loading && !stats ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : !stats ? (
        <p className="py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.stats.unavailable')}</p>
      ) : (
        <div className="space-y-3 py-2">
          {/* The money leads, because it is the number a reader opens this screen to check. It is a card
              rather than a line of text so a glance is enough, and the unpriced count travels inside it:
              a total that quietly left models out is worse than one that says what it left out. */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <div className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
              <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                <Coins size={11} className="mr-1 inline align-[-1px]" />
                {t('assistant.stats.cost')}
              </p>
              <p className="mt-0.5 text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">
                {mainSpend ? money(mainSpend.amount, mainSpend.currency) : t('assistant.stats.cost_none')}
              </p>
              {stats.unpricedModels > 0 && (
                <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.stats.unpriced', { count: stats.unpricedModels })}</p>
              )}
            </div>
            {[
              [t('assistant.stats.requests'), stats.total.requests.toLocaleString()],
              [t('assistant.stats.tokens_in'), compact(stats.total.inputTokens)],
              [t('assistant.stats.tokens_out'), compact(stats.total.outputTokens)],
              [t('assistant.stats.tools'), stats.total.toolCalls.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
                <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</p>
                <p className="mt-0.5 text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">{value}</p>
              </div>
            ))}
          </div>

          {stats.series.length > 0 && (
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('assistant.stats.cost_chart')}{mainSpend ? ` (${mainSpend.currency})` : ''}
                </p>
                {/* The same days, grouped two ways: which model the money went to, or which key paid for
                    it. Both splits arrive on the same series, so the switch costs no request. */}
                <Segmented
                  size="sm"
                  label={t('assistant.stats.group_by')}
                  value={group}
                  onChange={(next) => setGroup(next as Grouping)}
                  options={[
                    { value: 'model', label: t('assistant.stats.filter_model') },
                    { value: 'key', label: t('assistant.stats.filter_key') },
                  ]}
                />
              </div>
              {mainSpend ? (
                <CostBars series={stats.series} group={group} currency={mainSpend.currency} />
              ) : (
                <p className="py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.stats.cost_none')}</p>
              )}
            </div>
          )}

          {/* Each of the busiest models gets its own pair of charts. Bounded, because a reader with a
              dozen models would otherwise scroll past a dozen canvases to reach the conversations — and
              the account view's ranking already says which ones did not make the cut. */}
          {stats.models.slice(0, MAX_MODEL_SECTIONS).map((entry) => (
            <div key={entry.label}>
              <p className="mb-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
                {entry.label || t('assistant.stats.unknown_model')}
              </p>
              <ModelTrend series={stats.series} label={entry.label} />
            </div>
          ))}

          {stats.conversations.length > 0 && (
            <div>
              <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.by_conversation')}</p>
              <ul className="space-y-0.5">
                {stats.conversations.map((conversation) => (
                  <li key={conversation.id} className="flex items-center gap-2 text-[length:var(--text-12)]">
                    <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{conversation.title || t('assistant.chat.untitled')}</span>
                    <span className="shrink-0 tabular text-[var(--text-quaternary)]">
                      {conversation.requests} · {compact(conversation.inputTokens + conversation.outputTokens)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Group>
  )
}

export function UsagePanel() {
  const [view, setView] = useState<View>('detail')
  return (
    <>
      <Segmented
        size="sm"
        label={t('assistant.stats.view')}
        value={view}
        onChange={(next) => setView(next as View)}
        options={VIEWS.map((entry) => ({ value: entry, label: t(`assistant.stats.view_${entry}`) }))}
        className={cn('self-start')}
      />
      {view === 'detail' ? <UsageDetail /> : <Group title={t('assistant.stats.app_usage')}><AppUsage /></Group>}
    </>
  )
}

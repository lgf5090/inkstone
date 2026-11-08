import type { IconBootstrap, IconFormat } from '@shared/development/icons/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { Button } from '../../../../components/primitives'
import { Checkbox, Input } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { DatePicker } from '../../../../components/date-picker'
import { activeFilterCount, clearFilters, type BrowseState, type IconColorFilter, type IconStyleFilter } from '../lib/browse'

const FORMATS: { id: IconFormat; label: string }[] = [
  { id: 'svg', label: 'SVG' },
  { id: 'png', label: 'PNG' },
  { id: 'jpg', label: 'JPG' },
  { id: 'webp', label: 'WebP' },
]

const STYLES: { id: Exclude<IconStyleFilter, ''>; label: string }[] = [
  { id: 'line', label: 'development.icons.style.line' },
  { id: 'fill', label: 'development.icons.style.fill' },
  { id: 'duotone', label: 'development.icons.style.duotone' },
  { id: 'brand', label: 'development.icons.style.brand' },
]

const COLORS: { id: Exclude<IconColorFilter, ''>; label: string }[] = [
  { id: 'mono', label: 'development.icons.filter.mono' },
  { id: 'multi', label: 'development.icons.filter.multi' },
]

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[length:var(--text-11)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{title}</h3>
        {hint && <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Chip({ pressed, onClick, children, count }: { pressed: boolean; onClick: () => void; children: React.ReactNode; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[var(--r-full)] border px-2.5 text-[length:var(--text-11)] transition-colors',
        pressed
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
      )}
    >
      {children}
      {count !== undefined && <span className="tabular-nums text-[var(--text-tertiary)]">{count}</span>}
    </button>
  )
}

export interface FilterPanelProps {
  open: boolean
  onClose: () => void
  bootstrap: IconBootstrap
  state: BrowseState
  onChange: (state: BrowseState) => void
}

/**
 * One place for every facet, with the count each choice would leave behind. Chips toggle in place;
 * the grid refetches while the panel stays open, so a reader can see the effect before closing it.
 */
export function FilterPanel({ open, onClose, bootstrap, state, onChange }: FilterPanelProps) {
  const counts = bootstrap.counts
  const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value])
  const active = activeFilterCount(state)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.icons.filter.title')}
      description={t('development.icons.filter.description')}
      width={620}
      footer={(
        <div className="flex w-full items-center gap-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.icons.filter.active')}: {active}</span>
          <Button size="sm" variant="ghost" onClick={() => onChange(clearFilters(state))} disabled={!active}>{t('development.icons.filter.reset')}</Button>
          <Button size="sm" className="ml-auto" onClick={onClose}>{t('development.icons.filter.done')}</Button>
        </div>
      )}
    >
      <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
        <Section title={t('development.icons.filter.collections')}>
          <div className="flex flex-wrap gap-1.5">
            {bootstrap.collections.map((collection) => (
              <Chip
                key={collection.id}
                pressed={state.collections.includes(collection.id)}
                count={counts.collections[collection.id] ?? 0}
                onClick={() => onChange({ ...state, state: 'all', collections: toggle(state.collections, collection.id) })}
              >
                {collection.name}
              </Chip>
            ))}
            {bootstrap.collections.length === 0 && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.collection.empty')}</span>}
          </div>
        </Section>

        <Section title={t('development.icons.filter.style')}>
          <div className="flex flex-wrap gap-1.5">
            {STYLES.map((style) => (
              <Chip
                key={style.id}
                pressed={state.style === style.id}
                count={counts.styles[style.id] ?? 0}
                onClick={() => onChange({ ...state, style: state.style === style.id ? '' : style.id })}
              >
                {t(style.label as never)}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title={t('development.icons.filter.format')}>
          <div className="flex flex-wrap gap-1.5">
            {FORMATS.map((format) => (
              <Chip
                key={format.id}
                pressed={state.formats.includes(format.id)}
                count={counts.formats[format.id] ?? 0}
                onClick={() => onChange({ ...state, formats: toggle(state.formats, format.id) })}
              >
                {format.label}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title={t('development.icons.filter.tags')}>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {bootstrap.tags.map((tag) => (
              <Chip
                key={tag.id}
                pressed={state.tags.includes(tag.id)}
                count={counts.tags[tag.id] ?? 0}
                onClick={() => onChange({ ...state, state: 'all', tags: toggle(state.tags, tag.id) })}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                {tag.name}
              </Chip>
            ))}
            {bootstrap.tags.length === 0 && <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.tag.empty')}</span>}
          </div>
        </Section>

        <Section title={t('development.icons.filter.color')}>
          <div className="flex flex-wrap gap-1.5">
            {COLORS.map((color) => (
              <Chip
                key={color.id}
                pressed={state.colorMode === color.id}
                count={counts.colorModes[color.id] ?? 0}
                onClick={() => onChange({ ...state, colorMode: state.colorMode === color.id ? '' : color.id })}
              >
                {t(color.label as never)}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title={t('development.icons.filter.size')} hint={t('development.icons.filter.size_hint')}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={8192}
              value={state.sizeMin}
              placeholder="0"
              aria-label={t('development.icons.filter.size_min')}
              onChange={(event) => onChange({ ...state, sizeMin: event.target.value })}
              className="w-28"
            />
            <span className="text-[var(--text-tertiary)]">—</span>
            <Input
              type="number"
              min={0}
              max={8192}
              value={state.sizeMax}
              placeholder="8192"
              aria-label={t('development.icons.filter.size_max')}
              onChange={(event) => onChange({ ...state, sizeMax: event.target.value })}
              className="w-28"
            />
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{'px'}</span>
          </div>
        </Section>

        <Section title={t('development.icons.filter.created')}>
          <div className="flex flex-wrap items-center gap-2">
            <DatePicker label={t('development.icons.filter.from')} value={state.from} placeholder={t('development.icons.filter.from')} onChange={(value) => onChange({ ...state, from: value })} className="w-40" />
            <span className="text-[var(--text-tertiary)]">—</span>
            <DatePicker label={t('development.icons.filter.to')} value={state.to} placeholder={t('development.icons.filter.to')} onChange={(value) => onChange({ ...state, to: value })} className="w-40" />
          </div>
        </Section>

        <Section title={t('development.icons.filter.views')}>
          <div className="flex flex-wrap gap-3">
            <Checkbox
              checked={state.state === 'favorites'}
              onChange={(checked) => onChange({ ...state, state: checked ? 'favorites' : 'all' })}
              label={t('development.icons.sidebar.favorites')}
            />
            <Checkbox
              checked={state.state === 'pinned'}
              onChange={(checked) => onChange({ ...state, state: checked ? 'pinned' : 'all' })}
              label={t('development.icons.sidebar.pinned')}
            />
          </div>
        </Section>
      </div>
    </Modal>
  )
}

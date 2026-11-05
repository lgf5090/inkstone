/**
 * The tag colour board, the same one the notebook paints for tags and folders.
 *
 * The presets are `ORGANIZER_COLORS` — the ramp folders, note tags and QuickAdd already share — so a
 * reader who picked "red" in one module sees the same red here. The first sixteen are the deep tones
 * the app shipped with and the last eight are the same hues one step brighter; the grid draws them in
 * that order rather than inventing a second palette. The last row keeps the custom wheel and hex
 * field, guarded against a colour that would disappear into the panel behind it.
 */
import { useRef, useState } from 'react'
import { Hash, Settings2 } from 'lucide-react'
import {
  ORGANIZER_COLORS,
  isCustomOrganizerColor,
  isOrganizerColorVisible,
  isResolvedOrganizerColor,
  organizerColorContrast,
  organizerColorLabel,
} from '@shared/organizer-colors'
import { cn } from '../../lib/cn'
import { isImeComposing } from '../../lib/ime'
import { Input } from '../../components/form'
import { Swatch } from '../../components/color-swatch'
import { ColorWheelTrigger } from '../../components/color-field'
import { paintedSurface } from '../../lib/format-colors'
import { t } from '../../lib/i18n'

const PANEL_WIDTH = 214

export function TagColorMenu({ color, onSelectColor, onManageTags }: {
  color?: string | null
  onSelectColor: (color: string | null) => void
  onManageTags?: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [refused, setRefused] = useState(false)
  // The panel behind the field is what the swatch is read against; walking to it keeps the guard
  // honest in both themes instead of assuming a surface.
  const surface = () => paintedSurface(panelRef.current, isResolvedOrganizerColor)
  const ratio = (hex: string) => organizerColorContrast(hex, surface())
  const offer = (hex: string) => {
    const next = hex.toLocaleLowerCase()
    if (!isCustomOrganizerColor(next)) return
    if (!isOrganizerColorVisible(next, surface())) {
      setDraft(next)
      setRefused(true)
      return
    }
    setRefused(false)
    onSelectColor(next)
  }
  const shown = color ?? null
  const shownRatio = shown && isCustomOrganizerColor(shown) ? ratio(shown) : null
  return (
    <div
      ref={panelRef}
      role="group"
      aria-label={t('scriptshub.tag.color')}
      className="w-[214px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)] outline-none"
      style={{ width: PANEL_WIDTH }}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-0.5 pt-0.5 pb-2">
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('scriptshub.tag.color')}</span>
        {shown && (
          <span className="flex min-w-0 items-center gap-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: shown }} aria-hidden="true" />
            <span className="truncate">{organizerColorLabel(shown, t)}</span>
          </span>
        )}
      </div>
      <div role="group" aria-label={t('scriptshub.tag.color_presets')} className="grid grid-cols-6 gap-1.5 px-0.5">
        <Swatch
          color={null}
          label={t('scriptshub.tag.color_auto')}
          active={!color}
          onPick={() => {
            setRefused(false)
            onSelectColor(null)
          }}
          icon={<Hash size={13} />}
        />
        {ORGANIZER_COLORS.map((value) => (
          <Swatch
            key={value}
            color={value}
            label={organizerColorLabel(value, t)}
            active={color === value}
            background={value}
            onPick={() => {
              setRefused(false)
              onSelectColor(value)
            }}
          />
        ))}
      </div>
      <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]" />
      <div className="flex items-center gap-1.5">
        <ColorWheelTrigger
          shape="round"
          label={t('color.custom')}
          value={/^#[0-9a-f]{6}$/i.test(draft || shown || '') ? draft || shown : null}
          onChange={setDraft}
          onCommit={offer}
        />
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => offer(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              offer(event.currentTarget.value)
            }
          }}
          placeholder={shown ?? '#rrggbb'}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('scriptshub.tag.color_custom')}
          invalid={refused}
          style={{ height: 28 }}
          className={cn('min-w-0 flex-1 px-2 font-mono text-[length:var(--text-11-5)] uppercase')}
        />
      </div>
      <p className={cn('px-0.5 pt-1 text-[length:var(--text-11)]', refused ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>
        {refused
          ? t('color.contrast_too_low')
          : shownRatio !== null
            ? t('color.contrast_ratio_value0', { value0: shownRatio.toFixed(1) })
            : t('scriptshub.tag.color_custom_hint')}
      </p>
      {onManageTags && (
        <>
          <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={onManageTags}
            className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            <Settings2 size={13} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="truncate">{t('scriptshub.sidebar.tags')}</span>
          </button>
        </>
      )}
    </div>
  )
}

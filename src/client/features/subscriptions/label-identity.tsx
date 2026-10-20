/**
 * One answer to "what does this type or category look like", for everything that draws one.
 *
 * The list avatar, the rail, the share bars, the detail header and the form's combobox all used to
 * invent their own: the rail put the same `Tag` glyph on every category, the share bars filled every
 * bar with the accent, and the avatar drew the name's first character whatever the type was. Each was
 * reasonable alone and together they meant a reader could not learn what anything looks like, which is
 * the whole point of giving a label a face.
 *
 * Resolution order lives in `@shared/subscriptions/identity` so the worker's notification body can
 * pick the same colour as the browser's row. This file only caches it per render.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Check, Palette, Slash } from 'lucide-react'
import { organizerColorLabel } from '@shared/organizer-colors'
import {
  CATEGORY_PRESETS,
  hashColorOf,
  presetFor,
  SUBSCRIPTION_COLORS,
  SUBSCRIPTION_ICON_GROUPS,
  TYPE_PRESETS,
  iconValueOf,
  type IconSpec,
} from '@shared/subscriptions/identity'
import type { LabelEntry, LabelKind } from '@shared/subscriptions/model'
import { useClickOutside, useEscape, usePanelCaret } from '../../components/overlay'
import { Swatch } from '../../components/color-swatch'
import { cn } from '../../lib/cn'
import { t, useLocale, useLocaleRepaint } from '../../lib/i18n'
import { Z_INDEX } from '../../lib/z-index'
import { iconComponentOf } from './label-icons'
import { useSubscriptions } from './store'

export interface LabelIdentity {
  /** `lucide:<Name>` or null when nothing matches and an initial should draw instead. */
  icon: string | null
  /** A palette hex, always — a label with no choice still has a derived colour. */
  color: string
}

/**
 * The names worth offering in a label field: the built-in list plus whatever the reader already uses.
 *
 * Both halves matter alone. Without the built-ins a fresh account is asked to invent vocabulary from an
 * empty box — which is exactly what the reader sees before their first subscription. Without the
 * registry the suggestions forget every name that was typed by hand, and the second one costs a typo.
 *
 * Sorted with `localeCompare` on the reader's language: these labels are frequently not Latin, and a
 * byte sort would order them by code point rather than by the alphabet the reader reads in.
 */
export function useLabelSuggestions(kind: LabelKind): string[] {
  const types = useSubscriptions((state) => state.types)
  const categories = useSubscriptions((state) => state.categories)
  const locale = useLocale()
  return useMemo(() => {
    const registry = (kind === 'type' ? types : categories).map((entry) => entry.name)
    const builtIn = (kind === 'type' ? TYPE_PRESETS : CATEGORY_PRESETS).map((preset) => t(preset.key))
    const names = [...new Set([...builtIn, ...registry].map((name) => name.trim()).filter(Boolean))]
    return names.sort((a, b) => a.localeCompare(b, locale))
  }, [kind, types, categories, locale])
}

/**
 * The resolver, memoised against the two registries.
 *
 * A per-name map rather than a per-call resolution: a list of forty subscriptions asks the same six
 * questions forty times, and the preset lookup is a scan over the built-in list.
 */
export function useLabelIdentity(): (kind: LabelKind, name: string) => LabelIdentity {
  const types = useSubscriptions((state) => state.types)
  const categories = useSubscriptions((state) => state.categories)
  // Nothing here reads the locale directly, but `t` does inside the preset lookup — a re-render on
  // switch is what keeps a label named in one language from resolving against the other list.
  useLocaleRepaint()

  return useMemo(() => {
    const index = new Map<string, LabelIdentity>()
    const seed = (kind: LabelKind, list: readonly LabelEntry[]) => {
      for (const entry of list) index.set(`${kind}:${entry.name}`, resolve(entry, kind))
    }
    seed('type', types)
    seed('category', categories)
    return (kind: LabelKind, name: string): LabelIdentity => {
      const key = `${kind}:${name}`
      const known = index.get(key)
      if (known) return known
      const derived = resolve({ name, icon: '', color: '' }, kind)
      index.set(key, derived)
      return derived
    }
  }, [types, categories])
}

/**
 * Resolve one registry row, per axis.
 *
 * This is deliberately not the shared `resolveIdentity`: that one validates an icon against the list of
 * names the worker may store, and this one validates against the map of components the browser actually
 * has. The guard test keeps the two lists equal, but a name that ever arrives without a component would
 * be stored happily and draw nothing — falling through to the preset is the safer answer to a question
 * only the client can ask.
 */
function resolve(entry: LabelEntry, kind: LabelKind): LabelIdentity {
  const chosenIcon = entry.icon ? iconComponentOf(entry.icon) : null
  const chosenColor = SUBSCRIPTION_COLORS.includes(entry.color as (typeof SUBSCRIPTION_COLORS)[number])
    ? entry.color
    : null
  if (chosenIcon && chosenColor) return { icon: entry.icon, color: chosenColor }
  const preset = presetFor(entry.name, kind, (key) => t(key))
  return {
    icon: chosenIcon ? entry.icon : preset ? iconValueOf(preset.icon) : null,
    color: chosenColor ?? preset?.color ?? hashColorOf(entry.name),
  }
}

/**
 * A label's glyph.
 *
 * The colour is applied as `color`, not as a background: these are stroked icons and they read as
 * themselves only when the stroke carries the tint. `role="img"` with a name keeps the icon out of the
 * way of a reader who already hears the label beside it — hence the empty label when `named` is false.
 */
export function LabelGlyph({ identity, label, size = 14, named = false }: {
  identity: LabelIdentity
  label: string
  size?: number
  named?: boolean
}) {
  const Icon = iconComponentOf(identity.icon)
  if (!Icon) {
    return (
      <span
        aria-hidden='true'
        className='inline-flex shrink-0 items-center justify-center rounded-full text-[length:var(--text-10)] font-semibold uppercase leading-none'
        style={{ width: size + 8, height: size + 8, color: identity.color, background: `color-mix(in oklab, ${identity.color} 16%, transparent)` }}
      >
        {Array.from(label.trim())[0] ?? '?'}
      </span>
    )
  }
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full', !named && 'aria-hidden')}
      role={named ? 'img' : undefined}
      aria-label={named ? label : undefined}
      style={{ color: identity.color }}
    >
      <Icon size={size} />
    </span>
  )
}

const PANEL_WIDTH = 250
const TILE = 'size-[26px]'

/**
 * The face picker: a grid of icons and a row of swatches, opened from a label field.
 *
 * Mirrors the folder appearance menu rather than inventing a second idiom — the same tile size, the
 * same panel chrome, and a colour row the reader can clear back to the derived default, which is the
 * one control that makes an accidental choice survivable.
 *
 * A pick names one axis only. Sending the *resolved* icon along with a colour change would store the
 * default as if the reader had chosen it, and from then on a preset change could never reach that label.
 */
export function LabelStylePicker({ kind, name, onPick }: {
  kind: LabelKind
  name: string
  onPick: (patch: { icon?: string | null; color?: string | null }) => void
}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState({ top: 0, left: 0, maxHeight: 352 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const identity = useLabelIdentity()(kind, name)

  useEscape(open, () => setOpen(false))
  useClickOutside([wrapRef, panelRef], open, () => setOpen(false))
  usePanelCaret(open, panelRef, triggerRef)
  useEffect(() => {
    if (!name) setOpen(false)
  }, [name])

  /**
   * Open the panel where the trigger is, clamped to the viewport.
   *
   * The panel is portalled out of the dialog rather than left in place: inside the dialog it was clipped
   * by that dialog's own scroll box, and the last three of the sixteen colours sat below the clip. An
   * inner scrollbar could not help, because it was the panel's bottom edge that was outside.
   */
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const top = rect.bottom + 4
    setPlace({
      left: Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)),
      top,
      maxHeight: Math.max(180, Math.min(352, window.innerHeight - top - 12)),
    })
  }

  return (
    <div ref={wrapRef} className='relative'>
      <button
        ref={triggerRef}
        type='button'
        onClick={toggle}
        disabled={!name.trim()}
        aria-expanded={open}
        aria-label={t('subscriptions.picker.icon')}
        className='flex size-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-default)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40'
      >
        {open ? <Check size={13} /> : <Palette size={13} />}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className='fixed overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]'
          style={{ width: PANEL_WIDTH, top: place.top, left: place.left, maxHeight: place.maxHeight, zIndex: Z_INDEX.pop }}
          onClick={(event) => event.stopPropagation()}
        >
          {/* One scroller for the whole panel. The icon grid used to own its own, which left the colour
              rows below it outside the dialog's clip and unreachable — a reader could see thirteen of the
              sixteen colours and no way to the rest. */}
          <div className='grid grid-cols-7 gap-1'>
            {SUBSCRIPTION_ICON_GROUPS.map((group) => (
              <div key={group.key} className='col-span-7'>
                <div className='px-0.5 pb-1 pt-1 text-[length:var(--text-10)] font-medium text-[var(--text-tertiary)]'>
                  {t(group.key)}
                </div>
                <div className='grid grid-cols-7 gap-1'>
                  {group.icons.map((spec) => (
                    <IconButton key={spec.name} spec={spec} active={identity.icon === iconValueOf(spec.name)} onPick={(icon) => onPick({ icon })} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className='mt-2 grid grid-cols-7 gap-1 border-t border-[var(--border-subtle)] pt-2'>
            <Swatch
              color={null}
              label={t('subscriptions.picker.reset')}
              active={!identity.color}
              onPick={() => onPick({ color: null })}
              icon={<Slash size={11} />}
            />
            {SUBSCRIPTION_COLORS.map((color) => (
              <Swatch
                key={color}
                color={color}
                label={organizerColorLabel(color, t)}
                active={identity.color === color}
                background={color}
                onPick={() => onPick({ color })}
              />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function IconButton({ spec, active, onPick }: { spec: IconSpec; active: boolean; onPick: (icon: string) => void }) {
  const Icon = iconComponentOf(iconValueOf(spec.name))
  const label = t(spec.labelKey)
  if (!Icon) return null
  return (
    <button
      type='button'
      onClick={() => onPick(iconValueOf(spec.name))}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className={cn(
        `flex ${TILE} items-center justify-center rounded-[var(--r-sm)] transition-transform hover:scale-110 hover:bg-[var(--bg-hover)]`,
        active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
      )}
    >
      <Icon size={14} />
    </button>
  )
}

/**
 * A label as a pill: its face, its colour, its name.
 *
 * Used wherever a subscription names its type or one of its categories. An empty label draws
 * `fallbackLabel` without a tint, because "Uncategorized" is a statement about the absence of a choice
 * and painting it in a hash-derived colour would present that absence as one.
 */
export function LabelChip({ kind, name, fallbackLabel }: {
  kind: LabelKind
  name: string
  fallbackLabel?: string
}): ReactElement {
  const identityOf = useLabelIdentity()
  if (!name.trim()) {
    return (
      <span className='inline-flex items-center rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]'>
        {fallbackLabel ?? '—'}
      </span>
    )
  }
  const identity = identityOf(kind, name)
  const Icon = iconComponentOf(identity.icon)
  return (
    <span
      className='inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--text-11)]'
      style={{ color: identity.color, background: `color-mix(in oklab, ${identity.color} 14%, transparent)` }}
    >
      {Icon && <span aria-hidden='true' className='inline-flex shrink-0'><Icon size={10} /></span>}
      <span className='truncate'>{name}</span>
    </span>
  )
}

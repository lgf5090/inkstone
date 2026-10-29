import { useEffect, useRef, useState } from 'react'
import { Ban, Plus, Trash2 } from 'lucide-react'
import {
  ORGANIZER_COLORS,
  isCustomOrganizerColor,
  isOrganizerColorVisible,
  organizerColorLabel,
  organizerColorOrNull,
} from '@shared/organizer-colors'
import { Swatch } from '../../../components/color-swatch'
import { Button, IconButton } from '../../../components/primitives'
import { Input, commitOnEnter } from '../../../components/form'
import { isOpaqueBackgroundColor } from '../../../components/overlay'
import { useThemeDark } from '../../../lib/hooks'
import { t } from '../../../lib/i18n'

const DEFAULT_TAG_COLOR = ORGANIZER_COLORS[0]

/** The dot is drawn with utilities rather than feature CSS because menus portal out of the page root. */
const TAG_DOT_CLASS = 'inline-block size-2 shrink-0 rounded-full'

function useResolvedSurface(ref: React.RefObject<HTMLElement | null>): string {
  const dark = useThemeDark()
  const [surface, setSurface] = useState('')
  useEffect(() => {
    let node = ref.current
    while (node) {
      const color = getComputedStyle(node).backgroundColor
      if (isOpaqueBackgroundColor(color)) {
        setSurface(color)
        return
      }
      node = node.parentElement
    }
    setSurface('')
  }, [dark, ref])
  return surface
}

/** The colour dots a row or grid tile carries. Names stay in the inspector and list. */
export function TagDots({ tags, max = 4 }: { tags: { name: string; color: string }[]; max?: number }) {
  if (tags.length === 0) return null
  const shown = tags.slice(0, max)
  return (
    <span
      role="img"
      aria-label={tags.map((tag) => tag.name).join(', ')}
      className="flex items-center justify-center gap-1"
    >
      {shown.map((tag) => (
        <span key={tag.name} aria-hidden="true" className={TAG_DOT_CLASS} style={{ backgroundColor: tag.color }} />
      ))}
    </span>
  )
}

/** The compact tag column in list view: colour plus name, so colour is never the only cue. */
export function TagList({ tags, max = 3 }: { tags: { name: string; color: string }[]; max?: number }) {
  if (tags.length === 0) return null
  const rest = Math.max(0, tags.length - max)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {tags.slice(0, max).map((tag) => (
        <span key={tag.name} className="flex min-w-0 items-center gap-1">
          <span aria-hidden="true" className={TAG_DOT_CLASS} style={{ backgroundColor: tag.color }} />
          <span className="truncate text-[length:var(--text-11)]">{tag.name}</span>
        </span>
      ))}
      {rest > 0 && <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">+{rest}</span>}
    </span>
  )
}

/**
 * The folder palette. A custom hex is checked against the surface it will be painted on before
 * it is accepted: a folder that disappears into the background is not a preference, it is a bug.
 */
export function FolderColorMenu({
  value,
  onPick,
  className,
}: {
  value: string | null
  onPick: (color: string | null) => void
  className?: string
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const surface = useResolvedSurface(surfaceRef)
  const [draft, setDraft] = useState(value ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(value ?? '')
    setError(null)
  }, [value])

  const pick = (color: string | null) => {
    setError(null)
    onPick(color)
  }

  const applyCustom = () => {
    const candidate = organizerColorOrNull(draft.trim())
    if (!candidate) {
      setError(t('clouddrive.color.invalid'))
      return
    }
    if (!isOrganizerColorVisible(candidate, surface)) {
      setError(t('color.contrast_too_low'))
      return
    }
    setError(null)
    onPick(candidate)
  }

  const customValue = value && isCustomOrganizerColor(value) ? value : null

  return (
    <div
      ref={surfaceRef}
      onClick={(event) => event.stopPropagation()}
      className={className ?? 'w-[236px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]'}
    >
      <div className="px-1 pb-2 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
        {t('clouddrive.action.color')}
      </div>
      <div className="grid grid-cols-6 gap-1.5 px-0.5">
        <Swatch
          color={null}
          label={t('tags.clear_color')}
          active={!value}
          onPick={() => pick(null)}
          icon={<Ban size={13} />}
        />
        {ORGANIZER_COLORS.map((color) => (
          <Swatch
            key={color}
            color={color}
            label={organizerColorLabel(color, t)}
            active={value === color}
            background={color}
            onPick={() => pick(color)}
          />
        ))}
        {customValue && (
          <Swatch
            color={customValue}
            label={organizerColorLabel(customValue, t)}
            active={value === customValue}
            background={customValue}
            onPick={() => pick(customValue)}
          />
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5 px-0.5">
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => commitOnEnter(event, applyCustom)}
          placeholder={t('clouddrive.color.custom_placeholder')}
          aria-label={t('clouddrive.color.custom_placeholder')}
          aria-invalid={error ? true : undefined}
          className="h-8 min-w-0 flex-1"
        />
        <Button size="sm" variant="secondary" onClick={applyCustom}>{t('common.save')}</Button>
      </div>
      {error && <p role="alert" className="mt-1.5 px-1 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
    </div>
  )
}

/** Tags for one entry: existing rows with a remove button, plus a palette and a name field. */
export function TagEditorMenu({
  tags,
  busy = false,
  onAdd,
  onRemove,
}: {
  tags: { name: string; color: string }[]
  busy?: boolean
  onAdd: (tag: string, color: string) => void | Promise<void>
  onRemove: (tag: string) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(DEFAULT_TAG_COLOR)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim().normalize('NFC')
    if (!trimmed) return
    if (trimmed.length > 32) {
      setError(t('clouddrive.tags.invalid'))
      return
    }
    if (tags.some((tag) => tag.name.normalize('NFC').toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
      setError(t('clouddrive.error.conflict'))
      return
    }
    setError(null)
    setName('')
    void onAdd(trimmed, color)
  }

  return (
    <div onClick={(event) => event.stopPropagation()} className="w-[244px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]">
      <div className="px-1 pb-2 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
        {t('clouddrive.action.tags')}
      </div>
      {tags.length === 0
        ? <p className="px-1 pb-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.tags.none')}</p>
        : (
          <ul className="mb-2 flex flex-col gap-0.5 px-0.5">
            {tags.map((tag) => (
              <li key={tag.name} className="flex items-center gap-2 rounded-[var(--r-sm)] px-1 py-1 hover:bg-[var(--bg-hover)]">
                <span aria-hidden="true" className={TAG_DOT_CLASS} style={{ backgroundColor: tag.color }} />
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{tag.name}</span>
                <IconButton
                  size="xs"
                  label={`${t('clouddrive.tags.remove')}: ${tag.name}`}
                  disabled={busy}
                  onClick={() => void onRemove(tag.name)}
                >
                  <Trash2 size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      <div className="grid grid-cols-6 gap-1.5 px-0.5">
        {ORGANIZER_COLORS.map((swatch) => (
          <Swatch
            key={swatch}
            color={swatch}
            label={organizerColorLabel(swatch, t)}
            active={color === swatch}
            background={swatch}
            onPick={() => setColor(swatch)}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 px-0.5">
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => commitOnEnter(event, submit)}
          placeholder={t('clouddrive.tags.placeholder')}
          aria-label={t('clouddrive.tags.placeholder')}
          aria-invalid={error ? true : undefined}
          className="h-8 min-w-0 flex-1"
        />
        <Button size="sm" variant="secondary" icon={<Plus size={12} />} onClick={submit} disabled={busy}>
          {t('clouddrive.tags.add')}
        </Button>
      </div>
      {error && <p role="alert" className="mt-1.5 px-1 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
    </div>
  )
}

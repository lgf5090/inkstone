import { useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Eye, Pencil } from 'lucide-react'
import { t } from '../../../i18n'
import { KANBAN_DESCRIPTION_MAX_CHARS } from '../body'

/**
 * Descriptions are free prose stored inside the note body, so the box bounds how far one can grow
 * instead of letting a single card balloon the fence. Content a board already stores above the bound
 * stays editable: clamping it on the first keystroke would delete what the note already holds.
 * The bound itself is the fence's own (`KANBAN_DESCRIPTION_MAX_CHARS` in `body.ts`) — every writer
 * answers to the same number.
 */
export { KANBAN_DESCRIPTION_MAX_CHARS }
/** The counter appears for the last stretch, so the bound is seen coming rather than only hit. */
const KANBAN_DESCRIPTION_WARN_CHARS = KANBAN_DESCRIPTION_MAX_CHARS - 500
const DESCRIPTION_ROWS = 4
const EXPANDED_DESCRIPTION_ROWS = 16
const DESCRIPTION_TEXT_CLASS = 'w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-[var(--sp-2-5)] text-[length:var(--text-12)] text-[var(--text-primary)]'
const DESCRIPTION_CONTROL_CLASS = 'flex items-center justify-center rounded-[var(--r-xs)] p-[var(--sp-1)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'

/** What the length bound has to say about the draft in progress: the notice only after a rejection. */
function DescriptionFeedback({ count, trimmed }: { count: number; trimmed: boolean }) {
  if (!trimmed && count < KANBAN_DESCRIPTION_WARN_CHARS) return null
  return (
    <>
      {trimmed ? (
        <p role='status' className='text-[length:var(--text-11)] text-[var(--text-secondary)]'>
          {t('preview.kanban_desc_limit_reached', { limit: KANBAN_DESCRIPTION_MAX_CHARS })}
        </p>
      ) : null}
      {count >= KANBAN_DESCRIPTION_WARN_CHARS ? (
        <p data-kanban-desc-count className='text-[length:var(--text-11)] text-[var(--text-tertiary)] tabular'>
          {t('preview.kanban_desc_count', { count, limit: KANBAN_DESCRIPTION_MAX_CHARS })}
        </p>
      ) : null}
    </>
  )
}

/** The heading and the two controls that change how the box below it is drawn. */
function DescriptionHeader({
  boxId,
  expanded,
  previewable,
  previewing,
  onToggleExpand,
  onTogglePreview,
}: {
  boxId: string
  expanded: boolean
  previewable: boolean
  previewing: boolean
  onToggleExpand: () => void
  onTogglePreview: () => void
}) {
  return (
    <div className='flex items-center justify-between gap-[var(--sp-2)]'>
      {/* The type goes on this wrapper, not on the heading: prose owns a note's `h4` and wins any
          utility written on it (see the hand-back block in `styles/kanban.css`). */}
      <div className='text-[length:var(--text-13)] font-semibold'>
        <h4 className='text-[var(--text-secondary)]'>
          {t('preview.kanban_card_description')}
        </h4>
      </div>
      <div className='flex items-center gap-[var(--sp-1)]'>
        {previewable ? (
          <button
            type='button'
            aria-controls={boxId}
            aria-label={t(previewing ? 'preview.kanban_edit_description' : 'preview.kanban_preview_description')}
            onClick={onTogglePreview}
            className={DESCRIPTION_CONTROL_CLASS}
          >
            {previewing ? <Pencil size={14} /> : <Eye size={14} />}
          </button>
        ) : null}
        {previewing ? null : (
          <button
            type='button'
            aria-expanded={expanded}
            aria-controls={boxId}
            aria-label={t(expanded ? 'preview.kanban_collapse_description' : 'preview.kanban_expand_description')}
            onClick={onToggleExpand}
            className={DESCRIPTION_CONTROL_CLASS}
          >
            <ChevronDown size={14} className={expanded ? 'rotate-180' : undefined} />
          </button>
        )}
      </div>
    </div>
  )
}

/** The box itself: the same draft, either as source being edited or as prose the host rendered. */
function DescriptionBox({
  id,
  draft,
  expanded,
  html,
  onInput,
  onBlur,
  onDiscard,
}: {
  id: string
  draft: string
  expanded: boolean
  html: string | null
  onInput: (next: string) => void
  onBlur: () => void
  onDiscard: () => void
}) {
  if (html !== null) {
    // The host's renderer is the sanitizer: it is the very pipeline the note body goes through, so a
    // description cannot preview a wider surface than the note it lives in already draws.
    return (
      <div
        id={id}
        data-kanban-desc-preview
        className={`ink-prose ${DESCRIPTION_TEXT_CLASS}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <textarea
      id={id}
      value={draft}
      data-owns-escape='true'
      onChange={(e) => onInput(e.target.value)}
      onBlur={onBlur}
      // Enter commits nothing here: the description is the one multi-line field, so the key must stay a newline.
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDiscard()
      }}
      placeholder={t('preview.kanban_card_description_placeholder')}
      rows={expanded ? EXPANDED_DESCRIPTION_ROWS : DESCRIPTION_ROWS}
      className={`${DESCRIPTION_TEXT_CLASS} outline-none resize-y focus:border-[var(--accent)]`}
    />
  )
}

/**
 * Everything the description box remembers: the uncommitted draft, whether the last edit was refused
 * for length, and how tall / which face of the box is showing. All of it belongs to one card, which is
 * why the caller keys this component by item id — switching cards gives a fresh box instead of
 * carrying one card's draft into another, without a hand-rolled tracker of which card we were on.
 */
function useDescriptionBox(
  content: string | undefined,
  onChange: (text: string) => void,
  renderDescription?: (source: string) => string,
) {
  const [draft, setDraft] = useState(content ?? '')
  const [trimmed, setTrimmed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const boxId = useId()
  const lastSent = useRef(content ?? '')
  const commitDraft = () => {
    if (draft === lastSent.current) return
    lastSent.current = draft
    onChange(draft)
  }
  // An emptied draft has nothing to render, so offering the control there would be a dead button.
  const previewable = renderDescription !== undefined && draft.trim() !== ''
  const showPreview = previewing && previewable
  return {
    boxId,
    draft,
    trimmed,
    expanded,
    previewable,
    showPreview,
    html: useMemo(
      () => (showPreview && renderDescription ? renderDescription(draft) : null),
      [showPreview, renderDescription, draft],
    ),
    onInput: (next: string) => {
      const ceiling = Math.max(KANBAN_DESCRIPTION_MAX_CHARS, draft.length)
      const kept = next.slice(0, ceiling)
      setTrimmed(kept.length < next.length)
      setDraft(kept)
    },
    onBlur: commitDraft,
    onDiscard: () => {
      setDraft(lastSent.current)
      setTrimmed(false)
    },
    onToggleExpand: () => setExpanded((prev) => !prev),
    onTogglePreview: () => {
      commitDraft()
      setPreviewing((prev) => !prev)
    },
  }
}

export function DetailDescription({
  content,
  onChange,
  renderDescription,
}: {
  content?: string
  onChange: (text: string) => void
  renderDescription?: (source: string) => string
}) {
  const box = useDescriptionBox(content, onChange, renderDescription)
  return (
    <div data-kanban-description className='flex flex-col gap-[var(--sp-2)]'>
      <DescriptionHeader
        boxId={box.boxId}
        expanded={box.expanded}
        previewable={box.previewable}
        previewing={box.showPreview}
        onToggleExpand={box.onToggleExpand}
        onTogglePreview={box.onTogglePreview}
      />
      <DescriptionBox
        id={box.boxId}
        draft={box.draft}
        expanded={box.expanded}
        html={box.html}
        onInput={box.onInput}
        onBlur={box.onBlur}
        onDiscard={box.onDiscard}
      />
      <DescriptionFeedback count={box.draft.length} trimmed={box.trimmed} />
    </div>
  )
}

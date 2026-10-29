import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, Plus } from 'lucide-react'
import {
  buildTagTree,
  tagDepth,
  type YouTubeTag,
  type YouTubeTagNode,
  type YouTubeVideo,
} from '@shared/youtube/model'
import { useClickOutside, useEscape } from '../../../components/overlay'
import { treeIndent } from '../../../lib/tree/indent'
import { TagPill } from '../../../components/TagChip'
import { t } from '../../../lib/i18n'

/** Walk the tree in the order it is drawn, so a child is listed directly below its parent. */
function flattenTagTree(nodes: YouTubeTagNode[]): YouTubeTag[] {
  return nodes.flatMap((node) => [node, ...flattenTagTree(node.children)])
}

const ORDER_CACHE = new WeakMap<readonly YouTubeTag[], YouTubeTag[]>()

function orderedTagList(tags: readonly YouTubeTag[]): YouTubeTag[] {
  const cached = ORDER_CACHE.get(tags)
  if (cached) return cached
  const ordered = flattenTagTree(buildTagTree(tags))
  ORDER_CACHE.set(tags, ordered)
  return ordered
}

/**
 * The tags a saved video wears, and the picker that changes them.
 *
 * The bar stays a row of chips, so the list of the video's own tags is readable without opening
 * anything. The picker is a popover rather than a dialog: it belongs to the row, and a dialog would
 * cover the row the reader is working on. Every option is a button, so a row can be toggled from the
 * keyboard, and the pointer only ever lands on this bar — never on the row's selection overlay.
 */
export function TagAssignBar(props: {
  video: YouTubeVideo
  assignedTags: YouTubeTag[]
  allTags: YouTubeTag[]
  onToggle: (tagId: string) => void
}) {
  const { assignedTags, allTags, onToggle } = props
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState({ up: false, right: false })
  const barRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const panelId = useId()

  const orderedTags = useMemo(() => orderedTagList(allTags), [allTags])
  const assignedIds = useMemo(() => new Set(assignedTags.map((tag) => tag.id)), [assignedTags])

  const close = () => setOpen(false)

  useClickOutside([barRef], open, close)
  useEscape(open, () => {
    close()
    triggerRef.current?.focus({ preventScroll: true })
  })

  // Opening the panel moves the caret to its first row, so the arrow keys work without a Tab first.
  useEffect(() => {
    if (!open) return
    rowRefs.current[0]?.focus({ preventScroll: true })
  }, [open])

  const focusRow = (index: number) => {
    const count = orderedTags.length
    if (!count) return
    const next = ((index % count) + count) % count
    rowRefs.current[next]?.focus({ preventScroll: true })
  }

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      focusRow(index + 1)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      focusRow(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusRow(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusRow(orderedTags.length - 1)
    }
  }

  return (
    <div
      ref={barRef}
      role="group"
      aria-label={t('youtube.tags.assign')}
      data-video-id={props.video.id}
      className="flex flex-wrap items-center gap-1"
    >
      {assignedTags.map((tag) => (
        <TagPill key={tag.id} label={tag.name} color={tag.color} />
      ))}
      <div className="relative inline-flex">
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('youtube.tags.add_tag')}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={(event) => {
            event.stopPropagation()
            const rect = triggerRef.current?.getBoundingClientRect()
            if (rect) {
              setPlacement({
                up: rect.bottom + 280 > window.innerHeight,
                right: rect.right + 256 > window.innerWidth,
              })
            }
            setOpen((current) => !current)
          }}
          className="inline-flex items-center gap-1 rounded-[var(--r-full)] border border-dashed border-[var(--border-default)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-[length:var(--text-11)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <Plus size={11} aria-hidden="true" />
          {t('youtube.tags.add_tag')}
        </button>
        {open ? (
          <div
            id={panelId}
            role="group"
            aria-label={t('youtube.tags.assign')}
                  className={`absolute z-[var(--z-pop)] max-h-64 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)] ${placement.up ? 'bottom-full mb-1' : 'top-full mt-1'} ${placement.right ? 'right-0' : 'left-0'}`}
          >
            {orderedTags.length === 0 ? (
              <div className="px-2 py-3">
                <p className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
                  {t('youtube.tags.none_here')}
                </p>
                <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
                  {t('youtube.tags.none_hint')}
                </p>
              </div>
            ) : (
              orderedTags.map((tag, index) => {
                const assigned = assignedIds.has(tag.id)
                return (
                  <button
                    key={tag.id}
                    ref={(node) => {
                      rowRefs.current[index] = node
                    }}
                    type="button"
                    aria-pressed={assigned}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggle(tag.id)
                    }}
                    onKeyDown={(event) => onRowKeyDown(event, index)}
                    style={{ paddingLeft: treeIndent(tagDepth(allTags, tag.id)) }}
                    className="flex w-full items-center gap-1.5 rounded-[var(--r-sm)] py-1 pr-2 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                  >
                    <span
                      aria-hidden="true"
                      className="size-[var(--sp-1-5)] shrink-0 rounded-[var(--r-full)]"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                    {assigned ? <Check size={12} aria-hidden="true" className="shrink-0 text-[var(--accent)]" /> : null}
                  </button>
                )
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

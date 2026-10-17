/**
 * A message's own menu: what the reader can do with one turn, wherever the pointer happens to be.
 *
 * The hover row under a message carries the two or three actions a reader reaches for most, and that is
 * the right size for a row of icons. The rest — copy as plain text, read it aloud, keep it as a note,
 * download it, quote it back — have had nowhere to live, so an action existed only if some surface
 * happened to draw a button for it. A context menu is where a reader looks for the rest of them, and it
 * costs nothing on screen until it is asked for.
 *
 * The rows are built by a plain function so the shape of the menu is testable without a pointer: which
 * rows each role offers, and which of them are only there when they can actually do something.
 */

import { useCallback, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { Copy, CornerUpLeft, Download, GitBranch, ListChecks, MessageSquareQuote, NotebookPen, NotebookText, PanelRight, Pencil, Play, RotateCcw, Share2, TextCursorInput, ThumbsDown, ThumbsUp, Trash2, Volume2, type LucideIcon } from 'lucide-react'
import { toPlainText } from '@shared/markdown-utils'
import type { MessageFeedback } from '@shared/assistant'
import { Z_INDEX } from '../../lib/z-index'
import { getLocale, t } from '../../lib/i18n'
import { Menu, useContextMenu, type MenuItem } from '../../components/overlay'
import { downloadTextFile, safeFileName } from '../../lib/export-note'
import { copyText } from '../../lib/clipboard'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { saveReplyAsNote } from './save-to-note'
import { canSpeak, speak, stopSpeaking } from './speech'

/** A point on screen, in the shape `Menu` anchors to. */
export interface MenuPoint {
  x: number
  y: number
}

export interface MessageMenuTarget {
  role: 'user' | 'assistant'
  /** The turn as stored: Markdown for a reply, the reader's own words for their message. */
  text: string
  /** Offered only where asking again means something — the newest answer of the thread. */
  onRetry?: () => void
  onRetryLabel?: 'assistant.chat.retry' | 'assistant.chat.regenerate'
  /** Offered on the newest answer only: finish a reply that stopped early instead of asking again. */
  onContinue?: () => void
  onEdit?: () => void
  onDelete?: () => void
  /** The verdict already left on this answer, so the menu can show which thumb is down. */
  feedback?: MessageFeedback
  /** Present only where a verdict can be recorded — a stored answer, not a turn still streaming. */
  onRate?: (feedback: MessageFeedback) => void
  /** Present for a stored turn: a branch carries the thread up to and including this message. */
  onFork?: () => void
  /** Turns the thread into a picker with this message already ticked. */
  onSelect?: () => void
  /** Publishes this turn behind a link. Present for a stored turn, which is the only kind with an id. */
  onShare?: () => void
  /**
   * Present for a stored reply: keeps a copy of it as a draft in the conversation's side panel.
   *
   * A copy and not a move — the reply stays the record of what was said, and the draft is what the reader
   * edits. Offered only where there is a row to hang a draft on, which is why the live turn has none.
   */
  onOpenCanvas?: () => void
  /**
   * Present for a stored reply: keeps the whole thread as a note, with a pointer back to it.
   *
   * The row is about the thread, not the message, but this is the menu the reader has open while
   * reading one — and the alternative is the conversation list's export, which writes a file and
   * never reaches the notebook.
   */
  onSaveConversation?: () => void
  /**
   * Present for a stored reply while a note is open: puts `![[chat:<id>]]` into that note.
   *
   * The row is about the thread, not the message, but this is the menu the reader has open while
   * reading one — and the alternative is asking them to find the conversation's id.
   */
  onEmbedInNote?: () => void
  /**
   * Present for a stored reply while a note is open: writes this answer into that note.
   *
   * A reply that has to be read in the chat container before it can be written means retyping it, which
   * is the whole reason this row exists; where the write lands (the caret, or the end of the note) is
   * the module's own decision rather than the caller's.
   */
  onInsertIntoNote?: () => void
}

interface ItemSpec {
  id: string
  icon: LucideIcon
  label: string
  run: () => void
  separatorBefore?: boolean
  checked?: boolean
}

/**
 * Copy one menu row's text.
 *
 * The failure is said out loud: a copy that quietly did nothing is indistinguishable from one that
 * worked, and the reader only finds out when they paste somewhere and nothing arrives.
 */
function copy(text: string): void {
  void copyText(text).then((ok) => {
    if (!ok) useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
  })
}

function readAloud(text: string): void {
  stopSpeaking()
  speak(toPlainText(text), getLocale())
}

/** The name a downloaded turn takes, from its own first line. */
function downloadName(text: string, role: MessageMenuTarget['role']): string {
  const firstLine = toPlainText(text).split('\n')[0] ?? ''
  const fallback = t(role === 'user' ? 'assistant.chat.you' : 'assistant.chat.assistant')
  return safeFileName(firstLine.slice(0, 40).trim() || fallback)
}

/**
 * The rows this message offers.
 *
 * A row that cannot do anything is left out rather than drawn disabled: a menu of greyed-out entries is
 * a menu a reader has to read twice, and every one of these is knowable from the message alone.
 */
export function messageMenuItems(target: MessageMenuTarget): MenuItem[] {
  const specs: ItemSpec[] = [
    {
      id: 'copy-md',
      icon: Copy,
      label: target.role === 'assistant' ? t('assistant.chat.copy_markdown') : t('assistant.chat.copy'),
      run: () => copy(target.text),
    },
    {
      id: 'copy-text',
      icon: Copy,
      label: t('assistant.chat.copy_plain'),
      run: () => copy(toPlainText(target.text)),
    },
    {
      id: 'quote',
      icon: CornerUpLeft,
      label: t('assistant.chat.quote'),
      run: () => useAssistant.getState().seedComposer(quoteOf(target)),
    },
  ]
  if (canSpeak()) {
    specs.push({ id: 'read', icon: Volume2, label: t('assistant.chat.read_aloud'), run: () => readAloud(target.text) })
  }
  if (target.role === 'assistant') {
    specs.push(
      { id: 'save', icon: NotebookPen, label: t('assistant.chat.save_to_note'), run: () => saveReplyAsNote(target.text) },
    )
    if (target.onSaveConversation) {
      specs.push({
        id: 'save-conversation',
        icon: NotebookText,
        label: t('assistant.note.save_conversation'),
        run: target.onSaveConversation,
      })
    }
    // Between keeping it as a note and taking it away: a note is where a reply goes when it is finished,
    // and the panel is where one goes while it is still being worked on.
    if (target.onOpenCanvas) {
      specs.push({ id: 'canvas', icon: PanelRight, label: t('assistant.canvas.open'), run: target.onOpenCanvas })
    }
    if (target.onInsertIntoNote) {
      specs.push({
        id: 'insert-into-note',
        icon: TextCursorInput,
        label: t('assistant.note.insert_into_note'),
        run: target.onInsertIntoNote,
      })
    }
    if (target.onEmbedInNote) {
      specs.push({ id: 'embed-in-note', icon: MessageSquareQuote, label: t('assistant.embed.menu'), run: target.onEmbedInNote })
    }
    specs.push(
      {
        id: 'download',
        icon: Download,
        label: t('assistant.chat.download_markdown'),
        run: () => downloadTextFile(`${downloadName(target.text, 'assistant')}.md`, target.text, 'text/markdown;charset=utf-8'),
      },
    )
  }
  // Beside the picking row below it rather than among the copies above: both of them are about what
  // leaves this app, and a reader looking for one will find the other.
  if (target.onShare) {
    specs.push({ id: 'share', icon: Share2, label: t('assistant.chat.share_message'), run: target.onShare, separatorBefore: true })
  }
  if (target.onRate) {
    specs.push(
      {
        id: 'rate-up',
        icon: ThumbsUp,
        label: t('assistant.chat.rate_up'),
        run: () => target.onRate!('up'),
        checked: target.feedback === 'up',
        separatorBefore: true,
      },
      {
        id: 'rate-down',
        icon: ThumbsDown,
        label: t('assistant.chat.rate_down'),
        run: () => target.onRate!('down'),
        checked: target.feedback === 'down',
      },
    )
  }
  if (target.onFork) {
    specs.push({ id: 'fork', icon: GitBranch, label: t('assistant.chat.fork'), run: target.onFork, separatorBefore: !target.onRate })
  }
  if (target.onRetry) {
    specs.push({
      id: 'retry',
      icon: RotateCcw,
      label: t(target.onRetryLabel ?? 'assistant.chat.regenerate'),
      run: target.onRetry,
      separatorBefore: true,
    })
  }
  if (target.onContinue) {
    specs.push({ id: 'continue', icon: Play, label: t('assistant.chat.continue'), run: target.onContinue, separatorBefore: true })
  }
  if (target.onSelect) {
    specs.push({ id: 'select', icon: ListChecks, label: t('assistant.chat.select_messages'), run: target.onSelect, separatorBefore: true })
  }
  if (target.onEdit) {
    specs.push({ id: 'edit', icon: Pencil, label: t('assistant.chat.edit_message'), run: target.onEdit, separatorBefore: !target.onRetry })
  }
  if (target.onDelete) {
    specs.push({ id: 'delete', icon: Trash2, label: t('assistant.chat.delete_message'), run: target.onDelete })
  }
  return specs.map((spec) => ({
    id: spec.id,
    label: spec.label,
    icon: <spec.icon size={13} />,
    ...(spec.separatorBefore ? { separatorBefore: true } : {}),
    ...(spec.checked ? { checked: true } : {}),
    onSelect: spec.run,
  }))
}

/**
 * The block a quote puts in the composer: the turn, marked as somebody's words at a time.
 *
 * The speaker and the clock go in the quote because a transcript of `>` lines with no attribution reads
 * as the reader's own thought by the time the model sees it.
 */
export function quoteOf(target: MessageMenuTarget, now = new Date()): string {
  // A blank line keeps its marker: an unmarked empty line ends the blockquote in Markdown, and every
  // line after it would quietly stop being part of what the reader quoted.
  const quoted = target.text.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join('\n')
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return `> ${t(target.role === 'user' ? 'assistant.chat.you' : 'assistant.chat.assistant')} · ${clock}\n${quoted}`
}

/**
 * The two ways this menu opens, held in one place.
 *
 * A message offers it from its own right-click and from the overflow button on its hover row, and the
 * two anchor differently: a press is a point, a button is an element the panel should line up under.
 * Keeping both in one state object means one panel is mounted whichever way it was asked for, rather
 * than a second copy of the same rows anchored at the other place.
 */
export interface MessageMenuState {
  anchor: MenuPoint | RefObject<HTMLElement | null> | null
  open: boolean
  buttonRef: RefObject<HTMLSpanElement | null>
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  openFromButton: () => void
  close: () => void
}

export function useMessageMenu(): MessageMenuState {
  const context = useContextMenu()
  const buttonRef = useRef<HTMLSpanElement>(null)
  const [buttonOpen, setButtonOpen] = useState(false)
  const close = useCallback(() => {
    setButtonOpen(false)
    context.close()
  }, [context])
  return {
    anchor: buttonOpen ? buttonRef : context.point,
    open: buttonOpen || context.point !== null,
    buttonRef,
    onContextMenu: context.onContextMenu,
    openFromButton: () => setButtonOpen(true),
    close,
  }
}

/** The menu itself, anchored where it was asked for. */
export function MessageMenu({ target, menu }: { target: MessageMenuTarget, menu: MessageMenuState }) {
  if (!menu.open || !menu.anchor) return null
  return (
    <Menu
      anchor={menu.anchor}
      open
      onClose={menu.close}
      items={messageMenuItems(target)}
      width={214}
      zIndex={Z_INDEX.pinnedMenu}
      label={t('assistant.chat.message_actions')}
    />
  )
}

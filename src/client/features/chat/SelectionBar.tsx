/**
 * The bar that appears once a reader has picked out turns.
 *
 * Selection is a mode rather than a modifier because the alternative is a checkbox on every message all
 * of the time, which is furniture nobody asked for in a conversation. The bar is what makes the mode
 * legible: it says how many rows are picked, and every action it offers acts on exactly those.
 */

import { Copy, Download, Share2, Trash2, X } from 'lucide-react'
import type { AssistantMessage } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { useUi } from '../../store/ui'
import { downloadTranscript } from './transcript'

export interface MessageSelection {
  active: boolean
  checked: boolean
  onToggle: () => void
}

/** The turns the reader ticked, in the order they appear in the thread. */
export function selectedMessages(messages: readonly AssistantMessage[], selected: ReadonlySet<string>): AssistantMessage[] {
  return messages.filter((message) => selected.has(message.id))
}

export function SelectionBar({ picked, title, onShare, onDelete, onExit }: {
  picked: AssistantMessage[]
  title: string
  /** Publishes exactly the ticked turns behind one link, which is what the mode is for beyond copying. */
  onShare: () => void
  onDelete: () => void
  onExit: () => void
}) {
  const toast = useUi((state) => state.toast)
  const count = picked.length
  return (
    <div
      role="toolbar"
      aria-label={t('assistant.chat.select_messages')}
      className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5"
    >
      <span aria-live="polite" className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
        {count ? t('assistant.chat.selected_count', { count }) : t('assistant.chat.select_none')}
      </span>
      <span className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        disabled={!count}
        onClick={() => {
          void navigator.clipboard?.writeText(picked.map((message) => message.content).join('\n\n'))
        }}
      >
        <Copy size={13} />
        {t('assistant.chat.select_copy')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!count}
        onClick={() => {
          downloadTranscript(picked, title)
          toast({ title: t('assistant.chat.select_exported', { count }), tone: 'success' })
        }}
      >
        <Download size={13} />
        {t('assistant.chat.select_export')}
      </Button>
      <Button size="sm" variant="ghost" disabled={!count} onClick={onShare}>
        <Share2 size={13} />
        {t('assistant.chat.select_share')}
      </Button>
      <Button size="sm" variant="ghost" className="text-[var(--danger)]" disabled={!count} onClick={onDelete}>
        <Trash2 size={13} />
        {t('assistant.chat.select_delete')}
      </Button>
      <IconButton size="sm" label={t('common.close')} onClick={onExit}>
        <X size={13} />
      </IconButton>
    </div>
  )
}

/** The tick a message shows while the mode is on. */
export function SelectionTick({ label, checked, onToggle }: { label: string, checked: boolean, onToggle: () => void }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-start pt-1" title={label}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={label}
        className="size-3.5 accent-[var(--accent)]"
      />
    </label>
  )
}


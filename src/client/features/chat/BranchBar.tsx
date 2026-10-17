/**
 * The bar that says which branch of a thread you are reading.
 *
 * A fork copies its turns, so the branch and its parent are two conversations that happen to share a
 * beginning — and after the fork nothing on screen said so. This is the map: the thread it came from, and
 * the other threads forked off the same point, each one a press away. It draws nothing at all for a
 * conversation that is its own root with no forks, because a bar that says "no branches" is a bar the
 * reader has to read to learn there is nothing there.
 */
import { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { openConversationInChat } from './start-chat'

interface Branches {
  parent: { id: string, title: string } | null
  siblings: Array<{ id: string, title: string, updatedAt: number }>
}

export function BranchBar({ conversationId }: { conversationId: string | null }) {
  const [branches, setBranches] = useState<Branches | null>(null)

  // Read once per conversation. The tree only changes when the reader forks, and that opens the new
  // thread — which is a different id, so the next read is the one that shows the new sibling.
  useEffect(() => {
    setBranches(null)
    if (!conversationId) return
    let alive = true
    void api.assistant.conversationBranches(conversationId)
      .then((data) => {
        if (alive) setBranches(data)
      })
      .catch(() => {
        // A branch bar is a convenience, not a state the thread depends on: a failed read leaves it out
        // rather than putting an error above the conversation.
        if (alive) setBranches(null)
      })
    return () => {
      alive = false
    }
  }, [conversationId])

  if (!conversationId || !branches) return null
  if (!branches.parent && branches.siblings.length < 2) return null

  const chip = 'max-w-[180px] truncate rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-11)] transition-colors duration-[var(--dur-fast)]'
  return (
    <div
      role="group"
      aria-label={t('assistant.branch.label')}
      className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-2 text-[var(--text-tertiary)]"
    >
      <GitBranch size={12} className="shrink-0 text-[var(--text-quaternary)]" />
      {branches.parent && (
        <button
          type="button"
          onClick={() => openConversationInChat(branches.parent!.id)}
          className={cn(chip, 'shrink-0 text-[var(--accent)] hover:bg-[var(--bg-hover)]')}
          title={t('assistant.branch.from', { title: branches.parent.title })}
        >
          {t('assistant.branch.from', { title: branches.parent.title || t('assistant.chat.untitled') })}
        </button>
      )}
      {branches.siblings.map((sibling) => {
        const current = sibling.id === conversationId
        return (
          <button
            key={sibling.id}
            type="button"
            aria-current={current ? 'true' : undefined}
            disabled={current}
            onClick={() => openConversationInChat(sibling.id)}
            className={cn(
              chip,
              current
                ? 'shrink-0 bg-[var(--bg-inset)] text-[var(--text-primary)]'
                : 'shrink-0 hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
            )}
            title={sibling.title || t('assistant.chat.untitled')}
          >
            {sibling.title || t('assistant.chat.untitled')}
          </button>
        )
      })}
    </div>
  )
}

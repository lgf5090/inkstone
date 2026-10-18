/**
 * The shelf: the answers the reader kept, in the sidebar's own tab strip.
 *
 * It sits beside the starred/pinned/archived shortlists because it does the same job — a list of pointers
 * into threads — with one difference: its rows name a turn rather than a conversation, so pressing one
 * opens the thread *at* that turn. The rows come from `GET /api/assistant/saved-messages` through
 * `saved-shelf.ts`, which is the only place this screen's paging state lives.
 *
 * Every state a read can answer with is drawn: the spinner while the shelf is unread, the route's own line
 * and a retry when it was refused, an empty shelf that says how a keep gets here, and the list. An empty
 * list and a refused one are two different facts, so they never share a block.
 */
import { useEffect } from 'react'
import type { SavedMessage } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { Button, Spinner } from '../../components/primitives'
import { LoadFailure } from './assistant-settings-shared'
import { useAssistant } from './assistant-store'
import { useSavedShelf } from './saved-shelf'

/**
 * One kept answer.
 *
 * The row is a `button`, so the keyboard reaches it and the name it announces is its own text: the
 * answer's opening lines, the thread it lives in, and how long ago it was kept. The thread's title is the
 * server's current one rather than a copy taken at keep time, so renaming a conversation moves every
 * pointer to it.
 */
function ShelfRow({ row, active, onOpen }: { row: SavedMessage; active: boolean; onOpen: () => void }) {
  const title = row.conversationTitle || t('assistant.chat.untitled')
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
        className={cn(
          'flex w-full flex-col gap-px rounded-[var(--r-sm)] px-2 py-1.5 text-left',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        )}
      >
        <span className="min-w-0 truncate text-[length:var(--text-12)] font-medium">
          {row.excerpt || title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <span className="min-w-0 truncate">{t('assistant.chat.saved_in_thread', { title })}</span>
          <span className="shrink-0 tabular-nums">{relativeTime(row.savedAt)}</span>
        </span>
      </button>
    </li>
  )
}

export function SavedShelf({ onOpen }: { onOpen?: () => void }) {
  const items = useSavedShelf((state) => state.items)
  const failure = useSavedShelf((state) => state.failure)
  const hasMore = useSavedShelf((state) => state.hasMore)
  const loadingMore = useSavedShelf((state) => state.loadingMore)
  const load = useSavedShelf((state) => state.load)
  const loadMore = useSavedShelf((state) => state.loadMore)
  const activeId = useAssistant((state) => state.activeId)
  const openConversation = useAssistant((state) => state.openConversation)

  // Read on every visit, the same way the settings lists do: a keep made in another thread — or on another
  // device — belongs on the shelf the reader is about to look at, and a list that only refreshes on a
  // reload teaches them their press was lost.
  useEffect(() => {
    void load()
  }, [load])

  if (items === null && !failure) {
    return (
      <div role="status" aria-label={t('common.loading')} className="flex justify-center py-3">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      {failure && (
        <LoadFailure messageKey="assistant.chat.saved_failed" detail={failure.detail} onRetry={() => void load()} />
      )}

      {items?.length === 0 && (
        <p className="px-2 py-2 text-[length:var(--text-12)] leading-relaxed text-[var(--text-quaternary)]">
          {t('assistant.chat.saved_empty')}
        </p>
      )}

      {items && items.length > 0 && (
        <ul aria-label={t('assistant.chat.tab.saved')} className="flex flex-col gap-px">
          {items.map((row) => (
            <ShelfRow
              key={row.id}
              row={row}
              active={row.conversationId === activeId}
              onOpen={() => {
                void openConversation(row.conversationId, { focusMessageId: row.id })
                onOpen?.()
              }}
            />
          ))}
        </ul>
      )}

      {hasMore && (
        <Button size="sm" variant="secondary" block loading={loadingMore} onClick={() => void loadMore()}>
          {t('assistant.chat.saved_more')}
        </Button>
      )}
    </div>
  )
}

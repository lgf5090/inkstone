import { Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSummary } from '@shared/email/model'
import { EMAIL_PAGE_SIZE } from '@shared/email/model'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { t } from '../../lib/i18n'
import { folderLabel, listEmptyText } from './format'
import { MessageRow } from './MessageRow'
import { Pager } from './Pager'
import type { EmailLoadStatus } from './store'

export function MessageList({
  messages,
  total,
  status,
  error,
  page,
  refreshing,
  searchMode,
  query,
  folderId,
  folders,
  selectedId,
  onOpen,
  onToggleStar,
  onToggleRead,
  onDelete,
  onRetry,
  onPage,
  onReload,
  onManageTrash,
}: {
  messages: EmailSummary[]
  total: number
  status: EmailLoadStatus
  error: string | null
  page: number
  refreshing: boolean
  searchMode: boolean
  query: string
  folderId: string | null
  folders: readonly EmailFolder[]
  selectedId: string | null
  onOpen: (message: EmailSummary) => void
  onToggleStar: (message: EmailSummary) => void
  onToggleRead: (message: EmailSummary) => void
  onDelete: (message: EmailSummary) => void
  onRetry: (message: EmailSummary) => void
  onPage: (page: number) => void
  onReload: () => void
  onManageTrash: () => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / EMAIL_PAGE_SIZE))
  const title = searchMode ? t('email.search.title') : folderLabel(folderId, folders)
  return (
    <section aria-label={t('email.a11y.message_list')} className="flex min-h-0 flex-1 flex-col bg-[var(--bg-base)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {refreshing && <Spinner size={12} />}
        <span
          aria-live={searchMode ? 'polite' : undefined}
          className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]"
        >
          {searchMode
            ? t(total === 1 ? 'email.search.results_one' : 'email.search.results_other', { count: total })
            : t(total === 1 ? 'email.list.count_one' : 'email.list.count_other', { count: total })}
        </span>
        {folderId === 'trash' && (
          <IconButton label={t('email.trash.manage')} size="xs" onClick={onManageTrash}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
      {status === 'loading' && messages.length === 0 ? (
        <LoadingBlock label={t('email.list.loading')} />
      ) : status === 'error' && messages.length === 0 ? (
        <Empty
          art="folder"
          compact
          title={t('email.list.error')}
          description={error}
          action={<Button size="sm" onClick={onReload}>{t('common.retry')}</Button>}
        />
      ) : messages.length === 0 ? (
        <Empty
          art={searchMode ? 'search' : folderId === 'trash' ? 'trash' : folderId === 'archive' ? 'archive' : 'folder'}
          compact
          title={searchMode ? t('email.search.empty') : listEmptyText(folderId ?? 'inbox', false)}
          description={searchMode ? t('email.search.empty_hint') : undefined}
          action={folderId === 'trash'
            ? <Button size="sm" variant="ghost" onClick={onManageTrash}>{t('email.trash.manage')}</Button>
            : undefined}
        />
      ) : (
        <>
          {status === 'error' && error && (
            <div role="alert" className="border-b border-[var(--border-subtle)] bg-[var(--danger-soft)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
              {error}
            </div>
          )}
          <ul
            aria-label={t('email.a11y.message_list')}
            aria-busy={refreshing}
            className="m-0 min-h-0 list-none overflow-y-auto p-0"
          >
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                selected={selectedId === message.id}
                searchMode={searchMode}
                query={query}
                folders={folders}
                onOpen={() => onOpen(message)}
                onToggleStar={() => onToggleStar(message)}
                onToggleRead={() => onToggleRead(message)}
                onDelete={() => onDelete(message)}
                onRetry={() => onRetry(message)}
              />
            ))}
          </ul>
        </>
      )}
      <Pager page={page} pageCount={pageCount} onPage={onPage} label={t('email.list.pagination')} />
    </section>
  )
}

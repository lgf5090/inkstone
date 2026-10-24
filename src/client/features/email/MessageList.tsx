import { PenLine, Trash2 } from 'lucide-react'
import type { EmailFolder, EmailSummary, EmailTag } from '@shared/email/model'
import { EMAIL_PAGE_SIZE } from '@shared/email/model'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { Segmented } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { t } from '../../lib/i18n'
import { folderLabel, listEmptyText } from './format'
import { MessageRow, SelectionBox } from './MessageRow'
import { Pager } from './Pager'
import type { EmailFocusFilter, EmailLoadStatus, EmailReadFilter } from './store'

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
  tags,
  selectedId,
  selectedIds,
  dragEnabled,
  focusFilter,
  focusedInboxEnabled,
  readFilter,
  onFocusFilterChange,
  onReadFilterChange,
  onOpen,
  onToggleSelect,
  onSelectAll,
  onToggleStar,
  onToggleRead,
  onMove,
  onArchive,
  onTag,
  onDelete,
  onRetry,
  onPage,
  onReload,
  onManageTrash,
  onCompose,
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
  tags: readonly EmailTag[]
  selectedId: string | null
  selectedIds: ReadonlySet<string>
  dragEnabled: boolean
  focusFilter: EmailFocusFilter
  focusedInboxEnabled: boolean
  readFilter: EmailReadFilter
  onFocusFilterChange: (filter: EmailFocusFilter) => void
  onReadFilterChange: (filter: EmailReadFilter) => void
  onOpen: (message: EmailSummary) => void
  onToggleSelect: (message: EmailSummary, modifiers: { shiftKey: boolean }) => void
  onSelectAll: (selected: boolean) => void
  onToggleStar: (message: EmailSummary) => void
  onToggleRead: (message: EmailSummary) => void
  onMove: (message: EmailSummary, folderId: string) => void
  onArchive: (message: EmailSummary) => void
  onTag: (message: EmailSummary, tag: EmailTag) => void
  onDelete: (message: EmailSummary) => void
  onRetry: (message: EmailSummary) => void
  onPage: (page: number) => void
  onReload: () => void
  onManageTrash: () => void
  onCompose: () => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / EMAIL_PAGE_SIZE))
  const title = searchMode ? t('email.search.title') : folderLabel(folderId, folders)
  const showFocusFilter = !searchMode && folderId === 'inbox' && focusedInboxEnabled
  const allSelected = messages.length > 0 && messages.every((message) => selectedIds.has(message.id))
  const someSelected = messages.some((message) => selectedIds.has(message.id))
  const emptyTitle = searchMode
    ? t('email.search.empty')
    : showFocusFilter && focusFilter !== 'all'
      ? t(focusFilter === 'focused' ? 'email.list.empty.focused' : 'email.list.empty.other')
      : listEmptyText(folderId ?? 'inbox', false)
  return (
    <section aria-label={t('email.a11y.message_list')} className="flex min-h-0 flex-1 flex-col bg-[var(--bg-base)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        {messages.length > 0 && (
          <SelectionBox
            checked={allSelected}
            mixed={!allSelected && someSelected}
            label={t('email.list.select_all')}
            onToggle={() => onSelectAll(!allSelected)}
          />
        )}
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {refreshing && <Spinner size={12} />}
        <span
          aria-live={searchMode ? 'polite' : undefined}
          className="hidden shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)] sm:inline"
        >
          {searchMode
            ? t(total === 1 ? 'email.search.results_one' : 'email.search.results_other', { count: total })
            : t(total === 1 ? 'email.list.count_one' : 'email.list.count_other', { count: total })}
        </span>
        {folderId === 'trash' && (
          <Tooltip label={t('email.trash.manage')} side="top">
            <IconButton label={t('email.trash.manage')} size="xs" onClick={onManageTrash}>
              <Trash2 size={13} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip label={t('email.compose.title_new')} side="top">
          <IconButton label={t('email.compose.title_new')} size="xs" onClick={onCompose}>
            <PenLine size={13} />
          </IconButton>
        </Tooltip>
      </div>
      {(!searchMode || showFocusFilter) && (
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 pb-1.5 no-scrollbar">
        {!searchMode && (
          <Segmented
            size="sm"
            value={readFilter}
            onChange={onReadFilterChange}
            label={t('email.filter.read_state')}
            options={[
              { value: 'all', label: t('email.filter.all') },
              { value: 'unread', label: t('email.filter.unread') },
              { value: 'read', label: t('email.filter.read') },
            ]}
          />
        )}
        {showFocusFilter && (
          <Segmented
            size="sm"
            value={focusFilter}
            onChange={onFocusFilterChange}
            label={t('email.focus.filter')}
            options={[
              { value: 'all', label: t('email.focus.all') },
              { value: 'focused', label: t('email.focus.focused') },
              { value: 'other', label: t('email.focus.other') },
            ]}
          />
        )}
      </div>
      )}
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
          title={emptyTitle}
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
                batchSelected={selectedIds.has(message.id)}
                selectedIds={selectedIds}
                dragEnabled={dragEnabled}
                searchMode={searchMode}
                query={query}
                folders={folders}
                tags={tags}
                onOpen={() => onOpen(message)}
                onToggleSelect={(modifiers) => onToggleSelect(message, modifiers)}
                onToggleStar={() => onToggleStar(message)}
                onToggleRead={() => onToggleRead(message)}
                onMove={(targetFolderId) => onMove(message, targetFolderId)}
                onArchive={() => onArchive(message)}
                onTag={(tag) => onTag(message, tag)}
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

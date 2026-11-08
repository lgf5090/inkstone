import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type DragEvent } from 'react'
import { CheckSquare, Plus, Search, Settings, Sparkles, X } from 'lucide-react'
import type { DecryptedAccount } from '@shared/tools/password/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { compileQuery, queryKeeps, queryKeepsRows } from '../../../lib/query-match'
import { usePinyinVersion } from '../../../lib/pinyin'
import { Empty } from '../../../components/feedback'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Tooltip } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { useToolsStore } from '../store'
import { usePasswordVaultStore } from './store'
import { AccountCard } from './AccountCard'

export interface AccountListProps {
  filterFavoritesOnly?: boolean
  groupId?: string | null
  className?: string
}

/** Fixed row height, which is what lets the list virtualize without measuring every card. */
const ROW_HEIGHT = 56
const OVERSCAN = 8

interface VirtualRowProps {
  account: DecryptedAccount
  /** Absolute row index: it stays the same while scrolling, so a mounted row keeps its props. */
  index: number
  isSelected: boolean
  onSelect: (account: DecryptedAccount) => void
  onToggleFavorite: (id: string) => void
  onDragStart: (e: DragEvent, account: DecryptedAccount) => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent, account: DecryptedAccount) => void
}

/**
 * Memoised so scrolling only mounts the rows entering the window: re-rendering every card that is
 * already on screen was most of the frame cost a virtual list is meant to remove.
 */
const VirtualRow = memo(function VirtualRow({
  account,
  index,
  isSelected,
  onSelect,
  onToggleFavorite,
  onDragStart,
  onDragOver,
  onDrop,
}: VirtualRowProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: index * ROW_HEIGHT,
        left: 0,
        right: 0,
        height: ROW_HEIGHT,
      }}
      className="py-0.5"
    >
      <AccountCard
        account={account}
        isSelected={isSelected}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
    </div>
  )
})

export function AccountList({
  filterFavoritesOnly = false,
  groupId,
  className,
}: AccountListProps) {
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const decryptedAccounts = usePasswordVaultStore((s) => s.decryptedAccounts)
  const selectedAccountId = usePasswordVaultStore((s) => s.selectedAccountId)
  const setSelectedAccountId = usePasswordVaultStore((s) => s.setSelectedAccountId)
  const selectedGroupId = usePasswordVaultStore((s) => s.selectedGroupId)
  const groups = usePasswordVaultStore((s) => s.groups)
  const createAccount = usePasswordVaultStore((s) => s.createAccount)
  const toggleFavorite = usePasswordVaultStore((s) => s.toggleFavorite)
  const openGeneratorModal = usePasswordVaultStore((s) => s.openGeneratorModal)
  const openBatchOperations = usePasswordVaultStore((s) => s.openBatchOperations)
  const openBackupSettings = usePasswordVaultStore((s) => s.openBackupSettings)
  const reorderAccounts = usePasswordVaultStore((s) => s.reorderAccounts)
  const loadMoreAccounts = usePasswordVaultStore((s) => s.loadMoreAccounts)
  const ensureAllAccounts = usePasswordVaultStore((s) => s.ensureAllAccounts)
  const nextAccountsCursor = usePasswordVaultStore((s) => s.nextAccountsCursor)

  const activePasswordView = useToolsStore((s) => s.activePasswordView)

  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)

  // Map raw accounts order to decrypted accounts
  const decryptedList = useMemo(() => {
    return accounts
      .map((a) => decryptedAccounts[a.id])
      .filter((a): a is DecryptedAccount => Boolean(a))
  }, [accounts, decryptedAccounts])

  // Filter based on view mode / group
  const scopeFiltered = useMemo(() => {
    if (filterFavoritesOnly || activePasswordView === 'favorites') {
      return decryptedList.filter((a) => a.isFavorite)
    }

    const targetGroupId = groupId !== undefined ? groupId : (activePasswordView === 'groups' ? selectedGroupId : null)
    if (targetGroupId) {
      return decryptedList.filter((a) => a.groupId === targetGroupId)
    }

    return decryptedList
  }, [decryptedList, filterFavoritesOnly, activePasswordView, groupId, selectedGroupId])

  // Filter based on search query. The shared matcher reads a Chinese title by its initials, accepts
  // `/pattern/flags`, and refuses an unsafe expression instead of stalling the tab — none of which
  // the hand-written `toLowerCase().includes` could do. `pinyinVersion` is in the deps because the
  // reading table loads asynchronously: a filter frozen before it lands would never match again.
  const pinyinVersion = usePinyinVersion()
  const query = useMemo(() => compileQuery(search), [search])
  const filteredAccounts = useMemo(() => {
    if (queryKeepsRows(query)) return scopeFiltered
    return scopeFiltered.filter(
      (a) =>
        queryKeeps(query, a.title) ||
        queryKeeps(query, a.username) ||
        queryKeeps(query, a.link) ||
        queryKeeps(query, a.remark),
    )
  }, [scopeFiltered, query, pinyinVersion])

  // A search, the favourites view and a single group all answer from rows the first page may not
  // hold, so they need the whole vault loaded before they can filter it.
  const needsWholeVault =
    Boolean(search.trim()) ||
    filterFavoritesOnly ||
    activePasswordView === 'favorites' ||
    (activePasswordView === 'groups' && Boolean(groupId !== undefined ? groupId : selectedGroupId))
  useEffect(() => {
    if (needsWholeVault && nextAccountsCursor) void ensureAllAccounts()
  }, [needsWholeVault, nextAccountsCursor, ensureAllAccounts])

  // The scroll container only exists once there is something to show.
  const hasRows = filteredAccounts.length > 0
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    // Scroll fires several times per frame; updating state on each one rendered the list more often
    // than the screen could show. One update per animation frame, rounded to the row grid: only a
    // row boundary changes which cards exist, and an unchanged bucket does not re-render at all.
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = Math.floor(element.scrollTop / ROW_HEIGHT) * ROW_HEIGHT
        setScrollTop((prev) => (prev === next ? prev : next))
      })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    setViewportHeight(element.clientHeight || 600)
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => setViewportHeight(element.clientHeight || 600))
        : null
    observer?.observe(element)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      element.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [hasRows])

  // Ask for the next page a few rows before the end of what is loaded.
  useEffect(() => {
    if (!nextAccountsCursor) return
    const total = filteredAccounts.length * ROW_HEIGHT
    if (scrollTop + viewportHeight > total - ROW_HEIGHT * 6) void loadMoreAccounts()
  }, [scrollTop, viewportHeight, filteredAccounts.length, nextAccountsCursor, loadMoreAccounts])

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIndex = Math.min(
    filteredAccounts.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  )
  const visibleAccounts = filteredAccounts.slice(startIndex, endIndex)

  // Stable callbacks: the memoised rows bail out while scrolling only if their props keep identity.
  const handleSelect = useCallback(
    (account: DecryptedAccount) => setSelectedAccountId(account.id),
    [setSelectedAccountId],
  )
  const handleToggleFavorite = useCallback(
    (id: string) => {
      void toggleFavorite(id).catch((err: unknown) => {
        useUi.getState().toast({
          title: err instanceof Error ? err.message : t('common.save_failed'),
          tone: 'danger',
        })
      })
    },
    [toggleFavorite],
  )
  const cursorRef = useRef(nextAccountsCursor)
  cursorRef.current = nextAccountsCursor
  const handleDragStart = useCallback(() => {
    // Reordering re-numbers every row, so it needs the whole vault loaded.
    if (cursorRef.current) void ensureAllAccounts()
  }, [ensureAllAccounts])

  const handleQuickNew = async () => {
    const targetGroupId = selectedGroupId || groups[0]?.id
    if (!targetGroupId) {
      useUi.getState().toast({
        title: t('tools.password.account.no_group'),
        tone: 'danger',
      })
      return
    }
    try {
      const created = await createAccount({
        groupId: targetGroupId,
        title: '',
        username: '',
        password: '',
        link: '',
        remark: '',
        isFavorite: filterFavoritesOnly || activePasswordView === 'favorites',
      })
      setSelectedAccountId(created.id)
    } catch (err) {
      useUi.getState().toast({
        title: err instanceof Error ? err.message : t('common.save_failed'),
        tone: 'danger',
      })
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (filteredAccounts.length === 0) return
    const currentIndex = filteredAccounts.findIndex((a) => a.id === selectedAccountId)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const nextIndex = currentIndex < filteredAccounts.length - 1 ? currentIndex + 1 : 0
      setSelectedAccountId(filteredAccounts[nextIndex]!.id)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : filteredAccounts.length - 1
      setSelectedAccountId(filteredAccounts[prevIndex]!.id)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setSelectedAccountId(filteredAccounts[0]!.id)
    } else if (e.key === 'End') {
      e.preventDefault()
      setSelectedAccountId(filteredAccounts[filteredAccounts.length - 1]!.id)
    }
  }

  // Without a cancelling dragover on the drop target the browser never fires `drop`, so card-to-card
  // reordering was dead even though the card carried an onDrop handler.
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleReorderDrop = useCallback(
    (e: DragEvent, targetAccount: DecryptedAccount) => {
      const draggedId = e.dataTransfer.getData('text/plain')
      if (!draggedId || draggedId === targetAccount.id) return
      const sourceIndex = filteredAccounts.findIndex((a) => a.id === draggedId)
      const targetIndex = filteredAccounts.findIndex((a) => a.id === targetAccount.id)
      if (sourceIndex < 0 || targetIndex < 0) return

      const reordered = [...filteredAccounts]
      const [removed] = reordered.splice(sourceIndex, 1)
      reordered.splice(targetIndex, 0, removed!)

      const updates = reordered.map((acc, index) => ({ id: acc.id, sort: index }))
      void reorderAccounts(updates)
    },
    [filteredAccounts, reorderAccounts],
  )

  return (
    <div
      data-testid="account-list"
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-base)]',
        className,
      )}
    >
      {/* Top action toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] p-2.5">
        <div className="relative flex-1 min-w-0">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tools.password.account.search_placeholder')}
            leading={<Search size={14} />}
            trailing={
              search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label={t('common.clear')}
                  className="rounded p-0.5 text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
                >
                  <X size={13} />
                </button>
              ) : null
            }
            className="h-8 w-full text-[length:var(--text-12)]"
            data-testid="account-search-input"
          />
        </div>

        <Tooltip label={t('tools.password.account.new')} side="bottom">
          <IconButton
            label={t('tools.password.account.new')}
            size="sm"
            variant="primary"
            onClick={handleQuickNew}
            data-testid="account-add-btn"
          >
            <Plus size={15} />
          </IconButton>
        </Tooltip>

        <Tooltip label={t('tools.password.generator.title')} side="bottom">
          <IconButton
            label={t('tools.password.generator.title')}
            size="sm"
            variant="ghost"
            onClick={() => openGeneratorModal()}
            data-testid="account-generator-btn"
          >
            <Sparkles size={15} />
          </IconButton>
        </Tooltip>

        <Tooltip label={t('tools.password.batch.title')} side="bottom">
          <IconButton
            label={t('tools.password.batch.title')}
            size="sm"
            variant="ghost"
            onClick={() => openBatchOperations()}
            data-testid="account-batch-btn"
          >
            <CheckSquare size={15} />
          </IconButton>
        </Tooltip>

        <Tooltip label={t('tools.password.nav.backup_settings')} side="bottom">
          <IconButton
            label={t('tools.password.nav.backup_settings')}
            size="sm"
            variant="ghost"
            onClick={() => openBackupSettings()}
            data-testid="account-backup-settings-btn"
          >
            <Settings size={15} />
          </IconButton>
        </Tooltip>
      </div>

      {/* Account items list */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {filteredAccounts.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <Empty
              art={search ? 'search' : 'notes'}
              title={
                search
                  ? t('tools.password.search.not_found')
                  : t('tools.password.account.empty')
              }
              action={
                !search ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Plus size={14} />}
                    onClick={handleQuickNew}
                  >
                    {t('tools.password.account.new')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div
            ref={scrollRef}
            // Each row is a button, not an option: `role="listbox"` promised options, and an option
            // cannot hold the star control every card carries.
            role="list"
            aria-label={t('tools.password.nav.all')}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="flex-1 min-h-0 overflow-y-auto p-2 focus:outline-none"
            data-testid="account-cards-container"
          >
            {/* Only the rows inside the viewport (plus a small overscan) exist in the DOM. */}
            <div style={{ height: filteredAccounts.length * ROW_HEIGHT, position: 'relative' }}>
              {visibleAccounts.map((acc, index) => (
                <VirtualRow
                  key={acc.id}
                  account={acc}
                  index={startIndex + index}
                  isSelected={acc.id === selectedAccountId}
                  onSelect={handleSelect}
                  onToggleFavorite={handleToggleFavorite}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleReorderDrop}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

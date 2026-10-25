import { useMemo, useState, type KeyboardEvent, type DragEvent } from 'react'
import { CheckSquare, Plus, Search, Sparkles, X } from 'lucide-react'
import type { DecryptedAccount } from '@shared/tools/password/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { Empty } from '../../../components/feedback'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Tooltip } from '../../../components/overlay'
import { useToolsStore } from '../store'
import { usePasswordVaultStore } from './store'
import { AccountCard } from './AccountCard'

export interface AccountListProps {
  filterFavoritesOnly?: boolean
  groupId?: string | null
  className?: string
}

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
  const reorderAccounts = usePasswordVaultStore((s) => s.reorderAccounts)

  const activePasswordView = useToolsStore((s) => s.activePasswordView)

  const [search, setSearch] = useState('')

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

  // Filter based on search query (instant fuzzy/substring match)
  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return scopeFiltered
    return scopeFiltered.filter((a) => {
      return (
        a.title.toLowerCase().includes(q) ||
        a.username.toLowerCase().includes(q) ||
        a.link.toLowerCase().includes(q) ||
        a.remark.toLowerCase().includes(q)
      )
    })
  }, [scopeFiltered, search])

  const handleQuickNew = async () => {
    const targetGroupId = selectedGroupId || groups[0]?.id || 'default'
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

  const handleReorderDrop = (e: DragEvent, targetAccount: DecryptedAccount) => {
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
  }

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
            role="listbox"
            tabIndex={0}
            aria-label={t('tools.password.nav.all')}
            onKeyDown={handleKeyDown}
            className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1 focus:outline-none"
            data-testid="account-cards-container"
          >
            {filteredAccounts.map((acc) => (
              <AccountCard
                key={acc.id}
                account={acc}
                isSelected={acc.id === selectedAccountId}
                onSelect={(account) => setSelectedAccountId(account.id)}
                onToggleFavorite={(id) => void toggleFavorite(id)}
                onDrop={handleReorderDrop}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

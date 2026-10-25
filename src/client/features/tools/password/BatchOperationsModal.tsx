import { useState, useMemo } from 'react'
import {
  Trash2,
  FolderInput,
  Copy,
  Search,
  AlertTriangle,
  Folder,
} from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Input, Select, Checkbox } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { passwordApi } from './api'

export interface BatchOperationsModalProps {
  open?: boolean
  onClose?: () => void
}

export function BatchOperationsModal({ open, onClose }: BatchOperationsModalProps) {
  const toast = useUi((s) => s.toast)
  const storeIsOpen = usePasswordVaultStore((s) => s.isBatchOperationsOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeBatchOperations)

  const groups = usePasswordVaultStore((s) => s.groups)
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const decryptedAccounts = usePasswordVaultStore((s) => s.decryptedAccounts)
  const refreshData = usePasswordVaultStore((s) => s.refreshData)

  const isVisible = open !== undefined ? open : storeIsOpen
  const handleClose = onClose || storeClose

  const [selectedGroupFilter, setSelectedGroupFilter] = useState<string>('all')
  const [searchFilter, setSearchFilter] = useState<string>('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [targetGroupId, setTargetGroupId] = useState<string>(groups[0]?.id ?? '')
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState<boolean>(false)

  // Map of group ID to group name
  const groupNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of groups) {
      map.set(g.id, g.name)
    }
    return map
  }, [groups])

  // Filtered account items
  const filteredAccounts = useMemo(() => {
    return accounts
      .map((acc) => decryptedAccounts[acc.id] || acc)
      .filter((acc) => {
        if (selectedGroupFilter !== 'all' && acc.groupId !== selectedGroupFilter) {
          return false
        }
        if (searchFilter.trim()) {
          const q = searchFilter.toLowerCase()
          const title = (acc.title || '').toLowerCase()
          const username = (acc.username || '').toLowerCase()
          const link = (acc.link || '').toLowerCase()
          return title.includes(q) || username.includes(q) || link.includes(q)
        }
        return true
      })
  }, [accounts, decryptedAccounts, selectedGroupFilter, searchFilter])

  // Selection handlers
  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    const next = new Set<string>()
    for (const acc of filteredAccounts) {
      next.add(acc.id)
    }
    setSelectedIds(next)
  }

  const handleInvertSelect = () => {
    const next = new Set<string>()
    for (const acc of filteredAccounts) {
      if (!selectedIds.has(acc.id)) {
        next.add(acc.id)
      }
    }
    setSelectedIds(next)
  }

  const handleClearSelection = () => {
    setSelectedIds(new Set())
  }

  // Batch move
  const handleBatchMove = async () => {
    if (selectedIds.size === 0 || !targetGroupId) return
    setIsProcessing(true)
    try {
      const ids = Array.from(selectedIds)
      await passwordApi.batchMoveAccounts(ids, targetGroupId)
      await refreshData()
      const targetName = groupNameMap.get(targetGroupId) || t('tools.password.batch.target_group_fallback')
      toast({
        title: t('tools.password.batch.moved_success', { count: ids.length, target: targetName }),
        tone: 'success',
      })
      setSelectedIds(new Set())
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.batch.move_failed'),
        tone: 'danger',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  // Batch copy
  const handleBatchCopy = async () => {
    if (selectedIds.size === 0) return
    const selectedAccs = accounts
      .filter((a) => selectedIds.has(a.id))
      .map((a) => decryptedAccounts[a.id] || a)

    const text = selectedAccs
      .map(
        (a) =>
          `Title: ${a.title || ''}\nUsername: ${a.username || ''}\nPassword: ${a.password || ''}\nURL: ${
            a.link || ''
          }\nRemark: ${a.remark || ''}`
      )
      .join('\n\n-------------------------\n\n')

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      }
      toast({
        title: t('tools.password.batch.copied_success', { count: selectedAccs.length }),
        tone: 'success',
      })
    } catch {
      toast({
        title: t('tools.password.batch.copied_success', { count: selectedAccs.length }),
        tone: 'success',
      })
    }
  }

  // Batch delete
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    setIsProcessing(true)
    try {
      const ids = Array.from(selectedIds)
      await passwordApi.batchDeleteAccounts(ids)
      await refreshData()
      toast({
        title: t('tools.password.batch.delete_success', { count: ids.length }),
        tone: 'success',
      })
      setSelectedIds(new Set())
      setIsConfirmDeleteOpen(false)
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.batch.delete_failed'),
        tone: 'danger',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <>
      <Modal
        open={isVisible}
        onClose={handleClose}
        title={t('tools.password.batch.title')}
        width={720}
        dismissible={!isProcessing}
      >
        <div className="flex flex-col gap-4 text-[var(--text-primary)]">
          {/* Top Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('tools.password.batch.group_label')}</span>
              <Select
                value={selectedGroupFilter}
                onChange={(e) => setSelectedGroupFilter(e.target.value)}
                className="h-8 min-w-36 text-[length:var(--text-12)]"
              >
                <option value="all">{t('tools.password.common.all_groups')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="w-56">
              <Input
                leading={<Search size={14} className="text-[var(--text-tertiary)]" />}
                placeholder={t('tools.password.common.filter_accounts')}
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="h-8 text-[length:var(--text-12)]"
              />
            </div>
          </div>

          {/* Selection Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleSelectAll}
                disabled={filteredAccounts.length === 0}
              >
                {t('tools.password.batch.select_all')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleInvertSelect}
                disabled={filteredAccounts.length === 0}
              >
                {t('tools.password.batch.invert')}
              </Button>
              {selectedIds.size > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearSelection}
                >
                  {t('tools.password.common.clear_selection')}
                </Button>
              )}
            </div>
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
              {t('tools.password.batch.selected_summary', { selected: selectedIds.size, total: filteredAccounts.length })}
            </span>
          </div>

          {/* Accounts List */}
          <div className="max-h-64 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            {filteredAccounts.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                {t('tools.password.batch.no_matches')}
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {filteredAccounts.map((acc) => {
                  const isChecked = selectedIds.has(acc.id)
                  const groupName = groupNameMap.get(acc.groupId) || t('tools.password.common.ungrouped')
                  return (
                    <label
                      key={acc.id}
                      className="flex items-center gap-3 p-2.5 hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
                    >
                      <Checkbox
                        checked={isChecked}
                        onChange={() => handleToggleSelect(acc.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-[length:var(--text-13)] text-[var(--text-primary)] truncate">
                            {acc.title || t('tools.password.common.no_title')}
                          </span>
                          <span className="rounded bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)] flex items-center gap-1">
                            <Folder size={10} />
                            {groupName}
                          </span>
                        </div>
                        <div className="text-[length:var(--text-11)] text-[var(--text-secondary)] truncate">
                          {acc.username || t('tools.password.common.no_user')} {acc.link ? `• ${acc.link}` : ''}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* Batch Actions Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--border-subtle)]">
            <div className="flex items-center gap-2">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {t('tools.password.batch.target_group')}:
              </span>
              <Select
                value={targetGroupId}
                onChange={(e) => setTargetGroupId(e.target.value)}
                className="h-8 min-w-36 text-[length:var(--text-12)]"
                disabled={selectedIds.size === 0 || isProcessing}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<FolderInput size={14} />}
                onClick={handleBatchMove}
                disabled={selectedIds.size === 0 || !targetGroupId || isProcessing}
              >
                {t('tools.password.batch.move')}
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Copy size={14} />}
                onClick={handleBatchCopy}
                disabled={selectedIds.size === 0 || isProcessing}
              >
                {t('tools.password.batch.copy')}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={() => setIsConfirmDeleteOpen(true)}
                disabled={selectedIds.size === 0 || isProcessing}
              >
                {t('tools.password.batch.delete')}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={isConfirmDeleteOpen}
        onClose={() => setIsConfirmDeleteOpen(false)}
        title={t('tools.password.batch.confirm_delete_title')}
        width={420}
        dismissible={!isProcessing}
      >
        <div className="flex flex-col gap-4 text-[var(--text-primary)]">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
              <AlertTriangle size={18} />
            </div>
            <p className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]">
              {t('tools.password.batch.delete_confirm', { count: selectedIds.size })}
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setIsConfirmDeleteOpen(false)}
              disabled={isProcessing}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleBatchDelete}
              loading={isProcessing}
            >
              {t('tools.password.batch.confirm_delete_btn')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

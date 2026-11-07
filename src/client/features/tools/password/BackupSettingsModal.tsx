import { useEffect, useRef, useState } from 'react'
import {
  Cloud,
  RefreshCw,
  Download,
  Upload,
  RotateCcw,
  Trash2,
  AlertTriangle,
} from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Modal, confirm } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { passwordApi } from './api'
import type { PasswordBackupRecord, PasswordBackupData } from '@shared/tools/password/types'
import { ReauthDialog } from './ReauthDialog'

export interface BackupSettingsModalProps {
  open?: boolean
  onClose?: () => void
}

export function BackupSettingsModal({ open, onClose }: BackupSettingsModalProps) {
  const toast = useUi((s) => s.toast)
  const storeIsOpen = usePasswordVaultStore((s) => s.isBackupSettingsOpen)
  const storeClose = usePasswordVaultStore((s) => s.closeBackupSettings)
  const groups = usePasswordVaultStore((s) => s.groups)
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const vaultState = usePasswordVaultStore((s) => s.vaultState)
  const refreshData = usePasswordVaultStore((s) => s.refreshData)

  const isVisible = open !== undefined ? open : storeIsOpen
  const handleClose = onClose || storeClose

  // Backups state
  const [backups, setBackups] = useState<PasswordBackupRecord[]>([])
  const [isLoadingBackups, setIsLoadingBackups] = useState<boolean>(false)
  const [isCreatingBackup, setIsCreatingBackup] = useState<boolean>(false)

  // Restore confirmation modal state
  const [restoreTarget, setRestoreTarget] = useState<PasswordBackupRecord | null>(null)
  const [isRestoring, setIsRestoring] = useState<boolean>(false)
  const [authorizing, setAuthorizing] = useState<{
    kind: 'restore' | 'delete' | 'restore-local'
    id?: string
    filename: string
    payload?: unknown
  } | null>(null)

  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(5)
  const autoLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchBackups = async () => {
    setIsLoadingBackups(true)
    try {
      const records = await passwordApi.getBackups()
      setBackups(records || [])
    } catch {
      // Ignored
    } finally {
      setIsLoadingBackups(false)
    }
  }

  const fetchSettings = async () => {
    try {
      const settings = await passwordApi.getSettings()
      if (settings?.autoLockMinutes) {
        setAutoLockMinutes(settings.autoLockMinutes)
      }
    } catch {
      // Ignored
    }
  }

  useEffect(() => {
    if (isVisible) {
      void fetchBackups()
      void fetchSettings()
    }
  }, [isVisible])

  // Dragging a slider fires on every step; the write is debounced and the store is refreshed so the
  // auto-lock timer picks the new value up immediately.
  const handleAutoLockChange = (minutes: number) => {
    setAutoLockMinutes(minutes)
    if (autoLockTimerRef.current) clearTimeout(autoLockTimerRef.current)
    autoLockTimerRef.current = setTimeout(() => {
      void passwordApi
        .saveSettings({ autoLockMinutes: minutes })
        .then(() => usePasswordVaultStore.getState().loadSettings())
        .catch((err: unknown) => {
          toast({
            title: err instanceof Error ? err.message : t('tools.password.backup.save_failed'),
            tone: 'danger',
          })
        })
    }, 400)
  }

  useEffect(() => {
    return () => {
      if (autoLockTimerRef.current) clearTimeout(autoLockTimerRef.current)
    }
  }, [])

  // Handle create cloud backup
  const handleCreateCloudBackup = async () => {
    setIsCreatingBackup(true)
    try {
      await passwordApi.createBackup()
      toast({
        title: t('tools.password.backup.created'),
        tone: 'success',
      })
      await fetchBackups()
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.backup.create_failed'),
        tone: 'danger',
      })
    } finally {
      setIsCreatingBackup(false)
    }
  }

  // Handle local JSON download
  const handleDownloadLocalBackup = () => {
    try {
      const backupData: PasswordBackupData = {
        _backup_info: {
          type: 'inkstone_password_backup',
          version: '1.0.0',
          createTime: Date.now(),
          platform: 'web',
          // Which key the rows belong to; a restore from another vault's file is refused rather
          // than replacing this vault with values it cannot open.
          kdfSalt: vaultState?.kdfSalt,
        },
        data: {
          groups,
          accounts,
        },
      }

      const jsonStr = JSON.stringify(backupData, null, 2)
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const filename = `inkstone_password_backup_${Date.now()}.json`

      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      toast({
        title: t('tools.password.backup.download_local_ok'),
        tone: 'success',
      })
    } catch {
      toast({
        title: t('tools.password.backup.download_local_failed'),
        tone: 'danger',
      })
    }
  }

  // Handle confirm restore
  const handleExecuteRestore = () => {
    if (!restoreTarget) return
    const target = restoreTarget
    setRestoreTarget(null)
    // The restore itself waits for the master password; the token is what the route checks.
    setAuthorizing({ kind: 'restore', id: target.id, filename: target.filename })
  }

  // Handle delete backup
  const handleDeleteBackup = (record: PasswordBackupRecord) => {
    setAuthorizing({ kind: 'delete', id: record.id, filename: record.filename })
  }

  const handleAuthorized = async (confirmToken: string) => {
    const action = authorizing
    if (!action) return

    if (action.kind === 'restore-local') {
      setIsRestoring(true)
      try {
        await passwordApi.restoreLocalBackup(action.payload, confirmToken)
        await refreshData()
        toast({ title: t('tools.password.backup.restore_local_done'), tone: 'success' })
        setAuthorizing(null)
        handleClose()
      } catch (err: any) {
        toast({ title: err?.message || t('tools.password.backup.restore_failed'), tone: 'danger' })
      } finally {
        setIsRestoring(false)
      }
      return
    }

    if (action.kind === 'restore' && action.id) {
      setIsRestoring(true)
      try {
        await passwordApi.restoreBackup(action.id, confirmToken)
        await refreshData()
        toast({
          title: t('tools.password.backup.restored'),
          tone: 'success',
        })
        setAuthorizing(null)
        handleClose()
      } catch (err: any) {
        toast({
          title: err?.message || t('tools.password.backup.restore_failed'),
          tone: 'danger',
        })
      } finally {
        setIsRestoring(false)
      }
      return
    }

    if (!action.id) return
    try {
      await passwordApi.deleteBackup(action.id, confirmToken)
      setBackups((prev) => prev.filter((backup) => backup.id !== action.id))
      toast({
        title: t('tools.password.backup.deleted'),
        tone: 'success',
      })
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.backup.delete_failed'),
        tone: 'danger',
      })
    } finally {
      setAuthorizing(null)
    }
  }

  const handleLocalRestoreFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        _backup_info?: unknown
        data?: { groups?: unknown; accounts?: unknown }
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !parsed.data ||
        !Array.isArray(parsed.data.groups) ||
        !Array.isArray(parsed.data.accounts)
      ) {
        throw new Error(t('tools.password.backup.restore_local_invalid'))
      }
      const ok = await confirm({
        title: t('tools.password.backup.restore_local'),
        description: t('tools.password.backup.restore_confirm'),
        tone: 'danger',
        confirmLabel: t('tools.password.backup.restore'),
        cancelLabel: t('common.cancel'),
      })
      if (!ok) return
      setAuthorizing({ kind: 'restore-local', filename: file.name, payload: parsed })
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t('tools.password.backup.restore_local_invalid'),
        tone: 'danger',
      })
    }
  }

  return (
    <>
      <Modal
        open={isVisible}
        onClose={handleClose}
        title={t('tools.password.backup.title')}
        width={680}
      >
        <div className="flex flex-col gap-5 text-[var(--text-primary)]">
          <div className="flex flex-col gap-5">
              {/* Actions Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
                <div>
                  <h4 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                    {t('tools.password.backup.snapshot_ops')}
                  </h4>
                  <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                    {t('tools.password.backup.snapshot_desc')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Download size={14} />}
                    onClick={handleDownloadLocalBackup}
                  >
                    {t('tools.password.backup.download')}
                  </Button>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                    <Upload size={14} aria-hidden="true" />
                    <span>{t('tools.password.backup.restore_local')}</span>
                    <input
                      type="file"
                      accept=".json,application/json"
                      className="sr-only"
                      data-testid="backup-local-input"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (file) void handleLocalRestoreFile(file)
                        event.currentTarget.value = ''
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    icon={<Cloud size={14} />}
                    onClick={handleCreateCloudBackup}
                    loading={isCreatingBackup}
                  >
                    {t('tools.password.backup.now')}
                  </Button>
                </div>
              </div>

              {/* Auto-lock. The value lived in the database with no control and no reader. */}
              <div className="flex flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
                <Slider
                  label={t('tools.password.backup.auto_lock')}
                  value={autoLockMinutes}
                  min={1}
                  max={60}
                  suffix={t('tools.password.common.minutes')}
                  onChange={handleAutoLockChange}
                />
                <p className="text-[length:var(--text-11)] text-[var(--text-secondary)]">
                  {t('tools.password.backup.auto_lock_desc')}
                </p>
              </div>

              {/* Backup History List */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                    {t('tools.password.backup.history')}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw size={12} />}
                    onClick={fetchBackups}
                    loading={isLoadingBackups}
                  >
                    {t('tools.password.common.refresh')}
                  </Button>
                </div>

                <div className="max-h-56 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                  {backups.length === 0 ? (
                    <div className="flex h-32 items-center justify-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                      {isLoadingBackups ? t('tools.password.backup.loading_history') : t('tools.password.backup.no_history')}
                    </div>
                  ) : (
                    <div className="divide-y divide-[var(--border-subtle)]">
                      {backups.map((rec) => (
                        <div
                          key={rec.id}
                          className="flex items-center justify-between gap-3 p-3 hover:bg-[var(--bg-hover)]"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[length:var(--text-12)] font-medium text-[var(--text-primary)] truncate">
                                {rec.filename}
                              </span>
                              <span className="rounded bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)] uppercase">
                                {rec.type}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                              {`${new Date(rec.createdAt).toLocaleString()} • ${(rec.size / 1024).toFixed(1)} KB`}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              icon={<RotateCcw size={13} />}
                              onClick={() => setRestoreTarget(rec)}
                            >
                              {t('tools.password.backup.restore')}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              icon={<Trash2 size={13} className="text-[var(--danger)]" />}
                              onClick={() => handleDeleteBackup(rec)}
                              aria-label={t('tools.password.backup.delete_snapshot')}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
      </Modal>

      {/* Restore Confirmation Modal */}
      <Modal
        open={Boolean(restoreTarget)}
        onClose={() => setRestoreTarget(null)}
        title={t('tools.password.backup.confirm_restore_title')}
        width={420}
        dismissible={!isRestoring}
      >
        <div className="flex flex-col gap-4 text-[var(--text-primary)]">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--warning-soft)] text-[var(--warning)]">
              <AlertTriangle size={18} />
            </div>
            <div>
              <p className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]">
                {t('tools.password.backup.restore_confirm')}
              </p>
              {restoreTarget && (
                <p className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)] font-mono">
                  {t('tools.password.backup.restore_target_version', {
                    filename: restoreTarget.filename,
                    date: new Date(restoreTarget.createdAt).toLocaleString(),
                  })}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRestoreTarget(null)}
              disabled={isRestoring}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleExecuteRestore}
              loading={isRestoring}
            >
              {t('tools.password.backup.restore')}
            </Button>
          </div>
        </div>
      </Modal>

      <ReauthDialog
        open={Boolean(authorizing)}
        onClose={() => setAuthorizing(null)}
        onAuthorized={(token) => void handleAuthorized(token)}
        description={
          authorizing
            ? t(
                authorizing.kind === 'delete'
                  ? 'tools.password.backup.delete_confirm'
                  : 'tools.password.backup.restore_confirm',
                { filename: authorizing.filename },
              )
            : undefined
        }
      />
    </>
  )
}

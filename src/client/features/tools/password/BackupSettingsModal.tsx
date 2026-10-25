import { useState, useEffect } from 'react'
import {
  Cloud,
  RefreshCw,
  Download,
  RotateCcw,
  Trash2,
  AlertTriangle,
  Save,
} from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Input, Switch, Segmented } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { passwordApi } from './api'
import type {
  PasswordBackupRecord,
  PasswordBackupData,
  WebdavConfig,
} from '@shared/tools/password/types'

export type BackupTab = 'local' | 'webdav'

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
  const refreshData = usePasswordVaultStore((s) => s.refreshData)

  const isVisible = open !== undefined ? open : storeIsOpen
  const handleClose = onClose || storeClose

  const [activeTab, setActiveTab] = useState<BackupTab>('local')

  // Backups state
  const [backups, setBackups] = useState<PasswordBackupRecord[]>([])
  const [isLoadingBackups, setIsLoadingBackups] = useState<boolean>(false)
  const [isCreatingBackup, setIsCreatingBackup] = useState<boolean>(false)

  // Restore confirmation modal state
  const [restoreTarget, setRestoreTarget] = useState<PasswordBackupRecord | null>(null)
  const [isRestoring, setIsRestoring] = useState<boolean>(false)

  // WebDAV settings state
  const [webdavConfig, setWebdavConfig] = useState<WebdavConfig>({
    url: '',
    username: '',
    password: '',
    enabled: false,
  })
  const [isTestingWebdav, setIsTestingWebdav] = useState<boolean>(false)
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false)

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
      if (settings?.webdav) {
        setWebdavConfig(settings.webdav)
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
  const handleExecuteRestore = async () => {
    if (!restoreTarget) return
    setIsRestoring(true)
    try {
      await passwordApi.restoreBackup(restoreTarget.id)
      await refreshData()
      toast({
        title: t('tools.password.backup.restored'),
        tone: 'success',
      })
      setRestoreTarget(null)
      handleClose()
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.backup.restore_failed'),
        tone: 'danger',
      })
    } finally {
      setIsRestoring(false)
    }
  }

  // Handle delete backup
  const handleDeleteBackup = async (id: string) => {
    try {
      await passwordApi.deleteBackup(id)
      setBackups((prev) => prev.filter((b) => b.id !== id))
      toast({
        title: t('tools.password.backup.deleted'),
        tone: 'success',
      })
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.backup.delete_failed'),
        tone: 'danger',
      })
    }
  }

  // Handle WebDAV test
  const handleTestWebdav = async () => {
    if (!webdavConfig.url) {
      toast({ title: t('tools.password.backup.webdav_url_required'), tone: 'danger' })
      return
    }
    setIsTestingWebdav(true)
    try {
      const res = await passwordApi.testWebdav(webdavConfig)
      if (res && res.ok) {
        toast({
          title: t('tools.password.backup.webdav_test_ok'),
          tone: 'success',
        })
      } else {
        toast({
          title: res?.error || t('tools.password.backup.webdav_test_failed'),
          tone: 'danger',
        })
      }
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.backup.webdav_test_failed'),
        tone: 'danger',
      })
    } finally {
      setIsTestingWebdav(false)
    }
  }

  // Handle WebDAV save
  const handleSaveWebdav = async () => {
    setIsSavingSettings(true)
    try {
      await passwordApi.saveSettings({ webdav: webdavConfig })
      toast({
        title: t('tools.password.backup.webdav_saved'),
        tone: 'success',
      })
    } catch (err: any) {
      toast({
        title: err?.message || t('tools.password.backup.save_failed'),
        tone: 'danger',
      })
    } finally {
      setIsSavingSettings(false)
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
          {/* Tab Navigation */}
          <div className="w-full">
            <Segmented<BackupTab>
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { value: 'local', label: t('tools.password.backup.local_tab') },
                { value: 'webdav', label: t('tools.password.backup.webdav_tab') },
              ]}
            />
          </div>

          {/* Tab 1: R2 & Local Backup */}
          {activeTab === 'local' && (
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
                              icon={<Trash2 size={13} className="text-red-500" />}
                              onClick={() => handleDeleteBackup(rec.id)}
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
          )}

          {/* Tab 2: WebDAV Cloud Sync */}
          {activeTab === 'webdav' && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
                <div className="flex flex-col">
                  <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                    {t('tools.password.backup.webdav_enable')}
                  </span>
                  <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {t('tools.password.backup.webdav_desc')}
                  </span>
                </div>
                <Switch
                  checked={webdavConfig.enabled}
                  onChange={(val) => setWebdavConfig((prev) => ({ ...prev, enabled: val }))}
                />
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="webdav-url"
                    className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]"
                  >
                    {t('tools.password.backup.webdav_url')}
                  </label>
                  <Input
                    id="webdav-url"
                    type="url"
                    placeholder="https://example.com/dav/passwords/"
                    value={webdavConfig.url}
                    onChange={(e) =>
                      setWebdavConfig((prev) => ({ ...prev, url: e.target.value }))
                    }
                    className="h-8 text-[length:var(--text-13)]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="webdav-username"
                      className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]"
                    >
                      {t('tools.password.backup.webdav_user')}
                    </label>
                    <Input
                      id="webdav-username"
                      value={webdavConfig.username}
                      onChange={(e) =>
                        setWebdavConfig((prev) => ({ ...prev, username: e.target.value }))
                      }
                      className="h-8 text-[length:var(--text-13)]"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="webdav-password"
                      className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]"
                    >
                      {t('tools.password.backup.webdav_pass')}
                    </label>
                    <Input
                      id="webdav-password"
                      type="password"
                      value={webdavConfig.password || ''}
                      onChange={(e) =>
                        setWebdavConfig((prev) => ({ ...prev, password: e.target.value }))
                      }
                      className="h-8 text-[length:var(--text-13)]"
                    />
                  </div>
                </div>
              </div>

              {/* WebDAV Actions */}
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-subtle)]">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleTestWebdav}
                  loading={isTestingWebdav}
                >
                  {t('tools.password.backup.webdav_test')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  icon={<Save size={14} />}
                  onClick={handleSaveWebdav}
                  loading={isSavingSettings}
                >
                  {t('tools.password.backup.save_settings')}
                </Button>
              </div>
            </div>
          )}
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
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
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
    </>
  )
}

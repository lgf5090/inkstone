import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Cloud,
  RefreshCw,
  Download,
  Upload,
  RotateCcw,
  Trash2,
  AlertTriangle,
} from 'lucide-react'
import { t, type MessageKey } from '../../../lib/i18n'
import { Modal, confirm } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Segmented, Slider, Input } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { passwordApi, PasswordApiError } from './api'
import type {
  PasswordBackupRecord,
  PasswordBackupData,
  PasswordAuditEntry,
  PasswordSettings,
  VerifierTier,
} from '@shared/tools/password/types'
import {
  FREE_PLAN_CPU_MS,
  VERIFIER_TIERS,
  isVerifierTierCost,
} from '@shared/tools/password/types'
import { ReauthDialog } from './ReauthDialog'

export interface BackupSettingsModalProps {
  open?: boolean
  onClose?: () => void
}

/** Action names the server writes; anything else is shown verbatim rather than hidden. */
const AUDIT_LABEL_KEYS: Record<string, MessageKey> = {
  unlock_ok: 'tools.password.audit.unlock_ok',
  unlock_failed: 'tools.password.audit.unlock_failed',
  reauth_ok: 'tools.password.audit.reauth_ok',
  reauth_failed: 'tools.password.audit.reauth_failed',
  reset_ok: 'tools.password.audit.reset_ok',
  reset_failed: 'tools.password.audit.reset_failed',
  wipe_ok: 'tools.password.audit.wipe_ok',
  restore_ok: 'tools.password.audit.restore_ok',
  backup_created: 'tools.password.audit.backup_created',
  backup_deleted: 'tools.password.audit.backup_deleted',
  confirm_rejected: 'tools.password.audit.confirm_rejected',
  verifier_target_changed: 'tools.password.audit.verifier_target_changed',
  verifier_retargeted: 'tools.password.audit.verifier_retargeted',
  verifier_retarget_failed: 'tools.password.audit.verifier_retarget_failed',
  verifier_switch_failed: 'tools.password.audit.verifier_switch_failed',
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

  const [settings, setSettings] = useState<PasswordSettings | null>(null)
  const [verifierWarning, setVerifierWarning] = useState<{ cost: number } | null>(null)
  const [verifierPrompt, setVerifierPrompt] = useState<{ cost: number } | null>(null)
  const [verifierPassword, setVerifierPassword] = useState('')
  const [verifierError, setVerifierError] = useState<string | null>(null)
  const [isSwitchingVerifier, setIsSwitchingVerifier] = useState(false)
  const verifierPollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [auditEntries, setAuditEntries] = useState<PasswordAuditEntry[]>([])
  const [isLoadingAudit, setIsLoadingAudit] = useState(false)

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
      const next = await passwordApi.getSettings()
      setSettings(next)
      if (next?.autoLockMinutes) {
        setAutoLockMinutes(next.autoLockMinutes)
      }
    } catch {
      // Ignored
    }
  }

  const fetchAudit = async () => {
    setIsLoadingAudit(true)
    try {
      setAuditEntries(await passwordApi.getAudit(20))
    } catch {
      // Keep whatever is on screen; the next open or refresh retries.
    } finally {
      setIsLoadingAudit(false)
    }
  }

  useEffect(() => {
    if (isVisible) {
      void fetchBackups()
      void fetchSettings()
      void fetchAudit()
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
      if (verifierPollRef.current) clearTimeout(verifierPollRef.current)
    }
  }, [])

  const tierOfCost = (cost: number): VerifierTier | null => {
    const entry = (Object.keys(VERIFIER_TIERS) as VerifierTier[]).find(
      (tier) => VERIFIER_TIERS[tier] === cost,
    )
    return entry ?? null
  }

  const measuredFor = (cost: number): number | null => {
    const value = settings?.verifierSamples[String(cost)]
    return typeof value === 'number' && value > 0 ? value : null
  }

  /**
   * A tier whose measured verify time exceeds the Free plan's 10 ms CPU budget would make every
   * unlock fail there, so the reader is made to say so out loud before the request is sent. A tier
   * that has never been measured on this deployment is treated the same way for the two expensive
   * ones: the screen would otherwise promise a number it does not have.
   */
  const tierNeedsWarning = (cost: number): boolean => {
    const measured = measuredFor(cost)
    if (measured !== null) return measured > FREE_PLAN_CPU_MS
    return cost > VERIFIER_TIERS.low
  }

  const handleSelectVerifierTier = (tier: VerifierTier) => {
    const cost = VERIFIER_TIERS[tier]
    if (!isVerifierTierCost(cost)) return
    if (settings && cost === settings.verifierCost) return

    if (tierNeedsWarning(cost)) {
      setVerifierWarning({ cost })
      return
    }

    setVerifierError(null)
    setVerifierPassword('')
    setVerifierPrompt({ cost })
  }

  const submitVerifierSwitch = async (event?: FormEvent) => {
    event?.preventDefault()
    if (isSwitchingVerifier || !verifierPrompt) return
    if (!verifierPassword) {
      setVerifierError(t('tools.password.door.placeholder'))
      return
    }

    setIsSwitchingVerifier(true)
    setVerifierError(null)
    try {
      const result = await passwordApi.setVerifierCost(verifierPrompt.cost, verifierPassword)
      setVerifierPassword('')
      setVerifierPrompt(null)
      toast({
        title:
          result.applied === 'deferred'
            ? t('tools.password.settings.switch_deferred')
            : t('tools.password.settings.switch_done', { cost: String(result.storedCost) }),
        tone: 'success',
      })
      await fetchSettings()
      // The stronger tier finishes after the response; one re-read is enough to show its measurement.
      if (result.applied === 'deferred') {
        if (verifierPollRef.current) clearTimeout(verifierPollRef.current)
        verifierPollRef.current = setTimeout(() => void fetchSettings(), 4000)
      }
      void fetchAudit()
    } catch (err) {
      setVerifierError(
        err instanceof PasswordApiError && err.code === 'wrong_password'
          ? t('tools.password.door.fail')
          : err instanceof Error
            ? err.message
            : t('tools.password.settings.switch_failed'),
      )
    } finally {
      setIsSwitchingVerifier(false)
    }
  }

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

              {/* Verifier cost. This is the only dial that changes how much CPU an unlock costs the
                  Worker, so the reader picks it and sees what this deployment actually measured. */}
              <div
                data-testid="password-verifier-section"
                className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4"
              >
                <div className="min-w-0">
                  <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                    {t('tools.password.settings.title')}
                  </span>
                  <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-secondary)]">
                    {t('tools.password.settings.desc')}
                  </p>
                </div>

                <Segmented<VerifierTier>
                  value={tierOfCost(settings?.verifierCost ?? VERIFIER_TIERS.standard) ?? 'standard'}
                  size="sm"
                  label={t('tools.password.settings.title')}
                  disabled={isSwitchingVerifier}
                  onChange={(tier) => void handleSelectVerifierTier(tier)}
                  options={[
                    { value: 'low', label: t('tools.password.settings.tier_low') },
                    { value: 'standard', label: t('tools.password.settings.tier_standard') },
                    { value: 'high', label: t('tools.password.settings.tier_high') },
                  ]}
                />

                <div className="flex flex-col gap-1" data-testid="password-verifier-tiers">
                  {(Object.keys(VERIFIER_TIERS) as VerifierTier[]).map((tier) => {
                    const cost = VERIFIER_TIERS[tier]
                    const measured = measuredFor(cost)
                    return (
                      <div
                        key={tier}
                        data-testid={`password-verifier-tier-${tier}`}
                        className="flex items-baseline justify-between gap-3 text-[length:var(--text-11)]"
                      >
                        <span className="text-[var(--text-secondary)]">
                          {t(`tools.password.settings.tier_${tier}` as MessageKey)}
                          <span className="ml-1 text-[var(--text-quaternary)]">{` cost ${cost}`}</span>
                        </span>
                        <span
                          data-testid={`password-verifier-measured-${tier}`}
                          className="font-mono text-[var(--text-tertiary)]"
                        >
                          {measured === null
                            ? t('tools.password.settings.unmeasured')
                            : t('tools.password.settings.measured', { ms: measured.toFixed(1) })}
                        </span>
                      </div>
                    )
                  })}
                </div>

                <p
                  data-testid="password-verifier-effective"
                  className="text-[length:var(--text-11)] text-[var(--text-secondary)]"
                >
                  {t('tools.password.settings.effective', {
                    target: String(settings?.verifierCost ?? VERIFIER_TIERS.standard),
                    stored: String(settings?.verifierStoredCost ?? VERIFIER_TIERS.standard),
                  })}
                </p>

                <p className="flex items-start gap-1.5 rounded-[var(--r-sm)] bg-[var(--warning-soft)] px-2.5 py-2 text-[length:var(--text-11)] leading-relaxed text-[var(--text-primary)]">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
                  <span>{t('tools.password.settings.free_note', { limit: String(FREE_PLAN_CPU_MS) })}</span>
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

              {/* Security log: what the server recorded, so a wipe or a refused confirmation the
                  reader did not perform is visible instead of only living in the deployment log. */}
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                      {t('tools.password.audit.title')}
                    </span>
                    <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                      {t('tools.password.audit.hint')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw size={12} />}
                    onClick={fetchAudit}
                    loading={isLoadingAudit}
                  >
                    {t('tools.password.common.refresh')}
                  </Button>
                </div>

                <div
                  data-testid="password-audit-list"
                  className="max-h-48 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                >
                  {auditEntries.length === 0 ? (
                    <div className="flex h-20 items-center justify-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                      {t('tools.password.audit.empty')}
                    </div>
                  ) : (
                    <div className="divide-y divide-[var(--border-subtle)]">
                      {auditEntries.map((entry) => (
                        <div
                          key={entry.id}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                          data-testid="password-audit-row"
                        >
                          <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                            {AUDIT_LABEL_KEYS[entry.action]
                              ? t(AUDIT_LABEL_KEYS[entry.action]!)
                              : entry.action}
                          </span>
                          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                            {new Date(entry.createdAt).toLocaleString()}
                          </span>
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

      {/* A tier this deployment has never measured, or one measured above the Free plan's CPU
          budget, is confirmed in its own dialog rather than silently accepted. */}
      <Modal
        open={Boolean(verifierWarning)}
        onClose={() => setVerifierWarning(null)}
        title={t('tools.password.settings.warn_title')}
        width={420}
      >
        <div className="flex flex-col gap-4 text-[var(--text-primary)]">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--warning-soft)] text-[var(--warning)]">
              <AlertTriangle size={18} />
            </div>
            <div>
              <p className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]">
                {t('tools.password.settings.warn_desc', {
                  limit: String(FREE_PLAN_CPU_MS),
                })}
              </p>
              {verifierWarning && (
                <p className="mt-2 text-[length:var(--text-11)] font-mono text-[var(--text-tertiary)]">
                  {t('tools.password.settings.effective', {
                    target: String(verifierWarning.cost),
                    stored: String(settings?.verifierStoredCost ?? VERIFIER_TIERS.standard),
                  })}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] pt-2">
            <Button type="button" variant="ghost" onClick={() => setVerifierWarning(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="password-verifier-warn-confirm"
              type="button"
              variant="danger"
              onClick={() => {
                const cost = verifierWarning?.cost
                setVerifierWarning(null)
                if (!cost) return
                setVerifierError(null)
                setVerifierPassword('')
                setVerifierPrompt({ cost })
              }}
            >
              {t('tools.password.settings.warn_confirm')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* The verifier switch needs the password itself, not a confirmation token: the server rehashes
          from the password it has just verified, so the stored digest can never describe another one. */}
      <Modal
        open={Boolean(verifierPrompt)}
        onClose={() => {
          setVerifierPassword('')
          setVerifierError(null)
          setVerifierPrompt(null)
        }}
        title={t('tools.password.settings.switch_title')}
        width={420}
        dismissible={!isSwitchingVerifier}
      >
        <form onSubmit={(event) => void submitVerifierSwitch(event)} className="space-y-4 pt-1">
          <p className="text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]">
            {t('tools.password.settings.switch_prompt', {
              from: String(settings?.verifierCost ?? VERIFIER_TIERS.standard),
              to: String(verifierPrompt?.cost ?? 0),
            })}
          </p>

          <Input
            data-testid="password-verifier-password"
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            autoFocus
            value={verifierPassword}
            onChange={(event) => {
              setVerifierPassword(event.target.value)
              if (verifierError) setVerifierError(null)
            }}
            placeholder={t('tools.password.door.placeholder')}
            aria-label={t('tools.password.settings.switch_title')}
            aria-invalid={Boolean(verifierError)}
          />

          {verifierError && (
            <div
              data-testid="password-verifier-error"
              role="alert"
              className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]"
            >
              {verifierError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setVerifierPassword('')
                setVerifierError(null)
                setVerifierPrompt(null)
              }}
              disabled={isSwitchingVerifier}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="password-verifier-submit"
              type="submit"
              variant="primary"
              loading={isSwitchingVerifier}
            >
              {t('tools.password.settings.switch_submit')}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  )
}

/**
 * Copying environment variables and secrets from one Worker to others.
 *
 * Cloudflare never returns secret plaintext, so the dialog asks only for the values it is about to
 * write. Preview compares names (and plain values) and leaves the actual send to an explicit execute.
 */
import { useEffect, useMemo, useState } from 'react'
import { Field, Input, Checkbox } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import {
  workersApi,
  type EnvSyncPreview,
  type EnvSyncResultRow,
  type WorkerRow,
} from '../../api/workers'
import { useCfT } from '../../i18n'

function targetKey(accountId: string, workerName: string): string {
  return `${accountId}:${workerName}`
}

export function EnvSyncDialog({
  open,
  onClose,
  accountId,
  workerName,
  sourceKeys,
  onDone,
}: {
  open: boolean
  onClose: () => void
  accountId: string
  workerName: string
  sourceKeys: Array<{ name: string; type: string }>
  onDone: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [workers, setWorkers] = useState<WorkerRow[]>([])
  const [selectedTargets, setSelectedTargets] = useState<string[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<EnvSyncPreview | null>(null)
  const [results, setResults] = useState<EnvSyncResultRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const secrets = useMemo(
    () => sourceKeys.filter((key) => key.type === 'secret_text'),
    [sourceKeys],
  )
  const targetRows = useMemo(
    () => workers.filter((row) => row.type === 'worker'
      && !(row.accountId === accountId && row.name === workerName)),
    [workers, accountId, workerName],
  )

  useEffect(() => {
    if (!open) return
    setResults([])
    setPreview(null)
    setError('')
    setSelectedTargets([])
    setSelectedKeys(sourceKeys.map((key) => key.name))
    setSecretValues({})
    let cancelled = false
    void workersApi.list()
      .then((list) => {
        if (!cancelled) setWorkers(list)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(cfErrorText(reason))
      })
    return () => {
      cancelled = true
    }
  }, [open, accountId, workerName, sourceKeys])

  function toggleTarget(key: string): void {
    setSelectedTargets((current) => (
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    ))
    setPreview(null)
  }

  function toggleKey(name: string): void {
    setSelectedKeys((current) => (
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    ))
    setPreview(null)
  }

  function targets(): Array<{ accountId: string; workerName: string }> {
    return selectedTargets.map((key) => {
      const separator = key.indexOf(':')
      return {
        accountId: key.slice(0, separator),
        workerName: key.slice(separator + 1),
      }
    })
  }

  async function runPreview(): Promise<void> {
    if (selectedTargets.length === 0) {
      toast({ title: t('cloudflare.worker_settings.target_workers'), tone: 'warning' })
      return
    }
    setBusy(true)
    setError('')
    try {
      setPreview(await workersApi.envSyncPreview(
        { accountId, workerName },
        targets(),
      ))
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  async function execute(): Promise<void> {
    if (selectedTargets.length === 0 || selectedKeys.length === 0) {
      toast({ title: t('cloudflare.workers.msg.info_required'), tone: 'warning' })
      return
    }
    const missingValue = secrets
      .filter((secret) => selectedKeys.includes(secret.name) && !secretValues[secret.name])
    if (missingValue.length > 0) {
      toast({ title: t('cloudflare.worker_settings.msg.at_least_one_secret'), tone: 'warning' })
      return
    }
    setBusy(true)
    setError('')
    try {
      const answer = await workersApi.envSyncExecute(
        { accountId, workerName },
        targets(),
        selectedKeys,
        Object.fromEntries(secrets.map((secret) => [secret.name, secretValues[secret.name] ?? ''])),
      )
      setResults(answer)
      const succeeded = answer.filter((row) => row.success).length
      toast({
        title: t('cloudflare.worker_settings.msg.sync_complete', {
          success: succeeded,
          total: answer.length,
        }),
        tone: succeeded === answer.length ? 'success' : 'warning',
      })
      onDone()
    } catch (reason) {
      setError(cfErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudflare.worker_settings.env_sync_title')}
      width={720}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {uiT('common.close')}
          </Button>
          <Button variant="secondary" loading={busy} onClick={() => void runPreview()}>
            {t('cloudflare.worker_settings.preview')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void execute()}>
            {t('cloudflare.worker_settings.sync')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('cloudflare.worker_settings.secret_value_hint')}
        </p>
        {error && <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}

        <div className="space-y-1.5">
          <p className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('cloudflare.worker_settings.target_workers')}
          </p>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2">
            {targetRows.map((row) => {
              const key = targetKey(row.accountId, row.name)
              return (
                <Checkbox
                  key={key}
                  checked={selectedTargets.includes(key)}
                  label={`${row.accountName} / ${row.name}`}
                  onChange={() => toggleTarget(key)}
                />
              )
            })}
            {targetRows.length === 0 && (
              <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('share.no_data_yet')}</p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('cloudflare.worker_settings.sync_to_other')}
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-2">
            {sourceKeys.map((key) => (
              <Checkbox
                key={key.name}
                checked={selectedKeys.includes(key.name)}
                label={key.type === 'secret_text'
                  ? `${key.name} · ${t('cloudflare.workers.env_vars.secret_label')}`
                  : key.name}
                onChange={() => toggleKey(key.name)}
              />
            ))}
            {sourceKeys.length === 0 && (
              <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('share.no_data_yet')}</p>
            )}
          </div>
        </div>

        {secrets.filter((secret) => selectedKeys.includes(secret.name)).map((secret) => (
          <Field key={secret.name} label={secret.name}>
            <Input
              type="password"
              value={secretValues[secret.name] ?? ''}
              placeholder={t('cloudflare.worker_settings.input_value_placeholder')}
              onChange={(event) => setSecretValues((current) => ({
                ...current,
                [secret.name]: event.target.value,
              }))}
            />
          </Field>
        ))}

        {preview && (
          <div className="space-y-1.5 border-t border-[var(--border-subtle)] pt-2">
            {preview.previews.map((entry) => (
              <div key={targetKey(entry.accountId, entry.workerName)} className="text-[length:var(--text-11-5)]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={entry.error ? 'danger' : entry.missing.length + entry.changed.length > 0 ? 'warning' : 'success'}>
                    {entry.workerName}
                  </Badge>
                  {entry.error
                    ? <span className="text-[var(--danger)]">{entry.error}</span>
                    : (
                      <span className="text-[var(--text-tertiary)]">
                        {entry.missing.map((item) => item.name).join(', ')}
                        {entry.changed.length > 0 ? ` · ${entry.changed.map((item) => item.name).join(', ')}` : ''}
                        {entry.missing.length + entry.changed.length === 0
                          ? t('cloudflare.workers.deploy_dialog.success_tag')
                          : ''}
                      </span>
                    )}
                </div>
              </div>
            ))}
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-1 border-t border-[var(--border-subtle)] pt-2">
            {results.map((row) => (
              <div key={targetKey(row.accountId, row.workerName)} className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-11-5)]">
                <Badge tone={row.success ? 'success' : 'danger'}>{row.workerName}</Badge>
                <span className={row.success ? 'text-[var(--text-tertiary)]' : 'text-[var(--danger)]'}>
                  {row.success ? row.applied.join(', ') : row.error}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

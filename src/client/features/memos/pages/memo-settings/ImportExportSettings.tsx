import { useRef, useState, type ChangeEvent, type ReactElement } from 'react'
import { Download, Upload } from 'lucide-react'
import type {
  MemoImportConflictPolicy,
  MemoImportIssue,
  MemoImportPlan,
  MemoImportReport,
  MemoImportSession,
} from '@shared/memos/types'
import { Button, Spinner } from '../../../../components/primitives'
import { Field, Select } from '../../../../components/form'
import { confirm } from '../../../../components/overlay'
import { ApiError } from '../../../../lib/api'
import { downloadBlob } from '../../../../lib/export-note'
import { t, type MessageKey } from '../../../../lib/i18n'
import { formatBytes } from '../../../../lib/time'
import { memoIsAbortError } from '../../errors'
import { bump } from '../../events'
import { MEMO_IMPORT_ARCHIVE_MAX_BYTES, memoTransferClient } from '../../transfer-client'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'
import { settingsErrorMessage } from './error'

type ImportPhase = 'idle' | 'uploading' | 'planning' | 'ready' | 'committing' | 'cancelling' | 'done' | 'error'

interface ImportFailure {
  headingKey: MessageKey | null
  message: string
  retryable: boolean
}

interface ConflictOption {
  value: MemoImportConflictPolicy
  labelKey: MessageKey
}

const CONFLICT_OPTIONS: readonly ConflictOption[] = [
  { value: 'skip', labelKey: 'memos.settings.transfer_conflict_skip' },
  { value: 'replace', labelKey: 'memos.settings.transfer_conflict_replace' },
  { value: 'duplicate', labelKey: 'memos.settings.transfer_conflict_duplicate' },
]

const REFRESH_DOMAINS = ['list', 'detail', 'stats', 'attachments', 'spaces'] as const

function isConflictPolicy(value: string): value is MemoImportConflictPolicy {
  return value === 'skip' || value === 'replace' || value === 'duplicate'
}

function validateImportArchive(file: File): string | null {
  if (!/\.zip$/i.test(file.name)) return t('memos.settings.transfer_invalid_type')
  if (file.size <= 0) return t('memos.settings.transfer_empty')
  if (file.size > MEMO_IMPORT_ARCHIVE_MAX_BYTES) {
    return t('memos.settings.transfer_too_large', {
      size: formatBytes(file.size),
      limit: formatBytes(MEMO_IMPORT_ARCHIVE_MAX_BYTES),
    })
  }
  return null
}

function CountTile({
  name,
  label,
  value,
  tone,
}: {
  name: string
  label: string
  value: number
  tone?: 'success' | 'danger'
}) {
  const color = tone === 'success'
    ? 'text-[var(--success)]'
    : tone === 'danger'
      ? 'text-[var(--danger)]'
      : 'text-[var(--text-primary)]'
  return (
    <div data-import-count={name} className="rounded-[var(--r-sm)] bg-[var(--bg-base)] px-2 py-1.5">
      <dt className="truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{label}</dt>
      <dd className={`mt-0.5 text-[length:var(--text-16)] font-semibold tabular ${color}`}>{value}</dd>
    </div>
  )
}

function IssueList({
  heading,
  issues,
  tone = 'warning',
}: {
  heading: string
  issues: readonly MemoImportIssue[]
  tone?: 'warning' | 'danger'
}) {
  return (
    <section className="mt-2">
      <p className={`text-[length:var(--text-11)] font-medium ${tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--warning)]'}`}>
        {heading}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.path ?? ''}-${index}`} className="min-w-0">
            <span className="break-words">{issue.message}</span>
            {issue.path ? (
              <code className="ml-1 break-all rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1 py-0.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                {issue.path}
              </code>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PlanSummary({ plan }: { plan: MemoImportPlan }) {
  return (
    <div className="mt-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5">
      <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
        {t('memos.settings.transfer_plan_title')}
      </p>
      <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {t('memos.settings.transfer_plan_exporter', { exporter: plan.exporter })}
      </p>
      <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
        {t('memos.settings.transfer_plan_memos', { count: plan.memoCount })}
        {' · '}
        {t('memos.settings.transfer_plan_attachments', { count: plan.attachmentCount })}
      </p>
      <dl className="mt-2 grid grid-cols-3 gap-1.5">
        <CountTile name="new" label={t('memos.settings.transfer_plan_new')} value={plan.newCount} tone="success" />
        <CountTile name="renamed" label={t('memos.settings.transfer_plan_renamed')} value={plan.renamedCount} />
        <CountTile name="existing" label={t('memos.settings.transfer_plan_existing')} value={plan.existingCount} />
      </dl>
      {plan.warnings.length > 0 ? (
        <IssueList
          heading={t('memos.settings.transfer_warnings', { count: plan.warnings.length })}
          issues={plan.warnings}
        />
      ) : null}
    </div>
  )
}

function ImportReportSummary({ report }: { report: MemoImportReport }) {
  return (
    <div className="mt-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5">
      <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
        {t('memos.settings.transfer_report_title')}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-1.5 md:grid-cols-4">
        <CountTile name="created" label={t('memos.settings.transfer_report_created')} value={report.created} tone="success" />
        <CountTile name="updated" label={t('memos.settings.transfer_report_updated')} value={report.updated} />
        <CountTile name="skipped" label={t('memos.settings.transfer_report_skipped')} value={report.skipped} />
        <CountTile name="failed" label={t('memos.settings.transfer_report_failed')} value={report.failed} tone="danger" />
      </dl>
      {report.failures.length > 0 ? (
        <IssueList heading={t('memos.settings.transfer_failures')} issues={report.failures} tone="danger" />
      ) : null}
      {report.warnings.length > 0 ? (
        <IssueList
          heading={t('memos.settings.transfer_warnings', { count: report.warnings.length })}
          issues={report.warnings}
        />
      ) : null}
    </div>
  )
}

function UploadProgress({
  received,
  total,
  planning,
}: {
  received: number
  total: number
  planning: boolean
}) {
  const percent = planning ? 100 : total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
  const status = planning
    ? t('memos.settings.transfer_planning')
    : t('memos.settings.transfer_upload_progress', {
      received: formatBytes(received),
      total: formatBytes(total),
    })
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span role="status" aria-live="polite" className="inline-flex min-w-0 items-center gap-1.5">
          <Spinner size={12} />
          <span className="truncate">{status}</span>
        </span>
        <span className="tabular">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={status}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-raised)]"
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function FailureNotice({ failure }: { failure: ImportFailure }) {
  return (
    <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
      {failure.headingKey ? (
        <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
          {t(failure.headingKey)}
        </p>
      ) : null}
      <p className={`text-[length:var(--text-11)] leading-relaxed ${failure.headingKey ? 'mt-0.5 text-[var(--text-tertiary)]' : 'text-[var(--danger)]'}`}>
        {failure.message}
      </p>
    </div>
  )
}

export function ImportExportSettings(): ReactElement {
  const [phase, setPhase] = useState<ImportPhase>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [session, setSession] = useState<MemoImportSession | null>(null)
  const [received, setReceived] = useState(0)
  const [plan, setPlan] = useState<MemoImportPlan | null>(null)
  const [policy, setPolicy] = useState<MemoImportConflictPolicy>('skip')
  const [report, setReport] = useState<MemoImportReport | null>(null)
  const [failure, setFailure] = useState<ImportFailure | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportFailure, setExportFailure] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const sessionRef = useRef<MemoImportSession | null>(null)
  const runRef = useRef(0)

  const busy = phase === 'uploading' || phase === 'planning' || phase === 'committing' || phase === 'cancelling'

  const runExport = async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
    setExportFailure(null)
    try {
      const download = await memoTransferClient.downloadExport()
      downloadBlob(download.filename, download.blob)
    } catch (error) {
      setExportFailure(settingsErrorMessage(error))
    } finally {
      setExporting(false)
    }
  }

  const clearAll = (): void => {
    runRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    sessionRef.current = null
    setSession(null)
    setFile(null)
    setReceived(0)
    setPlan(null)
    setReport(null)
    setFailure(null)
    setPolicy('skip')
    setPhase('idle')
  }

  const beginImport = async (picked: File): Promise<void> => {
    const problem = validateImportArchive(picked)
    if (problem) {
      setFile(null)
      setPlan(null)
      setReport(null)
      setFailure({ headingKey: null, message: problem, retryable: false })
      setPhase('error')
      return
    }
    const run = runRef.current + 1
    runRef.current = run
    const controller = new AbortController()
    controllerRef.current = controller
    setFile(picked)
    setSession(null)
    setPlan(null)
    setReport(null)
    setFailure(null)
    setReceived(0)
    setPolicy('skip')
    setPhase('uploading')
    let stage: 'upload' | 'plan' = 'upload'
    try {
      const created = await memoTransferClient.createImportSession(
        { filename: picked.name, totalSize: picked.size },
        controller.signal,
      )
      if (runRef.current !== run) return
      sessionRef.current = created
      setSession(created)
      let offset = 0
      while (offset < picked.size) {
        const end = Math.min(offset + created.chunkSize, picked.size)
        const result = await memoTransferClient.uploadImportChunk(
          created.id,
          offset,
          picked.slice(offset, end),
          controller.signal,
        )
        if (runRef.current !== run) return
        if (result.received <= offset) {
          throw new ApiError(502, 'invalid_response', t('api.invalid_server_response'))
        }
        offset = result.received
        setReceived(offset)
      }
      stage = 'plan'
      setPhase('planning')
      const nextPlan = await memoTransferClient.planImport(created.id, controller.signal)
      if (runRef.current !== run) return
      setPlan(nextPlan)
      setPhase('ready')
    } catch (error) {
      if (runRef.current !== run || memoIsAbortError(error)) return
      setFailure({
        headingKey: stage === 'plan' ? 'memos.settings.transfer_plan_failed' : 'memos.settings.transfer_upload_failed',
        message: settingsErrorMessage(error),
        retryable: true,
      })
      setPhase('error')
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  const discard = async (): Promise<boolean> => {
    if (phase === 'cancelling') return false
    runRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    const current = sessionRef.current
    setFailure(null)
    if (current) {
      setPhase('cancelling')
      try {
        await memoTransferClient.cancelImport(current.id)
      } catch (error) {
        setFailure({
          headingKey: 'memos.settings.transfer_discard_failed',
          message: settingsErrorMessage(error),
          retryable: false,
        })
        setPhase('error')
        return false
      }
    }
    clearAll()
    return true
  }

  const retry = async (): Promise<void> => {
    const picked = file
    if (!picked) return
    if (await discard()) await beginImport(picked)
  }

  const commit = async (): Promise<void> => {
    if (!session || !plan || phase !== 'ready') return
    if (policy !== 'skip' && plan.existingCount > 0) {
      const replace = policy === 'replace'
      const agreed = await confirm({
        title: replace
          ? t('memos.settings.transfer_confirm_replace_title', { count: plan.existingCount })
          : t('memos.settings.transfer_confirm_duplicate_title', { count: plan.existingCount }),
        description: replace
          ? t('memos.settings.transfer_confirm_replace_description')
          : t('memos.settings.transfer_confirm_duplicate_description'),
        confirmLabel: replace
          ? t('memos.settings.transfer_confirm_replace')
          : t('memos.settings.transfer_confirm_duplicate'),
        cancelLabel: t('memos.common.cancel'),
        tone: replace ? 'danger' : 'default',
      })
      if (!agreed) return
    }
    setFailure(null)
    setPhase('committing')
    try {
      const result = await memoTransferClient.commitImport(session.id, policy)
      sessionRef.current = null
      setSession(null)
      setPlan(null)
      setFile(null)
      setReport(result)
      setPhase('done')
      for (const domain of REFRESH_DOMAINS) bump(domain)
    } catch (error) {
      sessionRef.current = null
      setSession(null)
      setFailure({
        headingKey: 'memos.settings.transfer_commit_failed',
        message: settingsErrorMessage(error),
        retryable: false,
      })
      setPhase('error')
    }
  }

  const chooseFile = (): void => {
    fileInputRef.current?.click()
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0] ?? null
    event.target.value = ''
    if (picked) void beginImport(picked)
  }

  const fileSummary = file
    ? t('memos.settings.transfer_file_size', { name: file.name, size: formatBytes(file.size) })
    : ''

  const renderImportBody = (): ReactElement => {
    if (phase === 'uploading' || phase === 'planning') {
      return (
        <div className="mt-2">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{fileSummary}</p>
          <UploadProgress received={received} total={file?.size ?? 0} planning={phase === 'planning'} />
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => void discard()}>
              {phase === 'planning'
                ? t('memos.settings.transfer_discard')
                : t('memos.settings.transfer_cancel')}
            </Button>
          </div>
        </div>
      )
    }
    if (phase === 'cancelling') {
      return (
        <div className="mt-2 flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <Spinner size={13} />
          <span role="status" aria-live="polite">{t('memos.settings.transfer_cancelling')}</span>
        </div>
      )
    }
    if (phase === 'ready' && plan) {
      return (
        <div className="mt-2">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{fileSummary}</p>
          <PlanSummary plan={plan} />
          <div className="mt-2 max-w-[280px]">
            <Field
              label={t('memos.settings.transfer_conflict')}
              hint={t('memos.settings.transfer_conflict_hint')}
            >
              <Select
                value={policy}
                onChange={(event) => {
                  const next = event.target.value
                  if (isConflictPolicy(next)) setPolicy(next)
                }}
              >
                {CONFLICT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" onClick={() => void commit()}>
              {t('memos.settings.transfer_commit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void discard()}>
              {t('memos.settings.transfer_discard')}
            </Button>
          </div>
        </div>
      )
    }
    if (phase === 'committing' && plan) {
      return (
        <div className="mt-2">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{fileSummary}</p>
          <PlanSummary plan={plan} />
          <div className="mt-2">
            <Button size="sm" variant="primary" loading>
              {t('memos.settings.transfer_committing')}
            </Button>
          </div>
        </div>
      )
    }
    if (phase === 'done' && report) {
      return (
        <div className="mt-2">
          <ImportReportSummary report={report} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => void discard()}>
            {t('memos.settings.transfer_reset')}
          </Button>
        </div>
      )
    }
    if (phase === 'error') {
      return (
        <div className="mt-2">
          {failure ? <FailureNotice failure={failure} /> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {failure?.retryable && file ? (
              <Button size="sm" variant="secondary" onClick={() => void retry()}>
                {t('memos.common.retry')}
              </Button>
            ) : null}
            {file === null ? (
              <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={chooseFile}>
                {t('memos.settings.transfer_choose_file')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void discard()}>
              {session ? t('memos.settings.transfer_discard') : t('memos.settings.transfer_clear')}
            </Button>
          </div>
        </div>
      )
    }
    return (
      <div className="mt-2">
        <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={chooseFile}>
          {t('memos.settings.transfer_choose_file')}
        </Button>
      </div>
    )
  }

  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.transfer}
      title={t('memos.settings.transfer')}
      description={t('memos.settings.transfer_description')}
    >
      <h4 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
        {t('memos.settings.transfer_export')}
      </h4>
      <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
        {t('memos.settings.transfer_export_hint')}
      </p>
      <div className="mt-2">
        <Button
          size="sm"
          variant="secondary"
          icon={<Download size={13} />}
          loading={exporting}
          onClick={() => void runExport()}
        >
          {exporting
            ? t('memos.settings.transfer_exporting')
            : t('memos.settings.transfer_export_button')}
        </Button>
      </div>
      {exportFailure ? (
        <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
            {t('memos.settings.transfer_export_failed')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
            {exportFailure}
          </p>
        </div>
      ) : null}
      <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
        <h4 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('memos.settings.transfer_import')}
        </h4>
        <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('memos.settings.transfer_import_hint')}
        </p>
        {renderImportBody()}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          disabled={busy}
          onChange={onFileChange}
        />
      </div>
    </SettingsCard>
  )
}

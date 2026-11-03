import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { ArrowRight, FolderInput, Trash2 } from 'lucide-react'
import {
  cloudDriveNameProblem,
  normalizeCloudDrivePath,
  type CloudDriveEntry,
} from '@shared/clouddrive/model'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Input, Segmented, commitOnEnter } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { planBatchRename, type BatchRenameMode } from './batch-rename'

function useOpenReset(open: boolean, reset: () => void, inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    if (!open) return
    reset()
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
    // The reset runs when the dialog opens, not on every render of its parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

export function NameDialog({
  open,
  busy,
  onClose,
  onSubmit,
  title = t('clouddrive.dialog.new_folder'),
}: {
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (name: string) => Promise<boolean>
  title?: string
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const errorId = useId()

  useOpenReset(open, () => {
    setName('')
    setError(null)
  }, inputRef)

  const submit = async () => {
    const trimmed = name.trim().normalize('NFC')
    if (cloudDriveNameProblem(trimmed)) {
      setError(t('clouddrive.error.path_invalid'))
      return
    }
    setError(null)
    if (await onSubmit(trimmed)) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={440}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('clouddrive.dialog.cancel')}</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>{t('clouddrive.dialog.create')}</Button>
        </>
      )}
    >
      <label htmlFor={inputId} className="mb-1 block text-[length:var(--text-12)] text-[var(--text-secondary)]">
        {t('clouddrive.dialog.name')}
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => commitOnEnter(event, () => void submit())}
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && <p id={errorId} role="alert" className="mt-2 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
    </Modal>
  )
}

export function RenameDialog({
  open,
  entry,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  entry: CloudDriveEntry | null
  busy: boolean
  onClose: () => void
  onSubmit: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const errorId = useId()

  useOpenReset(open, () => {
    setName(entry?.name ?? '')
    setError(null)
  }, inputRef)

  const submit = async () => {
    if (!entry) return
    const trimmed = name.trim().normalize('NFC')
    if (cloudDriveNameProblem(trimmed)) {
      setError(t('clouddrive.error.path_invalid'))
      return
    }
    if (trimmed === entry.name) {
      onClose()
      return
    }
    setError(null)
    if (await onSubmit(trimmed)) onClose()
  }

  return (
    <Modal
      open={open && entry !== null}
      onClose={onClose}
      title={t('clouddrive.dialog.rename')}
      width={440}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('clouddrive.dialog.cancel')}</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>{t('clouddrive.dialog.save')}</Button>
        </>
      )}
    >
      <label htmlFor={inputId} className="mb-1 block text-[length:var(--text-12)] text-[var(--text-secondary)]">
        {t('clouddrive.dialog.name')}
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => commitOnEnter(event, () => void submit())}
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && <p id={errorId} role="alert" className="mt-2 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
    </Modal>
  )
}

export function MoveDialog({
  open,
  count,
  initialPath,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  count: number
  initialPath: string
  busy: boolean
  onClose: () => void
  onSubmit: (destination: string) => Promise<boolean>
}) {
  const [path, setPath] = useState(initialPath)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()

  useOpenReset(open, () => {
    setPath(initialPath)
    setError(null)
  }, inputRef)

  const submit = async () => {
    let normalized: string
    try {
      normalized = normalizeCloudDrivePath(path.trim(), { allowRoot: true })
    } catch {
      setError(t('clouddrive.error.path_invalid'))
      return
    }
    setError(null)
    if (await onSubmit(normalized)) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('clouddrive.dialog.move')}
      description={t('clouddrive.selection.count', { count })}
      width={480}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('clouddrive.dialog.cancel')}</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>{t('clouddrive.action.move')}</Button>
        </>
      )}
    >
      <label htmlFor={inputId} className="mb-1 block text-[length:var(--text-12)] text-[var(--text-secondary)]">
        {t('clouddrive.dialog.move_path')}
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        leading={<FolderInput size={13} />}
        value={path}
        onChange={(event) => {
          setPath(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => commitOnEnter(event, () => void submit())}
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hintId}
      />
      {error
        ? <p id={errorId} role="alert" className="mt-2 text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>
        : <p id={hintId} className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.dialog.move_hint')}</p>}
    </Modal>
  )
}

export function ConfirmDeleteDialog({
  open,
  count,
  busy,
  external = false,
  onClose,
  onConfirm,
}: {
  open: boolean
  count: number
  busy: boolean
  external?: boolean
  onClose: () => void
  onConfirm: () => Promise<boolean>
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={external ? t('clouddrive.dialog.delete_external_title') : t('clouddrive.dialog.delete_title')}
      width={440}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('clouddrive.dialog.cancel')}</Button>
          <Button
            variant="danger"
            icon={<Trash2 size={13} />}
            loading={busy}
            onClick={() => {
              void onConfirm().then((ok) => {
                if (ok) onClose()
              })
            }}
          >
            {external ? t('clouddrive.dialog.delete_external') : t('clouddrive.dialog.delete')}
          </Button>
        </>
      )}
    >
      <p className="text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">
        {external
          ? t('clouddrive.dialog.delete_external_body', { count })
          : t('clouddrive.dialog.delete_body', { count })}
      </p>
    </Modal>
  )
}

const RENAME_MODES: BatchRenameMode[] = ['prefix', 'suffix', 'replace', 'number']

const RENAME_MODE_KEYS: Record<BatchRenameMode, MessageKey> = {
  prefix: 'clouddrive.rename.mode.prefix',
  suffix: 'clouddrive.rename.mode.suffix',
  replace: 'clouddrive.rename.mode.replace',
  number: 'clouddrive.rename.mode.number',
}

const PROBLEM_KEYS: Record<'invalid' | 'duplicate', MessageKey> = {
  invalid: 'clouddrive.rename.invalid',
  duplicate: 'clouddrive.rename.duplicate',
}

/**
 * Renames the whole selection with one rule and shows every resulting name before anything is sent.
 * The plan is computed from the same two checks the server applies, so a row the drive would refuse
 * is marked here rather than failing as a toast afterwards.
 */
export function BatchRenameDialog({
  open,
  entries,
  staying,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  entries: readonly CloudDriveEntry[]
  /** The rest of the folder, so a new name colliding with a row that stays put is visible. */
  staying: readonly CloudDriveEntry[]
  busy: boolean
  onClose: () => void
  onSubmit: (items: { id: string; name: string }[]) => Promise<boolean>
}) {
  const [mode, setMode] = useState<BatchRenameMode>('prefix')
  const [value, setValue] = useState('')
  const [find, setFind] = useState('')
  const [start, setStart] = useState(1)
  const valueRef = useRef<HTMLInputElement>(null)

  useOpenReset(open, () => {
    setMode('prefix')
    setValue('')
    setFind('')
    setStart(1)
  }, valueRef)

  const plan = useMemo(
    () => planBatchRename(entries, staying, { mode, value, find, start }),
    [entries, staying, mode, value, find, start],
  )
  const problems = plan.filter((item) => item.problem !== null)
  const changed = plan.filter((item) => item.name !== item.from)
  const preview = plan.slice(0, 12)

  const submit = async () => {
    if (problems.length > 0 || changed.length === 0) return
    if (await onSubmit(changed.map((item) => ({ id: item.id, name: item.name })))) onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('clouddrive.dialog.batch_rename', { count: entries.length })}
      width={560}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('clouddrive.dialog.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={problems.length > 0 || changed.length === 0}
            onClick={() => void submit()}
          >
            {t('clouddrive.rename.apply', { count: changed.length })}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Segmented
          label={t('clouddrive.rename.mode')}
          value={mode}
          onChange={setMode}
          options={RENAME_MODES.map((one) => ({ value: one, label: t(RENAME_MODE_KEYS[one]) }))}
        />
        {mode === 'replace' && (
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.rename.find')}</span>
            <Input ref={valueRef} value={find} onChange={(event) => setFind(event.target.value)} disabled={busy} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {mode === 'replace' ? t('clouddrive.rename.replace_with') : mode === 'number' ? t('clouddrive.rename.base') : t('clouddrive.rename.value')}
          </span>
          <Input
            ref={mode === 'replace' ? undefined : valueRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
          />
        </label>
        {mode === 'number' && (
          <label className="flex w-[140px] flex-col gap-1">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.rename.start')}</span>
            <Input
              type="number"
              min={0}
              value={String(start)}
              onChange={(event) => setStart(Math.max(0, Math.round(Number(event.target.value) || 0)))}
              disabled={busy}
            />
          </label>
        )}
        <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0 text-[length:var(--text-12)]">
          {preview.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-wrap items-baseline gap-1.5">
              <span className="min-w-0 truncate text-[var(--text-tertiary)] line-through">{item.from}</span>
              <ArrowRight size={12} aria-hidden className="shrink-0 text-[var(--text-quaternary)]" />
              <span className={`min-w-0 truncate ${item.problem ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'}`}>{item.name}</span>
              {item.problem && <span className="shrink-0 text-[length:var(--text-11)] text-[var(--danger)]">{t(PROBLEM_KEYS[item.problem])}</span>}
            </li>
          ))}
          {plan.length > preview.length && (
            <li className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.rename.more', { count: plan.length - preview.length })}</li>
          )}
        </ul>
      </div>
    </Modal>
  )
}

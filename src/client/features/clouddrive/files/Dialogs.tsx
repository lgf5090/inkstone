import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { FolderInput, Trash2 } from 'lucide-react'
import {
  cloudDriveNameProblem,
  normalizeCloudDrivePath,
  type CloudDriveEntry,
} from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Input, commitOnEnter } from '../../../components/form'
import { Modal } from '../../../components/overlay'

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

export function NewFolderDialog({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
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
      title={t('clouddrive.dialog.new_folder')}
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
  onClose,
  onConfirm,
}: {
  open: boolean
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: () => Promise<boolean>
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('clouddrive.dialog.delete_title')}
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
            {t('clouddrive.dialog.delete')}
          </Button>
        </>
      )}
    >
      <p className="text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">
        {t('clouddrive.dialog.delete_body', { count })}
      </p>
    </Modal>
  )
}

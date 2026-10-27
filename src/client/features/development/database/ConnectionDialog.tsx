import { useEffect, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import type { D1DatabaseInfo, DatabaseConnectionView } from '@shared/development/database/types'
import { Button } from '../../../components/primitives'
import { Field, Input, Segmented } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { t } from '../../../lib/i18n'
import { createConnection, describeError, listD1Databases, testConnection, updateConnection } from './api'
import { isLocalSqliteFileName, MAX_LOCAL_SQLITE_FILE_BYTES } from './drivers'

type ConnectionType = 'd1' | 'turso' | 'sqlite'

interface ConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: DatabaseConnectionView | null
  onSaved: (connection: DatabaseConnectionView) => void
  onLocalFile: (file: File) => void
  onError: (message: string) => void
}

export function ConnectionDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
  onLocalFile,
  onError,
}: ConnectionDialogProps) {
  const [type, setType] = useState<ConnectionType>('d1')
  const [name, setName] = useState('')
  const [d1AccountId, setD1AccountId] = useState('')
  const [d1Token, setD1Token] = useState('')
  const [databases, setDatabases] = useState<D1DatabaseInfo[]>([])
  const [d1DatabaseId, setD1DatabaseId] = useState('')
  const [d1Loading, setD1Loading] = useState(false)
  const [tursoUrl, setTursoUrl] = useState('')
  const [tursoToken, setTursoToken] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const isEdit = Boolean(editing)

  useEffect(() => {
    if (!open) return
    setType((editing?.type as ConnectionType | undefined) ?? 'd1')
    setName(editing?.name ?? '')
    setD1AccountId(editing?.d1AccountId ?? '')
    setD1Token('')
    setDatabases([])
    setD1DatabaseId(editing?.d1DatabaseId ?? '')
    setTursoUrl(editing?.tursoUrl ?? '')
    setTursoToken('')
    setFile(null)
    setTestResult(null)
  }, [open, editing])

  useEffect(() => {
    setTestResult(null)
  }, [d1AccountId, d1DatabaseId, d1Token, tursoUrl, tursoToken, type])

  const loadDatabases = async () => {
    const sameSavedAccount = Boolean(editing) && d1AccountId.trim() === editing?.d1AccountId.trim()
    const useSavedSecret = sameSavedAccount && !d1Token.trim()
    if (!useSavedSecret && (!d1AccountId.trim() || !d1Token.trim())) {
      onError(t('development.database.conn.account_token_required'))
      return
    }
    setD1Loading(true)
    try {
      const list = await listD1Databases(
        editing && useSavedSecret
          ? { connectionId: editing.id }
          : { accountId: d1AccountId.trim(), apiToken: d1Token.trim() },
      )
      setDatabases(list)
      if (list.length > 0 && !list.some((database) => database.uuid === d1DatabaseId)) {
        setD1DatabaseId(list[0]!.uuid)
      }
      if (list.length === 0) onError(t('development.database.conn.no_databases'))
    } catch (error) {
      onError(describeError(error))
    } finally {
      setD1Loading(false)
    }
  }

  const submit = async () => {
    if (type === 'sqlite') {
      if (!file) {
        onError(t('development.database.conn.file_required'))
        return
      }
      onLocalFile(file)
      onOpenChange(false)
      return
    }
    if (!name.trim()) {
      onError(t('development.database.conn.name_required'))
      return
    }
    setSubmitting(true)
    try {
      if (type === 'd1') {
        const database = databases.find((entry) => entry.uuid === d1DatabaseId)
        if (!isEdit && !d1Token.trim()) {
          onError(t('development.database.conn.token_required'))
          return
        }
        const payload = {
          name: name.trim(),
          d1AccountId: d1AccountId.trim(),
          d1DatabaseId,
          d1DatabaseName: database?.name ?? editing?.d1DatabaseName ?? '',
        }
        const saved = editing
          ? await updateConnection(editing.id, {
              ...payload,
              ...(d1Token.trim() ? { secret: d1Token.trim() } : {}),
            })
          : await createConnection({ ...payload, type: 'd1', secret: d1Token.trim() })
        onSaved(saved)
      } else {
        if (!tursoUrl.trim()) {
          onError(t('development.database.conn.url_required'))
          return
        }
        if ((!isEdit || urlChanged) && !tursoToken.trim()) {
          onError(t('development.database.conn.token_required'))
          return
        }
        const saved = editing
          ? await updateConnection(editing.id, {
              name: name.trim(),
              tursoUrl: tursoUrl.trim(),
              ...(tursoToken.trim() ? { secret: tursoToken.trim() } : {}),
            })
          : await createConnection({
              type: 'turso',
              name: name.trim(),
              tursoUrl: tursoUrl.trim(),
              secret: tursoToken.trim(),
            })
        onSaved(saved)
      }
      onOpenChange(false)
    } catch (error) {
      onError(describeError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = type === 'd1'
        ? await testConnection({
            type: 'd1',
            ...(editing ? { connectionId: editing.id } : {}),
            d1AccountId: d1AccountId.trim(),
            d1DatabaseId,
            ...(d1Token.trim() ? { secret: d1Token.trim() } : {}),
          })
        : await testConnection({
            type: 'turso',
            ...(editing ? { connectionId: editing.id } : {}),
            tursoUrl: tursoUrl.trim(),
            ...(tursoToken.trim() ? { secret: tursoToken.trim() } : {}),
          })
      setTestResult({ ok: true, text: t('development.database.conn.test_ok', { ms: result.latencyMs }) })
    } catch (error) {
      setTestResult({ ok: false, text: t('development.database.conn.test_failed', { message: describeError(error) }) })
    } finally {
      setTesting(false)
    }
  }

  const chooseFile = (next: File | null) => {
    if (!next) {
      setFile(null)
      return
    }
    if (!isLocalSqliteFileName(next.name)) {
      onError(t('development.database.conn.file_type_invalid'))
      return
    }
    if (next.size > MAX_LOCAL_SQLITE_FILE_BYTES) {
      onError(t('development.database.conn.file_too_large'))
      return
    }
    setFile(next)
  }

  const databaseOptions = databases.length > 0
    ? databases.map((database) => ({ value: database.uuid, label: database.name }))
    : editing?.d1DatabaseId && d1DatabaseId === editing.d1DatabaseId
      ? [{ value: editing.d1DatabaseId, label: editing.d1DatabaseName || editing.d1DatabaseId }]
      : []
  const accountChanged = Boolean(editing) && d1AccountId.trim() !== editing?.d1AccountId.trim()
  const urlChanged = Boolean(editing) && tursoUrl.trim() !== editing?.tursoUrl.trim()
  const canSubmit = (type === 'sqlite' || Boolean(name.trim())) && (type === 'sqlite'
    ? Boolean(file)
    : type === 'd1'
      ? Boolean(d1AccountId.trim() && d1DatabaseId && (!isEdit || !accountChanged || d1Token.trim()))
      : Boolean(tursoUrl.trim() && ((isEdit && !urlChanged) || tursoToken.trim())))

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title={isEdit ? t('development.database.conn.edit_title') : t('development.database.conn.new_title')}
      description={t('development.database.conn.description')}
      width={520}
      footer={
        <>
          {type !== 'sqlite' && (
            <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={!canSubmit || submitting || testing}>
              {testing && <Loader2 size={14} className="animate-spin" />}
              {t('development.database.conn.test')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('development.database.conn.cancel')}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit || submitting}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? t('development.database.conn.save') : t('development.database.conn.connect')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={type}
          onChange={(next) => {
            if (!isEdit) setType(next)
          }}
          label={t('development.database.conn.type')}
          options={[
            { value: 'd1', label: t('development.database.conn.type_d1') },
            { value: 'turso', label: t('development.database.conn.type_turso') },
            { value: 'sqlite', label: t('development.database.conn.type_sqlite') },
          ]}
          disabled={isEdit}
        />

        {type !== 'sqlite' && (
          <Field label={t('development.database.conn.name')} required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('development.database.conn.name_placeholder')}
              autoFocus
            />
          </Field>
        )}

        {type === 'd1' && (
          <>
            <Field label={t('development.database.conn.account_id')} hint={t('development.database.conn.account_hint')} required>
              <Input
                value={d1AccountId}
                onChange={(event) => {
                  const next = event.target.value
                  setD1AccountId(next)
                  if (editing && next.trim() !== editing.d1AccountId.trim()) {
                    setDatabases([])
                    setD1DatabaseId('')
                  }
                }}
                placeholder={t('development.database.conn.account_placeholder')}
                spellCheck={false}
              />
            </Field>
            <Field
              label={t('development.database.conn.api_token')}
              hint={accountChanged
                ? t('development.database.conn.token_account_changed')
                : isEdit ? t('development.database.conn.token_keep') : t('development.database.conn.token_hint')}
              required={!isEdit}
            >
              <Input
                type="password"
                value={d1Token}
                onChange={(event) => setD1Token(event.target.value)}
                placeholder={isEdit ? t('development.database.conn.token_keep_placeholder') : ''}
                spellCheck={false}
              />
            </Field>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label={t('development.database.conn.d1_database')}>
                  <SelectMenu
                    label={t('development.database.conn.d1_database')}
                    value={d1DatabaseId}
                    options={databaseOptions}
                    onChange={setD1DatabaseId}
                    placeholder={t('development.database.conn.select_database')}
                    disabled={d1Loading || databaseOptions.length === 0}
                  />
                </Field>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void loadDatabases()} disabled={d1Loading}>
                {d1Loading ? <Loader2 size={14} className="animate-spin" /> : null}
                {t('development.database.conn.load_databases')}
              </Button>
            </div>
          </>
        )}

        {type === 'turso' && (
          <>
            <Field label={t('development.database.conn.turso_url')} required>
              <Input
                value={tursoUrl}
                onChange={(event) => setTursoUrl(event.target.value)}
                placeholder={t('development.database.conn.turso_url_placeholder')}
                spellCheck={false}
              />
            </Field>
            <Field
              label={t('development.database.conn.api_token')}
              hint={urlChanged
                ? t('development.database.conn.token_url_changed')
                : isEdit ? t('development.database.conn.token_keep') : t('development.database.conn.token_hint')}
              required={urlChanged || !isEdit}
            >
              <Input
                type="password"
                value={tursoToken}
                onChange={(event) => setTursoToken(event.target.value)}
                placeholder={isEdit && !urlChanged ? t('development.database.conn.token_keep_placeholder') : ''}
                spellCheck={false}
              />
            </Field>
          </>
        )}

        {type === 'sqlite' && (
          <Field label={t('development.database.conn.sqlite_file')} hint={t('development.database.conn.sqlite_hint')}>
            <label className="flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] px-3 py-3 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
              <Upload size={18} />
              {file ? file.name : t('development.database.conn.choose_file')}
              <input
                type="file"
                className="hidden"
                accept=".db,.sqlite,.sqlite3,.db3"
                onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </Field>
        )}
        {type !== 'sqlite' && testResult && (
          <p
            role={testResult.ok ? 'status' : 'alert'}
            className={`rounded-[var(--r-md)] border p-2 text-[length:var(--text-11)] leading-relaxed ${
              testResult.ok
                ? 'border-[var(--success)]/30 bg-[var(--success-soft)] text-[var(--success)]'
                : 'border-[var(--danger)]/30 bg-[var(--danger-soft)] text-[var(--danger)]'
            }`}
          >
            {testResult.text}
          </p>
        )}
      </div>
    </Modal>
  )
}

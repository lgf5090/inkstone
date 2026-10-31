import { useEffect, useState } from 'react'
import { Download, Eye, EyeOff, FileCode, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import type { GistFile, GistItem, GithubAccountView } from '@shared/development/github/types'
import { MAX_GIST_TOTAL_CONTENT_BYTES } from '@shared/development/github/limits'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { githubApi } from '../api'
import { extractGistId } from '../lib/format'
import { addGistFile, gistFileIssueKey, GistFileError, normalizeGistFiles, removeGistFile, updateGistFile } from '../lib/gist-files'
import { Button, IconButton } from '../../../../components/primitives'
import { Input, Switch, Textarea } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'

export function GistImportDialog({ open, onClose, onImport }: { open: boolean; onClose: () => void; onImport: (gist: GistItem) => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const importGist = async () => {
    const id = extractGistId(url)
    if (!id) {
      setError(t('development.github.gists.invalid_url'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const gist = await githubApi.gistDetail(id)
      onImport(gist)
      setUrl('')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('development.github.common.load_failed'))
    } finally {
      setLoading(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={<span className="inline-flex items-center gap-2"><Download size={15} />{t('development.github.gists.import_title')}</span>} description={t('development.github.gists.import_desc')} width={520} footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>{t('common.cancel')}</Button><Button onClick={() => void importGist()} disabled={loading || !url.trim()} loading={loading}><Download size={13} />{loading ? t('development.github.gists.importing') : t('development.github.gists.import')}</Button></>}>
      <div className="space-y-2">
        <Input value={url} onChange={(event) => { setUrl(event.target.value); setError(null) }} placeholder="https://gist.github.com/user/abc123" onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter' && url.trim() && !loading) { event.preventDefault(); void importGist() } }} autoFocus />
        {error && <p className="text-[length:var(--text-11)] text-[var(--danger)]" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

export function GistCreateDialog({ open, onClose, onCreate, accountCount, accounts, activeAccountId, onOpenAccounts }: { open: boolean; onClose: () => void; onCreate: (gist: GistItem) => void; accountCount: number; accounts: GithubAccountView[]; activeAccountId: string | null; onOpenAccounts: () => void }) {
  const [description, setDescription] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [accountId, setAccountId] = useState(activeAccountId ?? accounts[0]?.id ?? '')
  const [files, setFiles] = useState<GistFile[]>([{ filename: 'snippet.txt', language: 'Text', content: '', size: 0 }])
  useEffect(() => {
    if (open) setAccountId(activeAccountId ?? accounts[0]?.id ?? '')
  }, [open, activeAccountId, accounts])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const issueMessage = (issue: GistFileError): string =>
    t(gistFileIssueKey(issue.issue), { limit: Math.round(MAX_GIST_TOTAL_CONTENT_BYTES / 1024) })
  const updateFile = (index: number, patch: Partial<Pick<GistFile, 'filename' | 'content'>>) => {
    setFiles((previous) => updateGistFile(previous, index, patch))
  }
  const addFile = () => {
    try {
      setFiles(addGistFile(files))
    } catch (cause) {
      if (cause instanceof GistFileError) setError(issueMessage(cause))
    }
  }
  const removeFile = (index: number) => setFiles(removeGistFile(files, index))
  const create = async () => {
    const drafts = files.filter((file) => file.filename.trim() && file.content.trim())
    if (drafts.length === 0) return
    let normalized: GistFile[]
    try {
      normalized = normalizeGistFiles(drafts)
    } catch (cause) {
      if (cause instanceof GistFileError) setError(issueMessage(cause))
      else setError(t('development.github.gists.create_failed'))
      return
    }
    if (accountCount === 0) {
      setError(t('development.github.gists.token_required'))
      return
    }
    setPending(true)
    setError(null)
    try {
      const gist = await githubApi.createRemoteGist({ description: description.trim(), isPublic, files: normalized }, accountId || undefined)
      onCreate(gist)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('development.github.gists.create_failed'))
    } finally {
      setPending(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={<span className="inline-flex items-center gap-2"><Plus size={15} />{t('development.github.gists.create_title')}</span>} description={t('development.github.gists.create_desc')} width={720} footer={<><Button variant="secondary" onClick={onClose} disabled={pending}>{t('common.cancel')}</Button><Button onClick={() => void create()} disabled={pending || accountCount === 0 || !files.some((file) => file.filename.trim() && file.content.trim())} loading={pending}><Plus size={13} />{pending ? t('development.github.gists.creating') : t('development.github.gists.create_to_github')}</Button></>}>
      <div className="space-y-3">
        {accountCount === 0 && <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] p-2.5 text-[length:var(--text-11)]"><ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--warning)]" /><div className="min-w-0 flex-1"><p className="font-medium text-[var(--warning)]">{t('development.github.gists.token_missing')}</p><p className="mt-0.5 text-[var(--text-tertiary)]">{t('development.github.gists.token_missing_desc')}</p></div><Button variant="secondary" size="sm" onClick={onOpenAccounts}><KeyRound size={12} />{t('development.github.accounts.configure')}</Button></div>}
        {accounts.length > 1 && <SelectMenu value={accountId} options={accounts.map((account) => ({ value: account.id, label: account.username }))} onChange={setAccountId} label={t('development.github.gists.account')} searchable />}
        <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t('development.github.gists.description_placeholder')} />
        <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
          <div className="flex items-center gap-2">{isPublic ? <Eye size={13} className="text-[var(--success)]" /> : <EyeOff size={13} className="text-[var(--text-tertiary)]" />}<div><p className="text-[length:var(--text-12)] font-medium">{isPublic ? t('development.github.gists.public') : t('development.github.gists.secret')}</p><p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{isPublic ? t('development.github.gists.public_desc') : t('development.github.gists.secret_desc')}</p></div></div>
          <Switch checked={isPublic} onChange={setIsPublic} label={t('development.github.gists.public')} />
        </div>
        <div className="flex items-center justify-between"><span className="text-[length:var(--text-12)] font-medium">{t('development.github.gists.files')} ({files.length})</span><Button variant="secondary" size="sm" onClick={addFile}><Plus size={12} />{t('development.github.gists.add_file')}</Button></div>
        <div className="space-y-2">
          {files.map((file, index) => <div key={index} className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2"><div className="flex items-center gap-2"><FileCode size={13} className="shrink-0 text-[var(--text-tertiary)]" /><Input value={file.filename} onChange={(event) => updateFile(index, { filename: event.target.value })} placeholder={t('development.github.gists.filename_placeholder')} className="h-7 flex-1 text-[length:var(--text-11)]" /><span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{file.language}</span><IconButton label={t('common.delete')} size="sm" onClick={() => removeFile(index)} disabled={files.length <= 1}><Trash2 size={12} /></IconButton></div><Textarea value={file.content} onChange={(event) => updateFile(index, { content: event.target.value })} placeholder={t('development.github.gists.content_placeholder')} className="min-h-20 font-mono text-[length:var(--text-11)]" /></div>)}
        </div>
        {error && <p className="text-[length:var(--text-11)] text-[var(--danger)]" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

/**
 * The publish card beside a snippet.
 *
 * A publication is one file at one path, and the card says the whole contract: status, visibility,
 * expiry, the `curl` a reader can run, the short address when one exists, and the token exactly once
 * when it is minted. Nothing here is a decoration — every switch writes the row the public route
 * reads.
 */
import { useState } from 'react'
import { Copy, ExternalLink, KeyRound, Link2, Radio, Trash2, Upload } from 'lucide-react'
import { publicationDetailPath, publicationUrlPath, publicationPathProblem } from '@shared/scriptshub/path'
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/clipboard'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Input, Switch } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { SelectMenu } from '../../components/select-menu'
import { Modal, confirm } from '../../components/overlay'
import { CopyButton } from '../../components/copy-button'
import { useUi } from '../../store/ui'
import { useScriptsHub } from './store'
import { scriptshubApi } from './api'
import { LanguageIcon } from './language-icon'
import type { ScriptSnippetDetail } from '@shared/scriptshub/types'

function slugify(text: string): string {
  const value = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return value || 'script'
}

function defaultPath(detail: ScriptSnippetDetail, folders: Array<{ id: string; name: string; parentId: string | null }>, fileId: string): string {
  const file = detail.files.find((entry) => entry.id === fileId) ?? detail.files[0]
  if (!file) return 'scripts/script.txt'
  const parts: string[] = []
  let cursor = detail.folderId
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  while (cursor) {
    const folder = byId.get(cursor)
    if (!folder) break
    parts.unshift(slugify(folder.name))
    cursor = folder.parentId
  }
  if (!parts.length) parts.push('scripts')
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : 'txt'
  return `${parts.join('/')}/${slugify(file.name.replace(/\\.[^.]+$/, ''))}.${extension}`
}

function commandFor(path: string, fileName: string, language: string): string {
  const url = `${window.location.origin}${publicationUrlPath(path)}`
  return language === 'shell'
    ? `curl -fsSL ${url} | bash`
    : `curl -fsSL ${url} -o ${fileName}`
}

export function PublishPanel({ detail }: { detail: ScriptSnippetDetail }) {
  const toast = useUi((state) => state.toast)
  const folders = useScriptsHub((state) => state.overview?.folders) ?? []
  const publish = useScriptsHub((state) => state.publish)
  const updatePublication = useScriptsHub((state) => state.updatePublication)
  const deletePublication = useScriptsHub((state) => state.deletePublication)
  const [open, setOpen] = useState(false)
  const [fileId, setFileId] = useState(detail.files[0]?.id ?? '')
  const [path, setPath] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'token'>('public')
  const [expiresOn, setExpiresOn] = useState('')
  const [shortlink, setShortlink] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mintedToken, setMintedToken] = useState<string | null>(null)
  const publication = detail.publication
  const activeFile = detail.files.find((file) => file.id === publication?.fileId) ?? detail.files[0]

  const openDialog = () => {
    const firstFile = detail.files[0]?.id ?? ''
    setFileId(firstFile)
    setPath(defaultPath(detail, folders, firstFile))
    setVisibility('public')
    setExpiresOn('')
    setShortlink(true)
    setError(null)
    setMintedToken(null)
    setOpen(true)
  }

  const runPublish = async () => {
    const problem = publicationPathProblem(path)
    if (problem) {
      setError(t('scriptshub.publish.path_invalid', { reason: problem }))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await publish(detail.id, {
        fileId,
        path,
        visibility,
        expiresAt: expiresOn ? Date.parse(`${expiresOn}T23:59:59`) : null,
        createShortlink: visibility === 'public' && shortlink,
      })
      setMintedToken(created.token ?? null)
      setOpen(false)
      toast({ title: t('scriptshub.publish.created'), tone: 'success' })
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError))
    } finally {
      setSaving(false)
    }
  }

  const copyCommand = async () => {
    if (!publication) return
    const ok = await copyText(commandFor(publication.path, activeFile?.name ?? 'script', activeFile?.language ?? detail.language))
    toast({ title: ok ? t('scriptshub.publish.command_copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  const toggleEnabled = async (next: boolean) => {
    if (!publication) return
    await updatePublication(publication.id, { isEnabled: next })
  }

  const rotate = async () => {
    if (!publication) return
    const agreed = await confirm({
      title: t('scriptshub.publish.rotate_title'),
      description: t('scriptshub.publish.rotate_body'),
      confirmLabel: t('scriptshub.publish.rotate'),
    })
    if (!agreed) return
    try {
      const result = await scriptshubApi.rotateToken(publication.id)
      await useScriptsHub.getState().select(detail.id)
      setMintedToken(result.token)
      toast({ title: t('scriptshub.publish.rotated'), tone: 'success' })
    } catch (rotateError) {
      toast({ title: t('scriptshub.publish.failed'), description: rotateError instanceof Error ? rotateError.message : String(rotateError), tone: 'danger' })
    }
  }

  const unpublish = async () => {
    if (!publication) return
    const agreed = await confirm({
      title: t('scriptshub.publish.unpublish_title'),
      description: t('scriptshub.publish.unpublish_body'),
      confirmLabel: t('scriptshub.publish.unpublish'),
      tone: 'danger',
    })
    if (agreed) await deletePublication(publication.id)
  }

  return (
    <>
      <section aria-labelledby="scriptshub-publish-heading" className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3">
        <div className="flex items-center gap-2">
          <Radio size={13} aria-hidden="true" className="text-[var(--accent)]" />
          <h2 id="scriptshub-publish-heading" className="min-w-0 flex-1 text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">
            {t('scriptshub.publish.title')}
          </h2>
          {publication && (
            <Switch
              checked={publication.isEnabled}
              label={t('scriptshub.publish.enabled')}
              onChange={(next) => void toggleEnabled(next)}
            />
          )}
        </div>
        {!publication ? (
          <div className="mt-2.5 space-y-2">
            <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{t('scriptshub.publish.empty')}</p>
            <Button size="sm" variant="primary" block icon={<Upload size={12} aria-hidden="true" />} onClick={openDialog}>
              {t('scriptshub.publish.publish')}
            </Button>
          </div>
        ) : (
          <div className="mt-2.5 space-y-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={publication.isEnabled ? 'success' : 'neutral'}>
                {publication.isEnabled ? t('scriptshub.publish.active') : t('scriptshub.publish.paused')}
              </Badge>
              <Badge tone={publication.visibility === 'token' ? 'warning' : 'accent'}>
                {publication.visibility === 'token' ? t('scriptshub.publish.token') : t('scriptshub.publish.public')}
              </Badge>
              {publication.expiresAt && (
                <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                  {t('scriptshub.publish.expires', { date: new Date(publication.expiresAt).toISOString().slice(0, 10) })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                /{publication.path}
              </code>
              <CopyButton text={`${window.location.origin}${publicationUrlPath(publication.path)}`} label={t('scriptshub.publish.copy_url')} className="size-7" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" icon={<Copy size={12} aria-hidden="true" />} onClick={() => void copyCommand()}>
                {t('scriptshub.publish.copy_command')}
              </Button>
              <Button size="sm" variant="ghost" icon={<ExternalLink size={12} aria-hidden="true" />} onClick={() => window.open(publicationDetailPath(publication.id), '_blank', 'noopener')}>
                {t('scriptshub.publish.open_page')}
              </Button>
              {publication.visibility === 'token' && (
                <Button size="sm" variant="ghost" icon={<KeyRound size={12} aria-hidden="true" />} onClick={() => void rotate()}>
                  {t('scriptshub.publish.rotate')}
                </Button>
              )}
              <IconButton label={t('scriptshub.publish.unpublish')} size="sm" onClick={() => void unpublish()} className="text-[var(--danger)]">
                <Trash2 size={12} aria-hidden="true" />
              </IconButton>
            </div>
            {publication.shortSlug && (
              <div className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                <Link2 size={11} aria-hidden="true" />
                <a href={`/l/${publication.shortSlug}`} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[var(--accent)] hover:underline">
                  {`${window.location.origin}/l/${publication.shortSlug}`}
                </a>
                <CopyButton text={`${window.location.origin}/l/${publication.shortSlug}`} label={t('scriptshub.publish.copy_short')} className="size-6" />
              </div>
            )}
            {mintedToken && (
              <div className="space-y-1.5 rounded-[var(--r-sm)] border border-[var(--warning)]/40 bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] p-2">
                <p className="text-[length:var(--text-10-5)] font-medium text-[var(--warning)]">{t('scriptshub.publish.token_once')}</p>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-10-5)]">{mintedToken}</code>
                  <CopyButton text={mintedToken} label={t('scriptshub.publish.copy_token')} className="size-6" />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('scriptshub.publish.dialog_title')}
        description={t('scriptshub.publish.dialog_body')}
        width={520}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('scriptshub.common.cancel')}</Button>
            <Button variant="primary" loading={saving} onClick={() => void runPublish()}>{t('scriptshub.publish.publish')}</Button>
          </>
        )}
      >
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.publish.file')}</span>
            <SelectMenu
              label={t('scriptshub.publish.file')}
              value={fileId}
              onChange={(next) => {
                setFileId(next)
                setPath(defaultPath(detail, folders, next))
              }}
              options={detail.files.map((file) => ({
                value: file.id,
                label: file.name,
                icon: <LanguageIcon id={file.language} size={14} />,
              }))}
              width={260}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.publish.path')}</span>
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t('scriptshub.publish.path_placeholder')}
              aria-describedby="scriptshub-publish-path-hint"
            />
            <span id="scriptshub-publish-path-hint" className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.publish.path_hint')}</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.publish.visibility')}</span>
              <SelectMenu
                label={t('scriptshub.publish.visibility')}
                value={visibility}
                onChange={setVisibility}
                options={[
                  { value: 'public', label: t('scriptshub.publish.public') },
                  { value: 'token', label: t('scriptshub.publish.token') },
                ]}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.publish.expires_label')}</span>
              <DatePicker
                label={t('scriptshub.publish.expires_label')}
                value={expiresOn}
                placeholder={t('scriptshub.publish.no_expiry')}
                onChange={setExpiresOn}
              />
            </label>
          </div>
          <label className="flex items-start gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
            <Switch checked={visibility === 'public' && shortlink} disabled={visibility === 'token'} label={t('scriptshub.publish.shortlink')} onChange={setShortlink} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('scriptshub.publish.shortlink')}</span>
              <span className="block text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                {visibility === 'token' ? t('scriptshub.publish.shortlink_token') : t('scriptshub.publish.shortlink_hint')}
              </span>
            </span>
          </label>
          <div className="rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2.5 font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {commandFor(path, activeFile?.name ?? 'script', activeFile?.language ?? detail.language)}
          </div>
          {error && <p className="text-[length:var(--text-12)] text-[var(--danger)]" role="alert">{error}</p>}
        </div>
      </Modal>
    </>
  )
}

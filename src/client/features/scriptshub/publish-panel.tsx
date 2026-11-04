/**
 * The distribution cards beside a snippet.
 *
 * A publication belongs to one file: two files in the same snippet can sit at two unrelated paths,
 * with their own tokens, pauses and expiries. The card lists every file, says which are serving,
 * and opens one editor per file so a reader never has to guess which file a path belongs to.
 */
import { useState } from 'react'
import { Copy, ExternalLink, KeyRound, Link2, Pencil, Radio, Trash2, Upload } from 'lucide-react'
import { publicationDetailPath, publicationUrlPath, publicationPathProblem } from '@shared/scriptshub/path'
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/clipboard'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Input, Switch } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { SelectMenu } from '../../components/select-menu'
import { Modal, Tooltip, confirm } from '../../components/overlay'
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
  const folderPath = parts.join('/')
  const snippetSlug = slugify(detail.title)
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : 'txt'
  return `${folderPath}/${snippetSlug}-${slugify(file.name.replace(/\.[^.]+$/, ''))}.${extension}`
}

function commandFor(path: string, fileName: string, language: string): string {
  const url = `${window.location.origin}${publicationUrlPath(path)}`
  return language === 'shell'
    ? `curl -fsSL ${url} | bash`
    : `curl -fsSL ${url} -o ${fileName}`
}

export function PublishPanel({ detail, activeFileId }: {
  detail: ScriptSnippetDetail
  activeFileId?: string | null
}) {
  const toast = useUi((state) => state.toast)
  const folders = useScriptsHub((state) => state.overview?.folders) ?? []
  const publish = useScriptsHub((state) => state.publish)
  const updatePublication = useScriptsHub((state) => state.updatePublication)
  const deletePublication = useScriptsHub((state) => state.deletePublication)
  const [open, setOpen] = useState(false)
  const [fileId, setFileId] = useState('')
  const [path, setPath] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'token'>('public')
  const [expiresOn, setExpiresOn] = useState('')
  const [shortlink, setShortlink] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [minted, setMinted] = useState<Record<string, string>>({})
  const editing = detail.publications.find((entry) => entry.fileId === fileId)

  const openCreate = (target: string) => {
    setFileId(target)
    setPath(defaultPath(detail, folders, target))
    setVisibility('public')
    setExpiresOn('')
    setShortlink(true)
    setError(null)
    setOpen(true)
  }

  const openEdit = (publication: NonNullable<ScriptSnippetDetail['publications'][number]>) => {
    setFileId(publication.fileId)
    setPath(publication.path)
    setVisibility(publication.visibility)
    setExpiresOn(publication.expiresAt ? new Date(publication.expiresAt).toISOString().slice(0, 10) : '')
    setShortlink(Boolean(publication.shortSlug))
    setError(null)
    setOpen(true)
  }

  const runSave = async () => {
    const problem = publicationPathProblem(path)
    if (problem) {
      setError(t('scriptshub.publish.path_invalid', { reason: problem }))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (editing) {
        await updatePublication(editing.id, {
          path,
          visibility,
          expiresAt: expiresOn ? Date.parse(`${expiresOn}T23:59:59`) : null,
        })
        toast({ title: t('scriptshub.publish.updated'), tone: 'success' })
      } else {
        const created = await publish(detail.id, {
          fileId,
          path,
          visibility,
          expiresAt: expiresOn ? Date.parse(`${expiresOn}T23:59:59`) : null,
          createShortlink: visibility === 'public' && shortlink,
        })
        if (created.token) setMinted((current) => ({ ...current, [created.id]: created.token! }))
        toast({ title: t('scriptshub.publish.created'), tone: 'success' })
      }
      setOpen(false)
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError))
    } finally {
      setSaving(false)
    }
  }

  const copyCommand = async (publication: NonNullable<ScriptSnippetDetail['publications'][number]>) => {
    const file = detail.files.find((entry) => entry.id === publication.fileId)
    const ok = await copyText(commandFor(publication.path, file?.name ?? 'script', file?.language ?? detail.language))
    toast({ title: ok ? t('scriptshub.publish.command_copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  const toggleEnabled = async (publication: NonNullable<ScriptSnippetDetail['publications'][number]>, next: boolean) => {
    await updatePublication(publication.id, { isEnabled: next })
  }

  const rotate = async (publication: NonNullable<ScriptSnippetDetail['publications'][number]>) => {
    const agreed = await confirm({
      title: t('scriptshub.publish.rotate_title'),
      description: t('scriptshub.publish.rotate_body'),
      confirmLabel: t('scriptshub.publish.rotate'),
    })
    if (!agreed) return
    try {
      const result = await scriptshubApi.rotateToken(publication.id)
      await useScriptsHub.getState().select(detail.id)
      setMinted((current) => ({ ...current, [publication.id]: result.token }))
      toast({ title: t('scriptshub.publish.rotated'), tone: 'success' })
    } catch (rotateError) {
      toast({ title: t('scriptshub.publish.failed'), description: rotateError instanceof Error ? rotateError.message : String(rotateError), tone: 'danger' })
    }
  }

  const unpublish = async (publication: NonNullable<ScriptSnippetDetail['publications'][number]>) => {
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
          <span className="shrink-0 tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {t('scriptshub.publish.published_count', { published: detail.publications.length, total: detail.files.length })}
          </span>
        </div>

        <div className="mt-2.5 space-y-2">
          {detail.files.map((file) => {
            const publication = detail.publications.find((entry) => entry.fileId === file.id)
            const fileMinted = publication ? minted[publication.id] : undefined
            return (
              <div
                key={file.id}
                data-publish-file={file.id}
                className={file.id === activeFileId ? 'rounded-[var(--r-sm)] bg-[var(--bg-hover)] p-1.5 -m-1.5' : 'p-1.5 -m-1.5'}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <LanguageIcon id={file.language} size={12} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{file.name}</span>
                  {publication ? (
                    <>
                      <Badge tone={publication.isEnabled ? 'success' : 'neutral'} className="shrink-0">
                        {publication.isEnabled ? t('scriptshub.publish.active') : t('scriptshub.publish.paused')}
                      </Badge>
                      <Tooltip label={publication.visibility === 'token' ? t('scriptshub.publish.token') : t('scriptshub.publish.public')} side="left">
                        <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                          {publication.visibility === 'token' ? <KeyRound size={10} aria-hidden="true" /> : <Link2 size={10} aria-hidden="true" />}
                        </span>
                      </Tooltip>
                      <Switch
                        checked={publication.isEnabled}
                        label={t('scriptshub.publish.enabled')}
                        onChange={(next) => void toggleEnabled(publication, next)}
                      />
                    </>
                  ) : (
                    <Button size="sm" variant="primary" icon={<Upload size={11} aria-hidden="true" />} onClick={() => openCreate(file.id)}>
                      {t('scriptshub.publish.publish')}
                    </Button>
                  )}
                </div>

                {publication && (
                  <div className="mt-1 space-y-1.5">
                    <div className="flex min-w-0 items-center gap-1">
                      <Tooltip label={`${window.location.origin}${publicationUrlPath(publication.path)}`} side="bottom">
                        <code className="min-w-0 flex-1 truncate rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1 font-mono text-[length:var(--text-10-5)] text-[var(--text-secondary)]">
                          /{publication.path}
                        </code>
                      </Tooltip>
                      {publication.expiresAt && (
                        <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                          {t('scriptshub.publish.expires', { date: new Date(publication.expiresAt).toISOString().slice(0, 10) })}
                        </span>
                      )}
                      <IconButton label={t('scriptshub.publish.edit')} size="xs" onClick={() => openEdit(publication)}>
                        <Pencil size={10} aria-hidden="true" />
                      </IconButton>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button size="sm" variant="ghost" icon={<Copy size={11} aria-hidden="true" />} onClick={() => void copyCommand(publication)}>
                        {t('scriptshub.publish.copy_command')}
                      </Button>
                      <IconButton label={t('scriptshub.publish.copy_url')} size="sm" onClick={() => {
                        void copyText(`${window.location.origin}${publicationUrlPath(publication.path)}`).then((ok) => {
                          toast({ title: ok ? t('scriptshub.publish.command_copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
                        })
                      }}>
                        <Link2 size={11} aria-hidden="true" />
                      </IconButton>
                      <IconButton label={t('scriptshub.publish.open_page')} size="sm" onClick={() => window.open(publicationDetailPath(publication.id), '_blank', 'noopener')}>
                        <ExternalLink size={11} aria-hidden="true" />
                      </IconButton>
                      {publication.visibility === 'token' && (
                        <IconButton label={t('scriptshub.publish.rotate')} size="sm" onClick={() => void rotate(publication)}>
                          <KeyRound size={11} aria-hidden="true" />
                        </IconButton>
                      )}
                      <IconButton label={t('scriptshub.publish.unpublish')} size="sm" onClick={() => void unpublish(publication)} className="text-[var(--danger)]">
                        <Trash2 size={11} aria-hidden="true" />
                      </IconButton>
                    </div>
                    {publication.shortSlug && (
                      <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                        <Link2 size={10} aria-hidden="true" />
                        <a href={`/l/${publication.shortSlug}`} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[var(--accent)] hover:underline">
                          {`${window.location.origin}/l/${publication.shortSlug}`}
                        </a>
                        <CopyButton text={`${window.location.origin}/l/${publication.shortSlug}`} label={t('scriptshub.publish.copy_short')} className="size-5" />
                      </div>
                    )}
                    {fileMinted && (
                      <div className="space-y-1 rounded-[var(--r-sm)] border border-[var(--warning)]/40 bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] p-1.5">
                        <p className="text-[length:var(--text-10)] font-medium text-[var(--warning)]">{t('scriptshub.publish.token_once')}</p>
                        <div className="flex items-center gap-1">
                          <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-10)]">{fileMinted}</code>
                          <CopyButton text={fileMinted} label={t('scriptshub.publish.copy_token')} className="size-5" />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t('scriptshub.publish.edit_title') : t('scriptshub.publish.dialog_title')}
        description={t('scriptshub.publish.dialog_body')}
        width={520}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('scriptshub.common.cancel')}</Button>
            <Button variant="primary" loading={saving} onClick={() => void runSave()}>{t('scriptshub.common.save')}</Button>
          </>
        )}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1.5">
            <LanguageIcon
              id={detail.files.find((file) => file.id === fileId)?.language ?? detail.language}
              size={12}
            />
            <span className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">
              {detail.files.find((file) => file.id === fileId)?.name ?? t('scriptshub.publish.file')}
            </span>
          </div>
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
          {!editing && (
            <label className="flex items-start gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <Switch checked={visibility === 'public' && shortlink} disabled={visibility === 'token'} label={t('scriptshub.publish.shortlink')} onChange={setShortlink} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('scriptshub.publish.shortlink')}</span>
                <span className="block text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                  {visibility === 'token' ? t('scriptshub.publish.shortlink_token') : t('scriptshub.publish.shortlink_hint')}
                </span>
              </span>
            </label>
          )}
          <div className="rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2.5 font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {commandFor(path, detail.files.find((file) => file.id === fileId)?.name ?? 'script', detail.files.find((file) => file.id === fileId)?.language ?? detail.language)}
          </div>
          {error && <p className="text-[length:var(--text-12)] text-[var(--danger)]" role="alert">{error}</p>}
        </div>
      </Modal>
    </>
  )
}

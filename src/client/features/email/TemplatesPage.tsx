import { useEffect, useId, useState } from 'react'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import type { EmailTemplate } from '@shared/email/templates'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { navigateToPath } from '../../lib/app-history'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { emailFolderPath } from './email-address'
import { emailErrorText } from './errors'
import { TemplateEditor } from './TemplateEditor'
import { useEmailStore } from './store'

type TemplatesStatus = 'loading' | 'ready' | 'error'

const BODY_PREVIEW_CHARS = 160

function bodyPreview(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, BODY_PREVIEW_CHARS)
}

export function TemplatesPage({ accountId, onBack }: { accountId: string; onBack?: () => void }) {
  const account = useEmailStore((state) => state.accounts.find((entry) => entry.id === accountId) ?? null)
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [status, setStatus] = useState<TemplatesStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<EmailTemplate | null>(null)
  const headingId = useId()

  useEffect(() => {
    let live = true
    setStatus('loading')
    setError(null)
    setTemplates([])
    void api.email.listTemplates(accountId).then((rows) => {
      if (!live) return
      setTemplates(rows)
      setStatus('ready')
    }).catch((reason) => {
      if (!live) return
      setStatus('error')
      setError(emailErrorText(reason))
    })
    return () => {
      live = false
    }
  }, [accountId, reloadToken])

  const openCreate = (): void => {
    setEditing(null)
    setEditorOpen(true)
  }

  const openEdit = (template: EmailTemplate): void => {
    setEditing(template)
    setEditorOpen(true)
  }

  const closeEditor = (): void => {
    setEditorOpen(false)
    setEditing(null)
  }

  const saved = (template: EmailTemplate): void => {
    setTemplates((current) => {
      const exists = current.some((entry) => entry.id === template.id)
      const next = exists
        ? current.map((entry) => entry.id === template.id ? template : entry)
        : [...current, template]
      return next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    })
    closeEditor()
    useUi.getState().toast({ title: t('email.templates.saved'), tone: 'success' })
  }

  const remove = async (template: EmailTemplate): Promise<void> => {
    const ok = await confirm({
      title: t('email.templates.delete_title', { name: template.name }),
      description: t('email.templates.delete_hint'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.email.deleteTemplate(accountId, template.id)
      setTemplates((current) => current.filter((entry) => entry.id !== template.id))
      useUi.getState().toast({ title: t('email.templates.deleted'), tone: 'success' })
    } catch (reason) {
      useUi.getState().toast({
        title: t('email.toast.failed'),
        description: emailErrorText(reason),
        tone: 'danger',
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 md:px-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft size={14} />}
          onClick={() => { if (onBack) onBack(); else navigateToPath(emailFolderPath(accountId, 'inbox')) }}
        >
          {t('email.header.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('email.templates.title')}
          </h1>
          {account && (
            <p className="m-0 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {account.displayName ? `${account.displayName} · ${account.address}` : account.address}
            </p>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 md:px-4">
          <section
            aria-labelledby={headingId}
            className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h2 id={headingId} className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                  {t('email.templates.title')}
                </h2>
                <p className="m-0 mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
                  {t('email.templates.hint')}
                </p>
              </div>
              <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>{t('email.templates.new')}</Button>
            </div>
            <div className="mt-3">
              {status === 'loading' && <LoadingBlock label={t('email.templates.loading')} />}
              {status === 'error' && (
                <Empty
                  compact
                  art="folder"
                  title={t('email.templates.error')}
                  description={error}
                  action={<Button size="sm" onClick={() => setReloadToken((token) => token + 1)}>{t('common.retry')}</Button>}
                />
              )}
              {status === 'ready' && templates.length === 0 && (
                <Empty compact art="folder" title={t('email.templates.empty')} description={t('email.templates.empty_hint')} />
              )}
              {status === 'ready' && templates.length > 0 && (
                <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
                  {templates.map((template) => (
                    <li key={template.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="m-0 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                          {template.name}
                        </p>
                        <p className="m-0 mt-0.5 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
                          {template.subject || t('email.templates.no_subject')}
                        </p>
                        {template.body.trim() && (
                          <p className="m-0 mt-0.5 truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                            {bodyPreview(template.body)}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <IconButton label={t('email.templates.edit_named', { name: template.name })} size="sm" onClick={() => openEdit(template)}>
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton label={t('email.templates.delete_named', { name: template.name })} size="sm" onClick={() => { void remove(template) }}>
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
      <TemplateEditor
        open={editorOpen}
        accountId={accountId}
        template={editing}
        onClose={closeEditor}
        onSaved={saved}
      />
    </div>
  )
}

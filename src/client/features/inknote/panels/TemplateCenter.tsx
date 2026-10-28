/** The template shelf: the seven built-ins plus the account's saved pages. */
import { useMemo } from 'react'
import type { InknoteTemplate } from '@shared/inknote/types'
import { BUILTIN_TEMPLATES } from '@shared/inknote/constants'
import { paperSurfaceFor } from '@shared/inknote/color'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Modal, confirm, prompt } from '../../../components/overlay'
import { templateContent, templateName, templateTitle } from '../../../lib/inknote/template'
import { useInknoteStore } from '../store'
import { inknoteApi } from '../api'
import { useUi } from '../../../store/ui'
import { Pencil, Plus, Trash2 } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  notebookId: string | null
}

const EMPTY_TEMPLATES: InknoteTemplate[] = []

export function TemplateCenter({ open, onClose, notebookId }: Props) {
  const templates = useInknoteStore((state) => state.library?.templates) ?? EMPTY_TEMPLATES
  const note = useInknoteStore((state) => state.note)
  const pages = useInknoteStore((state) => state.pages)
  const toast = useUi((state) => state.toast)
  const all = useMemo(() => [...BUILTIN_TEMPLATES, ...templates], [templates])
  const pageSize = { width: note?.pageWidth ?? 816, height: note?.pageHeight ?? 1056 }

  const applyTemplate = async (template: InknoteTemplate, mode: 'new' | 'page') => {
    const store = useInknoteStore.getState()
    const content = templateContent(template, (key) => t(key as never), pageSize)
    if (mode === 'new') {
      if (!notebookId) { toast({ title: t('inknote.template.no_notebook') }); return }
      const id = await store.createNote(notebookId, templateName(template, (key) => t(key as never)))
      if (!id) return
      await store.updateNoteMeta({ paper: template.paper })
      const page = useInknoteStore.getState().pages[0]
      if (page) { store.replacePageContent(page.id, content); await store.savePage(page.id) }
    } else {
      await store.createPage()
      const pageId = useInknoteStore.getState().activePageId
      if (!pageId) return
      store.replacePageContent(pageId, content)
      await store.savePage(pageId)
    }
    onClose()
  }

  const saveCurrentPage = async () => {
    const store = useInknoteStore.getState()
    const page = pages.find((entry) => entry.id === store.activePageId) ?? pages[0]
    if (!page) return
    const name = await prompt({ title: t('inknote.template.name'), defaultValue: note?.title ?? '' })
    if (!name?.trim()) return
    try {
      await store.addTemplate({
        name: name.trim().slice(0, 60),
        paper: note?.paper,
        bgAssetId: page.content.bg?.assetId ?? null,
        texts: page.content.texts,
        title: name.trim().slice(0, 60),
      })
      toast({ title: t('inknote.template.saved') })
    } catch (error) {
      toast({ title: String(error), tone: 'danger' })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('inknote.template.title')} width={640}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.template.hint')}</p>
          <Button size="sm" variant="secondary" icon={<Plus size={13}/>} onClick={() => void saveCurrentPage()} disabled={pages.length === 0}>{t('inknote.template.save_current')}</Button>
        </div>
        <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {all.map((template) => {
            const surface = paperSurfaceFor(template.paper.color)
            const name = templateName(template, (key) => t(key as never))
            return (
              <div key={template.id} className="flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
                <div className="mb-1.5 h-20 rounded-[var(--r-xs)] border border-[var(--border-subtle)]" style={{ background: template.bgUrl ? `center / cover no-repeat url(${JSON.stringify(template.bgUrl)})` : surface.bg }}>
                  <div className="flex h-full flex-col justify-center px-2" style={{ color: surface.dark ? '#f8fafc' : '#475569' }}>
                    <span className="truncate text-[length:var(--text-12)] font-semibold">{templateTitle(template, (key) => t(key as never))}</span>
                    {template.builtIn && template.sub && <span className="truncate text-[length:var(--text-10)] opacity-80">{t(template.sub as never)}</span>}
                  </div>
                </div>
                <span className="truncate text-[length:var(--text-11)]">{name}</span>
                <div className="mt-1 flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void applyTemplate(template, 'new')}>{t('inknote.template.use')}</Button>
                  {note && <IconButton label={t('inknote.template.apply')} size="xs" onClick={() => void applyTemplate(template, 'page')}><Plus size={11}/></IconButton>}
                  {!template.builtIn && (
                    <>
                      <IconButton label={t('inknote.template.rename')} size="xs" onClick={() => void prompt({ title: t('inknote.template.rename'), defaultValue: template.name }).then(async (next) => {
                        if (!next?.trim()) return
                        await inknoteApi.renameTemplate(template.id, next.trim().slice(0, 60))
                        await useInknoteStore.getState().refreshTemplates()
                      })}><Pencil size={11}/></IconButton>
                      <IconButton label={t('inknote.template.delete')} size="xs" onClick={() => void confirm({ title: t('inknote.template.delete'), confirmLabel: t('inknote.delete') }).then(async (ok) => {
                        if (!ok) return
                        await useInknoteStore.getState().removeTemplate(template.id)
                      })}><Trash2 size={11}/></IconButton>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { Pencil, Play, Plus, Star, Trash2, X } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Textarea } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Empty } from '../../components/feedback'
import { Modal, Tooltip, confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { CommandEditor } from './CommandEditor'
import {
  QUICK_COMMAND_CATEGORIES,
  QUICK_COMMAND_TEXT_MAX,
  QUICK_COMMAND_TITLE_MAX,
  loadQuickCommands,
  newQuickCommandId,
  quickCommandTitle,
  saveQuickCommands,
  type QuickCommandCategory,
  type QuickCommandEntry,
} from './quick-commands'

const CATEGORY_LABEL: Record<QuickCommandCategory, MessageKey> = {
  system: 'webssh.quick.category.system',
  files: 'webssh.quick.category.files',
  network: 'webssh.quick.category.network',
  process: 'webssh.quick.category.process',
  docker: 'webssh.quick.category.docker',
  logs: 'webssh.quick.category.logs',
  custom: 'webssh.quick.category.custom',
}

type SendTarget = 'current' | 'all'

interface CommandDraft {
  id: string | null
  title: string
  command: string
  category: QuickCommandCategory
  favorite: boolean
}

const EMPTY_DRAFT: CommandDraft = { id: null, title: '', command: '', category: 'custom', favorite: false }

export function QuickCommandsPanel({
  open,
  onClose,
  activeConnected,
  connectedCount,
  onSend,
  onInsert,
}: {
  open: boolean
  onClose: () => void
  activeConnected: boolean
  connectedCount: number
  onSend: (text: string, target: SendTarget) => void
  onInsert: (text: string) => void
}) {
  const [items, setItems] = useState<QuickCommandEntry[]>(loadQuickCommands)
  const [category, setCategory] = useState<'all' | QuickCommandCategory>('all')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [target, setTarget] = useState<SendTarget>('current')
  const [draftCommand, setDraftCommand] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<QuickCommandEntry | null>(null)
  const [draft, setDraft] = useState<CommandDraft>(EMPTY_DRAFT)

  useEffect(() => {
    saveQuickCommands(items)
  }, [items])

  if (!open) return null

  const canSend = target === 'all' ? connectedCount > 0 : activeConnected
  const canInsert = activeConnected
  const visible = items.filter((entry) => (category === 'all' || entry.category === category) && (!favoriteOnly || entry.favorite))
  const categoryOptions = [
    { value: 'all' as const, label: t('webssh.quick.all_categories') },
    ...QUICK_COMMAND_CATEGORIES.map((value) => ({ value, label: t(CATEGORY_LABEL[value]) })),
  ]

  const openCreate = () => {
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setEditorOpen(true)
  }

  const openEdit = (entry: QuickCommandEntry) => {
    setEditing(entry)
    setDraft({
      id: entry.id,
      title: quickCommandTitle(entry, t),
      command: entry.command,
      category: entry.category,
      favorite: entry.favorite,
    })
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditing(null)
    setDraft(EMPTY_DRAFT)
  }

  const saveDraft = () => {
    const title = draft.title.trim()
    const command = draft.command.trim()
    if (!title || !command) return
    if (editing) {
      setItems((current) => current.map((entry) => (entry.id === editing.id
        ? { id: entry.id, title, command, category: draft.category, favorite: entry.favorite }
        : entry)))
    } else {
      setItems((current) => [...current, {
        id: newQuickCommandId(),
        title,
        command,
        category: draft.category,
        favorite: draft.favorite,
      }])
    }
    closeEditor()
  }

  const toggleFavorite = (entry: QuickCommandEntry) => {
    setItems((current) => current.map((item) => (item.id === entry.id ? { ...item, favorite: !item.favorite } : item)))
  }

  const remove = async (entry: QuickCommandEntry) => {
    const approved = await confirm({
      title: t('webssh.quick.remove_title'),
      description: t('webssh.quick.remove_description', { title: quickCommandTitle(entry, t) }),
      tone: 'danger',
      confirmLabel: t('webssh.actions.delete'),
    })
    if (!approved) return
    setItems((current) => current.filter((item) => item.id !== entry.id))
  }

  return (
    <>
      <section className="flex min-h-0 w-full flex-col bg-[var(--bg-surface)]" aria-label={t('webssh.quick.title')}>
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('webssh.quick.title')}
          </h2>
          <Tooltip label={t('common.close')}>
            <IconButton label={t('common.close')} size="sm" onClick={onClose}>
              <X size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
          <div role="group" aria-label={t('webssh.quick.target')} className="flex min-w-0 items-center gap-1">
            <Button size="sm" variant={target === 'current' ? 'primary' : 'subtle'} aria-pressed={target === 'current'} onClick={() => setTarget('current')}>
              {t('webssh.quick.target_current')}
            </Button>
            <Button size="sm" variant={target === 'all' ? 'primary' : 'subtle'} aria-pressed={target === 'all'} onClick={() => setTarget('all')}>
              {t('webssh.quick.target_all', { count: connectedCount })}
            </Button>
          </div>
          <div className="ms-auto flex items-center gap-0.5">
            <Button size="sm" variant={favoriteOnly ? 'primary' : 'ghost'} aria-pressed={favoriteOnly} icon={<Star size={13} aria-hidden="true" />} onClick={() => setFavoriteOnly((value) => !value)}>
              {t('webssh.quick.favorites')}
            </Button>
            <Button size="sm" variant="primary" icon={<Plus size={13} aria-hidden="true" />} onClick={openCreate}>
              {t('webssh.quick.add')}
            </Button>
          </div>
        </div>

        <div className="shrink-0 px-3 pt-2">
          <SelectMenu
            label={t('webssh.quick.category_filter')}
            value={category}
            options={categoryOptions}
            onChange={(value) => setCategory(value)}
            size="sm"
            width={200}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {visible.length === 0 ? (
            <Empty art="select" compact title={t('webssh.quick.empty')} />
          ) : (
            <ul className="space-y-1">
              {visible.map((entry) => (
                <li key={entry.id} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-2 py-1.5">
                  <div className="flex items-start gap-1">
                    <IconButton
                      label={entry.favorite ? t('webssh.quick.unfavorite') : t('webssh.quick.favorite')}
                      size="xs"
                      active={entry.favorite}
                      onClick={() => toggleFavorite(entry)}
                    >
                      <Star size={12} aria-hidden="true" />
                    </IconButton>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                        {quickCommandTitle(entry, t)}
                      </p>
                      <p className="mt-0.5 line-clamp-2 break-all font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                        {entry.command}
                      </p>
                      <p className="mt-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t(CATEGORY_LABEL[entry.category])}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Tooltip label={canSend ? t('webssh.quick.send') : t('webssh.quick.no_session')}>
                        <IconButton label={t('webssh.quick.send')} size="xs" disabled={!canSend} onClick={() => onSend(entry.command, target)}>
                          <Play size={12} aria-hidden="true" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip label={t('webssh.actions.edit')}>
                        <IconButton label={t('webssh.actions.edit')} size="xs" onClick={() => openEdit(entry)}>
                          <Pencil size={12} aria-hidden="true" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip label={t('webssh.actions.delete')}>
                        <IconButton label={t('webssh.actions.delete')} size="xs" onClick={() => void remove(entry)}>
                          <Trash2 size={12} aria-hidden="true" />
                        </IconButton>
                      </Tooltip>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-2">
          {!canSend && (
            <p className="mb-2 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('webssh.quick.no_session')}</p>
          )}
          <CommandEditor
            value={draftCommand}
            onChange={setDraftCommand}
            canInsert={canInsert}
            canSend={canSend}
            onInsert={onInsert}
            onSendAll={(text) => onSend(text, target)}
            onSendLine={(text) => onSend(text, target)}
          />
        </div>
      </section>

      <Modal
        open={editorOpen}
        onClose={closeEditor}
        title={editing ? t('webssh.quick.edit_title') : t('webssh.quick.create_title')}
        width={520}
        footer={
          <>
            <Button onClick={closeEditor}>{t('webssh.actions.cancel')}</Button>
            <Button variant="primary" disabled={!draft.title.trim() || !draft.command.trim()} onClick={saveDraft}>
              {t('webssh.actions.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('webssh.quick.command_title')} required>
            <Input value={draft.title} maxLength={QUICK_COMMAND_TITLE_MAX} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </Field>
          <Field label={t('webssh.quick.category')}>
            <SelectMenu
              label={t('webssh.quick.category')}
              value={draft.category}
              options={QUICK_COMMAND_CATEGORIES.map((value) => ({ value, label: t(CATEGORY_LABEL[value]) }))}
              onChange={(value) => setDraft({ ...draft, category: value })}
            />
          </Field>
          <Field label={t('webssh.quick.command')} required>
            <Textarea rows={4} value={draft.command} maxLength={QUICK_COMMAND_TEXT_MAX} className="font-mono" onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
          </Field>
        </div>
      </Modal>
    </>
  )
}

export type { SendTarget }

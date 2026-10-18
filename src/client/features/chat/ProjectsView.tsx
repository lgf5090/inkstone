/**
 * The projects screen: standing briefs the assistant answers under.
 *
 * A project is not another place to file things — conversations already live in the notebook's folders.
 * It is a brief and a knowledge selection that every conversation inside it inherits, which is what makes
 * it different from a folder: the folder says where a thread sits, the project says what it is about.
 *
 * Kept lean on purpose: the list, the editor, and which project the current conversation belongs to. The
 * editor is where the real content is — instructions and the folders whose notes the assistant may read —
 * so it gets the room and the list does not.
 */

import { useEffect, useRef, useState } from 'react'
import { FileText, FolderOpen, ListChecks, MessageSquare, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { MAX_PROJECT_NOTES, type Project } from '@shared/assistant'
import { NotePicker } from './ComposerControls'
import { NoteScopePicker } from './NoteScopePicker'
import { api } from '../../lib/api'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select, Textarea } from '../../components/form'
import { Menu, Modal, confirm, type MenuItem } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { useAssistant } from './assistant-store'

const MAX_INSTRUCTIONS = 4000

interface Draft {
  id: string | null
  name: string
  description: string
  instructions: string
  noteScope: string[]
  noteIds: string[]
  modelId: string | null
}

const EMPTY: Draft = { id: null, name: '', description: '', instructions: '', noteScope: [], noteIds: [], modelId: null }

function draftFrom(project: Project): Draft {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    instructions: project.instructions,
    noteScope: project.noteScope,
    noteIds: project.noteIds,
    modelId: project.modelId,
  }
}

export function ProjectsView({ onOpen }: { onOpen?: () => void }) {
  const toast = useUi((s) => s.toast)
  const projects = useAssistant((state) => state.projects)
  const conversations = useAssistant((state) => state.conversations)
  const models = useAssistant((state) => state.models)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  // A write changes both the project rows and which conversation sits in which, so both are re-read;
  // `bootstrap` alone would leave the list showing the project the reader just made.
  const refresh = () => Promise.all([useAssistant.getState().loadProjects(), useAssistant.getState().bootstrap(true)])
  useEffect(() => {
    void useAssistant.getState().loadProjects().finally(() => setLoading(false))
  }, [])

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    setBusy(true)
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        noteScope: draft.noteScope,
        noteIds: draft.noteIds,
        modelId: draft.modelId,
      }
      if (draft.id) await api.assistant.updateProject(draft.id, body)
      else await api.assistant.createProject(body)
      await refresh()
      setDraft(null)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (project: Project) => {
    const conversationsIn = conversations.filter((entry) => entry.projectId === project.id).length
    const agreed = await confirm({
      title: t('assistant.projects.delete_title', { name: project.name }),
      description: t('assistant.projects.delete_hint', { count: conversationsIn }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    setBusy(true)
    try {
      await api.assistant.deleteProject(project.id)
      await refresh()
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const move = async (conversationId: string, projectId: string | null) => {
    try {
      await api.assistant.setConversationProject(conversationId, projectId)
      await refresh()
      onOpen?.()
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
    }
  }

  const inProject = (id: string) => conversations.filter((entry) => entry.projectId === id)
  const unfiled = conversations.filter((entry) => !entry.projectId)
  const modelLabel = (id: string) => models.find((model) => model.id === id)?.label ?? t('assistant.projects.model_unknown')

  // The brief is worth reading here, but reading the threads it governs is what the reader came for — and
  // the project filter already exists on the chat list, so this hands over to it rather than growing a
  // second list of conversations inside the settings screen.
  const openConversations = async (projectId: string) => {
    await useAssistant.getState().setProjectFilter(projectId)
    useAssistant.getState().setView('chat')
    onOpen?.()
  }

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-4 md:px-8">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
            {t('assistant.projects.hint')}
          </p>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDraft(EMPTY)}>
            {t('assistant.projects.new')}
          </Button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">…</p>
        ) : !projects.length ? (
          <Empty art="notes" compact title={t('assistant.projects.empty')} />
        ) : (
          <ul className="space-y-2">
            {projects.map((project) => {
              const inside = inProject(project.id)
              return (
                <li key={project.id} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                  <div className="flex items-center gap-2">
                    <ListChecks size={14} className="shrink-0 text-[var(--accent)]" />
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">{project.name}</span>
                    <Button size="sm" variant="ghost" icon={<MessageSquare size={13} />} onClick={() => void openConversations(project.id)}>
                      {t('assistant.projects.open_conversations')}
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setDraft(draftFrom(project))}>
                      {t('common.edit')}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-[var(--danger)]" icon={<Trash2 size={13} />} disabled={busy} onClick={() => void remove(project)}>
                      {t('common.delete')}
                    </Button>
                  </div>
                  {project.description && (
                    <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{project.description}</p>
                  )}
                  {project.instructions && (
                    <p className="mt-2 whitespace-pre-wrap rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
                      {project.instructions}
                    </p>
                  )}
                  <p className="mt-2 flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                    <FolderOpen size={11} />
                    {project.noteScope.length
                      ? t('assistant.projects.knowledge_count', { count: project.noteScope.length })
                      : t('assistant.projects.knowledge_none')}
                  </p>
                  {/* Named pages are the selection a reader is most often asked to justify — "why did it
                      answer from those three" — so the card says how many, not only the editor. */}
                  {project.noteIds.length > 0 && (
                    <p className="mt-1 flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      <FileText size={11} />
                      {t('assistant.projects.notes_count', { count: project.noteIds.length })}
                    </p>
                  )}
                  {/* Named rather than left to the editor: which model a project answers with is the sort
                      of thing a reader wants to check at a glance across several projects. */}
                  {project.modelId && (
                    <p className="mt-1 flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      <Sparkles size={11} />
                      {t('assistant.projects.model_uses', { model: modelLabel(project.modelId) })}
                    </p>
                  )}

                  {/* Filing is done here rather than by dragging, because what a drag means here is
                      "answer under this brief", which is worth seeing spelled out. */}
                  <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">
                    <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      {t('assistant.projects.members', { count: inside.length })}
                    </p>
                    {inside.map((conversation) => (
                      <div key={conversation.id} className="flex items-center gap-2 py-0.5 text-[length:var(--text-12)]">
                        <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{conversation.title || t('assistant.chat.untitled')}</span>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void move(conversation.id, null)}>
                          {t('assistant.projects.remove_conversation')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {unfiled.length > 0 && (
          <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3">
            <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.projects.unfiled')}</p>
            {projects.length ? (
              <ul className="space-y-0.5">
                {unfiled.map((conversation) => (
                  <li key={conversation.id} className="flex items-center gap-2 text-[length:var(--text-12)]">
                    <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{conversation.title || t('assistant.chat.untitled')}</span>
                    <MoveIntoProjectMenu
                      projects={projects}
                      disabled={busy}
                      onMove={(projectId) => void move(conversation.id, projectId)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('assistant.projects.move_needs_project')}</p>
            )}
          </div>
        )}
      </div>

      {draft && (
        <ProjectEditor draft={draft} busy={busy} onChange={setDraft} onSave={() => void save()} onClose={() => setDraft(null)} />
      )}
    </div>
  )
}

/**
 * The pages a project names by hand.
 *
 * The chips show titles because the reader picked by title, while the ids are what travels; a page deleted
 * since it was named keeps its id on the chip rather than vanishing, so what is on screen is what the row
 * holds. Reaching the cap is said in text under the button — a control that simply stops working, with the
 * reason only in a hover hint, is a bug the reader cannot report.
 */
function ProjectNotesPicker({ value, onChange, disabled }: {
  value: string[]
  onChange: (ids: string[]) => void
  disabled: boolean
}) {
  const notes = useNotes((state) => state.notes)
  const [picking, setPicking] = useState(false)
  const full = value.length >= MAX_PROJECT_NOTES
  const titleOf = (id: string): string => notes[id]?.title ?? id
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {value.map((id) => (
            <li key={id} className="flex items-center gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] py-0.5 pr-0.5 pl-1.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
              <FileText size={11} className="shrink-0 text-[var(--text-quaternary)]" />
              <span className="max-w-[200px] truncate">{titleOf(id)}</span>
              <IconButton size="sm" label={t('assistant.projects.note_drop', { name: titleOf(id) })} disabled={disabled} onClick={() => onChange(value.filter((entry) => entry !== id))}>
                <X size={11} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="ghost" icon={<Plus size={13} />} disabled={disabled || full} onClick={() => setPicking(true)}>
        {t('assistant.projects.note_add')}
      </Button>
      {full && (
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.projects.notes_full', { count: MAX_PROJECT_NOTES })}</p>
      )}
      <NotePicker
        open={picking}
        onClose={() => setPicking(false)}
        title={t('assistant.projects.note_add')}
        onPick={(row) => {
          setPicking(false)
          if (!value.includes(row.id)) onChange([...value, row.id])
        }}
        search={async (query) => {
          const response = await api.search(query || t('assistant.attach.note_prompt'), 12)
          return response.results.map((hit) => ({ id: hit.note.id, title: hit.note.title }))
        }}
      />
    </div>
  )
}

/**
 * The row-level way into a project.
 *
 * A menu rather than a `<select>`: a form field that is greyed out whenever there is nothing to pick
 * reads as broken, and a menu states the action and explains itself when it cannot run.
 */
function MoveIntoProjectMenu({ projects, disabled, onMove }: {
  projects: Project[]
  disabled: boolean
  onMove: (projectId: string) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = projects.map((project) => ({
    id: project.id,
    label: project.name,
    icon: <ListChecks size={13} />,
    onSelect: () => onMove(project.id),
  }))
  return (
    <>
      <Button
        ref={ref}
        size="sm"
        variant="ghost"
        disabled={disabled}
        icon={<FolderOpen size={13} />}
        onClick={() => setOpen((value) => !value)}
      >
        {t('assistant.projects.move_into')}
      </Button>
      <Menu
        anchor={ref}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        align="end"
        width={200}
        searchable={projects.length > 8}
        label={t('assistant.projects.move_into')}
      />
    </>
  )
}

function ProjectEditor({ draft, busy, onChange, onSave, onClose }: {
  draft: Draft
  busy: boolean
  onChange: (draft: Draft) => void
  onSave: () => void
  onClose: () => void
}) {
  const patch = (part: Partial<Draft>) => onChange({ ...draft, ...part })
  const models = useAssistant((state) => state.models)
  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? t('assistant.projects.edit') : t('assistant.projects.new')}
      width={560}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={onSave}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('assistant.projects.name')}>
          <Input value={draft.name} maxLength={200} onChange={(event) => patch({ name: event.target.value })} />
        </Field>
        <Field label={t('assistant.projects.description')}>
          <Input value={draft.description} maxLength={2000} onChange={(event) => patch({ description: event.target.value })} />
        </Field>
        <Field label={t('assistant.projects.instructions')} hint={t('assistant.projects.instructions_hint')}>
          <Textarea
            value={draft.instructions}
            maxLength={MAX_INSTRUCTIONS}
            rows={5}
            onChange={(event) => patch({ instructions: event.target.value })}
          />
        </Field>
        <Field label={t('assistant.projects.knowledge')} hint={t('assistant.projects.knowledge_hint')}>
          <NoteScopePicker value={draft.noteScope} onChange={(ids) => patch({ noteScope: ids })} disabled={busy} />
        </Field>
        <Field label={t('assistant.projects.notes')} hint={t('assistant.projects.notes_hint')}>
          <ProjectNotesPicker value={draft.noteIds} onChange={(ids) => patch({ noteIds: ids })} disabled={busy} />
        </Field>
        {/* A standing choice, not a per-turn one: the point of a project is that its conversations are
            answered the same way, and the model is part of that. Empty means the account's own default. */}
        <Field label={t('assistant.projects.model')} hint={t('assistant.projects.model_hint')}>
          <Select
            aria-label={t('assistant.projects.model')}
            value={draft.modelId ?? ''}
            onChange={(event) => patch({ modelId: event.target.value || null })}
          >
            <option value="">{t('assistant.projects.model_default')}</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

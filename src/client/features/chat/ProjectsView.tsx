/**
 * The assistants screen: saved briefs the chat answers under.
 *
 * An assistant is not another place to file things — conversations already live in the notebook's
 * folders. It is a brief, a model and a knowledge selection every conversation inside it inherits.
 *
 * The screen follows the shape the reader already knows from the chat client this app replaces: a
 * grouped list on the left, and one editor with a tab per decision (basic, model, system prompt,
 * prompts, built-in tools, knowledge, MCP). The list stays a list rather than becoming a form: which
 * assistant a thread answers under is the thing to see at a glance, so the editor gets the room.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, FileText, FolderOpen, ListChecks, MessageSquare, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { ASSISTANT_PARAM_TYPES, ASSISTANT_TOOL_SPECS, MAX_CUSTOM_PARAMS, MAX_PROJECT_NOTES, estimateTokens, type AssistantConversation, type AssistantCustomParam, type AssistantParamType, type Project, type ProjectMcpMode } from '@shared/assistant'
import type { MessageKey } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { NotePicker } from './ComposerControls'
import { NoteScopePicker } from './NoteScopePicker'
import { AssistantIconField } from './AssistantIconPicker'
import { AssistantIcon } from './AssistantIcon'
import { api } from '../../lib/api'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Field, Input, Segmented, Select, SettingRow, Slider, Switch, Textarea } from '../../components/form'
import { Menu, Modal, confirm, type MenuItem } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { useAssistant } from './assistant-store'

const MAX_INSTRUCTIONS = 4000

const EDITOR_TABS = ['basic', 'model', 'system', 'prompts', 'builtin', 'knowledge', 'mcp'] as const
type EditorTab = (typeof EDITOR_TABS)[number]

const TAB_LABELS: Record<EditorTab, MessageKey> = {
  basic: 'assistant.projects.tab_basic',
  model: 'assistant.projects.tab_model',
  system: 'assistant.projects.tab_system',
  prompts: 'assistant.projects.tab_prompts',
  builtin: 'assistant.projects.tab_builtin',
  knowledge: 'assistant.projects.tab_knowledge',
  mcp: 'assistant.projects.tab_mcp',
}

interface Draft {
  id: string | null
  name: string
  description: string
  icon: string
  instructions: string
  group: string
  noteScope: string[]
  excludeScope: string[]
  noteIds: string[]
  modelId: string | null
  tools: string[]
  toolsLimited: boolean
  toolOverrides: Record<string, string>
  skillIds: string[]
  temperature: number | null
  topP: number | null
  maxOutputTokens: number | null
  stream: boolean
  maxToolRounds: number | null
  keepRecentMessages: number | null
  contextCustom: boolean
  autoCompactMode: Project['autoCompactMode']
  autoCompactTokens: number
  autoCompactRatio: number
  customParams: AssistantCustomParam[]
  mcpMode: ProjectMcpMode
  mcpServerIds: string[]
  knowledgeBaseIds: string[]
  focusSync: boolean
  timeAware: boolean
  readProjectInstructions: boolean
}

const EMPTY: Draft = {
  id: null,
  name: '',
  description: '',
  icon: '',
  instructions: '',
  group: '',
  noteScope: [],
  excludeScope: [],
  noteIds: [],
  modelId: null,
  tools: [],
  toolsLimited: false,
  toolOverrides: {},
  skillIds: [],
  temperature: null,
  topP: null,
  maxOutputTokens: null,
  stream: true,
  maxToolRounds: null,
  keepRecentMessages: null,
  contextCustom: false,
  autoCompactMode: 'off',
  autoCompactTokens: 100_000,
  autoCompactRatio: 0.8,
  customParams: [],
  mcpMode: 'auto',
  mcpServerIds: [],
  knowledgeBaseIds: [],
  focusSync: true,
  timeAware: true,
  readProjectInstructions: false,
}

function draftFrom(project: Project): Draft {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    icon: project.icon,
    instructions: project.instructions,
    group: project.group,
    noteScope: project.noteScope,
    excludeScope: project.excludeScope,
    noteIds: project.noteIds,
    modelId: project.modelId,
    tools: project.tools,
    toolsLimited: project.toolsLimited,
    toolOverrides: project.toolOverrides,
    skillIds: project.skillIds,
    temperature: project.temperature,
    topP: project.topP,
    maxOutputTokens: project.maxOutputTokens,
    stream: project.stream,
    maxToolRounds: project.maxToolRounds,
    keepRecentMessages: project.keepRecentMessages,
    contextCustom: project.contextCustom,
    autoCompactMode: project.autoCompactMode,
    autoCompactTokens: project.autoCompactTokens,
    autoCompactRatio: project.autoCompactRatio,
    customParams: project.customParams,
    mcpMode: project.mcpMode,
    mcpServerIds: project.mcpServerIds,
    knowledgeBaseIds: project.knowledgeBaseIds,
    focusSync: project.focusSync,
    timeAware: project.timeAware,
    readProjectInstructions: project.readProjectInstructions,
  }
}

export function ProjectsView({ onOpen }: { onOpen?: () => void }) {
  const toast = useUi((s) => s.toast)
  const projects = useAssistant((state) => state.projects)
  const conversations = useAssistant((state) => state.conversations)
  const models = useAssistant((state) => state.models)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  // A write changes both the assistant rows and which conversation sits in which, so both are re-read;
  // `bootstrap` alone would leave the list showing the assistant the reader just made.
  const refresh = () => Promise.all([useAssistant.getState().loadProjects(), useAssistant.getState().bootstrap(true)])
  useEffect(() => {
    void useAssistant.getState().loadProjects().finally(() => setLoading(false))
    void useAssistant.getState().loadSkills()
    void useAssistant.getState().loadKnowledgeBases()
    void useAssistant.getState().loadMcpServers()
  }, [])

  const selected = projects.find((project) => project.id === selectedId) ?? null
  // The newest reader lands on a screen with one assistant and no selection; showing the first is what
  // every chat client this replaces does, and the list still says which row is open.
  useEffect(() => {
    if (!projects.length) { setSelectedId(null); return }
    if (!selectedId || !projects.some((project) => project.id === selectedId)) setSelectedId(projects[0]!.id)
  }, [projects, selectedId])

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    setBusy(true)
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        icon: draft.icon,
        instructions: draft.instructions,
        group: draft.group,
        noteScope: draft.noteScope,
        excludeScope: draft.excludeScope,
        noteIds: draft.noteIds,
        modelId: draft.modelId,
        tools: draft.tools,
        toolsLimited: draft.toolsLimited,
        toolOverrides: draft.toolOverrides,
        skillIds: draft.skillIds,
        temperature: draft.temperature,
        topP: draft.topP,
        maxOutputTokens: draft.maxOutputTokens,
        stream: draft.stream,
        maxToolRounds: draft.maxToolRounds,
        keepRecentMessages: draft.keepRecentMessages,
        contextCustom: draft.contextCustom,
        autoCompactMode: draft.autoCompactMode,
        autoCompactTokens: draft.autoCompactTokens,
        autoCompactRatio: draft.autoCompactRatio,
        customParams: draft.customParams.filter((param) => param.name.trim()),
        mcpMode: draft.mcpMode,
        mcpServerIds: draft.mcpServerIds,
        knowledgeBaseIds: draft.knowledgeBaseIds,
        focusSync: draft.focusSync,
        timeAware: draft.timeAware,
        readProjectInstructions: draft.readProjectInstructions,
      }
      const saved = draft.id
        ? await api.assistant.updateProject(draft.id, body)
        : await api.assistant.createProject(body)
      await refresh()
      setSelectedId(saved.project.id)
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

  const openConversations = async (projectId: string) => {
    await useAssistant.getState().setProjectFilter(projectId)
    useAssistant.getState().setView('chat')
    onOpen?.()
  }

  const groups = useMemo(() => {
    const buckets = new Map<string, Project[]>()
    for (const project of projects) {
      const key = project.group.trim()
      buckets.set(key, [...(buckets.get(key) ?? []), project])
    }
    return [...buckets.entries()].sort((left, right) => {
      if (!left[0]) return -1
      if (!right[0]) return 1
      return left[0].localeCompare(right[0])
    })
  }, [projects])

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex max-h-[45%] w-full shrink-0 flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] md:max-h-none md:w-56 md:border-r md:border-b-0">
        <div className="p-2">
          <Button size="sm" variant="primary" icon={<Plus size={14} />} className="w-full justify-center" onClick={() => setDraft(EMPTY)}>
            {t('assistant.projects.add')}
          </Button>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {loading ? (
            <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">…</p>
          ) : !projects.length ? (
            <p className="px-2 py-6 text-center text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">{t('assistant.projects.empty')}</p>
          ) : groups.map(([group, rows]) => (
            <section key={group || 'ungrouped'} className="mb-1">
              <h3 className="px-2 py-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {group || t('assistant.projects.ungrouped')}
              </h3>
              {rows.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => setSelectedId(project.id)}
                  className={`flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left text-[length:var(--text-12-5)] transition-colors duration-[var(--dur-fast)] ${project.id === selected?.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
                >
                  <AssistantIcon value={project.icon} fallback="lucide:bot" size={15} />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {project.id === selected?.id && <span aria-hidden className="h-4 w-0.5 rounded-full bg-[var(--accent)]" />}
                </button>
              ))}
            </section>
          ))}
        </div>
      </aside>

        <div className="no-scrollbar min-w-0 flex-1 overflow-y-auto py-0 md:py-0">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-4 py-4 md:px-8">
          {selected ? (
            <AssistantDetail
              project={selected}
              conversations={inProject(selected.id)}
              modelLabel={selected.modelId ? modelLabel(selected.modelId) : t('assistant.projects.model_default')}
              busy={busy}
              onEdit={() => setDraft(draftFrom(selected))}
              onOpenConversations={() => void openConversations(selected.id)}
              onRemove={() => void remove(selected)}
              onRemoveConversation={(conversationId) => void move(conversationId, null)}
            />
          ) : (
            <Empty art="notes" compact title={t('assistant.projects.select_hint')} />
          )}

          {unfiled.length > 0 && (
            <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3">
              <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.projects.unfiled')}</p>
              {projects.length ? (
                <ul className="no-scrollbar max-h-64 space-y-0.5 overflow-y-auto">
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
      </div>

      {draft && (
        <ProjectEditor draft={draft} busy={busy} onChange={setDraft} onSave={() => void save()} onClose={() => setDraft(null)} />
      )}
    </div>
  )
}

/** What one assistant is, as a page, before the editor opens on top of it. */
function AssistantDetail({ project, conversations, modelLabel, busy, onEdit, onOpenConversations, onRemove, onRemoveConversation }: {
  project: Project
  conversations: AssistantConversation[]
  modelLabel: string
  busy: boolean
  onEdit: () => void
  onOpenConversations: () => void
  onRemove: () => void
  onRemoveConversation: (conversationId: string) => void
}) {
  const skillIds = useAssistant((state) => state.skills.filter((skill) => skill.kind === 'prompt' && project.skillIds.includes(skill.id)).length)
  const mcpModeLabels: Record<ProjectMcpMode, MessageKey> = {
    off: 'assistant.projects.mcp_off',
    auto: 'assistant.projects.mcp_auto',
    manual: 'assistant.projects.mcp_manual',
  }
  const chips = [
    { icon: <Sparkles size={11} />, text: modelLabel },
    ...(project.group ? [{ icon: <ListChecks size={11} />, text: project.group }] : []),
    ...(project.toolsLimited ? [{ icon: <Check size={11} />, text: t('assistant.projects.summary_tools', { count: project.tools.length }) }] : []),
    ...(project.mcpMode !== 'auto' ? [{ icon: <ListChecks size={11} />, text: t('assistant.projects.summary_mcp_mode', { mode: t(mcpModeLabels[project.mcpMode]) }) }] : []),
    ...(project.knowledgeBaseIds.length ? [{ icon: <FolderOpen size={11} />, text: t('assistant.projects.summary_kb', { count: project.knowledgeBaseIds.length }) }] : []),
    ...(skillIds ? [{ icon: <FileText size={11} />, text: t('assistant.projects.summary_prompts', { count: skillIds }) }] : []),
  ]
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
      <div className="flex items-start gap-3">
        <AssistantIcon value={project.icon} fallback="lucide:bot" size={28} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{project.name}</h2>
          <p className="mt-0.5 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{project.description || t('assistant.projects.detail_hint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="primary" icon={<Pencil size={13} />} onClick={onEdit}>{t('assistant.projects.edit')}</Button>
          <IconButton label={t('assistant.projects.open_conversations')} size="sm" onClick={onOpenConversations}><MessageSquare size={14} /></IconButton>
          <IconButton label={t('common.delete')} size="sm" className="text-[var(--danger)]" disabled={busy} onClick={onRemove}><Trash2 size={14} /></IconButton>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chips.map((chip, index) => (
          <span key={index} className="flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {chip.icon}
            {chip.text}
          </span>
        ))}
      </div>
      {project.instructions && (
        <p className="mt-3 whitespace-pre-wrap rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {project.instructions}
        </p>
      )}
      <div className="mt-3 border-t border-[var(--border-subtle)] pt-2">
        <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('assistant.projects.members', { count: conversations.length })}
        </p>
        {conversations.length ? conversations.map((conversation) => (
          <div key={conversation.id} className="flex items-center gap-2 py-0.5 text-[length:var(--text-12)]">
            <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{conversation.title || t('assistant.chat.untitled')}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemoveConversation(conversation.id)}>
              {t('assistant.projects.remove_conversation')}
            </Button>
          </div>
        )) : (
          <p className="py-1 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.projects.no_conversations')}</p>
        )}
      </div>
    </div>
  )
}

/** A switch, its label, and the control that only exists while the switch is on. */
function ToggleRow({ title, description, checked, onChange, children }: {
  title: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
  children?: ReactNode
}) {
  return (
    <div className="border-b border-[var(--border-subtle)] py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-[length:var(--text-12-5)] text-[var(--text-primary)]">{title}</span>
        <Switch checked={checked} label={title} onChange={onChange} />
      </div>
      {description && <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{description}</p>}
      {checked && children && <div className="mt-2">{children}</div>}
    </div>
  )
}

function ProjectEditor({ draft, busy, onChange, onSave, onClose }: {
  draft: Draft
  busy: boolean
  onChange: (draft: Draft) => void
  onSave: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<EditorTab>('basic')
  const [newGroup, setNewGroup] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [promptDraft, setPromptDraft] = useState<{ title: string, content: string } | null>(null)
  const [binding, setBinding] = useState(false)
  const bindRef = useRef<HTMLButtonElement>(null)
  const models = useAssistant((state) => state.models)
  const projects = useAssistant((state) => state.projects)
  const skills = useAssistant((state) => state.skills)
  const knowledgeBases = useAssistant((state) => state.knowledgeBases)
  const mcpServers = useAssistant((state) => state.mcpServers)
  const patch = (part: Partial<Draft>) => onChange({ ...draft, ...part })
  const groups = useMemo(
    () => [...new Set(projects.map((project) => project.group.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
    [projects],
  )
  const boundPrompts = useMemo(
    () => skills.filter((skill) => skill.kind === 'prompt' && draft.skillIds.includes(skill.id)),
    [skills, draft.skillIds],
  )
  const bindablePrompts = useMemo(
    () => skills.filter((skill) => skill.kind === 'prompt' && !draft.skillIds.includes(skill.id)),
    [skills, draft.skillIds],
  )
  const linkedBases = knowledgeBases.filter((base) => draft.knowledgeBaseIds.includes(base.id))
  const availableBases = knowledgeBases.filter((base) => !draft.knowledgeBaseIds.includes(base.id))

  const createPrompt = async () => {
    const title = promptDraft?.title.trim() ?? ''
    const content = promptDraft?.content.trim() ?? ''
    if (!title || !content) return
    const skill = await useAssistant.getState().createSkill({ title, content, kind: 'prompt' })
    if (!skill) return
    patch({ skillIds: [...draft.skillIds, skill.id] })
    setPromptDraft(null)
  }

  const toggleServer = (id: string) => {
    const all = mcpServers.map((server) => server.id)
    const current = draft.mcpServerIds.length ? draft.mcpServerIds : all
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    patch({ mcpServerIds: next.length === all.length ? [] : next })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? t('assistant.projects.edit') : t('assistant.projects.add')}
      width={920}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={onSave}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex max-h-[68vh] min-h-[460px]">
        <nav className="w-36 shrink-0 border-r border-[var(--border-subtle)] pr-2" role="tablist" aria-label={t('assistant.projects.edit')}>
          <div className="flex flex-col gap-0.5">
            {EDITOR_TABS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                onClick={() => setTab(entry)}
                className={`rounded-[var(--r-md)] px-2.5 py-1.5 text-left text-[length:var(--text-12)] transition-colors duration-[var(--dur-fast)] ${tab === entry ? 'bg-[var(--bg-hover)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
              >
                {t(TAB_LABELS[entry])}
              </button>
            ))}
          </div>
        </nav>
        <div className="no-scrollbar min-w-0 flex-1 overflow-y-auto pl-4" role="tabpanel" aria-label={t(TAB_LABELS[tab])}>
          {tab === 'basic' && (
            <div className="space-y-3">
              <AssistantIconField value={draft.icon} fallback="lucide:bot" onChange={(icon) => patch({ icon })} />
              <Field label={t('assistant.projects.name')}>
                <Input value={draft.name} maxLength={200} onChange={(event) => patch({ name: event.target.value })} />
              </Field>
              <Field label={t('assistant.projects.description')}>
                <Textarea value={draft.description} rows={2} maxLength={2000} onChange={(event) => patch({ description: event.target.value })} />
              </Field>
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
              <Field label={t('assistant.projects.group')}>
                {creatingGroup ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={newGroup}
                      autoFocus
                      maxLength={60}
                      aria-label={t('assistant.projects.group_new')}
                      placeholder={t('assistant.projects.group_placeholder')}
                      onChange={(event) => setNewGroup(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || !newGroup.trim()) return
                        // A composition owns Enter; creating a group under an IME commit would eat the
                        // character the reader was still choosing.
                        if (isImeComposing(event.nativeEvent)) return
                        event.preventDefault()
                        patch({ group: newGroup.trim() })
                        setCreatingGroup(false)
                        setNewGroup('')
                      }}
                    />
                    <IconButton label={t('assistant.projects.group_create')} size="sm" disabled={!newGroup.trim()} onClick={() => { patch({ group: newGroup.trim() }); setCreatingGroup(false); setNewGroup('') }}>
                      <Check size={13} />
                    </IconButton>
                    <IconButton label={t('common.cancel')} size="sm" onClick={() => setCreatingGroup(false)}><X size={13} /></IconButton>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Select
                      aria-label={t('assistant.projects.group')}
                      value={groups.includes(draft.group) ? draft.group : ''}
                      onChange={(event) => {
                        if (event.target.value === '__new') { setCreatingGroup(true); return }
                        patch({ group: event.target.value })
                      }}
                      className="min-w-0 flex-1"
                    >
                      <option value="">{t('assistant.projects.group_none')}</option>
                      {groups.map((group) => <option key={group} value={group}>{group}</option>)}
                      <option value="__new">{t('assistant.projects.group_new')}</option>
                    </Select>
                    {draft.group && !groups.includes(draft.group) && (
                      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{draft.group}</span>
                    )}
                  </div>
                )}
              </Field>
            </div>
          )}

          {tab === 'model' && (
            <div>
              <ToggleRow
                title={t('assistant.projects.temperature')}
                description={t('assistant.projects.temperature_hint')}
                checked={draft.temperature !== null}
                onChange={(on) => patch({ temperature: on ? 1 : null })}
              >
                <Slider value={draft.temperature ?? 1} min={0} max={1.5} step={0.1} onChange={(temperature) => patch({ temperature })} label={t('assistant.projects.temperature')} />
              </ToggleRow>
              <ToggleRow
                title={t('assistant.projects.top_p')}
                checked={draft.topP !== null}
                onChange={(on) => patch({ topP: on ? 1 : null })}
              >
                <Slider value={draft.topP ?? 1} min={0} max={1} step={0.05} onChange={(topP) => patch({ topP })} label={t('assistant.projects.top_p')} />
              </ToggleRow>
              <ToggleRow
                title={t('assistant.projects.max_tokens')}
                checked={draft.maxOutputTokens !== null}
                onChange={(on) => patch({ maxOutputTokens: on ? 4096 : null })}
              >
                <Input
                  type="number"
                  min={64}
                  max={200000}
                  aria-label={t('assistant.projects.max_tokens')}
                  value={draft.maxOutputTokens ?? 4096}
                  onChange={(event) => patch({ maxOutputTokens: Math.max(64, Number(event.target.value) || 64) })}
                  className="w-36"
                />
              </ToggleRow>
              <ToggleRow title={t('assistant.projects.stream')} description={t('assistant.projects.stream_hint')} checked={draft.stream} onChange={(stream) => patch({ stream })} />
              <ToggleRow
                title={t('assistant.projects.max_tool_rounds')}
                checked={draft.maxToolRounds !== null}
                onChange={(on) => patch({ maxToolRounds: on ? 20 : null })}
              >
                <Input
                  type="number"
                  min={1}
                  max={50}
                  aria-label={t('assistant.projects.max_tool_rounds')}
                  value={draft.maxToolRounds ?? 20}
                  onChange={(event) => patch({ maxToolRounds: Math.min(50, Math.max(1, Number(event.target.value) || 1)) })}
                  className="w-28"
                />
              </ToggleRow>
              <ToggleRow
                title={t('assistant.projects.keep_recent')}
                checked={draft.keepRecentMessages !== null}
                onChange={(on) => patch({ keepRecentMessages: on ? 20 : null })}
              >
                <Input
                  type="number"
                  min={1}
                  max={200}
                  aria-label={t('assistant.projects.keep_recent')}
                  value={draft.keepRecentMessages ?? 20}
                  onChange={(event) => patch({ keepRecentMessages: Math.min(200, Math.max(1, Number(event.target.value) || 1)) })}
                  className="w-28"
                />
              </ToggleRow>
              <ToggleRow
                title={t('assistant.projects.context_custom')}
                description={draft.contextCustom ? undefined : t('assistant.projects.context_global')}
                checked={draft.contextCustom}
                onChange={(contextCustom) => patch({ contextCustom })}
              >
                <div className="space-y-2">
                  <Segmented
                    value={draft.autoCompactMode}
                    options={[
                      { value: 'off', label: t('assistant.projects.compact_off') },
                      { value: 'absolute', label: t('assistant.projects.compact_absolute') },
                      { value: 'ratio', label: t('assistant.projects.compact_ratio') },
                    ]}
                    onChange={(autoCompactMode) => patch({ autoCompactMode })}
                    size="sm"
                  />
                  {draft.autoCompactMode === 'absolute' && (
                    <Field label={t('assistant.projects.compact_tokens')}>
                      <Input
                        type="number"
                        min={10000}
                        max={2000000}
                        value={draft.autoCompactTokens}
                        onChange={(event) => patch({ autoCompactTokens: Math.min(2000000, Math.max(10000, Number(event.target.value) || 10000)) })}
                        className="w-40"
                      />
                    </Field>
                  )}
                  {draft.autoCompactMode === 'ratio' && (
                    <Slider
                      value={Math.round(draft.autoCompactRatio * 100)}
                      min={30}
                      max={95}
                      step={5}
                      suffix="%"
                      label={t('assistant.projects.compact_ratio_label')}
                      onChange={(percent) => patch({ autoCompactRatio: percent / 100 })}
                    />
                  )}
                </div>
              </ToggleRow>
              <div className="pt-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[length:var(--text-12-5)] text-[var(--text-primary)]">{t('assistant.projects.custom_params')}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Plus size={13} />}
                    disabled={draft.customParams.length >= MAX_CUSTOM_PARAMS}
                    onClick={() => patch({ customParams: [...draft.customParams, { name: '', type: 'string', value: '' }] })}
                  >
                    {t('assistant.projects.param_add')}
                  </Button>
                </div>
                {!draft.customParams.length && <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.projects.params_empty')}</p>}
                <div className="mt-1.5 space-y-1.5">
                  {draft.customParams.map((param, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <Input
                        value={param.name}
                        aria-label={t('assistant.projects.param_name')}
                        placeholder={t('assistant.projects.param_name')}
                        maxLength={41}
                        onChange={(event) => patch({ customParams: draft.customParams.map((entry, at) => at === index ? { ...entry, name: event.target.value } : entry) })}
                        className="min-w-0 flex-1"
                      />
                      <Select
                        aria-label={t('assistant.projects.param_type')}
                        value={param.type}
                        onChange={(event) => patch({ customParams: draft.customParams.map((entry, at) => at === index ? { ...entry, type: event.target.value as AssistantParamType } : entry) })}
                        className="w-28 shrink-0"
                      >
                        {ASSISTANT_PARAM_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </Select>
                      <Input
                        value={param.value}
                        aria-label={t('assistant.projects.param_value')}
                        placeholder={t('assistant.projects.param_value')}
                        onChange={(event) => patch({ customParams: draft.customParams.map((entry, at) => at === index ? { ...entry, value: event.target.value } : entry) })}
                        className="min-w-0 flex-1"
                      />
                      <IconButton
                        label={t('assistant.projects.param_remove')}
                        size="sm"
                        className="text-[var(--danger)]"
                        onClick={() => patch({ customParams: draft.customParams.filter((_entry, at) => at !== index) })}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'system' && (
            <div className="space-y-4">
              <Field label={t('assistant.projects.tab_system')} hint={t('assistant.projects.instructions_hint')}>
                <Textarea
                  value={draft.instructions}
                  maxLength={MAX_INSTRUCTIONS}
                  rows={12}
                  onChange={(event) => patch({ instructions: event.target.value })}
                />
                <p className="mt-1 text-right text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('assistant.projects.instructions_tokens', { count: estimateTokens(draft.instructions) })}
                </p>
              </Field>
              <div className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
                <SettingRow title={t('assistant.projects.focus_sync')} description={t('assistant.projects.focus_sync_hint')}>
                  <Switch checked={draft.focusSync} label={t('assistant.projects.focus_sync')} onChange={(focusSync) => patch({ focusSync })} />
                </SettingRow>
                <SettingRow title={t('assistant.projects.time_aware')} description={t('assistant.projects.time_aware_hint')}>
                  <Switch checked={draft.timeAware} label={t('assistant.projects.time_aware')} onChange={(timeAware) => patch({ timeAware })} />
                </SettingRow>
                <SettingRow title={t('assistant.projects.read_project_instructions')} description={t('assistant.projects.read_project_instructions_hint')}>
                  <Switch
                    checked={draft.readProjectInstructions}
                    label={t('assistant.projects.read_project_instructions')}
                    onChange={(readProjectInstructions) => patch({ readProjectInstructions })}
                  />
                </SettingRow>
              </div>
            </div>
          )}

          {tab === 'prompts' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[length:var(--text-12-5)] text-[var(--text-primary)]">
                  {t('assistant.projects.tab_prompts')}
                  <span className="ml-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.projects.prompts_current')}</span>
                </span>
                <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => useAssistant.getState().setView('skills')}>
                  {t('assistant.projects.prompt_manage')}
                </Button>
                <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setPromptDraft({ title: '', content: '' })}>
                  {t('assistant.projects.prompt_add')}
                </Button>
                <Button ref={bindRef} size="sm" variant="ghost" icon={<Plus size={13} />} disabled={!bindablePrompts.length} onClick={() => setBinding((open) => !open)}>
                  {t('assistant.projects.prompt_bind')}
                </Button>
                <Menu
                  anchor={bindRef}
                  open={binding}
                  onClose={() => setBinding(false)}
                  items={bindablePrompts.map((skill): MenuItem => ({
                    id: skill.id,
                    label: skill.title || t('assistant.skills.untitled'),
                    icon: <FileText size={13} />,
                    onSelect: () => patch({ skillIds: [...draft.skillIds, skill.id] }),
                  }))}
                  width={220}
                  searchable={bindablePrompts.length > 8}
                  label={t('assistant.projects.prompt_bind')}
                />
              </div>

              {promptDraft && (
                <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5">
                  <Input
                    value={promptDraft.title}
                    placeholder={t('assistant.projects.prompt_new_title')}
                    aria-label={t('assistant.projects.prompt_new_title')}
                    maxLength={200}
                    onChange={(event) => setPromptDraft({ ...promptDraft, title: event.target.value })}
                  />
                  <Textarea
                    value={promptDraft.content}
                    placeholder={t('assistant.projects.prompt_new_content')}
                    aria-label={t('assistant.projects.prompt_new_content')}
                    rows={3}
                    onChange={(event) => setPromptDraft({ ...promptDraft, content: event.target.value })}
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setPromptDraft(null)}>{t('common.cancel')}</Button>
                    <Button size="sm" variant="primary" disabled={!promptDraft.title.trim() || !promptDraft.content.trim()} onClick={() => void createPrompt()}>
                      {t('assistant.projects.prompt_create')}
                    </Button>
                  </div>
                </div>
              )}

              {boundPrompts.length ? (
                <ul className="space-y-1.5">
                  {boundPrompts.map((skill) => (
                    <li key={skill.id} className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
                      <FileText size={13} className="mt-0.5 shrink-0 text-[var(--text-quaternary)]" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{skill.title || t('assistant.skills.untitled')}</p>
                        <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">{skill.content.replace(/\s+/g, ' ').slice(0, 120)}</p>
                      </div>
                      <IconButton
                        label={t('assistant.projects.prompt_unbind', { name: skill.title || t('assistant.skills.untitled') })}
                        size="sm"
                        onClick={() => patch({ skillIds: draft.skillIds.filter((id) => id !== skill.id) })}
                      >
                        <X size={12} />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] px-3 py-6 text-center">
                  <FileText size={18} className="mx-auto text-[var(--text-quaternary)]" />
                  <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.projects.prompts_empty')}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'builtin' && (
            <div className="space-y-4">
              <Field label={t('assistant.projects.tools')} hint={t('assistant.projects.tools_hint')}>
                <ProjectToolsPicker
                  value={draft.tools}
                  limited={draft.toolsLimited}
                  onChange={(tools) => patch({ tools })}
                  onLimitedChange={(toolsLimited) => patch({ toolsLimited })}
                />
              </Field>
              <Field label={t('assistant.projects.skills')} hint={t('assistant.projects.skills_hint')}>
                <ProjectSkillsPicker value={draft.skillIds} onChange={(skillIds) => patch({ skillIds })} />
              </Field>
            </div>
          )}

          {tab === 'knowledge' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-[length:var(--text-12-5)] text-[var(--text-primary)]">{t('assistant.projects.kb_linked')}</span>
                  <AddKnowledgeBaseMenu
                    available={availableBases.map((base) => ({ id: base.id, label: base.name }))}
                    onPick={(id) => patch({ knowledgeBaseIds: [...draft.knowledgeBaseIds, id] })}
                  />
                </div>
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.projects.kb_hint')}</p>
                {linkedBases.length ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {linkedBases.map((base) => (
                      <li key={base.id} className="flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] py-0.5 pr-0.5 pl-1.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                        <FolderOpen size={11} className="shrink-0 text-[var(--text-quaternary)]" />
                        <span className="max-w-[200px] truncate">{base.name}</span>
                        <IconButton label={t('assistant.projects.kb_remove', { name: base.name })} size="sm" onClick={() => patch({ knowledgeBaseIds: draft.knowledgeBaseIds.filter((id) => id !== base.id) })}>
                          <X size={11} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] px-3 py-4 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.projects.kb_empty')}</p>
                )}
              </div>
              <Field label={t('assistant.projects.knowledge')} hint={t('assistant.projects.knowledge_hint')}>
                <NoteScopePicker value={draft.noteScope} onChange={(ids) => patch({ noteScope: ids })} disabled={busy} />
              </Field>
              <Field label={t('assistant.projects.exclude_scope')} hint={t('assistant.projects.exclude_scope_hint')}>
                <NoteScopePicker value={draft.excludeScope} onChange={(ids) => patch({ excludeScope: ids })} disabled={busy} />
              </Field>
              <Field label={t('assistant.projects.notes')} hint={t('assistant.projects.notes_hint')}>
                <ProjectNotesPicker value={draft.noteIds} onChange={(ids) => patch({ noteIds: ids })} disabled={busy} />
              </Field>
            </div>
          )}

          {tab === 'mcp' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[length:var(--text-12-5)] text-[var(--text-primary)]">{t('assistant.projects.mcp_mode')}</span>
                <Segmented
                  value={draft.mcpMode}
                  options={[
                    { value: 'off', label: t('assistant.projects.mcp_off') },
                    { value: 'auto', label: t('assistant.projects.mcp_auto') },
                    { value: 'manual', label: t('assistant.projects.mcp_manual') },
                  ]}
                  onChange={(mcpMode) => patch({ mcpMode })}
                  size="sm"
                />
              </div>
              {draft.mcpMode === 'manual' && (
                <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.projects.mcp_manual_hint')}</p>
              )}
              <div>
                <p className="mb-1 text-[length:var(--text-12-5)] text-[var(--text-primary)]">{t('assistant.projects.mcp_servers')}</p>
                {mcpServers.length ? (
                  <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                    {mcpServers.map((server) => {
                      const checked = !draft.mcpServerIds.length || draft.mcpServerIds.includes(server.id)
                      return (
                        <div key={server.id} className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-1.5 last:border-b-0">
                          <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{server.label}</span>
                          <Switch
                            checked={checked}
                            label={server.label}
                            disabled={draft.mcpMode === 'off'}
                            onChange={() => toggleServer(server.id)}
                          />
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.projects.mcp_none')}</p>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </Modal>
  )
}

/** The knowledge bases this assistant may link, as a searchable menu. */
function AddKnowledgeBaseMenu({ available, onPick }: {
  available: Array<{ id: string, label: string }>
  onPick: (id: string) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button ref={ref} size="sm" variant="ghost" icon={<Plus size={13} />} disabled={!available.length} onClick={() => setOpen((value) => !value)}>
        {t('assistant.projects.kb_add')}
      </Button>
      <Menu
        anchor={ref}
        open={open}
        onClose={() => setOpen(false)}
        items={available.map((base): MenuItem => ({
          id: base.id,
          label: base.label,
          icon: <FolderOpen size={13} />,
          onSelect: () => onPick(base.id),
        }))}
        width={220}
        searchable={available.length > 8}
        label={t('assistant.projects.kb_search')}
      />
    </>
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

/**
 * The tools an Agent may use.
 *
 * The account's policy is the ceiling; this list is the Agent's own narrowing. The switch is separate
 * from the list because "no tools" and "no restriction" are both an empty array.
 */
function ProjectToolsPicker({ value, limited, onChange, onLimitedChange }: {
  value: string[]
  limited: boolean
  onChange: (names: string[]) => void
  onLimitedChange: (limited: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return ASSISTANT_TOOL_SPECS.filter((spec) =>
      !needle || spec.name.toLocaleLowerCase().includes(needle) || t(spec.labelKey).toLocaleLowerCase().includes(needle))
  }, [query])
  const toggle = (name: string) => {
    onChange(value.includes(name) ? value.filter((entry) => entry !== name) : [...value, name])
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('assistant.projects.tools_limit')}</span>
        <Switch checked={limited} label={t('assistant.projects.tools_limit')} onChange={onLimitedChange} />
      </div>
      {limited ? (
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          <div className="border-b border-[var(--border-subtle)] p-1.5">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('assistant.projects.tools_search')}
              aria-label={t('assistant.projects.tools_search')}
              className="h-8 text-[length:var(--text-12)]"
            />
          </div>
          <div className="max-h-44 overflow-y-auto p-1.5">
            {rows.map((spec) => (
              <Checkbox
                key={spec.name}
                checked={value.includes(spec.name)}
                onChange={() => toggle(spec.name)}
                label={t(spec.labelKey)}
                className="w-full min-h-8 text-[length:var(--text-12)]"
              />
            ))}
            {!rows.length && <p className="px-2 py-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('assistant.projects.tools_none')}</p>}
          </div>
          <p className="border-t border-[var(--border-subtle)] px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('assistant.projects.tools_count', { count: value.length })}
          </p>
        </div>
      ) : (
        <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('assistant.projects.tools_all')}</p>
      )}
    </div>
  )
}

function ProjectSkillsPicker({ value, onChange }: { value: string[], onChange: (ids: string[]) => void }) {
  const skills = useAssistant((state) => state.skills)
  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id])
  }
  if (!skills.length) return <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('assistant.projects.skills_none')}</p>
  return (
    <div className="max-h-40 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] p-1.5">
      {skills.map((skill) => (
        <Checkbox
          key={skill.id}
          checked={value.includes(skill.id)}
          onChange={() => toggle(skill.id)}
          label={skill.title || t('assistant.skills.untitled')}
          className="w-full min-h-8 text-[length:var(--text-12)]"
        />
      ))}
    </div>
  )
}

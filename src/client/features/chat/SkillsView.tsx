/**
 * The reader's own skills.
 *
 * A skill is a piece of the reader's work, not a setting: it is written once and used in many
 * conversations, so it gets its own view, its own search, and a delete that asks first. The composer
 * reads the same list through the store, which is why nothing here keeps a copy.
 *
 * What separates a skill from a saved snippet is the arrangement around its words — the tools it wants,
 * the folders it reads, the model that answers — because a phrase the reader types twice a week is
 * rarely only a phrase: half of what they retype each time is "and look in my work folder with the big
 * model". Those three travel with the text and are applied together when the skill is picked. An emoji
 * is the fourth, smaller part: a dozen skills in a list are easier to tell apart by sight than by
 * reading every title.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Download, FileText, Folder, MoreHorizontal, Pencil, Plus, Search, Sparkles, Trash2, Upload, Wrench } from 'lucide-react'
import type { AssistantModel, AssistantTurnScope, AssistantSkill, SkillImportSkip } from '@shared/assistant'
import { MAX_SKILL_CONTENT_CHARS, MAX_SKILL_ICON_CHARS, MAX_SKILL_TITLE_CHARS, MAX_TURN_SCOPES, MAX_TURN_TOOLS } from '@shared/assistant'
import { ASSISTANT_TOOL_BY_NAME } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { useDebounced } from '../../lib/hooks'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select, Textarea } from '../../components/form'
import { Menu, Modal, confirm, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { NoteScopePicker, useVaultFolders } from './NoteScopePicker'
import { readSkillBundleFile } from './skill-bundle'
import { exampleSkills } from './skill-examples'

const UNGROUPED = '__none__'

/** What the editor holds while it is open: the saved row, or an empty one being written. */
interface Draft {
  id: string | null
  title: string
  content: string
  group: string
  icon: string
  tools: string[]
  scopes: AssistantTurnScope[]
  modelId: string | null
}

const EMPTY: Draft = { id: null, title: '', content: '', group: '', icon: '', tools: [], scopes: [], modelId: null }

const draftOf = (skill: AssistantSkill): Draft => ({
  id: skill.id,
  title: skill.title,
  content: skill.content,
  group: skill.group,
  icon: skill.icon,
  tools: skill.tools,
  scopes: skill.scopes,
  modelId: skill.modelId,
})

/** The binding summary one row shows under its words, or nothing when the skill is only words. */
function bindingHint(skill: AssistantSkill, models: AssistantModel[]): string {
  const parts: string[] = []
  if (skill.tools.length) parts.push(t('assistant.skills.tools_count', { count: skill.tools.length }))
  if (skill.scopes.length) parts.push(t('assistant.skills.knowledge_count', { count: skill.scopes.length }))
  const model = skill.modelId ? models.find((entry) => entry.id === skill.modelId) : null
  if (model) parts.push(model.label || model.model)
  return parts.join(' · ')
}

function SkillEditor({ draft, models, busy, onChange, onSubmit, onClose }: {
  draft: Draft
  models: AssistantModel[]
  busy: boolean
  onChange: (draft: Draft) => void
  onSubmit: (draft: Draft) => void
  onClose: () => void
}) {
  const patch = (part: Partial<Draft>) => onChange({ ...draft, ...part })
  const folders = useVaultFolders()
  // The built-in registry is what a reader may pin by name; a remote tool they have not listed here would
  // be a name nothing can resolve later, so the picker offers only what the assistant always has.
  const tools = useMemo(() => [...ASSISTANT_TOOL_BY_NAME.keys()], [])
  const toggleTool = (name: string) => {
    if (draft.tools.includes(name)) patch({ tools: draft.tools.filter((entry) => entry !== name) })
    else if (draft.tools.length < MAX_TURN_TOOLS) patch({ tools: [...draft.tools, name] })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? t('assistant.skills.edit') : t('assistant.skills.new')}
      width={620}
      bodyClassName="p-4 space-y-3"
      footer={(
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!draft.title.trim() && !draft.content.trim()}
            onClick={() => onSubmit(draft)}
          >
            {t('assistant.skills.save')}
          </Button>
        </>
      )}
    >
      {/* The icon leads the name, the way it leads the row in the list: one narrow box, and the name takes
          the rest of the line. */}
      <div className="flex items-center gap-2">
        <Input
          value={draft.icon}
          maxLength={MAX_SKILL_ICON_CHARS}
          aria-label={t('assistant.skills.icon')}
          placeholder={t('assistant.skills.icon_hint')}
          className="w-14 text-center"
          onChange={(event) => patch({ icon: event.target.value })}
        />
        <Input autoFocus value={draft.title} maxLength={MAX_SKILL_TITLE_CHARS} aria-label={t('assistant.skills.field_title')} placeholder={t('assistant.skills.field_title')} onChange={(event) => patch({ title: event.target.value })} />
      </div>
      <Input value={draft.group} maxLength={60} aria-label={t('assistant.skills.group')} placeholder={t('assistant.skills.group')} onChange={(event) => patch({ group: event.target.value })} />
      <Textarea
        value={draft.content}
        maxLength={MAX_SKILL_CONTENT_CHARS}
        rows={9}
        aria-label={t('assistant.skills.field_content')}
        placeholder={t('assistant.skills.field_content')}
        className="w-full resize-y font-mono text-[length:var(--text-12-5)]"
        onChange={(event) => patch({ content: event.target.value })}
      />
      <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{draft.content.length} / {MAX_SKILL_CONTENT_CHARS}</p>

      <Field label={t('assistant.skills.tools')} hint={t('assistant.skills.tools_hint')}>
        <div className="flex flex-wrap gap-1">
          {tools.map((name) => {
            const spec = ASSISTANT_TOOL_BY_NAME.get(name)!
            const on = draft.tools.includes(name)
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                onClick={() => toggleTool(name)}
                className={cn(
                  'rounded-[var(--r-sm)] border px-2 py-0.5 text-[length:var(--text-11-5)] transition-colors duration-[var(--dur-fast)]',
                  on
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {t(spec.labelKey)}
              </button>
            )
          })}
        </div>
      </Field>

      <Field label={t('assistant.skills.knowledge')} hint={t('assistant.skills.knowledge_hint')}>
        <NoteScopePicker
          value={draft.scopes.map((entry) => entry.id)}
          onChange={(ids) => patch({
            scopes: ids.slice(0, MAX_TURN_SCOPES).map((id) => ({
              kind: 'folder' as const,
              id,
              name: folders.find((folder) => folder.id === id)?.path ?? '',
            })),
          })}
          disabled={busy}
        />
      </Field>

      <Field label={t('assistant.skills.model')} hint={t('assistant.skills.model_hint')}>
        <Select
          aria-label={t('assistant.skills.model')}
          value={draft.modelId ?? ''}
          onChange={(event) => patch({ modelId: event.target.value || null })}
        >
          <option value="">{t('assistant.skills.model_follow')}</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>{model.label || model.model}</option>
          ))}
        </Select>
      </Field>
    </Modal>
  )
}

export function SkillsView() {
  const skills = useAssistant((state) => state.skills)
  const loadSkills = useAssistant((state) => state.loadSkills)
  const createSkill = useAssistant((state) => state.createSkill)
  const saveSkill = useAssistant((state) => state.saveSkill)
  const removeSkill = useAssistant((state) => state.removeSkill)
  const models = useAssistant((state) => state.models)
  const loadSettings = useAssistant((state) => state.loadSettings)
  const exportSkills = useAssistant((state) => state.exportSkills)
  const importSkills = useAssistant((state) => state.importSkills)
  const toast = useUi((state) => state.toast)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const bundleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void loadSkills() }, [loadSkills])
  // The model bound to a skill is named by id, so the list has to be there before the editor can offer it.
  useEffect(() => { void loadSettings() }, [loadSettings])
  const settledQuery = useDebounced(query, 180)
  useEffect(() => {
    void loadSkills(settledQuery.trim() || undefined)
  }, [settledQuery, loadSkills])

  const chatModels = useMemo(() => models.filter((model) => model.enabled && model.purpose === 'chat'), [models])

  const groups = useMemo(() => {
    const order: string[] = []
    const buckets = new Map<string, AssistantSkill[]>()
    for (const skill of skills) {
      const key = skill.group || UNGROUPED
      if (!buckets.has(key)) { buckets.set(key, []); order.push(key) }
      buckets.get(key)!.push(skill)
    }
    return order.map((key) => ({ key, label: key === UNGROUPED ? t('assistant.skills.ungrouped') : key, rows: buckets.get(key)! }))
  }, [skills])

  const submit = async (next: Draft) => {
    setBusy(true)
    try {
      const input = {
        title: next.title.trim() || next.content.trim().slice(0, 40),
        content: next.content,
        group: next.group.trim(),
        icon: next.icon.trim(),
        tools: next.tools,
        scopes: next.scopes,
        modelId: next.modelId,
      }
      if (next.id) await saveSkill(next.id, input)
      else await createSkill(input)
      setDraft(null)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (skill: AssistantSkill) => {
    const ok = await confirm({
      title: t('assistant.skills.delete'),
      description: skill.title,
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (ok) await removeSkill(skill.id)
  }

  // A bundle's rows are not patched into the list the way a single edit is: an import may add hundreds,
  // and this view is the one that knows which search is on screen, so it re-reads with its own.
  const runImport = async (entries: unknown[]) => {
    const result = await importSkills(entries)
    if (!result) return
    await loadSkills(settledQuery.trim() || undefined)
    // Counted by reason rather than listed: a file that came from somewhere else tends to fail the same
    // way many times over, and the same sentence eighty times is not a report.
    const byReason = new Map<SkillImportSkip, number>()
    for (const entry of result.skipped) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1)
    toast({
      title: result.imported
        ? t('assistant.skills.import_done', { count: result.imported })
        : t('assistant.skills.import_none'),
      ...(byReason.size
        ? {
          description: t('assistant.skills.import_skipped', {
            count: result.skipped.length,
            reasons: [...byReason]
              .map(([reason, count]) => `${t(`assistant.skills.import.reason.${reason}` as 'assistant.skills.import.reason.shape')} ×${count}`)
              .join(', '),
          }),
        }
        : {}),
      tone: result.imported ? 'success' : 'danger',
    })
  }

  const takeBundle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    // Cleared before the read, so picking the same file twice in a row still fires a change.
    event.target.value = ''
    if (!file) return
    try {
      await runImport(await readSkillBundleFile(file))
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('assistant.toast.failed'), tone: 'danger' })
    }
  }

  const menuItems: MenuItem[] = [
    { id: 'import', label: t('assistant.skills.import'), icon: <Upload size={13} />, onSelect: () => bundleRef.current?.click() },
    { id: 'export', label: t('assistant.skills.export'), icon: <Download size={13} />, onSelect: () => void exportSkills() },
    { id: 'examples', label: t('assistant.skills.add_examples'), icon: <Sparkles size={13} />, separatorBefore: true, onSelect: () => void runImport(exampleSkills()) },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* The wrapper carries the row's growth: the field hands its own `className` to the `<input>`, which
            cannot size the box around it. */}
        <div className="min-w-0 flex-1">
          <Input
            value={query}
            aria-label={t('assistant.skills.search')}
            placeholder={t('assistant.skills.search')}
            leading={<Search size={13} />}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDraft(EMPTY)}>{t('assistant.skills.new')}</Button>
        <span ref={anchor}>
          <IconButton label={t('assistant.skills.more')} size="sm" onClick={() => setMenuOpen((open) => !open)}>
            <MoreHorizontal size={15} />
          </IconButton>
        </span>
        <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} width={200} label={t('assistant.skills.more')} />
        <input ref={bundleRef} type="file" accept="application/json,.json" hidden onChange={(event) => void takeBundle(event)} />
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!skills.length && (
          <div className="px-2 py-6 text-center">
            <p className="text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('assistant.skills.empty')}</p>
            {/* An empty list is where the idea of a skill is least obvious, so the examples are offered
                here as well as in the menu — this is the one place a reader has nothing else to press. */}
            <Button size="sm" variant="secondary" className="mt-2" icon={<Sparkles size={13} />} onClick={() => void runImport(exampleSkills())}>
              {t('assistant.skills.add_examples')}
            </Button>
          </div>
        )}
        {groups.map((bucket) => (
          <section key={bucket.key} className="mb-2">
            <h3 className="px-2 py-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{bucket.label}</h3>
            <ul className="space-y-1">
              {bucket.rows.map((skill) => {
                const hint = bindingHint(skill, chatModels)
                return (
                  <li key={skill.id} className="group flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2 hover:border-[var(--border-default)]">
                    {/* The skill's own mark when it has one, the generic glyph when it does not. Both occupy
                        the same column, so a mixed list still reads down a straight edge. */}
                    {skill.icon
                      ? <span aria-hidden className="w-[13px] shrink-0 text-center text-[length:var(--text-12-5)] leading-[16px]">{skill.icon}</span>
                      : <FileText size={13} className="mt-0.5 shrink-0 text-[var(--text-quaternary)]" />}
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setDraft(draftOf(skill))}>
                      <span className="block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{skill.title}</span>
                      <span className={cn('block truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]')}>{skill.content.replace(/\s+/g, ' ')}</span>
                      {hint && (
                        <span className="mt-0.5 flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          {skill.tools.length > 0 && <Wrench size={10} aria-hidden />}
                          {skill.scopes.length > 0 && <Folder size={10} aria-hidden />}
                          {hint}
                        </span>
                      )}
                    </button>
                    <IconButton label={t('assistant.skills.edit')} size="xs" onClick={() => setDraft(draftOf(skill))}><Pencil size={12} /></IconButton>
                    <IconButton label={t('assistant.skills.delete')} size="xs" onClick={() => void remove(skill)}><Trash2 size={12} /></IconButton>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      {draft && (
        <SkillEditor
          draft={draft}
          models={chatModels}
          busy={busy}
          onChange={setDraft}
          onSubmit={(next) => void submit(next)}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  )
}

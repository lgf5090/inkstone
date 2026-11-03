/**
 * Knowledge bases: named slices of the notebook's AI index.
 *
 * A knowledge base owns no vectors. The account-wide embeddings answer every one of them; the scope is a
 * query-time filter, so editing a collection does not rebuild anything. The screen therefore has one
 * honesty rule: it never promises that an index exists — it says whether the notebook's AI index is on,
 * and names the count it can see.
 */
import { useEffect, useState } from 'react'
import { Database, FolderOpen, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import type { KnowledgeBase } from '@shared/assistant'
import { api } from '../../lib/api'
import { Button, Spinner } from '../../components/primitives'
import { Field, Input, Select, SettingRow, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { t } from '../../lib/i18n'
import { useAssistant } from './assistant-store'
import { NoteScopePicker } from './NoteScopePicker'
import { Group } from './assistant-settings-shared'

const CHUNK_CHOICES = [800, 1_200, 1_500, 2_000, 3_000]
const CONCURRENCY_CHOICES = [1, 2, 3, 4]

interface Draft {
  id: string | null
  name: string
  description: string
  includeScope: string[]
  excludeScope: string[]
}

const EMPTY: Draft = { id: null, name: '', description: '', includeScope: [], excludeScope: [] }

const draftOf = (kb: KnowledgeBase): Draft => ({
  id: kb.id,
  name: kb.name,
  description: kb.description,
  includeScope: kb.includeScope,
  excludeScope: kb.excludeScope,
})

export function KnowledgeTab() {  const knowledgeBases = useAssistant((state) => state.knowledgeBases)
  const loadKnowledgeBases = useAssistant((state) => state.loadKnowledgeBases)
  const createKnowledgeBase = useAssistant((state) => state.createKnowledgeBase)
  const updateKnowledgeBase = useAssistant((state) => state.updateKnowledgeBase)
  const deleteKnowledgeBase = useAssistant((state) => state.deleteKnowledgeBase)
  const settings = useAssistant((state) => state.settings)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ enabled: boolean, indexedCount: number, pendingCount: number } | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)

  const refreshStatus = async () => {
    setStatusBusy(true)
    try {
      const info = await api.mcp.get()
      setStatus({
        enabled: info.aiSearch.enabled,
        indexedCount: info.aiSearch.indexedCount,
        pendingCount: info.aiSearch.pendingCount,
      })
    } catch {
      // The knowledge bases still work without a status line; the line is an observation, not a gate.
      setStatus(null)
    } finally {
      setStatusBusy(false)
    }
  }

  useEffect(() => {
    void loadKnowledgeBases().finally(() => setLoading(false))
    void refreshStatus()
  }, [loadKnowledgeBases])

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    setBusy(true)
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        includeScope: draft.includeScope,
        excludeScope: draft.excludeScope,
      }
      const saved = draft.id
        ? await updateKnowledgeBase(draft.id, body)
        : await createKnowledgeBase(body)
      if (saved) setDraft(null)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (kb: KnowledgeBase) => {
    const agreed = await confirm({
      title: t('assistant.knowledge.delete_title', { name: kb.name }),
      description: t('assistant.knowledge.delete_hint'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    setBusy(true)
    try {
      await deleteKnowledgeBase(kb.id)
    } finally {
      setBusy(false)
    }
  }

  const missingIndex = status !== null && !status.enabled
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
          {t('assistant.knowledge.hint')}
        </p>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setDraft(EMPTY)}>
          {t('assistant.knowledge.new')}
        </Button>
      </div>

      {status && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <Database size={13} className={status.enabled ? 'text-[var(--success)]' : 'text-[var(--warning)]'} />
          <span>{status.enabled ? t('assistant.knowledge.index_on', { count: status.indexedCount }) : t('assistant.knowledge.index_off')}</span>
          {status.pendingCount > 0 && <span>· {t('assistant.knowledge.pending', { count: status.pendingCount })}</span>}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            loading={statusBusy}
            icon={<RefreshCw size={12} />}
            onClick={() => void refreshStatus()}
          >
            {t('assistant.knowledge.refresh')}
          </Button>
        </div>
      )}
      {missingIndex && (
        <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('assistant.knowledge.index_off_hint')}</p>
      )}

      {/* The two numbers a whole-book index is built from. They belong to the KB screen rather than the
          notes index because a book is the only source long enough for either to matter. */}
      <Group title={t('assistant.knowledge.index_settings')}>
        <SettingRow
          title={t('assistant.knowledge.chunk_chars')}
          description={t('assistant.knowledge.index_settings_hint')}
          controlId="kb-chunk-chars"
        >
          <Select
            id="kb-chunk-chars"
            value={String(settings?.kbChunkChars ?? 1_500)}
            onChange={(event) => { void saveSettings({ kbChunkChars: Number(event.target.value) }) }}
            className="h-8 w-36 text-[length:var(--text-12)]"
          >
            {CHUNK_CHOICES.map((count) => (
              <option key={count} value={count}>{t('assistant.knowledge.chunk_chars_value', { count })}</option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          title={t('assistant.knowledge.chunk_concurrency')}
          description={t('assistant.knowledge.chunk_concurrency_hint')}
          controlId="kb-chunk-concurrency"
        >
          <Select
            id="kb-chunk-concurrency"
            value={String(settings?.kbChunkConcurrency ?? 1)}
            onChange={(event) => { void saveSettings({ kbChunkConcurrency: Number(event.target.value) }) }}
            className="h-8 w-36 text-[length:var(--text-12)]"
          >
            {CONCURRENCY_CHOICES.map((count) => (
              <option key={count} value={count}>{t('assistant.knowledge.chunk_concurrency_value', { count })}</option>
            ))}
          </Select>
        </SettingRow>
      </Group>

      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : !knowledgeBases.length ? (
        <Empty art="notes" compact title={t('assistant.knowledge.empty')} />
      ) : (
        <ul className="space-y-2">
          {knowledgeBases.map((kb) => (
            <li key={kb.id} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">{kb.name}</span>
                <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setDraft(draftOf(kb))}>{t('common.edit')}</Button>
                <Button size="sm" variant="ghost" className="text-[var(--danger)]" icon={<Trash2 size={13} />} disabled={busy} onClick={() => void remove(kb)}>{t('common.delete')}</Button>
              </div>
              {kb.description && <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{kb.description}</p>}
              <p className="mt-2 flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                <FolderOpen size={11} />
                {kb.includeScope.length ? t('assistant.knowledge.scope_count', { count: kb.includeScope.length }) : t('assistant.knowledge.scope_all')}
              </p>
              {kb.excludeScope.length > 0 && (
                <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('assistant.knowledge.excluded_count', { count: kb.excludeScope.length })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {draft && (
        <KnowledgeEditor draft={draft} busy={busy} onChange={setDraft} onSave={() => void save()} onClose={() => setDraft(null)} />
      )}
    </div>
  )
}

function KnowledgeEditor({ draft, busy, onChange, onSave, onClose }: {
  draft: Draft
  busy: boolean
  onChange: (draft: Draft) => void
  onSave: () => void
  onClose: () => void
}) {
  const patch = (part: Partial<Draft>) => onChange({ ...draft, ...part })
  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? t('assistant.knowledge.edit') : t('assistant.knowledge.new')}
      width={560}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={onSave}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('assistant.knowledge.name')}>
          <Input value={draft.name} maxLength={120} onChange={(event) => patch({ name: event.target.value })} />
        </Field>
        <Field label={t('assistant.knowledge.description')} hint={t('assistant.knowledge.description_hint')}>
          <Textarea value={draft.description} maxLength={2000} rows={3} onChange={(event) => patch({ description: event.target.value })} />
        </Field>
        <Field label={t('assistant.knowledge.include')} hint={t('assistant.knowledge.include_hint')}>
          <NoteScopePicker value={draft.includeScope} onChange={(includeScope) => patch({ includeScope })} disabled={busy} />
        </Field>
        <Field label={t('assistant.knowledge.exclude')} hint={t('assistant.knowledge.exclude_hint')}>
          <NoteScopePicker value={draft.excludeScope} onChange={(excludeScope) => patch({ excludeScope })} disabled={busy} />
        </Field>
      </div>
    </Modal>
  )
}

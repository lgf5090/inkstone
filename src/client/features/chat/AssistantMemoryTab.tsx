/**
 * The memory tab: what is remembered, how recall is embedded, and which notes may feed it.
 */
import { useEffect, useState } from 'react'
import { type AssistantSettings } from '@shared/assistant'
import { SEMANTIC_MODEL_PATTERN } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button } from '../../components/primitives'
import { Input, SettingRow, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { Group } from './assistant-settings-shared'
import { NoteScopePicker } from './NoteScopePicker'

export function MemoryTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  return (
    <>
      <Group title={t('assistant.settings.memory')}>
        <SettingRow title={t('assistant.settings.auto_memory')} description={t('assistant.settings.auto_memory_hint')}>
          <Switch checked={settings.autoMemory} onChange={(value) => void saveSettings({ autoMemory: value })} label={t('assistant.settings.auto_memory')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.conflict_review')} description={t('assistant.settings.conflict_review_hint')}>
          <Switch checked={settings.conflictReview} onChange={(value) => void saveSettings({ conflictReview: value })} label={t('assistant.settings.conflict_review')} />
        </SettingRow>
        {settings.conflictReview && (
          <SettingRow title={t('assistant.settings.ai_conflict')} description={t('assistant.settings.ai_conflict_hint')}>
            <Switch checked={settings.aiConflictCheck} onChange={(value) => void saveSettings({ aiConflictCheck: value })} label={t('assistant.settings.ai_conflict')} />
          </SettingRow>
        )}
      </Group>
      <SemanticRecallRow settings={settings} />
      <NoteScopeRow />
    </>
  )
}

/**
 * The vector index over the reader's memories.
 *
 * The switch is a settings field, so it saves like any other; the numbers come from the server
 * because only it knows how many vectors exist and what the deployment can embed.
 */
function SemanticRecallRow({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.assistant.semantic>> | null>(null)
  const [busy, setBusy] = useState<'reindex' | 'clear' | null>(null)
  const [model, setModel] = useState(settings.semanticModel)
  const toast = useUi((state) => state.toast)

  // Another device, or the backfill this row itself starts, can leave the saved model behind the one
  // the field shows; the field follows the setting rather than the other way round.
  useEffect(() => {
    setModel(settings.semanticModel)
  }, [settings.semanticModel])

  const refresh = async () => {
    try {
      setStatus(await api.assistant.semantic())
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Group title={t('assistant.settings.semantic')}>
      <SettingRow title={t('assistant.settings.semantic')} description={t('assistant.settings.semantic_hint')}>
        <Switch
          checked={settings.semanticMemory}
          onChange={(value) => void saveSettings({ semanticMemory: value })}
          label={t('assistant.settings.semantic')}
        />
      </SettingRow>
      {!status ? (
        <p className="px-3 pb-2 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">…</p>
      ) : !status.available ? (
        <p className="px-3 pb-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('assistant.settings.semantic_off')}</p>
      ) : (
        <>
          <SettingRow
            title={t('assistant.settings.semantic_vectors', { count: status.vectors })}
            description={[
              status.pending > 0 ? t('assistant.settings.semantic_pending', { count: status.pending }) : '',
              t('assistant.settings.semantic_today', { used: status.today, cap: status.cap }),
            ].filter(Boolean).join(' · ')}
          >
            <div className="flex shrink-0 gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null || status.pending === 0}
                onClick={() => {
                  setBusy('reindex')
                  void api.assistant.reindexSemantic().then((result) => {
                    toast({
                      title: result.embedded
                        ? t('assistant.settings.semantic_done', { count: result.embedded })
                        : result.capped ? t('assistant.settings.semantic_capped') : t('assistant.settings.semantic_none'),
                      tone: 'success',
                    })
                    return refresh()
                  }).catch((error) => toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' }))
                    .finally(() => setBusy(null))
                }}
              >
                {t('assistant.settings.semantic_reindex')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null || status.vectors === 0}
                onClick={() => {
                  setBusy('clear')
                  void confirm({
                    title: t('assistant.settings.semantic_clear'),
                    description: t('assistant.settings.semantic_clear_hint'),
                    confirmLabel: t('assistant.settings.semantic_clear'),
                    tone: 'danger',
                  }).then(async (yes) => {
                    if (yes) await api.assistant.clearSemantic()
                    await refresh()
                  }).finally(() => setBusy(null))
                }}
              >
                {t('assistant.settings.semantic_clear')}
              </Button>
            </div>
          </SettingRow>
        </>
      )}
      {/* The model a reader picks is what the next write embeds with, so the field stays reachable on a
          deployment that has no binding yet — the same rule the switch follows. */}
      {settings.semanticMemory && (
        <>
          <SettingRow
            title={t('assistant.settings.semantic_model')}
            description={t('assistant.settings.semantic_model_hint')}
          >
            <form
              className="flex shrink-0 items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                const next = model.trim()
                if (!SEMANTIC_MODEL_PATTERN.test(next)) return
                void Promise.resolve(saveSettings({ semanticModel: next })).then(refresh)
              }}
            >
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                aria-label={t('assistant.settings.semantic_model')}
                maxLength={200}
                className="h-8 w-56 font-mono text-[length:var(--text-11)]"
              />
              <Button
                size="sm"
                variant="secondary"
                type="submit"
                disabled={busy !== null || !SEMANTIC_MODEL_PATTERN.test(model.trim()) || model.trim() === settings.semanticModel}
              >
                {t('common.save')}
              </Button>
            </form>
          </SettingRow>
          {status && <p className="px-3 pb-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{status.model}</p>}
        </>
      )}
    </Group>
  )
}

function NoteScopeRow() {
  const settings = useAssistant((state) => state.settings)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const scope = settings?.noteScope ?? []
  return (
    <Group title={t('assistant.settings.note_scope')}>
      <div className="py-3">
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.settings.note_scope_hint')}</p>
        <div className="mt-2">
          <NoteScopePicker value={scope} onChange={(ids) => void saveSettings({ noteScope: ids })} />
        </div>
      </div>
    </Group>
  )
}

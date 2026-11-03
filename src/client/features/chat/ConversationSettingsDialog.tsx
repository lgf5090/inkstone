import { useEffect, useState } from 'react'
import type { AssistantConversation, AssistantConversationSettings } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input, Segmented, Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { chatModels, useAssistant } from './assistant-store'
import { modelOptionLabel } from './assistant-settings-shared'

/**
 * One thread's own overrides.
 *
 * The form is built from the conversation it was opened on, and every field starts at "inherit": an
 * empty box is how the reader says "follow the Agent and the model", which is a different statement
 * from writing today's default into the row.
 */
export function ConversationSettingsDialog({
  conversation,
  open,
  onClose,
}: {
  conversation: AssistantConversation
  open: boolean
  onClose: () => void
}) {
  const models = useAssistant((state) => state.models)
  const providers = useAssistant((state) => state.providers)
  const save = useAssistant((state) => state.setConversationSettings)
  const [modelId, setModelId] = useState('')
  const [webSearch, setWebSearch] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [temperature, setTemperature] = useState('')
  const [topP, setTopP] = useState('')
  const [maxContext, setMaxContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const stored = conversation.settings ?? {}
    setModelId(stored.modelId ?? '')
    setWebSearch(stored.webSearch === undefined ? 'inherit' : stored.webSearch ? 'on' : 'off')
    setTemperature(stored.temperature === null || stored.temperature === undefined ? '' : String(stored.temperature))
    setTopP(stored.topP === null || stored.topP === undefined ? '' : String(stored.topP))
    setMaxContext(stored.maxContext === null || stored.maxContext === undefined ? '' : String(stored.maxContext))
    setError(null)
  }, [open, conversation.id, conversation.settings])

  const submit = async () => {
    const next: AssistantConversationSettings = {}
    if (modelId) next.modelId = modelId
    if (webSearch !== 'inherit') next.webSearch = webSearch === 'on'
    const temp = temperature.trim() === '' ? null : Number(temperature)
    if (temp !== null && (!Number.isFinite(temp) || temp < 0 || temp > 1.5)) {
      setError(t('assistant.conversation.settings.temperature_invalid'))
      return
    }
    if (temp !== null) next.temperature = temp
    const p = topP.trim() === '' ? null : Number(topP)
    if (p !== null && (!Number.isFinite(p) || p < 0 || p > 1)) {
      setError(t('assistant.conversation.settings.top_p_invalid'))
      return
    }
    if (p !== null) next.topP = p
    const context = maxContext.trim() === '' ? null : Number(maxContext)
    if (context !== null && (!Number.isInteger(context) || context < 1_000 || context > 2_000_000)) {
      setError(t('assistant.conversation.settings.context_invalid'))
      return
    }
    if (context !== null) next.maxContext = context
    setError(null)
    setBusy(true)
    const ok = await save(conversation.id, next)
    setBusy(false)
    if (ok) onClose()
  }

  const chat = chatModels(models)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('assistant.conversation.settings.title')}
      description={t('assistant.conversation.settings.hint')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('assistant.conversation.settings.model')}</span>
          <Select value={modelId} onChange={(event) => setModelId(event.target.value)} aria-label={t('assistant.conversation.settings.model')}>
            <option value="">{t('assistant.conversation.settings.inherit')}</option>
            {chat.map((model) => (
              <option key={model.id} value={model.id}>{modelOptionLabel(model, chat, providers)}</option>
            ))}
          </Select>
        </label>
        <div className="space-y-1.5">
          <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('assistant.conversation.settings.web_search')}</span>
          <Segmented
            value={webSearch}
            onChange={setWebSearch}
            label={t('assistant.conversation.settings.web_search')}
            options={[
              { value: 'inherit', label: t('assistant.conversation.settings.inherit') },
              { value: 'off', label: t('assistant.conversation.settings.off') },
              { value: 'on', label: t('assistant.conversation.settings.on') },
            ]}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('assistant.conversation.settings.temperature')}</span>
            <Input
              inputMode="decimal"
              value={temperature}
              placeholder={t('assistant.conversation.settings.inherit')}
              aria-label={t('assistant.conversation.settings.temperature')}
              onChange={(event) => setTemperature(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('assistant.conversation.settings.top_p')}</span>
            <Input
              inputMode="decimal"
              value={topP}
              placeholder={t('assistant.conversation.settings.inherit')}
              aria-label={t('assistant.conversation.settings.top_p')}
              onChange={(event) => setTopP(event.target.value)}
            />
          </label>
        </div>
        <label className="block space-y-1.5">
          <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('assistant.conversation.settings.max_context')}</span>
          <Input
            inputMode="numeric"
            value={maxContext}
            placeholder={t('assistant.conversation.settings.inherit')}
            aria-label={t('assistant.conversation.settings.max_context')}
            onChange={(event) => setMaxContext(event.target.value)}
          />
          <span className="block text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.conversation.settings.max_context_hint')}</span>
        </label>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}

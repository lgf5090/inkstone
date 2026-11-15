/**
 * The editor for the chat's rebindable chords.
 *
 * The built-in table stays the source of truth for what an action is; this screen only writes the
 * reader's overrides into `settings.shortcuts`. Every box is a plain text field with a real label, and
 * a chord is committed only if `normalizeShortcuts` accepts it — a typo stays on screen with an inline
 * error instead of being quietly dropped and leaving the reader believing it was saved.
 */
import { useId, useState } from 'react'
import {
  ASSISTANT_SHORTCUT_KEYS,
  normalizeShortcuts,
  type AssistantShortcutName,
  type AssistantShortcuts,
} from '@shared/assistant'
import { t, type MessageKey } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Input, SettingRow } from '../../components/form'
import { Group } from './assistant-settings-shared'
import { useAssistant } from './assistant-store'
import { CHAT_SHORTCUTS, resolvedCombo } from './chat-shortcuts'

/** Each action's own name, so a row's label names the thing the chord actually does. */
const ACTION_LABELS: Record<AssistantShortcutName, MessageKey> = {
  find: 'assistant.shortcuts.find' as MessageKey,
  stop: 'assistant.shortcuts.stop' as MessageKey,
  closePanel: 'assistant.shortcuts.close_panel' as MessageKey,
  send: 'assistant.shortcuts.send' as MessageKey,
  newLine: 'assistant.shortcuts.new_line' as MessageKey,
  pickerPrevious: 'assistant.shortcuts.picker_previous' as MessageKey,
  pickerNext: 'assistant.shortcuts.picker_next' as MessageKey,
  pickerPick: 'assistant.shortcuts.picker_pick' as MessageKey,
  pickerPickAlternate: 'assistant.shortcuts.picker_pick_alternate' as MessageKey,
}

const builtinFor = (name: AssistantShortcutName): string =>
  resolvedCombo(name as keyof typeof CHAT_SHORTCUTS)

function ShortcutRow({
  name,
  value,
  onInput,
  onReset,
  error,
}: {
  name: AssistantShortcutName
  value: string
  onInput: (raw: string) => void
  onReset: () => void
  error: string
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const label = t(ACTION_LABELS[name])
  const builtin = builtinFor(name)
  return (
    <SettingRow
      title={label}
      description={t('assistant.settings.shortcuts_default' as MessageKey, { combo: builtin })}
      controlId={id}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Input
            id={id}
            value={value}
            invalid={Boolean(error)}
            aria-label={label}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            onChange={(event) => onInput(event.target.value)}
            className="w-40 font-mono text-[length:var(--text-12)]"
          />
          <span id={hintId} className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('assistant.settings.shortcuts_format' as MessageKey)}
          </span>
          {error && <p id={errorId} role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={onReset}
          aria-label={t('assistant.settings.shortcuts_reset_label' as MessageKey, { action: label })}
        >
          {t('assistant.settings.shortcuts_reset' as MessageKey)}
        </Button>
      </div>
    </SettingRow>
  )
}

export function ShortcutSettings({ shortcuts }: { shortcuts: AssistantShortcuts }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(ASSISTANT_SHORTCUT_KEYS.map((name) => [name, shortcuts[name] ?? builtinFor(name)])),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const commit = (name: AssistantShortcutName, value: string | null) => {
    const next: AssistantShortcuts = { ...shortcuts }
    if (value === null) delete next[name]
    else next[name] = value
    void saveSettings({ shortcuts: next })
  }

  const onInput = (name: AssistantShortcutName, raw: string) => {
    setDrafts((current) => ({ ...current, [name]: raw }))
    const trimmed = raw.trim()
    const clearError = (message: string) => setErrors((current) => ({ ...current, [name]: message }))
    if (!trimmed) {
      // An empty box hands the action back to its built-in chord rather than storing an empty override.
      clearError('')
      commit(name, null)
      return
    }
    const accepted = normalizeShortcuts({ [name]: trimmed })[name]
    if (!accepted) {
      // Never silently discard a chord the validator refused: keep the draft and name the format.
      clearError(t('assistant.settings.shortcuts_invalid' as MessageKey))
      return
    }
    clearError('')
    commit(name, accepted)
  }

  const reset = (name: AssistantShortcutName) => {
    setDrafts((current) => ({ ...current, [name]: builtinFor(name) }))
    setErrors((current) => ({ ...current, [name]: '' }))
    commit(name, null)
  }

  return (
    <Group title={t('assistant.settings.shortcuts' as MessageKey)}>
      <p className="px-1 py-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
        {t('assistant.settings.shortcuts_hint' as MessageKey)}
      </p>
      {ASSISTANT_SHORTCUT_KEYS.map((name) => (
        <ShortcutRow
          key={name}
          name={name}
          value={drafts[name] ?? builtinFor(name)}
          error={errors[name] ?? ''}
          onInput={(raw) => onInput(name, raw)}
          onReset={() => reset(name)}
        />
      ))}
    </Group>
  )
}

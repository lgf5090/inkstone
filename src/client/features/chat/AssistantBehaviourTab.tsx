/**
 * The behaviour tab: what the assistant calls itself, and how it answers.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { type AssistantSearchKey, type AssistantSettings } from '@shared/assistant'
import { ASSISTANT_TOOL_MODES, ASSISTANT_TOOL_PERMISSIONS, MAX_CUSTOM_INSTRUCTIONS_CHARS, MAX_SEARCH_ENDPOINT_CHARS, searchEndpointValue } from '@shared/assistant'
import { MAX_SEARCH_KEY_CHARS, WEB_SEARCH_ENGINES, webSearchEngineFor } from '@shared/web-search-engines'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { t } from '../../lib/i18n'
import { ApiError, api } from '../../lib/api'
import { Button } from '../../components/primitives'
import { Input, Segmented, Select, SettingRow, Slider, Switch, Textarea } from '../../components/form'
import { useAssistant, type WriteFailure } from './assistant-store'
import { ToolManagerSection } from './ToolManagerSection'
import { CursorCommandsSection } from './CursorCommandsSection'
import { Group, SaveFailure, storedKeyLabel } from './assistant-settings-shared'

export function BehaviourTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const models = useAssistant((state) => state.models)
  // A key arriving or leaving changes what the composer is allowed to promise about search, and the chip
  // reads that from the settings response rather than guessing: so the settings are re-read here.
  const loadSettings = useAssistant((state) => state.loadSettings)
  const [name, setName] = useState(settings.agentName)
  useEffect(() => setName(settings.agentName), [settings.agentName])
  const [instructions, setInstructions] = useState(settings.customInstructions)
  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions])
  const [endpoint, setEndpoint] = useState(settings.webSearchEndpoint)
  useEffect(() => setEndpoint(settings.webSearchEndpoint), [settings.webSearchEndpoint])
  const [completionConstraint, setCompletionConstraint] = useState(settings.tabCompletionConstraint)
  useEffect(() => setCompletionConstraint(settings.tabCompletionConstraint), [settings.tabCompletionConstraint])
  const [quickAskTrigger, setQuickAskTrigger] = useState(settings.quickAskTrigger)
  useEffect(() => setQuickAskTrigger(settings.quickAskTrigger), [settings.quickAskTrigger])
  const [autoTokens, setAutoTokens] = useState(String(settings.autoCompactTokens))
  useEffect(() => setAutoTokens(String(settings.autoCompactTokens)), [settings.autoCompactTokens])
  const chatModels = models.filter((model) => model.enabled && model.purpose === 'chat')
  // The engine is a settings field; what it needs is not. A hosted engine's key lives in its own encrypted
  // row, so the state of that row has to be asked for — for the one engine the reader picked, and only when
  // the engine says it needs a key at all.
  const engine = webSearchEngineFor(settings.webSearchEngine)
  const [storedKey, setStoredKey] = useState<AssistantSearchKey | null>(null)
  // Whether the listing has actually answered "there is no key for this engine". Kept apart from
  // `storedKey === null`, because that is also what the row holds while the listing is still in the air and
  // after it failed — and a row that said "until a key is stored here" before the server had said so would
  // read as the reader's key having gone missing.
  const [keyAbsent, setKeyAbsent] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyProblem, setKeyProblem] = useState<WriteFailure | null>(null)
  useEffect(() => {
    setStoredKey(null)
    setKeyAbsent(false)
    setKeyDraft('')
    setKeyProblem(null)
    if (!engine.requiresKey) return
    // Whether this is still the engine the reader is looking at. A listing that answered late for the engine
    // they just left must not fill the row they are now on.
    let wanted = true
    void api.assistant.searchKeys()
      .then((answer) => {
        if (!wanted) return
        const entry = answer.keys.find((each) => each.engine === engine.id) ?? null
        setStoredKey(entry)
        setKeyAbsent(entry?.hasKey !== true)
      })
      .catch((error: unknown) => {
        // A listing that did not answer is said, rather than left as an empty box the reader reads as "my
        // key is gone" — which is the same lie the stored-key placeholder exists to prevent.
        if (wanted) setKeyProblem(keyRefusal(error))
      })
    return () => { wanted = false }
  }, [engine.id, engine.requiresKey])
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserZone]
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list]
  }, [browserZone, settings.timezone])
  // The three controls whose only words are the row's title: each id is what turns that title into the
  // control's accessible name rather than a line of text beside it.
  const agentNameId = useId()
  const timezoneId = useId()
  const startViewId = useId()
  const endpointId = useId()
  const engineId = useId()
  const keyId = useId()
  // Blank is a real answer here — it is how the built-in search tool is switched off — so only a value the
  // route would drop is worth refusing before the request goes out. `searchEndpointValue` is that route's
  // own rule, asked here so an address the worker will not relay to is answered beside this box instead of
  // through a toast over a field that still holds the rejected words.
  const wantedEndpoint = endpoint.trim()
  const endpointUnusable = wantedEndpoint !== '' && searchEndpointValue(wantedEndpoint, '') !== wantedEndpoint
  const endpointProblem = endpointUnusable ? t('assistant.settings.web_search_invalid') : null
  const endpointSaved = wantedEndpoint === settings.webSearchEndpoint

  const saveKey = async (): Promise<void> => {
    const key = keyDraft.trim()
    if (!key || keyBusy) return
    setKeyBusy(true)
    setKeyProblem(null)
    try {
      // The answer is the row's own state, and it holds no key: the engine is told which one it now has by
      // the last four characters, which is everything the worker is willing to say again.
      const answer = await api.assistant.putSearchKey(engine.id, { apiKey: key })
      setStoredKey(answer.key)
      setKeyAbsent(answer.key.hasKey !== true)
      setKeyDraft('')
      void loadSettings()
    } catch (error) {
      setKeyProblem(keyRefusal(error))
    } finally {
      setKeyBusy(false)
    }
  }

  const forgetKey = async (): Promise<void> => {
    if (keyBusy) return
    setKeyBusy(true)
    setKeyProblem(null)
    try {
      await api.assistant.deleteSearchKey(engine.id)
      setStoredKey(null)
      setKeyAbsent(true)
      void loadSettings()
    } catch (error) {
      setKeyProblem(keyRefusal(error))
    } finally {
      setKeyBusy(false)
    }
  }

  return (
    <>
      <Group title={t('assistant.settings.identity')}>
        <SettingRow title={t('assistant.settings.agent_name')} description={t('assistant.settings.agent_name_hint')} controlId={agentNameId}>
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (name.trim() && name !== settings.agentName) void saveSettings({ agentName: name.trim() })
            }}
          >
            <Input id={agentNameId} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className="h-8 w-44 text-[length:var(--text-12-5)]" />
            <Button type="submit" size="sm" variant="secondary" disabled={!name.trim() || name === settings.agentName}>
              {t('common.save')}
            </Button>
          </form>
        </SettingRow>
        <SettingRow title={t('assistant.settings.language')} description={t('assistant.settings.language_hint')}>
          <Segmented
            size="sm"
            label={t('assistant.settings.language')}
            value={settings.language}
            onChange={(value) => void saveSettings({ language: value })}
            options={[
              { value: 'en-US', label: t('settings.english') },
              { value: 'zh-CN', label: t('settings.simplified_chinese') },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={t('assistant.settings.timezone')}
          description={settings.timezone !== browserZone
            ? t('assistant.settings.timezone_use_device', { zone: browserZone })
            : t('assistant.settings.timezone_hint')}
          controlId={timezoneId}
        >
          <div className="flex items-center gap-2">
            {settings.timezone !== browserZone && isValidTimeZone(browserZone) && (
              <Button size="sm" variant="ghost" onClick={() => void saveSettings({ timezone: browserZone })}>
                {t('assistant.settings.timezone_detect')}
              </Button>
            )}
            <Select id={timezoneId} value={settings.timezone} onChange={(event) => void saveSettings({ timezone: event.target.value })} className="max-w-[220px]">
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </Select>
          </div>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.behaviour')}>
        <SettingRow title={t('assistant.settings.send_enter')} description={t('assistant.settings.send_enter_hint')}>
          <Switch checked={settings.sendOnEnter} onChange={(value) => void saveSettings({ sendOnEnter: value })} label={t('assistant.settings.send_enter')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.mention_mode')} description={t('assistant.settings.mention_mode_hint')}>
          <Segmented
            size="sm"
            label={t('assistant.settings.mention_mode')}
            value={settings.mentionMode}
            onChange={(mentionMode) => void saveSettings({ mentionMode })}
            options={[
              { value: 'full', label: t('assistant.settings.mention_mode.full') },
              { value: 'light', label: t('assistant.settings.mention_mode.light') },
            ]}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.chat_scale')} description={t('assistant.settings.chat_scale_hint')}>
          <div className="flex items-center gap-2">
            <Slider
              label={t('assistant.settings.chat_scale')}
              value={Math.round(settings.chatScale * 100)}
              min={70}
              max={150}
              step={5}
              suffix="%"
              onChange={(percent) => void saveSettings({ chatScale: percent / 100 })}
            />
          </div>
        </SettingRow>
        <SettingRow title={t('assistant.settings.tab_completion')} description={t('assistant.settings.tab_completion_hint')}>
          <Switch
            checked={settings.tabCompletionEnabled}
            label={t('assistant.settings.tab_completion')}
            onChange={(tabCompletionEnabled) => void saveSettings({ tabCompletionEnabled })}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.completion_model')} description={t('assistant.settings.completion_model_hint')}>
          <Select
            aria-label={t('assistant.settings.completion_model')}
            value={settings.tabCompletionModelId ?? ''}
            onChange={(event) => void saveSettings({ tabCompletionModelId: event.target.value || null })}
          >
            <option value="">{t('assistant.settings.naming_model_follow')}</option>
            {chatModels.map((model) => <option key={model.id} value={model.id}>{model.label || model.model}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={t('assistant.settings.completion_constraint')} description={t('assistant.settings.completion_constraint_hint')}>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              void saveSettings({ tabCompletionConstraint: completionConstraint })
            }}
          >
            <Input
              aria-label={t('assistant.settings.completion_constraint')}
              value={completionConstraint}
              maxLength={1000}
              onChange={(event) => setCompletionConstraint(event.target.value)}
              className="h-8 w-56 text-[length:var(--text-12)]"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={completionConstraint === settings.tabCompletionConstraint}>
              {t('common.save')}
            </Button>
          </form>
        </SettingRow>
        <SettingRow title={t('assistant.settings.quick_ask')} description={t('assistant.settings.quick_ask_hint')}>
          <Switch
            checked={settings.quickAskEnabled}
            label={t('assistant.settings.quick_ask')}
            onChange={(quickAskEnabled) => void saveSettings({ quickAskEnabled })}
          />
        </SettingRow>
        {settings.quickAskEnabled && (
          <SettingRow title={t('assistant.settings.quick_ask_trigger')} description={t('assistant.settings.quick_ask_trigger_hint')}>
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                const trigger = quickAskTrigger.trim()
                if (trigger && trigger.length <= 3) void saveSettings({ quickAskTrigger: trigger })
              }}
            >
              <Input
                aria-label={t('assistant.settings.quick_ask_trigger')}
                value={quickAskTrigger}
                maxLength={3}
                onChange={(event) => setQuickAskTrigger(event.target.value)}
                className="h-8 w-16 text-center font-mono text-[length:var(--text-12)]"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!quickAskTrigger.trim() || quickAskTrigger.trim().length > 3 || quickAskTrigger === settings.quickAskTrigger}>
                {t('common.save')}
              </Button>
            </form>
          </SettingRow>
        )}
        <SettingRow title={t('assistant.settings.image_compress')} description={t('assistant.settings.image_compress_hint')}>
          <Switch
            checked={settings.imageCompressEnabled}
            label={t('assistant.settings.image_compress')}
            onChange={(imageCompressEnabled) => void saveSettings({ imageCompressEnabled })}
          />
        </SettingRow>
        {settings.imageCompressEnabled && (
          <SettingRow title={t('assistant.settings.image_quality')} description={t('assistant.settings.image_quality_hint')}>
            <div className="flex items-center gap-2">
              <Slider
                label={t('assistant.settings.image_quality')}
                value={settings.imageCompressQuality}
                min={30}
                max={100}
                step={5}
                onChange={(imageCompressQuality) => void saveSettings({ imageCompressQuality })}
              />
            </div>
          </SettingRow>
        )}
        <SettingRow title={t('assistant.settings.auto_route')} description={t('assistant.settings.auto_route_hint')}>
          <Switch checked={settings.autoRoute} onChange={(value) => void saveSettings({ autoRoute: value })} label={t('assistant.settings.auto_route')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.start_view')} description={t('assistant.settings.start_view_hint')} controlId={startViewId}>
          <Select id={startViewId} value={settings.startView} onChange={(event) => void saveSettings({ startView: event.target.value })}>
            <option value="chat">{t('assistant.view.chat')}</option>
            <option value="memory">{t('assistant.view.memory')}</option>
            <option value="tasks">{t('assistant.view.tasks')}</option>
            <option value="automations">{t('assistant.view.automations')}</option>
            <option value="settings">{t('assistant.view.settings')}</option>
          </Select>
        </SettingRow>
      </Group>

      <Group title={t('assistant.cursor_commands.title')}>
        <CursorCommandsSection />
      </Group>

      <Group title={t('assistant.settings.compaction')}>        <SettingRow
          title={t('assistant.settings.compaction_mode')}
          description={t('assistant.settings.compaction_mode_hint')}
          controlId="assistant-compact-mode"
        >
          <Select
            id="assistant-compact-mode"
            value={settings.autoCompactMode}
            onChange={(event) => void saveSettings({ autoCompactMode: event.target.value as AssistantSettings['autoCompactMode'] })}
            className="h-7 max-w-[240px] text-[length:var(--text-11)]"
          >
            <option value="off">{t('assistant.settings.compaction_off')}</option>
            <option value="absolute">{t('assistant.settings.compaction_absolute')}</option>
            <option value="ratio">{t('assistant.settings.compaction_ratio')}</option>
          </Select>
        </SettingRow>
        {settings.autoCompactMode === 'absolute' && (
          <SettingRow title={t('assistant.settings.compaction_tokens')} controlId="assistant-compact-tokens">
            <Input
              id="assistant-compact-tokens"
              type="number"
              min={10_000}
              max={2_000_000}
              step={1_000}
              value={autoTokens}
              onChange={(event) => setAutoTokens(event.target.value)}
              onBlur={() => {
                const parsed = Number(autoTokens)
                if (Number.isInteger(parsed) && parsed >= 10_000 && parsed <= 2_000_000) void saveSettings({ autoCompactTokens: parsed })
                else setAutoTokens(String(settings.autoCompactTokens))
              }}
              className="w-40"
            />
          </SettingRow>
        )}
        {settings.autoCompactMode === 'ratio' && (
          <SettingRow title={t('assistant.settings.compaction_ratio')}>
            <Slider
              value={Math.round(settings.autoCompactRatio * 100)}
              min={30}
              max={95}
              step={5}
              suffix="%"
              label={t('assistant.settings.compaction_ratio')}
              onChange={(percent) => void saveSettings({ autoCompactRatio: percent / 100 })}
            />
          </SettingRow>
        )}
      </Group>

      <Group title={t('assistant.settings.notifications')}>        <SettingRow
          title={t('assistant.settings.notify_channel')}
          description={t('assistant.settings.notify_channel_hint')}
          controlId="assistant-notify-channel"
        >
          <Select
            id="assistant-notify-channel"
            value={settings.notifyChannel}
            onChange={(event) => void saveSettings({ notifyChannel: event.target.value as typeof settings.notifyChannel })}
            className="h-7 max-w-[240px] text-[length:var(--text-11)]"
          >
            <option value="off">{t('assistant.settings.notify_off')}</option>
            <option value="sound">{t('assistant.settings.notify_sound')}</option>
            <option value="browser">{t('assistant.settings.notify_browser')}</option>
            <option value="both">{t('assistant.settings.notify_both')}</option>
          </Select>
        </SettingRow>
        <SettingRow
          title={t('assistant.settings.notify_only_unfocused')}
          description={t('assistant.settings.notify_only_unfocused_hint')}
        >
          <Switch
            checked={settings.notifyOnlyUnfocused}
            label={t('assistant.settings.notify_only_unfocused')}
            onChange={(notifyOnlyUnfocused) => void saveSettings({ notifyOnlyUnfocused })}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.notify_approval')}>
          <Switch
            checked={settings.notifyApproval}
            label={t('assistant.settings.notify_approval')}
            onChange={(notifyApproval) => void saveSettings({ notifyApproval })}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.notify_finish')}>
          <Switch
            checked={settings.notifyFinish}
            label={t('assistant.settings.notify_finish')}
            onChange={(notifyFinish) => void saveSettings({ notifyFinish })}
          />
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.custom_instructions')}>
        <div className="flex flex-col gap-2 py-3">
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('assistant.settings.custom_instructions_hint')}
          </p>
          <Textarea
            rows={4}
            maxLength={MAX_CUSTOM_INSTRUCTIONS_CHARS}
            aria-label={t('assistant.settings.custom_instructions')}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t('assistant.settings.custom_instructions_placeholder')}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
              {instructions.length}/{MAX_CUSTOM_INSTRUCTIONS_CHARS}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={instructions.trim() === settings.customInstructions}
              onClick={() => void saveSettings({ customInstructions: instructions.trim() })}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Group>

      <Group title={t('assistant.settings.subagents')}>
        <SettingRow title={t('assistant.settings.subagent_enabled')} description={t('assistant.settings.subagent_enabled_hint')}>
          <Switch
            checked={settings.subagentEnabled}
            label={t('assistant.settings.subagent_enabled')}
            onChange={(subagentEnabled) => void saveSettings({ subagentEnabled })}
          />
        </SettingRow>
        {settings.subagentEnabled && (
          <SettingRow title={t('assistant.settings.subagent_model')} description={t('assistant.settings.subagent_model_hint')} controlId="assistant-subagent-model">
            <Select
              id="assistant-subagent-model"
              value={settings.subagentModelId ?? ''}
              aria-label={t('assistant.settings.subagent_model')}
              onChange={(event) => void saveSettings({ subagentModelId: event.target.value || null })}
              className="h-7 max-w-[240px] text-[length:var(--text-11)]"
            >
              <option value="">{t('assistant.conversation.settings.inherit')}</option>
              {chatModels.map((model) => (
                <option key={model.id} value={model.id}>{model.label || model.model}</option>
              ))}
            </Select>
          </SettingRow>
        )}
      </Group>

      <Group title={t('assistant.settings.tool_access')}>
        {ASSISTANT_TOOL_PERMISSIONS.map((permission) => (
          <SettingRow
            key={permission}
            title={t(`assistant.settings.tool_access.${permission}` as 'assistant.settings.tool_access.read')}
            description={t(`assistant.settings.tool_access.${permission}_hint` as 'assistant.settings.tool_access.read_hint')}
          >
            <Segmented
              size="sm"
              label={t(`assistant.settings.tool_access.${permission}` as 'assistant.settings.tool_access.read')}
              value={settings.toolModes[permission]}
              onChange={(value) => void saveSettings({ toolModes: { ...settings.toolModes, [permission]: value } })}
              options={ASSISTANT_TOOL_MODES.map((mode) => ({
                value: mode,
                label: t(`assistant.approval.${mode}` as 'assistant.approval.ask'),
              }))}
            />
          </SettingRow>
        ))}
        <ToolManagerSection />
        <SettingRow
          title={t('assistant.settings.web_search_engine')}
          description={t(engine.noteKey)}
          controlId={engineId}
        >
          <Select
            id={engineId}
            value={settings.webSearchEngine}
            onChange={(event) => void saveSettings({ webSearchEngine: event.target.value })}
            className="max-w-[220px]"
          >
            {Object.values(WEB_SEARCH_ENGINES).map((entry) => (
              <option key={entry.id} value={entry.id}>{t(entry.labelKey)}</option>
            ))}
          </Select>
        </SettingRow>
        {/* The address row belongs to the one engine that queries an address the reader wrote. Drawn for any
            other engine it would be a box nothing reads — a setting that appears to have stopped working —
            which is why it is here rather than always. */}
        {engine.selfHosted && (
          <SettingRow
            title={t('assistant.settings.web_search')}
            description={t('assistant.settings.web_search_hint')}
            controlId={endpointId}
          >
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                // The rule the route applies, asked before the request: an address the worker will not relay
                // to is answered beside this box rather than as a toast over a field that still shows it.
                if (endpointUnusable || endpointSaved) return
                void saveSettings({ webSearchEndpoint: wantedEndpoint })
              }}
            >
              {/* A plain text box, not `type="url"`: the browser's own constraint validation would swallow
                  the submit and answer with its bubble instead of this row's words. */}
              <Input
                id={endpointId}
                value={endpoint}
                inputMode="url"
                spellCheck={false}
                maxLength={MAX_SEARCH_ENDPOINT_CHARS}
                invalid={endpointProblem !== null}
                aria-describedby={endpointProblem !== null ? `${endpointId}-problem` : undefined}
                onChange={(event) => setEndpoint(event.target.value)}
                className="h-8 w-64 font-mono text-[length:var(--text-11)]"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={endpointUnusable || endpointSaved}>
                {t('common.save')}
              </Button>
            </form>
            {endpointProblem !== null && (
              <p id={`${endpointId}-problem`} role="alert" className="mt-1 break-words text-[length:var(--text-11)] text-[var(--danger)]">
                {endpointProblem}
              </p>
            )}
          </SettingRow>
        )}
        {/* A hosted engine's key: written once, shown only while it is being typed, and answered afterwards by
            the hint of what is stored rather than by the credential itself. */}
        {engine.requiresKey && (
          <SettingRow
            title={t('assistant.settings.web_search_key')}
            description={keyAbsent
              ? t('assistant.settings.web_search_key_required')
              : t('assistant.settings.web_search_key_hint')}
            controlId={keyId}
          >
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                void saveKey()
              }}
            >
              <Input
                id={keyId}
                type="password"
                value={keyDraft}
                maxLength={MAX_SEARCH_KEY_CHARS}
                autoComplete="off"
                spellCheck={false}
                disabled={keyBusy}
                invalid={keyProblem !== null}
                aria-describedby={keyProblem !== null ? `${keyId}-problem` : undefined}
                placeholder={storedKey?.hasKey ? storedKeyLabel(storedKey) : t('assistant.settings.api_key_placeholder')}
                onChange={(event) => setKeyDraft(event.target.value)}
                className="h-8 w-64 font-mono text-[length:var(--text-11)]"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!keyDraft.trim() || keyBusy}>
                {t('common.save')}
              </Button>
              {storedKey?.hasKey && (
                <Button type="button" size="sm" variant="ghost" disabled={keyBusy} onClick={() => void forgetKey()}>
                  {t('assistant.settings.web_search_key_forget')}
                </Button>
              )}
            </form>
            {keyProblem !== null && (
              <div id={`${keyId}-problem`} className="mt-1">
                <SaveFailure failure={keyProblem} />
              </div>
            )}
          </SettingRow>
        )}
      </Group>
    </>
  )
}

/**
 * Why the key row says no: the route's own reason where it gave one, and the plain claim that nothing was
 * stored where it did not — an unexplained empty box would be read as the key having been thrown away.
 */
function keyRefusal(error: unknown): WriteFailure {
  return {
    headline: t('assistant.toast.failed'),
    detail: error instanceof ApiError ? error.serverMessage ?? null : null,
  }
}

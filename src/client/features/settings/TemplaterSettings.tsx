/**
 * Settings → Templater: the switches, the triggers, and the chords.
 *
 * What a reader *runs* is not here — templates are rows in the template library, the way RSS feeds are rows in
 * theirs. This page carries the small always-needed part: the editing switches, the two lists that decide which
 * template fires on a note nobody asked for, the chords, the script folder, and the three answers that gate
 * code. Each one is a field of the account's `templater` blob (`@shared/types` `TemplaterSettings`), which the
 * session store writes as one debounced request; the two dangerous "may this run at all" answers are deliberately
 * not in that blob and live on this device only (`lib/templater/device-prefs.ts`).
 *
 * The panel is the third place those device answers appear, after the trigger and the startup bridge, and it is
 * the first one a reader can see them in, which is why turning either on asks a question rather than flipping
 * silently: a switch that starts running code over every new note is not a preference like the font size.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { FilePlus2, Plus, Trash2 } from 'lucide-react'
import type { TemplaterDevicePrefs } from '../../lib/templater/device-prefs'
import type { TemplaterHotkey, TemplaterScriptPolicy, TemplaterSettings } from '@shared/types'
import {
  TEMPLATER_FILE_CREATION_MODES,
  TEMPLATER_INTELLISENSE_RENDER,
  TEMPLATER_SCRIPT_POLICIES,
  LIMITS,
} from '@shared/constants'
import type { TemplaterFileCreationMode, TemplaterIntellisenseRender } from '@shared/types'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input, Select, SettingRow, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { compileQuery, queryKeeps } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { folderPathLabel } from '../../lib/folders'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { createUserScript } from '../templater/user-script-seed'
import { useSession } from '../../store/session'
import { useTemplaterDevicePrefs, setTemplaterDevicePrefs } from '../../lib/templater/device-prefs'
import type { TemplaterChordClaim, TemplaterHotkeyClaimant } from '../templater/hotkeys'
import { normaliseTemplaterCombo, planTemplaterHotkeys, templaterChordClaims } from '../templater/hotkeys'
import { TemplaterTriggers, useTemplaterLibrary } from './TemplaterTriggers'
import { TemplateReferenceButton } from '../templater/reference-entry'

/** The five documentation levels, in the order upstream numbers them, each named by what it adds. */
const INTELLISENSE_LABELS: Record<TemplaterIntellisenseRender, MessageKey> = {
  '0': 'templater.intellisense_off',
  '1': 'templater.intellisense_params_returns',
  '2': 'templater.intellisense_params',
  '3': 'templater.intellisense_returns',
  '4': 'templater.intellisense_description',
}

const CREATION_MODE_LABELS: Record<TemplaterFileCreationMode, MessageKey> = {
  none: 'templater.mode_none',
  folder: 'templater.mode_folder',
  regex: 'templater.mode_regex',
}

const SCRIPT_POLICY_LABELS: Record<TemplaterScriptPolicy, MessageKey> = {
  readonly: 'templater.policy_readonly',
  trusted: 'templater.policy_trusted',
}

/** Who already holds a chord, in the words the reader can act on: the app, QuickAdd, or their own other row. */
const CLAIMANT_LABELS: Record<TemplaterHotkeyClaimant, MessageKey> = {
  app: 'templater.hotkey.by_app',
  quickadd: 'templater.hotkey.by_quickadd',
  templater: 'templater.hotkey.by_other_row',
}

export function TemplaterSettings() {
  const templater = useSession((state) => state.settings.templater)
  const updateSettings = useSession((state) => state.updateSettings)
  const owner = useSession((state) => state.user?.id ?? '')
  const update = useCallback((patch: Partial<TemplaterSettings>) => {
    updateSettings({ templater: patch })
  }, [updateSettings])
  const triggerSwitch = useArmedDeviceSwitch(
    owner, 'triggerOnFileCreation', 'templater.device.trigger_title', 'templater.device.trigger_body')

  return (
    <div className="space-y-8">
      <Group titleKey="templater.group.basics">
        <SettingRow
          title={t('settings.templater_highlight')}
          description={t('settings.templater_highlight_desc')}
          className="border-t-0">
          <Switch
            label={t('settings.templater_highlight')}
            checked={templater.syntaxHighlighting}
            onChange={(syntaxHighlighting) => update({ syntaxHighlighting })}/>
        </SettingRow>
        <SettingRow
          title={t('settings.templater_highlight_mobile')}
          description={t('settings.templater_highlight_mobile_desc')}>
          <Switch
            label={t('settings.templater_highlight_mobile')}
            checked={templater.syntaxHighlightingMobile}
            onChange={(syntaxHighlightingMobile) => update({ syntaxHighlightingMobile })}/>
        </SettingRow>
        <IntellisenseRow templater={templater} update={update}/>
        <SettingRow
          title={t('settings.templater_reference')}
          description={t('settings.templater_reference_desc')}>
          <TemplateReferenceButton/>
        </SettingRow>
        <SettingRow
          title={t('settings.templater_auto_cursor')}
          description={t('settings.templater_auto_cursor_desc')}>
          <Switch
            label={t('settings.templater_auto_cursor')}
            checked={templater.autoJumpToCursor}
            onChange={(autoJumpToCursor) => update({ autoJumpToCursor })}/>
        </SettingRow>
        <SettingRow
          title={t('settings.templater_jump_after_create')}
          description={t('settings.templater_jump_after_create_desc')}>
          <Switch
            label={t('settings.templater_jump_after_create')}
            checked={templater.jumpToContentAfterCreate}
            onChange={(jumpToContentAfterCreate) => update({ jumpToContentAfterCreate })}/>
        </SettingRow>
      </Group>

      <HotkeyGroup templater={templater} update={update}/>

      <Group titleKey="templater.group.creation">
        <SettingRow
          title={t('settings.templater_creation_mode')}
          description={t('settings.templater_creation_mode_desc')}
          className="border-t-0">
          <Select
            aria-label={t('settings.templater_creation_mode')}
            value={templater.fileCreationMode}
            onChange={(event) => update({ fileCreationMode: event.target.value as TemplaterFileCreationMode })}>
            {TEMPLATER_FILE_CREATION_MODES.map((mode) => (
              <option key={mode} value={mode}>{t(CREATION_MODE_LABELS[mode])}</option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          title={t('settings.templater_device_trigger')}
          description={t('settings.templater_device_trigger_desc')}>
          <Switch
            label={t('settings.templater_device_trigger')}
            checked={triggerSwitch.checked}
            onChange={triggerSwitch.toggle}/>
        </SettingRow>
        {templater.fileCreationMode !== 'none' && (
          <TemplaterTriggers templater={templater} update={update}/>
        )}
      </Group>

      <StartupGroup templater={templater} update={update} owner={owner}/>

      <Group titleKey="templater.group.scripts">
        <ScriptFolderRow templater={templater} update={update}/>
        <SettingRow
          title={t('settings.templater_script_policy')}
          description={t('settings.templater_script_policy_desc')}>
          <PolicySelect templater={templater} update={update}/>
        </SettingRow>
      </Group>

      <Group titleKey="templater.group.security">
        <p className="pb-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('templater.security.note')}
        </p>
        <SettingRow
          title={t('settings.templater_web')}
          description={t('settings.templater_web_desc')}
          className="border-t-0">
          <Switch
            label={t('settings.templater_web')}
            checked={templater.webRequestsEnabled}
            onChange={(webRequestsEnabled) => update({ webRequestsEnabled })}/>
        </SettingRow>
      </Group>
    </div>
  )
}

function Group({ titleKey, children }: { titleKey: MessageKey; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 data-setting-title={t(titleKey)} className="pb-1 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
        {t(titleKey)}
      </h3>
      {children}
    </section>
  )
}

function IntellisenseRow({
  templater,
  update,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
}) {
  const label = t('settings.templater_intellisense')
  return (
    <SettingRow title={t('settings.templater_intellisense')} description={t('settings.templater_intellisense_desc')}>
      <Select
        aria-label={label}
        value={templater.intellisenseRender}
        onChange={(event) => update({ intellisenseRender: event.target.value as TemplaterIntellisenseRender })}>
        {TEMPLATER_INTELLISENSE_RENDER.map((level) => (
          <option key={level} value={level}>{t(INTELLISENSE_LABELS[level])}</option>
        ))}
      </Select>
    </SettingRow>
  )
}

/**
 * The community-template gate.
 *
 * `trusted` is the answer that lets a template from the gallery reach the reader's own scripts, so it is the
 * setting another person's words can argue for, and the only change on this page that asks a question. The box
 * shows the reader's pick while the answer is pending and falls back to the stored value on a no, because a
 * control that kept the value the store refused would be a lie the next reader has to decode.
 */
function PolicySelect({
  templater,
  update,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
}) {
  const label = t('settings.templater_script_policy')
  const [asked, setAsked] = useState(false)
  return (
    <Select
      aria-label={label}
      value={asked ? 'trusted' : templater.communityScriptPolicy}
      onChange={async (event) => {
        const next = event.target.value as TemplaterScriptPolicy
        if (next === templater.communityScriptPolicy) return
        if (next !== 'trusted') {
          update({ communityScriptPolicy: next })
          return
        }
        setAsked(true)
        const accepted = await confirm({
          title: t('templater.device.trusted_title'),
          description: t('templater.device.trusted_body'),
          confirmLabel: t('templater.policy_trusted'),
          tone: 'danger',
        })
        setAsked(false)
        if (accepted) update({ communityScriptPolicy: next })
      }}>
      {TEMPLATER_SCRIPT_POLICIES.map((policy) => (
        <option key={policy} value={policy}>{t(SCRIPT_POLICY_LABELS[policy])}</option>
      ))}
    </Select>
  )
}

function ScriptFolderRow({
  templater,
  update,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
}) {
  const folders = useNotes((state) => state.folders)
  const label = t('settings.templater_script_folder')
  const path = templater.userScriptsFolderId === null
    ? ''
    : folderPathLabel(folders, templater.userScriptsFolderId)
  return (
    <SettingRow
      title={t('settings.templater_script_folder')}
      description={t('settings.templater_script_folder_desc')}
      className="border-t-0">
      <Select
        aria-label={label}
        value={templater.userScriptsFolderId ?? ''}
        onChange={(event) => update({ userScriptsFolderId: event.target.value === '' ? null : event.target.value })}>
        <option value="">{t('templater.script.none')}</option>
        {[...folders]
          .sort((a, b) => folderPathLabel(folders, a.id).localeCompare(folderPathLabel(folders, b.id)))
          .map((folder) => (
            <option key={folder.id} value={folder.id}>{folderPathLabel(folders, folder.id)}</option>
          ))}
      </Select>
      {templater.userScriptsFolderId !== null && path === '' && (
        <span className="mt-1 block text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('templater.script.folder_gone')}
        </span>
      )}
      {templater.userScriptsFolderId !== null && path !== '' && (
        <Button
          size="sm"
          icon={<FilePlus2 size={13}/>}
          className="mt-2"
          onClick={() => {
            const folderId = templater.userScriptsFolderId
            if (folderId === null) return
            void createUserScript(folderId).then((name) => {
              if (name === null) return
              useUi.getState().toast({ title: t('templater.script.created', { value0: name }), tone: 'success' })
            })
          }}>
          {t('templater.script.create')}
        </Button>
      )}
    </SettingRow>
  )
}

/**
 * One of the two answers this device holds, behind a confirmation.
 *
 * Turning it off needs no ceremony; turning it on is the moment the app starts running code the reader did not
 * press, so the question is asked first and the write happens only on a yes. The rows are drawn by their groups
 * rather than by this hook — a switch component that took its own words as a prop would put the labels out of
 * reach of the search index's anchor check (`tests/settings-search.test.ts` reads literals, not indirections).
 */
function useArmedDeviceSwitch(
  owner: string,
  pref: keyof TemplaterDevicePrefs,
  confirmTitleKey: MessageKey,
  confirmBodyKey: MessageKey,
): { checked: boolean, toggle: (next: boolean) => void } {
  const checked = useTemplaterDevicePrefs(owner)[pref]
  return {
    checked,
    toggle: async (next: boolean) => {
      if (!next) {
        setTemplaterDevicePrefs(owner, { [pref]: false })
        return
      }
      const accepted = await confirm({
        title: t(confirmTitleKey),
        description: t(confirmBodyKey),
        confirmLabel: t('templater.device.arm'),
        tone: 'danger',
      })
      if (accepted) setTemplaterDevicePrefs(owner, { [pref]: true })
    },
  }
}

/** The startup list, its own device switch, and the count of rows whose template has gone. */
function StartupGroup({
  templater,
  update,
  owner,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
  owner: string
}) {
  const { templates, read } = useTemplaterLibrary()
  const [pending, setPending] = useState('')
  const ids = templater.startupTemplates
  const missing = read ? ids.filter((id) => !templates.some((template) => template.id === id)) : []
  const available = templates.filter((template) => !ids.includes(template.id))
  const startupSwitch = useArmedDeviceSwitch(
    owner, 'enableStartupTemplates', 'templater.device.startup_title', 'templater.device.startup_body')

  return (
    <Group titleKey="templater.group.startup">
      <SettingRow
        title={t('settings.templater_device_startup')}
        description={t('settings.templater_device_startup_desc')}
        className="border-t-0">
        <Switch
          label={t('settings.templater_device_startup')}
          checked={startupSwitch.checked}
          onChange={startupSwitch.toggle}/>
      </SettingRow>
      <SettingRow
        title={t('settings.templater_startup')}
        description={(
          <span className="block space-y-0.5">
            <span className="block">{t('settings.templater_startup_desc')}</span>
            {missing.length > 0 && (
              <span className="block text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('templater.startup.gone', { value0: String(missing.length) })}
              </span>
            )}
          </span>
        )}>
        <span className="flex items-end gap-2">
          <Select
            aria-label={t('templater.startup.choose')}
            className="w-[170px] max-w-full"
            value={pending}
            onChange={(event) => setPending(event.target.value)}>
            <option value="">{t('templater.startup.choose')}</option>
            {available.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </Select>
          <Button
            size="sm"
            icon={<Plus size={13}/>}
            disabled={pending === '' || ids.length >= LIMITS.templaterStartupMax}
            onClick={() => {
              if (pending === '') return
              update({ startupTemplates: [...ids, pending] })
              setPending('')
            }}>
            {t('templater.startup.add')}
          </Button>
        </span>
      </SettingRow>
      {ids.length === 0 && (
        <p className="pb-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('templater.startup.none')}</p>
      )}
      <div role="group" aria-label={t('settings.templater_startup')} className="space-y-1">
        {ids.map((id, index) => {
          const template = templates.find((candidate) => candidate.id === id)
          return (
            <div key={`${id}:${index}`} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-secondary)]" title={template?.name ?? id}>
                {template?.name ?? t('templater.trigger.template_gone')}
              </span>
              <IconButton
                label={t('templater.startup.remove')}
                size="sm"
                variant="danger"
                onClick={() => update({ startupTemplates: ids.filter((_, at) => at !== index) })}>
                <Trash2 size={12}/>
              </IconButton>
            </div>
          )
        })}
      </div>
    </Group>
  )
}

/**
 * How many chord rows the list draws before asking the reader to narrow it.
 *
 * One row per template is the shape the storage has, and a library of forty is a page three screens of
 * identical boxes; the filter is what reaches the rest, so the list stops where scanning stops working.
 */
const CHORD_ROWS_MAX = 25

/**
 * The chord list, drawn from the library rather than from the stored rows.
 *
 * A row exists for every template the reader owns — the alternative, a list of rows that only appears once a
 * chord is typed, gives nothing to type *into* — and the storage keeps only the rows with a chord. The report
 * comes from the same planner that binds the keys, so the screen cannot disagree with the keyboard about which
 * chord is contested; it adds the editor keymap on top, which is the one claim list the eager app chunk could
 * not afford to read (see `templaterChordClaims`).
 */
function HotkeyGroup({
  templater,
  update,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
}) {
  const { templates } = useTemplaterLibrary()
  const pinyinVersion = usePinyinVersion()
  const [query, setQuery] = useState('')
  const [editorClaims, setEditorClaims] = useState<TemplaterChordClaim[]>([])
  const compiled = useMemo(() => compileQuery(query), [query, pinyinVersion])
  const shown = useMemo(() => templates.filter((template) => queryKeeps(compiled, template.name)), [compiled, templates, pinyinVersion])

  useEffect(() => {
    let alive = true
    // Read lazily on purpose: the table lives in the editor's own graph, and this panel is the only place
    // that needs it. A failed read leaves the chords as the eager list already described them.
    void import('../../editor/shortcuts')
      .then((module) => {
        if (!alive) return
        setEditorClaims(module.EDITOR_SHORTCUTS
          .filter((shortcut: { combo?: string }) => typeof shortcut.combo === 'string' && shortcut.combo !== '')
          .map((shortcut: { id: string, combo: string }) => ({
            combo: shortcut.combo,
            takenBy: 'app' as const,
            owner: `editor:${shortcut.id}`,
          })))
      })
      .catch((error: unknown) => {
        console.warn('[templater] the editor chords could not be read for the settings list', error)
      })
    return () => {
      alive = false
    }
  }, [])

  const report = useMemo(
    () => planTemplaterHotkeys(templater.templateHotkeys, templates, [...templaterChordClaims(), ...editorClaims]).report,
    [editorClaims, templates, templater.templateHotkeys],
  )
  const rows = useMemo(() => new Map(templater.templateHotkeys.map((row) => [row.templateId, row])), [templater.templateHotkeys])

  const write = (templateId: string, patch: Partial<TemplaterHotkey>) => {
    const current = rows.get(templateId) ?? { templateId, combo: null, insert: false, create: false }
    const next = { ...current, ...patch }
    // No chord means nothing to bind: the row leaves the list rather than sitting in it as an empty string.
    const kept = next.combo === null || next.combo === ''
      ? templater.templateHotkeys.filter((row) => row.templateId !== templateId)
      : [...templater.templateHotkeys.filter((row) => row.templateId !== templateId), next]
    update({ templateHotkeys: kept })
  }

  return (
    <Group titleKey="templater.group.hotkeys">
      <SettingRow
        title={t('settings.templater_hotkeys')}
        description={(
          <span className="block space-y-0.5">
            <span className="block">{t('settings.templater_hotkeys_desc')}</span>
            {report.stale.length > 0 && (
              <span className="block text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('templater.hotkey.stale', { value0: String(report.stale.length) })}
              </span>
            )}
          </span>
        )}
        className="border-t-0">
        <Input
          aria-label={t('templater.hotkey.filter')}
          className="w-[180px] max-w-full"
          value={query}
          spellCheck={false}
          placeholder={t('templater.hotkey.filter')}
          onChange={(event) => setQuery(event.target.value)}/>
      </SettingRow>
      {templates.length === 0 && (
        <p className="pb-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('templater.hotkey.none')}</p>
      )}
      <div role="group" aria-label={t('settings.templater_hotkeys')} className="space-y-2">
        {shown.slice(0, CHORD_ROWS_MAX).map((template) => {
          const row = rows.get(template.id)
          const combo = row?.combo ?? ''
          const conflicts = report.conflicts.filter((conflict) => conflict.templateId === template.id)
          return (
            <div key={template.id} role="group" aria-label={template.name} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,170px)_auto] md:items-center">
                <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]" title={template.name}>
                  {template.name}
                </span>
                <Input
                  aria-label={`${t('templater.hotkey.chord')} ${template.name}`}
                  className="font-mono"
                  value={combo}
                  spellCheck={false}
                  maxLength={LIMITS.templaterComboMaxLength}
                  placeholder={t('templater.hotkey.chord_placeholder')}
                  onChange={(event) => {
                    const typed = normaliseTemplaterCombo(event.target.value)
                    if (typed === '') {
                      write(template.id, { combo: null })
                      return
                    }
                    // A chord with nothing claimed yet gets both halves off: the reader is about to tick one,
                    // and defaulting them on would bind two commands to a key they have not chosen yet.
                    write(template.id, { combo: typed, insert: row?.insert ?? false, create: row?.create ?? false })
                  }}/>
                <span className="flex flex-wrap items-center gap-3">
                  <Checkbox
                    label={t('templater.hotkey.insert')}
                    checked={row?.insert === true}
                    onChange={(insert) => write(template.id, { insert })}/>
                  <Checkbox
                    label={t('templater.hotkey.create')}
                    checked={row?.create === true}
                    onChange={(create) => write(template.id, { create })}/>
                  {combo !== '' && (
                    <IconButton label={t('templater.hotkey.clear')} size="sm" onClick={() => write(template.id, { combo: null })}>
                      <Trash2 size={12}/>
                    </IconButton>
                  )}
                </span>
              </div>
              {conflicts.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {conflicts.map((conflict) => (
                    <li key={`${conflict.action}:${conflict.owner}`} className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      {t('templater.hotkey.conflict', {
                        value0: conflict.combo,
                        value1: t(conflict.action === 'insert' ? 'templater.hotkey.insert' : 'templater.hotkey.create'),
                        value2: t(CLAIMANT_LABELS[conflict.takenBy]),
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
        {shown.length > CHORD_ROWS_MAX && (
          <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('templater.hotkey.more', { value0: String(shown.length - CHORD_ROWS_MAX) })}
          </p>
        )}
      </div>
    </Group>
  )
}

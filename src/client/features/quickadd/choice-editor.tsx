/**
 * The editor for one QuickAdd choice.
 *
 * A draft copy is edited and only written back on Save: a capture format is built over minutes, and
 * autosaving every keystroke would push a half-typed `{{DATE` to the account. The live preview is what
 * makes the form trustworthy — `inertFormat` is the same pass a run uses, so the preview shows what the
 * note will get, a prompt-shaped token is marked rather than guessed, and nothing here can ask a
 * question or touch a note.
 */
import { useCallback, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import {
  QUICKADD_LIMITS,
  normalizeQuickAddChoice,
  type QuickAddBlankLineMode,
  type QuickAddCaptureChoice,
  type QuickAddChoice,
  type QuickAddConditionOperator,
  type QuickAddCreateAt,
  type QuickAddDateOrigin,
  type QuickAddCaptureTargetMode,
  type QuickAddDirection,
  type QuickAddExistingAction,
  type QuickAddFolderMode,
  type QuickAddOnePageMode,
  type QuickAddTemplateMode,
  type QuickAddMacroChoice,
  type QuickAddOrderKey,
  type QuickAddPosition,
  type QuickAddStep,
  type QuickAddTemplateChoice,
} from '@shared/quickadd'
import type { MessageKey } from '@shared/locales/en-US'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Field, Input, Select, SettingRow, Switch, Textarea } from '../../components/form'
import { Modal } from '../../components/overlay'
import { t, useLocale } from '../../lib/i18n'
import { inertFormat } from '../../lib/quickadd/format'
import { previewRuntime } from '../../lib/quickadd/preview'
import { useNoteTemplates } from '../../store/note-templates'
import { useQuickAdd } from '../../store/quickadd'
import { QuickAddTokenHelp } from './token-help'

const STEP_KINDS: QuickAddStep['kind'][] = ['ask', 'set', 'insert', 'capture', 'create', 'copy', 'open', 'notify', 'wait', 'script', 'if', 'choice']
const OPERATORS: QuickAddConditionOperator[] = ['eq', 'ne', 'has', 'empty', 'gt', 'lt']
const ORDER_KEYS: QuickAddOrderKey[] = ['lexical', 'date', 'numeric', 'semver', 'insertion']
const POSITIONS: QuickAddPosition[] = ['bottom', 'top', 'insertAfter', 'insertBefore', 'cursor']
const CREATE_AT: QuickAddCreateAt[] = ['top', 'bottom', 'cursor', 'ordered']
const BLANK_MODES: QuickAddBlankLineMode[] = ['auto', 'skip', 'none']
const DIRECTIONS: QuickAddDirection[] = ['asc', 'desc']

const TYPE_KEYS = {
  template: 'quickadd.type_template',
  capture: 'quickadd.type_capture',
  macro: 'quickadd.type_macro',
  group: 'quickadd.type_group',
} as const satisfies Record<QuickAddChoice['type'], MessageKey>

const POSITION_KEYS: Record<QuickAddPosition, MessageKey> = {
  bottom: 'quickadd.position_bottom',
  top: 'quickadd.position_top',
  insertAfter: 'quickadd.position_insert_after',
  insertBefore: 'quickadd.position_insert_before',
  cursor: 'quickadd.position_cursor',
}

const CREATE_AT_KEYS: Record<QuickAddCreateAt, MessageKey> = {
  top: 'quickadd.create_at_top',
  bottom: 'quickadd.create_at_bottom',
  cursor: 'quickadd.create_at_cursor',
  ordered: 'quickadd.create_at_ordered',
}

const BLANK_KEYS: Record<QuickAddBlankLineMode, MessageKey> = {
  auto: 'quickadd.blank_auto',
  skip: 'quickadd.blank_skip',
  none: 'quickadd.blank_none',
}

const ORDER_KEYS_LABELS: Record<QuickAddOrderKey, MessageKey> = {
  lexical: 'quickadd.order_lexical',
  date: 'quickadd.order_date',
  numeric: 'quickadd.order_numeric',
  semver: 'quickadd.order_semver',
  insertion: 'quickadd.order_insertion',
}

const DIRECTION_KEYS: Record<QuickAddDirection, MessageKey> = {
  asc: 'quickadd.direction_asc',
  desc: 'quickadd.direction_desc',
}

const STEP_KEYS: Record<QuickAddStep['kind'], MessageKey> = {
  ask: 'quickadd.step_ask',
  set: 'quickadd.step_set',
  insert: 'quickadd.step_insert',
  capture: 'quickadd.step_capture',
  create: 'quickadd.step_create',
  copy: 'quickadd.step_copy',
  open: 'quickadd.step_open',
  notify: 'quickadd.step_notify',
  wait: 'quickadd.step_wait',
  script: 'quickadd.step_script',
  if: 'quickadd.step_if',
  choice: 'quickadd.step_choice_step',
}

const OPERATOR_KEYS: Record<QuickAddConditionOperator, MessageKey> = {
  eq: 'quickadd.operator_eq',
  ne: 'quickadd.operator_ne',
  has: 'quickadd.operator_has',
  empty: 'quickadd.operator_empty',
  gt: 'quickadd.operator_gt',
  lt: 'quickadd.operator_lt',
}

/** One line about what a choice does, for the list and the launcher's future hint text. */
export function choiceSummary(choice: QuickAddChoice, siblings: readonly QuickAddChoice[]): string {
  switch (choice.type) {
    case 'template':
      return choice.mode === 'insert-here'
        ? t('quickadd.summary_insert_here')
        : t('quickadd.summary_new_note', { value0: choice.templateId ? templateName(siblings, choice.templateId) : t('quickadd.no_template') })
    case 'capture':
      return choice.targetMode === 'active'
        ? t('quickadd.summary_into_active')
        : t('quickadd.summary_into', { value0: choice.targetTitle })
    case 'macro':
      return t('quickadd.summary_steps', { value0: String(choice.steps.length) })
    default:
      return t('quickadd.summary_children', { value0: String(siblings.filter((entry) => entry.parentId === choice.id).length) })
  }
}

function templateName(choices: readonly QuickAddChoice[], id: string): string {
  return choices.find((entry) => entry.id === id)?.name ?? id
}

export function QuickAddChoiceEditor({ choice, onClose }: {
  choice: QuickAddChoice
  onClose: () => void
}) {
  const update = useQuickAdd((state) => state.updateChoice)
  const settings = useQuickAdd((state) => state.settings)
  const choices = useQuickAdd((state) => state.choices)
  const locale = useLocale()
  const [draft, setDraft] = useState<QuickAddChoice>(choice)
  const [showHelp, setShowHelp] = useState(false)

  const patch = useCallback((next: Partial<QuickAddChoice>) => {
    setDraft((current) => ({ ...current, ...next }) as QuickAddChoice)
  }, [])

  const preview = useMemo(() => previewRuntime({
    settings,
    choices,
    title: t('quickadd.preview_note'),
    locale,
  }), [choices, locale, settings])

  const renderFormat = useCallback((text: string): string => {
    if (text.trim() === '') return ''
    return inertFormat(text, preview)
  }, [preview])

  const save = useCallback(() => {
    const normalized = normalizeQuickAddChoice(draft)
    if (!normalized) return
    // The whole draft is the patch: the store re-normalizes it and refuses a record it cannot read.
    update(normalized.id, normalized as unknown as Record<string, unknown>)
    onClose()
  }, [draft, onClose, update])

  return (
    <Modal
      open
      onClose={onClose}
      title={t('quickadd.edit_choice', { value0: draft.name })}
      description={t(TYPE_KEYS[draft.type])}
      width={680}
      footer={(<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={save} disabled={draft.name.trim() === ''}>{t('common.save')}</Button>
      </>)}
    >
      <div className="space-y-3 px-4 pb-4 md:px-5">
        <Field label={t('quickadd.field_name')}>
          <Input value={draft.name} maxLength={QUICKADD_LIMITS.maxNameLength} onChange={(event) => patch({ name: event.target.value })}/>
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('quickadd.field_icon')} hint={t('quickadd.field_icon_hint')}>
            <Input
              value={draft.icon ?? ''}
              maxLength={8}
              aria-label={t('quickadd.field_icon')}
              onChange={(event) => {
                const glyph = event.target.value.trim()
                patch({ icon: glyph === '' ? null : glyph })
              }}/>
          </Field>
          <Field label={t('quickadd.field_color')}>
            <div className="flex flex-wrap gap-1" role="group" aria-label={t('quickadd.field_color')}>
              <ColorSwatch active={draft.color === null} label={t('quickadd.color_none')} onClick={() => patch({ color: null })}/>
              {ORGANIZER_COLORS.map((color) => (
                <ColorSwatch key={color} color={color} active={draft.color === color} label={color} onClick={() => patch({ color })}/>
              ))}
            </div>
          </Field>
        </div>
        <div className="grid gap-1 md:grid-cols-2">
          <SettingRow title={t('quickadd.field_enabled')}>
            <Switch checked={draft.enabled} onChange={(enabled) => patch({ enabled })}/>
          </SettingRow>
          <SettingRow title={t('quickadd.field_as_command')} description={t('quickadd.field_as_command_desc')}>
            <Switch checked={draft.asCommand} onChange={(asCommand) => patch({ asCommand })}/>
          </SettingRow>
        </div>
        <Field label={t('quickadd.field_hotkey')} hint={t('quickadd.field_hotkey_hint')}>
          <Input
            aria-label={t('quickadd.field_hotkey')}
            value={draft.hotkey ?? ''}
            placeholder={t('quickadd.hotkey_placeholder')}
            onChange={(event) => {
              const combo = event.target.value.trim()
              patch({ hotkey: combo === '' ? null : combo.toLowerCase() })
            }}/>
        </Field>
        <SettingRow title={t('quickadd.field_one_page')} description={t('quickadd.field_one_page_desc')}>
          <Select aria-label={t('quickadd.field_one_page')} value={draft.onePage ?? 'auto'} onChange={(event) => patch({ onePage: event.target.value as QuickAddOnePageMode })}>
            <option value="auto">{t('quickadd.one_page_auto')}</option>
            <option value="always">{t('quickadd.one_page_always')}</option>
            <option value="never">{t('quickadd.one_page_never')}</option>
          </Select>
        </SettingRow>
        <SettingRow title={t('quickadd.field_date_origin')} description={t('quickadd.field_date_origin_desc')}>
          <Select aria-label={t('quickadd.field_date_origin')} value={draft.dateOrigin} onChange={(event) => patch({ dateOrigin: event.target.value as QuickAddDateOrigin })}>
            <option value="run">{t('quickadd.date_origin_run')}</option>
            <option value="note">{t('quickadd.date_origin_note')}</option>
            <option value="ask">{t('quickadd.date_origin_ask')}</option>
          </Select>
        </SettingRow>

        {draft.type === 'template' && <TemplateFields draft={draft} patch={patch} renderFormat={renderFormat}/>}
        {draft.type === 'capture' && <CaptureFields draft={draft} patch={patch} renderFormat={renderFormat}/>}
        {draft.type === 'macro' && <MacroFields draft={draft} patch={patch}/>}

        {draft.type === 'group' && (
          <Field label={t('quickadd.field_parent')} hint={t('quickadd.field_parent_hint')}>
            <GroupParentSelect value={draft.parentId} selfId={draft.id} choices={choices} onChange={(parentId) => patch({ parentId })}/>
          </Field>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowHelp((current) => !current)}
            aria-expanded={showHelp}
            className="text-[12px] font-medium text-[var(--accent)] hover:underline"
          >
            {showHelp ? t('quickadd.hide_token_help') : t('quickadd.show_token_help')}
          </button>
          {showHelp && <QuickAddTokenHelp/>}
        </div>
      </div>
    </Modal>
  )
}

function GroupParentSelect({ value, selfId, choices, onChange }: {
  value: string | null
  selfId: string
  choices: readonly QuickAddChoice[]
  onChange: (next: string | null) => void
}) {
  const options = choices.filter((entry) => entry.type === 'group' && entry.id !== selfId)
  return (
    <Select
      aria-label={t('quickadd.field_parent')}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
      <option value="">{t('quickadd.parent_top')}</option>
      {options.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </Select>
  )
}

function ColorSwatch({ color, active, label, onClick }: {
  color?: string
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-full border text-[10px] transition-transform hover:scale-110"
      style={{
        backgroundColor: color ?? 'transparent',
        borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
        color: 'var(--text-quaternary)',
      }}
    >
      {color ?? 'Ø'}
    </button>
  )
}

function FormatField({ label, hint, value, enabled, onChange, onEnabledChange, renderFormat }: {
  label: string
  hint?: string
  value: string
  enabled: boolean
  onChange: (next: string) => void
  onEnabledChange: (next: boolean) => void
  renderFormat: (text: string) => string
}) {
  const preview = enabled ? renderFormat(value) : ''
  return (
    <div className="space-y-1.5">
      <Checkbox checked={enabled} onChange={onEnabledChange} label={label}/>
      {enabled && (<>
        <Textarea
          aria-label={label}
          value={value}
          rows={3}
          spellCheck={false}
          className="w-full font-mono text-[12.5px]"
          onChange={(event) => onChange(event.target.value)}/>
        {hint && <p className="text-[11.5px] text-[var(--text-quaternary)]">{hint}</p>}
        {preview !== '' && (
          <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2 py-1.5 text-[11.5px]">
            <span className="text-[var(--text-quaternary)]">{t('quickadd.preview_label')}</span>
            <span className="ml-1 break-all font-mono text-[var(--text-secondary)]">{preview}</span>
          </p>
        )}
      </>)}
    </div>
  )
}

function TemplateFields({ draft, patch, renderFormat }: {
  draft: QuickAddTemplateChoice
  patch: (next: Partial<QuickAddChoice>) => void
  renderFormat: (text: string) => string
}) {
  const templates = useNoteTemplates((state) => state.templates)
  return (
    <div className="space-y-3 border-t border-[var(--border-subtle)] pt-3">
      <SettingRow title={t('quickadd.field_mode')}>
        <Select aria-label={t('quickadd.field_mode')} value={draft.mode} onChange={(event) => patch({ mode: event.target.value as QuickAddTemplateMode })}>
          <option value="new-note">{t('quickadd.mode_new_note')}</option>
          <option value="insert-here">{t('quickadd.mode_insert_here')}</option>
        </Select>
      </SettingRow>
      <Field label={t('quickadd.field_template')} hint={t('quickadd.field_template_hint')}>
        <Select
          aria-label={t('quickadd.field_template')}
          value={draft.templateId ?? ''}
          onChange={(event) => patch({ templateId: event.target.value === '' ? null : event.target.value })}>
          <option value="">{t('quickadd.no_template')}</option>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </Select>
      </Field>
      <FormatField
        label={t('quickadd.field_name_format')}
        hint={t('quickadd.field_name_format_hint')}
        value={draft.nameFormat.format}
        enabled={draft.nameFormat.enabled}
        onChange={(format) => patch({ nameFormat: { enabled: true, format } })}
        onEnabledChange={(enabled) => patch({ nameFormat: { ...draft.nameFormat, enabled } })}
        renderFormat={renderFormat}/>
      <SettingRow title={t('quickadd.field_folder_mode')}>
        <Select aria-label={t('quickadd.field_folder_mode')} value={draft.folderMode} onChange={(event) => patch({ folderMode: event.target.value as QuickAddFolderMode })}>
          <option value="default">{t('quickadd.folder_mode_default')}</option>
          <option value="fixed">{t('quickadd.folder_mode_fixed')}</option>
          <option value="ask">{t('quickadd.folder_mode_ask')}</option>
          <option value="source">{t('quickadd.folder_mode_source')}</option>
        </Select>
      </SettingRow>
      {draft.folderMode === 'fixed' && (
        <Field label={t('quickadd.field_folder_path')}>
          <Input aria-label={t('quickadd.field_folder_path')} value={draft.folderPath} onChange={(event) => patch({ folderPath: event.target.value })}/>
        </Field>
      )}
      {draft.mode === 'new-note' && (
        <SettingRow title={t('quickadd.field_existing')}>
          <Select aria-label={t('quickadd.field_existing')} value={draft.existing} onChange={(event) => patch({ existing: event.target.value as QuickAddExistingAction })}>
            <option value="cancel">{t('quickadd.existing_cancel')}</option>
            <option value="ask">{t('quickadd.existing_ask')}</option>
            <option value="number">{t('quickadd.existing_number')}</option>
          </Select>
        </SettingRow>
      )}
      <Field label={t('quickadd.field_tags')} hint={t('quickadd.field_tags_hint')}>
        <Input
          aria-label={t('quickadd.field_tags')}
          value={draft.tags.join(', ')}
          onChange={(event) => patch({ tags: event.target.value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '') })}/>
      </Field>
      <div className="grid gap-1 md:grid-cols-3">
        <Checkbox checked={draft.openAfter} onChange={(openAfter) => patch({ openAfter })} label={t('quickadd.field_open_after')}/>
        <Checkbox checked={draft.linkToSource} onChange={(linkToSource) => patch({ linkToSource })} label={t('quickadd.field_link_to_source')}/>
        <Checkbox checked={draft.copyLink} onChange={(copyLink) => patch({ copyLink })} label={t('quickadd.field_copy_link')}/>
      </div>
    </div>
  )
}

function CaptureFields({ draft, patch, renderFormat }: {
  draft: QuickAddCaptureChoice
  patch: (next: Partial<QuickAddChoice>) => void
  renderFormat: (text: string) => string
}) {
  const templates = useNoteTemplates((state) => state.templates)
  const set = (next: Partial<QuickAddCaptureChoice>) => patch(next as Partial<QuickAddChoice>)
  const anchored = draft.writePosition === 'insertAfter' || draft.writePosition === 'insertBefore'
  return (
    <div className="space-y-3 border-t border-[var(--border-subtle)] pt-3">
      <SettingRow title={t('quickadd.field_target_mode')}>
        <Select aria-label={t('quickadd.field_target_mode')} value={draft.targetMode} onChange={(event) => set({ targetMode: event.target.value as QuickAddCaptureTargetMode })}>
          <option value="active">{t('quickadd.target_active')}</option>
          <option value="note">{t('quickadd.target_note')}</option>
        </Select>
      </SettingRow>
      {draft.targetMode === 'note' && (
        <Field label={t('quickadd.field_target_title')} hint={t('quickadd.field_target_title_hint')}>
          <Input aria-label={t('quickadd.field_target_title')} value={draft.targetTitle} onChange={(event) => set({ targetTitle: event.target.value })}/>
          <p className="mt-1 text-[11.5px] text-[var(--text-quaternary)]">
            <span className="font-mono">{draft.targetTitle}</span>
          </p>
        </Field>
      )}
      {draft.targetMode === 'note' && (
        <div className="grid gap-2 md:grid-cols-2">
          <Checkbox checked={draft.createIfMissing} onChange={(createIfMissing) => set({ createIfMissing })} label={t('quickadd.field_create_target')}/>
          {draft.createIfMissing && (
            <Field label={t('quickadd.field_create_template')}>
              <Select
                aria-label={t('quickadd.field_create_template')}
                value={draft.createTemplateId ?? ''}
                onChange={(event) => set({ createTemplateId: event.target.value === '' ? null : event.target.value })}>
                <option value="">{t('quickadd.no_template')}</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
      )}
      <SettingRow title={t('quickadd.field_position')}>
        <Select
          aria-label={t('quickadd.field_position')}
          value={draft.writePosition}
          onChange={(event) => set({ writePosition: event.target.value as QuickAddPosition })}>
          {POSITIONS.map((position) => <option key={position} value={position}>{t(POSITION_KEYS[position])}</option>)}
        </Select>
      </SettingRow>
      {anchored && (
        <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <Field label={draft.writePosition === 'insertAfter' ? t('quickadd.field_after') : t('quickadd.field_before')} hint={t('quickadd.field_anchor_hint')}>
            <Input
              aria-label={draft.writePosition === 'insertAfter' ? t('quickadd.field_after') : t('quickadd.field_before')}
              value={draft.writePosition === 'insertAfter' ? draft.after : draft.before}
              onChange={(event) => set(draft.writePosition === 'insertAfter' ? { after: event.target.value } : { before: event.target.value })}/>
          </Field>
          <div className="grid gap-1 md:grid-cols-3">
            <Checkbox checked={draft.promptHeading} onChange={(promptHeading) => set({ promptHeading })} label={t('quickadd.field_prompt_heading')}/>
            <Checkbox checked={draft.atSectionEnd} onChange={(atSectionEnd) => set({ atSectionEnd })} label={t('quickadd.field_at_section_end')}/>
            <Checkbox checked={draft.considerSubsections} onChange={(considerSubsections) => set({ considerSubsections })} label={t('quickadd.field_consider_subsections')}/>
            <Checkbox checked={draft.inline} onChange={(inline) => set({ inline })} label={t('quickadd.field_inline')}/>
            <Checkbox checked={draft.replaceExisting} onChange={(replaceExisting) => set({ replaceExisting })} label={t('quickadd.field_replace_existing')}/>
            <Checkbox checked={draft.createLineIfMissing} onChange={(createLineIfMissing) => set({ createLineIfMissing })} label={t('quickadd.field_create_anchor')}/>
          </div>
          <SettingRow title={t('quickadd.field_blank_line')}>
            <Select
              aria-label={t('quickadd.field_blank_line')}
              value={draft.blankLine}
              onChange={(event) => set({ blankLine: event.target.value as QuickAddBlankLineMode })}>
              {BLANK_MODES.map((mode) => <option key={mode} value={mode}>{t(BLANK_KEYS[mode])}</option>)}
            </Select>
          </SettingRow>
          {draft.createLineIfMissing && (
            <>
              <SettingRow title={t('quickadd.field_create_at')}>
                <Select
                  aria-label={t('quickadd.field_create_at')}
                  value={draft.createAt}
                  onChange={(event) => set({ createAt: event.target.value as QuickAddCreateAt })}>
                  {CREATE_AT.map((where) => <option key={where} value={where}>{t(CREATE_AT_KEYS[where])}</option>)}
                </Select>
              </SettingRow>
              {draft.createAt === 'ordered' && (
                <div className="grid gap-2 md:grid-cols-3">
                  <Field label={t('quickadd.field_order_by')}>
                    <Select
                      aria-label={t('quickadd.field_order_by')}
                      value={draft.orderBy.by}
                      onChange={(event) => set({ orderBy: { ...draft.orderBy, by: event.target.value as QuickAddOrderKey } })}>
                      {ORDER_KEYS.map((by) => <option key={by} value={by}>{t(ORDER_KEYS_LABELS[by])}</option>)}
                    </Select>
                  </Field>
                  <Field label={t('quickadd.field_order_direction')}>
                    <Select
                      aria-label={t('quickadd.field_order_direction')}
                      value={draft.orderBy.direction}
                      onChange={(event) => set({ orderBy: { ...draft.orderBy, direction: event.target.value as QuickAddDirection } })}>
                      {DIRECTIONS.map((direction) => <option key={direction} value={direction}>{t(DIRECTION_KEYS[direction])}</option>)}
                    </Select>
                  </Field>
                  <Field label={t('quickadd.field_order_format')}>
                    <Input
                      aria-label={t('quickadd.field_order_format')}
                      value={draft.orderBy.dateFormat}
                      onChange={(event) => set({ orderBy: { ...draft.orderBy, dateFormat: event.target.value } })}/>
                  </Field>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <FormatField
        label={t('quickadd.field_format')}
        hint={t('quickadd.field_format_hint')}
        value={draft.format.format}
        enabled={draft.format.enabled}
        onChange={(format) => set({ format: { enabled: true, format } })}
        onEnabledChange={(enabled) => set({ format: { ...draft.format, enabled } })}
        renderFormat={renderFormat}/>
      <div className="grid gap-1 md:grid-cols-3">
        <Checkbox checked={draft.task} onChange={(task) => set({ task })} label={t('quickadd.field_task')}/>
        <Checkbox checked={draft.eachLine} onChange={(eachLine) => set({ eachLine })} label={t('quickadd.field_each_line')}/>
        <Checkbox checked={draft.openAfter} onChange={(openAfter) => set({ openAfter })} label={t('quickadd.field_open_after')}/>
        <Checkbox checked={draft.linkToSource} onChange={(linkToSource) => set({ linkToSource })} label={t('quickadd.field_link_to_source')}/>
        <Checkbox checked={draft.copyLink} onChange={(copyLink) => set({ copyLink })} label={t('quickadd.field_copy_link')}/>
      </div>
      <div className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
        <Checkbox checked={draft.property.enabled} onChange={(enabled) => set({ property: { ...draft.property, enabled } })} label={t('quickadd.field_property')}/>
        {draft.property.enabled && (
          <div className="grid gap-2 md:grid-cols-2">
            <Field label={t('quickadd.field_property_name')}>
              <Input
                aria-label={t('quickadd.field_property_name')}
                value={draft.property.name}
                onChange={(event) => set({ property: { ...draft.property, name: event.target.value } })}/>
            </Field>
            <Field label={t('quickadd.field_property_action')}>
              <Select
                aria-label={t('quickadd.field_property_action')}
                value={draft.property.action}
                onChange={(event) => set({ property: { ...draft.property, action: event.target.value as 'set' | 'append' } })}>
                <option value="set">{t('quickadd.property_set')}</option>
                <option value="append">{t('quickadd.property_append')}</option>
              </Select>
            </Field>
            <Checkbox checked={draft.property.prompted} onChange={(prompted) => set({ property: { ...draft.property, prompted } })} label={t('quickadd.field_property_prompted')}/>
            <Checkbox checked={draft.property.createIfMissing} onChange={(createIfMissing) => set({ property: { ...draft.property, createIfMissing } })} label={t('quickadd.field_property_create')}/>
            <div className="md:col-span-2">
              <FormatField
                label={t('quickadd.field_property_format')}
                hint={t('quickadd.field_property_format_hint')}
                value={draft.property.format.format}
                enabled={draft.property.format.enabled}
                onChange={(format) => set({ property: { ...draft.property, format: { enabled: true, format } } })}
                onEnabledChange={(enabled) => set({ property: { ...draft.property, format: { ...draft.property.format, enabled } } })}
                renderFormat={renderFormat}/>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function newStep(kind: QuickAddStep['kind']): QuickAddStep {
  switch (kind) {
    case 'ask': return { kind, variable: 'answer', label: '', options: '' }
    case 'set': return { kind, variable: 'value', value: '' }
    case 'insert': return { kind, text: '{{VALUE}}' }
    case 'capture': return { kind, title: 'Inbox', text: '{{VALUE}}', position: 'bottom' }
    case 'create': return { kind, title: '{{DATE}}', templateId: null, folderPath: '', openAfter: false }
    case 'copy': return { kind, text: '{{VALUE}}' }
    case 'open': return { kind, title: '' }
    case 'notify': return { kind, text: '' }
    case 'wait': return { kind, ms: 200 }
    case 'script': return { kind, name: 'step', code: 'return quickadd.title' }
    case 'if': return { kind, variable: 'answer', operator: 'eq', value: '', then: [], else: [] }
    default: return { kind: 'choice', choiceId: '' }
  }
}

function MacroFields({ draft, patch }: {
  draft: QuickAddMacroChoice
  patch: (next: Partial<QuickAddChoice>) => void
}) {
  const choices = useQuickAdd((state) => state.choices)
  const runnable = choices.filter((choice) => choice.id !== draft.id && choice.type !== 'group')
  const set = (steps: QuickAddStep[]) => patch({ steps } as Partial<QuickAddChoice>)
  const updateStep = (index: number, next: QuickAddStep) => set(draft.steps.map((step, at) => (at === index ? next : step)))
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= draft.steps.length) return
    const steps = [...draft.steps]
    steps[target] = steps[index]
    steps[index] = steps[target]
    set(steps)
  }
  return (
    <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{t('quickadd.field_steps')}</h3>
        <Button
          size="sm"
          onClick={() => {
            if (draft.steps.length >= QUICKADD_LIMITS.maxSteps) return
            set([...draft.steps, newStep('insert')])
          }}
        >
          <Plus size={13}/>{t('quickadd.add_step')}
        </Button>
      </div>
      {draft.steps.length === 0 && <p className="text-[12px] text-[var(--text-quaternary)]">{t('quickadd.no_steps')}</p>}
      {draft.steps.map((step, index) => (
        <fieldset key={`step-${index}`} className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
          <legend className="sr-only">{`${t('quickadd.step_kind')} ${index + 1}`}</legend>
          <div className="flex items-center gap-2">
            <Select
              aria-label={t('quickadd.step_kind')}
              value={step.kind}
              className="w-[150px]"
              onChange={(event) => updateStep(index, newStep(event.target.value as QuickAddStep['kind']))}>
              {STEP_KINDS.map((kind) => <option key={kind} value={kind}>{t(STEP_KEYS[kind])}</option>)}
            </Select>
            <span className="flex-1"/>
            <IconButton label={t('quickadd.move_step_up')} size="sm" onClick={() => move(index, -1)}>
              <ArrowUp size={13}/>
            </IconButton>
            <IconButton label={t('quickadd.move_step_down')} size="sm" onClick={() => move(index, 1)}>
              <ArrowDown size={13}/>
            </IconButton>
            <IconButton label={t('quickadd.remove_step')} size="sm" onClick={() => set(draft.steps.filter((_, at) => at !== index))}>
              <Trash2 size={13}/>
            </IconButton>
          </div>
          <StepFields step={step} index={index} runnable={runnable} onChange={(next) => updateStep(index, next)}/>
        </fieldset>
      ))}
    </div>
  )
}

function StepFields({ step, index, runnable, onChange }: {
  step: QuickAddStep
  index: number
  runnable: QuickAddChoice[]
  onChange: (next: QuickAddStep) => void
}) {
  const field = (label: string, value: string, next: (text: string) => void) => (<>
    <span className="block text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
    <Input
      aria-label={`${label} ${index + 1}`}
      value={value}
      onChange={(event) => next(event.target.value)}/>
  </>)
  switch (step.kind) {
    case 'ask':
      return (<div className="grid gap-2 md:grid-cols-3">
        {field(t('quickadd.step_variable'), step.variable, (variable) => onChange({ ...step, variable }))}
        {field(t('quickadd.step_label'), step.label, (label) => onChange({ ...step, label }))}
        {field(t('quickadd.step_options'), step.options, (options) => onChange({ ...step, options }))}
      </div>)
    case 'set':
      return (<div className="grid gap-2 md:grid-cols-2">
        {field(t('quickadd.step_variable'), step.variable, (variable) => onChange({ ...step, variable }))}
        {field(t('quickadd.step_value'), step.value, (value) => onChange({ ...step, value }))}
      </div>)
    case 'insert':
    case 'copy':
    case 'notify':
      return field(t('quickadd.step_text'), step.text, (text) => onChange({ ...step, text }))
    case 'open':
      return field(t('quickadd.step_title'), step.title, (title) => onChange({ ...step, title }))
    case 'create':
      return (<div className="grid gap-2 md:grid-cols-2">
        {field(t('quickadd.step_title'), step.title, (title) => onChange({ ...step, title }))}
        {field(t('quickadd.step_folder'), step.folderPath, (folderPath) => onChange({ ...step, folderPath }))}
        <Checkbox checked={step.openAfter} onChange={(openAfter) => onChange({ ...step, openAfter })} label={t('quickadd.field_open_after')}/>
      </div>)
    case 'capture':
      return (<div className="grid gap-2 md:grid-cols-2">
        {field(t('quickadd.step_title'), step.title, (title) => onChange({ ...step, title }))}
        {field(t('quickadd.step_text'), step.text, (text) => onChange({ ...step, text }))}
      </div>)
    case 'wait':
      return (<div>
        <span className="block text-[12px] font-medium text-[var(--text-secondary)]">{t('quickadd.step_ms')}</span>
        <Input
          aria-label={t('quickadd.step_ms')}
          type="number"
          min={0}
          max={30000}
          value={String(step.ms)}
          onChange={(event) => onChange({ ...step, ms: Math.max(0, Math.min(30_000, Number(event.target.value) || 0)) })}/>
      </div>)
    case 'script':
      return (<div className="space-y-2">
        {field(t('quickadd.step_name'), step.name, (name) => onChange({ ...step, name }))}
        <div>
          <span className="block text-[12px] font-medium text-[var(--text-secondary)]">{t('quickadd.step_code')}</span>
          <Textarea
            aria-label={t('quickadd.step_code')}
            value={step.code}
            rows={5}
            spellCheck={false}
            className="w-full font-mono text-[12.5px]"
            onChange={(event) => onChange({ ...step, code: event.target.value.slice(0, QUICKADD_LIMITS.maxScriptLength) })}/>
          <p className="text-[11.5px] text-[var(--text-quaternary)]">{t('quickadd.step_code_hint')}</p>
        </div>
      </div>)
    case 'if':
      return (<div className="grid gap-2 md:grid-cols-3">
        {field(t('quickadd.step_variable'), step.variable, (variable) => onChange({ ...step, variable }))}
        <div>
          <span className="block text-[12px] font-medium text-[var(--text-secondary)]">{t('quickadd.step_operator')}</span>
          <Select
            aria-label={t('quickadd.step_operator')}
            value={step.operator}
            onChange={(event) => onChange({ ...step, operator: event.target.value as QuickAddConditionOperator })}>
            {OPERATORS.map((operator) => <option key={operator} value={operator}>{t(OPERATOR_KEYS[operator])}</option>)}
          </Select>
        </div>
        {field(t('quickadd.step_value'), step.value, (value) => onChange({ ...step, value }))}
        <p className="text-[11.5px] text-[var(--text-quaternary)] md:col-span-3">
          {t('quickadd.step_branch_counts', { value0: String(step.then.length), value1: String(step.else.length) })}
        </p>
      </div>)
    default:
      return (<div>
        <span className="block text-[12px] font-medium text-[var(--text-secondary)]">{t('quickadd.step_choice_step')}</span>
        <Select
          aria-label={t('quickadd.step_choice_step')}
          value={step.choiceId}
          onChange={(event) => onChange({ ...step, choiceId: event.target.value })}>
          <option value="">{t('quickadd.step_choice_none')}</option>
          {runnable.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </Select>
      </div>)
  }
}

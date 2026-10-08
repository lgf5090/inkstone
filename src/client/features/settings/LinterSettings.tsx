/**
 * The markdown linter's settings page.
 *
 * Three things live here: when the linter runs, which rules are on, and what each rule wants.
 * The rule list is the reference plugin's, so a row is a switch, its own options, and the
 * before/after pair that rule was written with — the examples are the rule's, not a paraphrase, and
 * they run through the same code path a lint run uses, which is what keeps this page honest.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LINTER_LIMITS, type LinterSettings as LinterSettingsValue, type LinterRuleConfig } from '@shared/linter'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select, SettingRow, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { t, useLocale, type MessageKey } from '../../lib/i18n'
import { patternSafety } from '@shared/regex-safety'
import { LinterRuleTitle } from './LinterRuleTitles'
import { RuleType, type Rule } from '../../lib/linter/rules'
import type { RuleOption } from '../../lib/linter/option'
import type { LinterSettings as StoredSettings } from '../../lib/linter/settings-data'
import { ChevronDown, Plus, RotateCcw, Search, Trash2 } from 'lucide-react'

const RULE_TYPES: RuleType[] = [RuleType.YAML, RuleType.HEADING, RuleType.FOOTNOTE, RuleType.CONTENT, RuleType.SPACING, RuleType.PASTE]

const IDLE_KEYS: Record<string, MessageKey> = {
  '0': 'linter.idle.never',
  '5000': 'linter.idle.after_seconds_5',
  '10000': 'linter.idle.after_seconds_10',
  '15000': 'linter.idle.after_seconds_15',
  '30000': 'linter.idle.after_seconds_30',
  '60000': 'linter.idle.after_minute',
}

function ruleLoaded(): Promise<typeof import('../../lib/linter/registry')> {
  return import('../../lib/linter/registry')
}

/** Catalog text is plain, but a few descriptions carry inline markup from the reference plugin. */
function asPlainText(value: string): string {
  return value
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .trim()
}

/** The extra correction notes a rule reads are stored as file paths; the list control edits them. */
function linterNotePaths(value: boolean | string | number | string[]): string[] {
  return Array.isArray(value) ? value : []
}

function configFor(settings: StoredSettings, alias: string): LinterRuleConfig {
  return settings.ruleConfigs[alias] ?? {}
}

function optionValue(config: LinterRuleConfig, option: RuleOption): boolean | string | number | string[] {
  const stored = config[option.configKey]
  if (stored === undefined) return option.defaultValue as boolean | string | number | string[]

  return stored
}

export function LinterSettings() {
  const settings = useSession((state) => state.settings)
  const update = useSession((state) => state.updateSettings)
  const toast = useUi((state) => state.toast)
  useLocale()
  const linter = settings.linter
  const [rules, setRules] = useState<Rule[]>([])
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<RuleType | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ruleLoaded().then((registry) => {
      if (!cancelled) setRules(registry.rules)
    }).catch(() => {
      if (!cancelled) toast({ title: t('linter.error.rules_unavailable'), tone: 'danger' })
    })

    return () => {
      cancelled = true
    }
  }, [toast])

  const patch = useCallback((next: Partial<LinterSettingsValue>) => {
    void update({ linter: { ...linter, ...next } })
  }, [linter, update])

  const patchRule = useCallback((alias: string, config: LinterRuleConfig) => {
    const ruleConfigs = { ...linter.ruleConfigs, [alias]: config }
    if (Object.keys(config).length === 0) delete ruleConfigs[alias]
    void update({ linter: { ...linter, ruleConfigs } })
  }, [linter, update])

  const enabledCount = useMemo(() => rules.filter((rule) => rule.isEnabled(linter)).length, [rules, linter])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (rule: Rule) => {
      if (typeFilter !== 'all' && rule.type !== typeFilter) return false
      if (!needle) return true
      const haystack = [
        rule.getName(),
        rule.getDescription(),
        rule.alias,
        ...rule.options.map((option) => t(option.nameKey)),
      ].join('\n').toLowerCase()

      return haystack.includes(needle)
    }

    return rules.filter(matches)
  }, [query, rules, typeFilter])

  /**
   * Switching a rule on can mean switching others off, and all of it has to be one write. Each patch
   * is built from the settings this render saw, so a second `patchRule` would start from the copy
   * before the first and hand back the rival rule its switch — which is exactly what the reader just
   * agreed to give up.
   */
  const setRuleEnabled = useCallback(async (rule: Rule, next: boolean) => {
    const ruleConfigs: Record<string, LinterRuleConfig> = { ...linter.ruleConfigs }
    const write = (alias: string, config: LinterRuleConfig) => {
      if (Object.keys(config).length === 0) delete ruleConfigs[alias]
      else ruleConfigs[alias] = config
    }

    if (!next) {
      write(rule.alias, { ...configFor(linter, rule.alias), enabled: false })
      void update({ linter: { ...linter, ruleConfigs } })

      return
    }

    const conflicts = rule.conflictsWhenEnabled(true).filter((conflict) => {
      const config = configFor(linter, conflict.rule)
      if (conflict.option) return config[conflict.option] === true

      return config.enabled === true
    })

    if (conflicts.length) {
      const names = conflicts.map((conflict) => {
        const target = rules.find((candidate) => candidate.alias === conflict.rule)
        const optionLabel = conflict.option
          ? target?.options.find((option) => option.configKey === conflict.option)?.getName() ?? conflict.option
          : ''

        return [target?.getName() ?? conflict.rule, optionLabel].filter(Boolean).join(' → ')
      })
      const accepted = await confirm({
        title: t('linter.confirm.conflict_title'),
        description: t('linter.confirm.conflict_description', { name: rule.getName(), names: names.join(', ') }),
        confirmLabel: t('linter.confirm.turn_off'),
        tone: 'danger',
      })
      if (!accepted) return
      for (const conflict of conflicts) {
        const config = { ...configFor(linter, conflict.rule) }
        if (conflict.option) config[conflict.option] = false
        else config.enabled = false
        write(conflict.rule, config)
      }
    }

    write(rule.alias, { ...configFor(linter, rule.alias), enabled: true })
    void update({ linter: { ...linter, ruleConfigs } })
  }, [linter, rules, update])

  const switchAll = useCallback((next: boolean) => {
    const ruleConfigs: Record<string, LinterRuleConfig> = { ...linter.ruleConfigs }
    for (const rule of rules) {
      if (rule.type === RuleType.PASTE) continue
      ruleConfigs[rule.alias] = { ...ruleConfigs[rule.alias], enabled: next }
    }
    void update({ linter: { ...linter, ruleConfigs } })
  }, [linter, rules, update])

  return (
    <div className="space-y-6">
      <section>
        <SettingRow title={t('settings.markdown_linter')} description={t('linter.enabled_desc')}>
          <Switch checked={linter.enabled} onChange={(enabled) => patch({ enabled })} label={t('settings.markdown_linter')} />
        </SettingRow>
        <SettingRow title={t('settings.linter_lint_on_save')} description={t('linter.lint_on_save_desc')}>
          <Switch checked={linter.lintOnSave} onChange={(lintOnSave) => patch({ lintOnSave })} label={t('settings.linter_lint_on_save')} />
        </SettingRow>
        <SettingRow title={t('settings.linter_lint_on_paste')} description={t('linter.lint_on_paste_desc')}>
          <Switch checked={linter.lintOnPaste} onChange={(lintOnPaste) => patch({ lintOnPaste })} label={t('settings.linter_lint_on_paste')} />
        </SettingRow>
        <SettingRow title={t('settings.linter_lint_on_idle')} description={t('linter.lint_on_idle_desc')}>
          <Select
            aria-label={t('settings.linter_lint_on_idle')}
            value={String(linter.lintOnIdle)}
            onChange={(event) => patch({ lintOnIdle: Number(event.target.value) as LinterSettingsValue['lintOnIdle'] })}>
            {Object.entries(IDLE_KEYS).map(([value, key]) => (
              <option key={value} value={value}>{t(key)}</option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow title={t('settings.linter_report_changes')} description={t('linter.report_changes_desc')}>
          <Switch checked={linter.reportChanges} onChange={(reportChanges) => patch({ reportChanges })} label={t('settings.linter_report_changes')} />
        </SettingRow>
        <SettingRow title={t('settings.linter_record_log')} description={t('linter.record_log_desc')}>
          <Switch checked={linter.recordRunLog} onChange={(recordRunLog) => patch({ recordRunLog })} label={t('settings.linter_record_log')} />
        </SettingRow>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" size={14} aria-hidden="true" />
            <Input
              aria-label={t('linter.search_rules')}
              className="w-full pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('linter.search_rules')} />
          </div>
          <Select aria-label={t('linter.filter_by_type')} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as RuleType | 'all')}>
            <option value="all">{t('linter.type.all')}</option>
            {RULE_TYPES.map((type) => <option key={type} value={type}>{t(`linter.type.${type.toLowerCase()}` as MessageKey)}</option>)}
          </Select>
          <Button variant="secondary" onClick={() => switchAll(true)}>{t('linter.enable_all')}</Button>
          <Button variant="secondary" onClick={() => switchAll(false)}>{t('linter.disable_all')}</Button>
        </div>
        <p className="mb-1 text-[11.5px] text-[var(--text-tertiary)]">
          {t('linter.rules_on_count', { on: enabledCount, total: rules.length, shown: visible.length })}
        </p>
        {visible.map((rule) => {
          const config = configFor(linter, rule.alias)
          const expanded = open === rule.alias

          return (
            <div key={rule.alias} className="border-b border-[var(--border-subtle)] last:border-b-0">
              <div className="flex flex-col items-stretch gap-2 py-3 md:flex-row md:items-center md:gap-4">
                <div className="min-w-0 flex-1">
                  <LinterRuleTitle alias={rule.alias} runtimeName={rule.getName()} />
                  <div className="mt-0.5 break-words text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{asPlainText(rule.getDescription())}</div>
                  <code className="mt-1 block text-[10.5px] text-[var(--text-tertiary)]">{rule.alias}</code>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {rule.options.length > 0 && (
                    <IconButton
                      label={expanded ? t('linter.collapse') : t('linter.expand')}
                      onClick={() => setOpen(expanded ? null : rule.alias)}>
                      <ChevronDown size={14} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden="true" />
                    </IconButton>
                  )}
                  <Switch
                    checked={config.enabled === true}
                    disabled={!linter.enabled}
                    onChange={(next) => void setRuleEnabled(rule, next)}
                    label={rule.getName()} />
                </div>
              </div>
              {expanded && (
                <div className="pb-3">
                  {rule.options
                    .filter((option) => !rule.hiddenConfigKeys.includes(option.configKey))
                    .map((option) => (
                      <RuleOptionRow
                        key={option.configKey}
                        option={option}
                        config={config}
                        onChange={(value) => patchRule(rule.alias, { ...config, [option.configKey]: value })} />
                    ))}
                  {rule.examples.length > 0 && (
                    <div className="mt-2 space-y-3">
                      {rule.examples.map((example, index) => (
                        <ExampleBlock key={index} description={example.description} before={example.before} after={example.after} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </section>

      <section>
        <SettingRow title={t('linter.alias_array_style.name')} description={asPlainText(t('linter.alias_array_style.description'))}>
          <ArrayStyleSelect kind="alias" value={linter.commonStyles.aliasArrayStyle} onChange={(aliasArrayStyle) => patch({ commonStyles: { ...linter.commonStyles, aliasArrayStyle } })} />
        </SettingRow>
        <SettingRow title={t('linter.tag_array_style.name')} description={asPlainText(t('linter.tag_array_style.description'))}>
          <ArrayStyleSelect kind="tag" value={linter.commonStyles.tagArrayStyle} onChange={(tagArrayStyle) => patch({ commonStyles: { ...linter.commonStyles, tagArrayStyle } })} />
        </SettingRow>
        <SettingRow title={t('linter.default_array_style.name')} description={asPlainText(t('linter.default_array_style.description'))}>
          <ArrayStyleSelect kind="default" value={linter.commonStyles.defaultArrayStyle} onChange={(defaultArrayStyle) => patch({ commonStyles: { ...linter.commonStyles, defaultArrayStyle } })} />
        </SettingRow>
        <SettingRow title={t('linter.escape_character.name')} description={asPlainText(t('linter.escape_character.description'))}>
          <Select
            aria-label={t('linter.escape_character.name')}
            value={linter.commonStyles.escapeCharacter}
            onChange={(event) => patch({ commonStyles: { ...linter.commonStyles, escapeCharacter: event.target.value as '"' | "'" } })}>
            <option value={'"'}>{'"'}</option>
            <option value={"'"}>{"'"}</option>
          </Select>
        </SettingRow>
        <SettingRow title={t('linter.math_dollar_signs.name')} description={asPlainText(t('linter.math_dollar_signs.description'))}>
          <Select
            aria-label={t('linter.math_dollar_signs.name')}
            value={String(linter.commonStyles.minimumNumberOfDollarSignsToBeAMathBlock)}
            onChange={(event) => patch({ commonStyles: { ...linter.commonStyles, minimumNumberOfDollarSignsToBeAMathBlock: Number(event.target.value) } })}>
            <option value="2">{2}</option>
            <option value="3">{3}</option>
          </Select>
        </SettingRow>
      </section>

      <CustomRegexes linter={linter} patch={patch} />
      <IgnoreLists linter={linter} patch={patch} />
    </div>
  )
}

function RuleOptionRow({ option, config, onChange }: {
  option: RuleOption
  config: LinterRuleConfig
  onChange: (value: boolean | string | number | string[]) => void
}) {
  const value = optionValue(config, option)

  return (
    <SettingRow title={t(option.nameKey)} description={asPlainText(t(option.descriptionKey))}>
      {option.kind === 'toggle' && (
        <Switch checked={value === true} onChange={onChange} label={t(option.nameKey)} />
      )}
      {option.kind === 'dropdown' && (
        <Select
          aria-label={t(option.nameKey)}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}>
          {option.options.map((record) => (
            <option key={record.value} value={record.value}>{record.labelKey ? t(record.labelKey) : record.value}</option>
          ))}
        </Select>
      )}
      {(option.kind === 'text' || option.kind === 'date-format') && (
        <Input
          aria-label={t(option.nameKey)}
          className="w-[260px] max-w-full font-mono text-[12px]"
          value={String(value)}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)} />
      )}
      {option.kind === 'number' && (
        <Input
          aria-label={t(option.nameKey)}
          type="number"
          className="w-[110px] font-mono text-[12px]"
          value={String(value)}
          onChange={(event) => onChange(event.target.value === '' ? option.defaultValue : Number(event.target.value))} />
      )}
      {option.kind === 'list' && (
        <EntryList
          values={Array.isArray(value) ? value : []}
          placeholder={option.placeholderKey ? t(option.placeholderKey) : ''}
          emptyLabel={option.emptyStateKey ? t(option.emptyStateKey) : t('linter.list.empty')}
          allowReorder={option.allowReorder === true}
          validator={option.validator}
          onChange={onChange} />
      )}
      {option.kind === 'note-picker' && (
        <EntryList
          values={linterNotePaths(value)}
          placeholder={t('linter.note_picker.placeholder')}
          emptyLabel={t('linter.note_picker.empty')}
          allowReorder={false}
          onChange={onChange} />
      )}
    </SettingRow>
  )
}

function ArrayStyleSelect({ kind, value, onChange }: {
  kind: 'alias' | 'default' | 'tag'
  value: string
  onChange: (next: never) => void
}) {
  const options = kind === 'default'
    ? ['single-line', 'multi-line']
    : kind === 'tag'
      ? ['single-line', 'multi-line', 'single string space delimited', 'single-line space delimited', 'single string to single-line', 'single string to multi-line', 'single string comma delimited']
      : ['single-line', 'multi-line', 'single string to single-line', 'single string to multi-line', 'single string comma delimited']

  return (
    <Select aria-label={t(`linter.${kind}_array_style.name`)} value={value} onChange={(event) => onChange(event.target.value as never)}>
      {options.map((option) => (
        <option key={option} value={option}>
          {t(`linter.enums.${option.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}` as MessageKey)}
        </option>
      ))}
    </Select>
  )
}

/** A rule's own before/after pair, shown as the two documents rather than as prose. */
function ExampleBlock({ description, before, after }: { description: string, before: string, after: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
      <p className="mb-2 break-words text-[11.5px] text-[var(--text-secondary)]">{description}</p>
      <div className="grid gap-2 md:grid-cols-2">
        {[before, after].map((body, index) => (
          <pre
            key={index}
            className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--bg-inset)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
            <span className="mb-1 block font-sans text-[10px] uppercase text-[var(--text-tertiary)]">
              {index === 0 ? t('linter.example.before') : t('linter.example.after')}
            </span>{body}
          </pre>
        ))}
      </div>
    </div>
  )
}

/** A list of typed entries — words, YAML keys, folder names — with the rule's own validator. */
function EntryList({ values, placeholder, emptyLabel, allowReorder, validator, onChange }: {
  values: string[]
  placeholder: string
  emptyLabel: string
  allowReorder: boolean
  validator?: (value: string) => [boolean, string]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const add = useCallback(() => {
    const value = draft.trim()
    if (!value) return
    const verdict = validator?.(value)
    if (verdict && !verdict[0]) {
      setProblem(verdict[1])

      return
    }
    if (values.includes(value)) {
      setProblem(t('linter.already_in_list'))

      return
    }
    setProblem('')
    setDraft('')
    onChange([...values, value])
    input.current?.focus()
  }, [draft, onChange, validator, values])

  return (
    <div className="w-[320px] max-w-full">
      {values.length === 0 && <p className="mb-1 text-[11.5px] text-[var(--text-tertiary)]">{emptyLabel}</p>}
      <ul className="space-y-1">
        {values.map((value, index) => (
          <li key={`${value}:${index}`} className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-[var(--bg-sunken)] px-2 py-1 font-mono text-[11.5px]">{value}</code>
            {allowReorder && index > 0 && (
              <IconButton label={t('linter.list.move_up')} onClick={() => {
                const next = [...values]
                const [moved] = next.splice(index, 1)
                next.splice(index - 1, 0, moved)
                onChange(next)
              }}>
                <ChevronDown size={13} className="rotate-180" aria-hidden="true" />
              </IconButton>
            )}
            <IconButton label={t('linter.list.remove')} onClick={() => onChange(values.filter((_, at) => at !== index))}>
              <Trash2 size={13} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex items-center gap-2">
        <Input
          ref={input}
          aria-label={placeholder || emptyLabel}
          className="min-w-0 flex-1 font-mono text-[12px]"
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value)
            setProblem('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }} />
        <IconButton label={t('linter.add')} onClick={add}>
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {problem && <p className="mt-1 text-[11px] text-[var(--danger)]">{problem}</p>}
    </div>
  )
}

function CustomRegexes({ linter, patch }: { linter: LinterSettingsValue, patch: (next: Partial<LinterSettingsValue>) => void }) {
  const rows = linter.customRegexes

  const update = (index: number, next: Partial<LinterSettingsValue['customRegexes'][number]>) => {
    const customRegexes = rows.map((row, at) => (at === index ? { ...row, ...next } : row))
    patch({ customRegexes })
  }

  const problemFor = (find: string, flags: string): string => {
    if (!find) return ''
    if (find.length > LINTER_LIMITS.regexPatternChars) return t('linter.regex.too_long')
    if (patternSafety(find) === 'unsafe') return t('linter.regex.unsafe')
    try {
      new RegExp(find, flags)
    } catch {
      return t('linter.regex.invalid')
    }

    return ''
  }

  return (
    <section>
      <SettingRow title={t('linter.custom_regexes.name')} description={asPlainText(t('linter.custom_regexes.description'))}>
        <Button
          variant="secondary"
          onClick={() => patch({ customRegexes: [...rows, { label: '', find: '', replace: '', flags: 'g', enabled: false }] })}>
          <Plus size={13} aria-hidden="true" />
          {t('linter.custom_regexes.add')}
        </Button>
      </SettingRow>
      {rows.length === 0 && <p className="py-2 text-[11.5px] text-[var(--text-tertiary)]">{t('linter.custom_regexes.empty')}</p>}
      {rows.map((row, index) => {
        const problem = problemFor(row.find, row.flags)

        return (
          <div key={index} className="space-y-1 border-b border-[var(--border-subtle)] py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={t('linter.custom_regexes.label')}
                className="w-[150px] max-w-full"
                value={row.label}
                placeholder={t('linter.custom_regexes.label')}
                onChange={(event) => update(index, { label: event.target.value })} />
              <Input
                aria-label={t('linter.custom_regexes.find')}
                className="min-w-[160px] flex-1 font-mono text-[12px]"
                value={row.find}
                placeholder={t('linter.custom_regexes.find')}
                spellCheck={false}
                onChange={(event) => update(index, { find: event.target.value })} />
              <Input
                aria-label={t('linter.custom_regexes.replace')}
                className="min-w-[140px] flex-1 font-mono text-[12px]"
                value={row.replace}
                placeholder={t('linter.custom_regexes.replace')}
                spellCheck={false}
                onChange={(event) => update(index, { replace: event.target.value })} />
              <Input
                aria-label={t('linter.custom_regexes.flags')}
                className="w-[72px] font-mono text-[12px]"
                value={row.flags}
                onChange={(event) => update(index, { flags: event.target.value })} />
              <Switch checked={row.enabled} onChange={(enabled) => update(index, { enabled })} label={t('linter.options.custom_replace.enabled')} />
              <IconButton label={t('linter.list.remove')} onClick={() => patch({ customRegexes: rows.filter((_, at) => at !== index) })}>
                <Trash2 size={13} aria-hidden="true" />
              </IconButton>
            </div>
            {problem && <p className="text-[11px] text-[var(--danger)]">{problem}</p>}
          </div>
        )
      })}
    </section>
  )
}

function IgnoreLists({ linter, patch }: { linter: LinterSettingsValue, patch: (next: Partial<LinterSettingsValue>) => void }) {
  return (
    <section>
      <SettingRow title={t('linter.folders_to_ignore.name')} description={asPlainText(t('linter.folders_to_ignore.description'))}>
        <EntryList
          values={linter.foldersToIgnore}
          placeholder={t('linter.folders_to_ignore.placeholder')}
          emptyLabel={t('linter.folders_to_ignore.empty')}
          allowReorder={false}
          onChange={(foldersToIgnore) => patch({ foldersToIgnore })} />
      </SettingRow>
      <SettingRow title={t('linter.reset_defaults.name')} description={asPlainText(t('linter.reset_defaults.description'))}>
        <Button
          variant="secondary"
          onClick={async () => {
            const accepted = await confirm({
              title: t('linter.reset_defaults.name'),
              description: t('linter.reset_defaults.confirm'),
              confirmLabel: t('linter.reset_defaults.name'),
              tone: 'danger',
            })
            if (accepted) patch({ ruleConfigs: {}, customRegexes: [], foldersToIgnore: [], filesToIgnore: [] })
          }}>
          <RotateCcw size={13} aria-hidden="true" />
          {t('linter.reset_defaults.name')}
        </Button>
      </SettingRow>
    </section>
  )
}

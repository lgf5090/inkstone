import { useState, type FormEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { MEMO_TAG_RULE_MAX_COUNT, MEMO_TAG_RULE_MAX_LENGTH } from '@shared/memos/constants'
import type { MemoTagRule, MemoTagRuleMode } from '@shared/memos/types'
import { patternSafety } from '@shared/regex-safety'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { ColorWellField } from '../../../../components/color-field'
import { Checkbox, Field, Input, Select } from '../../../../components/form'
import { confirm } from '../../../../components/overlay'
import { t, type MessageKey } from '../../../../lib/i18n'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'
import { settingsErrorMessage } from './error'
import type { MemoSettingsSectionProps } from './types'

const MODE_KEYS: Record<MemoTagRuleMode, MessageKey> = {
  exact: 'memos.settings.tags_mode_exact',
  regex: 'memos.settings.tags_mode_regex',
}

const MODE_OPTIONS: readonly MemoTagRuleMode[] = ['exact', 'regex']

function tagRulePattern(rule: MemoTagRule): string {
  return rule.mode === 'regex' ? `/${rule.pattern}/` : rule.pattern
}

export function TagRulesSettings({ preferences, saving, save }: MemoSettingsSectionProps) {
  const [mode, setMode] = useState<MemoTagRuleMode>('exact')
  const [pattern, setPattern] = useState('')
  const [backgroundColor, setBackgroundColor] = useState<string | null>(null)
  const [blurContent, setBlurContent] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [sectionError, setSectionError] = useState<string | null>(null)
  const rules = preferences.tagRules
  const atLimit = rules.length >= MEMO_TAG_RULE_MAX_COUNT

  const validate = (value: string): string | null => {
    if (!value) return t('memos.settings.tags_pattern_required')
    if (value.length > MEMO_TAG_RULE_MAX_LENGTH) {
      return t('memos.settings.tags_pattern_too_long', { max: MEMO_TAG_RULE_MAX_LENGTH })
    }
    if (mode === 'regex') {
      const refusal = patternSafety(value, MEMO_TAG_RULE_MAX_LENGTH)
      if (refusal === 'unsafe') return t('memos.settings.tags_regex_unsafe')
      if (refusal === 'syntax') return t('memos.settings.tags_regex_invalid')
      try {
        new RegExp(value)
      } catch {
        return t('memos.settings.tags_regex_invalid')
      }
    }
    return null
  }

  const add = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving || atLimit) return
    const value = pattern.trim()
    const validation = validate(value)
    if (validation) {
      setFormError(validation)
      return
    }
    const rule: MemoTagRule = { pattern: value, mode, backgroundColor, blurContent }
    setFormError(null)
    try {
      const saved = await save({ tagRules: [...rules, rule] })
      if (saved) {
        setPattern('')
        setMode('exact')
        setBackgroundColor(null)
        setBlurContent(false)
      }
    } catch (failure) {
      setFormError(settingsErrorMessage(failure))
    }
  }

  const remove = async (index: number): Promise<void> => {
    const rule = rules[index]
    if (!rule || saving) return
    const agreed = await confirm({
      title: t('memos.settings.tags_delete_title'),
      description: t('memos.settings.tags_delete_description', { pattern: rule.pattern }),
      confirmLabel: t('memos.settings.tags_delete_confirm'),
      cancelLabel: t('memos.common.cancel'),
      tone: 'danger',
    })
    if (!agreed) return
    setSectionError(null)
    try {
      await save({ tagRules: rules.filter((_, position) => position !== index) })
    } catch (failure) {
      setSectionError(settingsErrorMessage(failure))
    }
  }

  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.tags}
      title={t('memos.settings.tags')}
      description={(
        <>
          <p>{t('memos.settings.tags_description')}</p>
          <p className="mt-1">
            {t('memos.settings.tags_count', { count: rules.length, max: MEMO_TAG_RULE_MAX_COUNT })}
          </p>
        </>
      )}
    >
      {sectionError ? (
        <div role="alert" className="mb-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
            {t('memos.settings.save_failed')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
            {sectionError}
          </p>
        </div>
      ) : null}
      {rules.length === 0 ? (
        <p className="py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('memos.settings.tags_empty')}
        </p>
      ) : (
        <ul aria-label={t('memos.settings.tags_list')} className="divide-y divide-[var(--border-subtle)]">
          {rules.map((rule, index) => (
            <li key={`${rule.mode}:${rule.pattern}:${index}`} className="flex items-center gap-2 py-2">
              {rule.backgroundColor ? (
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-[var(--r-full)]"
                  style={{ backgroundColor: rule.backgroundColor }}
                />
              ) : (
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[var(--r-full)] border border-[var(--border-default)]" />
              )}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <code className="min-w-0 break-words rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                  {tagRulePattern(rule)}
                </code>
                <Badge>{t(MODE_KEYS[rule.mode])}</Badge>
                {rule.blurContent ? <Badge tone="warning">{t('memos.settings.tags_blur_badge')}</Badge> : null}
              </div>
              <IconButton
                label={t('memos.settings.tags_delete', { pattern: rule.pattern })}
                size="sm"
                disabled={saving}
                onClick={() => void remove(index)}
              >
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void add(event)} className="mt-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-2.5">
        <h4 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('memos.settings.tags_add_title')}
        </h4>
        <div className="mt-2 grid gap-2 md:grid-cols-[140px_minmax(0,1fr)]">
          <Field label={t('memos.settings.tags_mode')}>
            <Select
              value={mode}
              disabled={saving}
              onChange={(event) => {
                const next = event.target.value
                if (next === 'exact' || next === 'regex') setMode(next)
                if (formError) setFormError(null)
              }}
            >
              {MODE_OPTIONS.map((option) => (
                <option key={option} value={option}>{t(MODE_KEYS[option])}</option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('memos.settings.tags_pattern')}
            hint={t('memos.settings.tags_pattern_hint')}
          >
            <Input
              value={pattern}
              disabled={saving || atLimit}
              maxLength={MEMO_TAG_RULE_MAX_LENGTH}
              invalid={Boolean(formError)}
              onChange={(event) => {
                setPattern(event.target.value)
                if (formError) setFormError(null)
              }}
            />
          </Field>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Field label={t('memos.settings.tags_color')}>
            <div className="flex items-center gap-1.5">
              <ColorWellField
                value={backgroundColor}
                label={t('memos.settings.tags_color')}
                onChange={setBackgroundColor}
              />
              {backgroundColor ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setBackgroundColor(null)}
                >
                  {t('memos.settings.tags_clear_color')}
                </Button>
              ) : null}
            </div>
          </Field>
          <Checkbox
            checked={blurContent}
            onChange={(next) => setBlurContent(next)}
            label={t('memos.settings.tags_blur')}
            className="ml-auto"
          />
        </div>
        <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
          {t('memos.settings.tags_blur_hint')}
        </p>
        {atLimit ? (
          <p className="mt-1 text-[length:var(--text-11)] text-[var(--warning)]">
            {t('memos.settings.tags_max', { max: MEMO_TAG_RULE_MAX_COUNT })}
          </p>
        ) : null}
        {formError ? (
          <p role="alert" className="mt-1 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {formError}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={saving || atLimit}
          >
            {t('memos.settings.tags_add')}
          </Button>
        </div>
      </form>
    </SettingsCard>
  )
}

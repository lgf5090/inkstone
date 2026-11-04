/**
 * The comparison options, all of which change the answer rather than the look.
 *
 * Every switch here is applied to the line keys before two lines are judged equal, so turning one on
 * can make a change disappear from the count and from the exported patch. The range boxes are for
 * reading one section of two long files; everything outside them is left alone.
 */
import { useState } from 'react'
import { Button } from '../../../../components/primitives'
import { Input, SettingRow, Switch } from '../../../../components/form'
import { regexProblem } from '@shared/tools/compare/engine'
import type { LineRange, TextCompareOptions } from '@shared/tools/compare/types'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'

function rangeValue(range: LineRange | null, field: 'from' | 'to'): string {
  return range ? String(range[field]) : ''
}

export function OptionsPanel({
  options,
  onChange,
  onReset,
}: {
  options: TextCompareOptions
  onChange: (patch: Partial<TextCompareOptions>) => void
  onReset: () => void
}) {
  const [regexDraft, setRegexDraft] = useState(options.ignoreRegex)
  const problem = regexProblem(regexDraft)

  const changeRange = (side: 'leftRange' | 'rightRange', field: 'from' | 'to', raw: string) => {
    const current = options[side] ?? { from: 1, to: 1 }
    const parsed = raw === '' ? 0 : Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onChange({ [side]: null })
      return
    }
    onChange({ [side]: { ...current, [field]: parsed } })
  }

  return (
    <div className="flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3">
      <SettingRow title={t('tools.compare.option.ignore_whitespace')} description={t('tools.compare.option.ignore_whitespace_desc')}>
        <Switch
          checked={options.ignoreWhitespace}
          onChange={(value) => onChange({ ignoreWhitespace: value })}
          label={t('tools.compare.option.ignore_whitespace')}
        />
      </SettingRow>
      <SettingRow title={t('tools.compare.option.ignore_case')} description={t('tools.compare.option.ignore_case_desc')}>
        <Switch
          checked={options.ignoreCase}
          onChange={(value) => onChange({ ignoreCase: value })}
          label={t('tools.compare.option.ignore_case')}
        />
      </SettingRow>
      <SettingRow title={t('tools.compare.option.ignore_line_endings')} description={t('tools.compare.option.ignore_line_endings_desc')}>
        <Switch
          checked={options.ignoreLineEndings}
          onChange={(value) => onChange({ ignoreLineEndings: value })}
          label={t('tools.compare.option.ignore_line_endings')}
        />
      </SettingRow>
      <SettingRow title={t('tools.compare.option.ignore_regex')} description={t('tools.compare.option.ignore_regex_desc')}>
        <div className="flex flex-col items-end gap-1">
          <Input
            value={regexDraft}
            onChange={(event) => {
              setRegexDraft(event.target.value)
              if (!regexProblem(event.target.value)) onChange({ ignoreRegex: event.target.value })
            }}
            onBlur={() => {
              if (!problem) onChange({ ignoreRegex: regexDraft })
            }}
            placeholder={t('tools.compare.option.regex_placeholder')}
            aria-label={t('tools.compare.option.ignore_regex')}
            invalid={Boolean(problem)}
            spellCheck={false}
            className="w-[220px] font-mono text-[length:var(--text-12)]"
          />
          {problem && <span className="text-[length:var(--text-11)] text-[var(--danger)]">{problem}</span>}
        </div>
      </SettingRow>

      <SettingRow title={t('tools.compare.option.ranges')} description={t('tools.compare.option.ranges_desc')}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <RangeBoxes
            label={t('tools.compare.text.left')}
            range={options.leftRange}
            onChange={(field, value) => changeRange('leftRange', field, value)}
          />
          <RangeBoxes
            label={t('tools.compare.text.right')}
            range={options.rightRange}
            onChange={(field, value) => changeRange('rightRange', field, value)}
          />
        </div>
      </SettingRow>

      <div className="flex justify-end py-2">
        <Button size="sm" variant="ghost" onClick={() => { setRegexDraft(''); onReset() }}>
          {t('tools.compare.option.reset')}
        </Button>
      </div>
    </div>
  )
}

function RangeBoxes({ label, range, onChange }: { label: string; range: LineRange | null; onChange: (field: 'from' | 'to', value: string) => void }) {
  return (
    <fieldset className={cn('flex items-center gap-1 rounded-[var(--r-sm)] border px-1.5 py-1', range ? 'border-[var(--accent)]/50' : 'border-[var(--border-subtle)]')}>
      <legend className="px-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{label}</legend>
      <Input
        type="number"
        min={1}
        value={rangeValue(range, 'from')}
        onChange={(event) => onChange('from', event.target.value)}
        aria-label={`${label} ${t('tools.compare.option.range_from')}`}
        placeholder={t('tools.compare.option.range_from')}
        className="h-7 w-[64px] px-1.5 text-center font-mono text-[length:var(--text-11)]"
      />
      <span aria-hidden="true" className="text-[var(--text-quaternary)]">–</span>
      <Input
        type="number"
        min={1}
        value={rangeValue(range, 'to')}
        onChange={(event) => onChange('to', event.target.value)}
        aria-label={`${label} ${t('tools.compare.option.range_to')}`}
        placeholder={t('tools.compare.option.range_to')}
        className="h-7 w-[64px] px-1.5 text-center font-mono text-[length:var(--text-11)]"
      />
    </fieldset>
  )
}

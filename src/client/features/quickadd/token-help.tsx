/**
 * The token cheat sheet, and the one place the QuickAdd grammar is spelled out for the author.
 *
 * Each row shows the token as it is typed and what the *same formatter* makes of it right now, so the
 * table cannot disagree with the engine the way a hand-written example eventually does.
 */
import { useMemo, useState } from 'react'
import { useLocale } from '../../lib/i18n'
import { t } from '../../lib/i18n'
import { FORMAT_TOKEN_HELP, inertFormat } from '../../lib/quickadd/format'
import { previewRuntime } from '../../lib/quickadd/preview'
import { useQuickAdd } from '../../store/quickadd'

export function QuickAddTokenHelp({ onInsert }: { onInsert?: (token: string) => void }) {
  const settings = useQuickAdd((state) => state.settings)
  const choices = useQuickAdd((state) => state.choices)
  const locale = useLocale()
  const [sample, setSample] = useState('{{DATE:YYYY-MM-DD}} {{TITLE}} — {{VALUE|default:idea}}')

  const runtime = useMemo(() => previewRuntime({
    settings,
    choices,
    title: t('quickadd.preview_note'),
    locale,
  }), [choices, locale, settings])

  const preview = useMemo(() => {
    try {
      return inertFormat(sample, runtime)
    } catch {
      return t('quickadd.preview_failed')
    }
  }, [runtime, sample])

  return (
    <div className="space-y-2 pt-2">
      <label className="block text-[12px] font-medium text-[var(--text-secondary)]" htmlFor="quickadd-token-sample">
        {t('quickadd.token_sample_label')}
      </label>
      <input
        id="quickadd-token-sample"
        className="h-9 w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 font-mono text-[12px] outline-none focus:border-[var(--accent)]"
        value={sample}
        onChange={(event) => setSample(event.target.value)}/>
      <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2 py-1.5 text-[11.5px]">
        <span className="text-[var(--text-quaternary)]">{t('quickadd.preview_label')}</span>
        <span className="ml-1 break-all font-mono text-[var(--text-secondary)]">{preview}</span>
      </p>
      <ul className="max-h-[240px] space-y-1 overflow-y-auto text-[12px]">
        {FORMAT_TOKEN_HELP.map((entry) => (
          <li key={entry.token}>
            <button
              type="button"
              onClick={() => onInsert?.(entry.token)}
              className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-[var(--bg-hover)]"
            >
              <code className="shrink-0 font-mono text-[11.5px] text-[var(--accent)]">{entry.token}</code>
              <span className="min-w-0 flex-1 text-[var(--text-tertiary)]">{t(entry.descriptionKey)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

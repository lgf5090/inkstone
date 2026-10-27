import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles, Square, Wand2 } from 'lucide-react'
import { isImeComposing } from '../../../lib/ime'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Segmented, Textarea } from '../../../components/form'
import { getAiStatus, streamAiChat } from './api'
import type { AiMode } from './types'

export interface AiSqlPanelProps {
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }> | null
  currentSql: string
  onInsert: (sql: string) => void
  onError: (message: string) => void
  className?: string
}

function schemaText(tables: AiSqlPanelProps['tables']): string {
  if (!tables || tables.length === 0) return ''
  return tables.map((table) => `- ${table.name}(${table.columns.map((column) => `${column.name} ${column.type}`).join(', ')})`).join('\n')
}

export function AiSqlPanel({ tables, currentSql, onInsert, onError, className }: AiSqlPanelProps) {
  const [mode, setMode] = useState<AiMode>('generate')
  const [prompt, setPrompt] = useState('')
  const [output, setOutput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [modelLabel, setModelLabel] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void getAiStatus().then((status) => {
      setConfigured(status.configured)
      setModelLabel(status.modelLabel ?? '')
    }).catch(() => setConfigured(false))
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  const schema = useMemo(() => schemaText(tables), [tables])

  const run = () => {
    if (streaming) return
    if (mode === 'generate' && !prompt.trim()) {
      onError(t('development.database.ai.enter_requirement'))
      return
    }
    if (mode !== 'generate' && !currentSql.trim()) {
      onError(t('development.database.ai.no_sql'))
      return
    }
    setOutput('')
    setError(null)
    setStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    void streamAiChat({ mode, prompt: prompt.trim(), currentSql, schemaText: schema }, (event) => {
      if (event.type === 'delta') setOutput((current) => current + event.content)
      if (event.type === 'error') setError(event.message)
    }, controller.signal)
      .catch((cause) => {
        if (controller.signal.aborted) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        onError(message)
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null
        setStreaming(false)
      })
  }

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
  }

  const openSettings = () => {
    useUi.getState().openPanel('settings')
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col gap-3 p-3', className)}>
      <Segmented
        value={mode}
        onChange={setMode}
        label={t('development.database.ai.mode')}
        options={[
          { value: 'generate', label: t('development.database.ai.generate') },
          { value: 'explain', label: t('development.database.ai.explain') },
          { value: 'optimize', label: t('development.database.ai.optimize') },
        ]}
      />

      {configured === false && (
        <div className="rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2.5 text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">
          <p>{t('development.database.ai.no_model')}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={openSettings}>
            {t('development.database.ai.open_settings')}
          </Button>
        </div>
      )}
      {configured && modelLabel && (
        <div className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.ai.model', { model: modelLabel })}</div>
      )}

      {mode === 'generate' ? (
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) run()
          }}
          placeholder={t('development.database.ai.requirement_placeholder')}
          className="h-20 shrink-0 resize-none text-[length:var(--text-12)]"
        />
      ) : (
        <div className="shrink-0">
          <div className="mb-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.ai.current_sql')}</div>
          <pre className="max-h-28 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2 font-mono text-[length:var(--text-10)] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
            {currentSql || t('development.database.ai.editor_empty')}
          </pre>
        </div>
      )}

      <div className="flex min-h-28 flex-1 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
          <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{output ? t('development.database.ai.output_chars', { count: output.length }) : t('development.database.ai.output')}</span>
          {streaming && <Button variant="ghost" size="sm" onClick={stop}><Square size={12} />{t('development.database.ai.stop')}</Button>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {error ? (
            <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">{error}</p>
          ) : output ? (
            <pre className="font-mono text-[length:var(--text-11)] leading-relaxed whitespace-pre-wrap text-[var(--text-primary)]">{output}</pre>
          ) : (
            <div className="flex h-full items-center justify-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {streaming ? <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />{t('development.database.ai.generating')}</span> : t('development.database.ai.empty')}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1.5">
        <Button variant="secondary" size="sm" disabled={!output.trim()} onClick={() => onInsert(output)}>
          <Wand2 size={13} />
          {t('development.database.ai.insert')}
        </Button>
        <Button size="sm" onClick={run} disabled={streaming || configured === false}>
          {streaming ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {streaming ? t('development.database.ai.generating') : t('development.database.ai.start')}
        </Button>
      </div>
    </div>
  )
}

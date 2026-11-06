/**
 * The arena: one prompt, several models, side-by-side answers.
 */

import { useEffect, useRef, useState } from 'react'
import { Play, Plus, Square, Trash2 } from 'lucide-react'
import { Badge, Button, IconButton, Spinner } from '../../../../components/primitives'
import { Field, Textarea } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import type { ArenaContestant, ArenaResult } from '@shared/tools/prompt-optimizer/types'
import { promptOptimizerApi } from '../api'
import { usePromptOptimizerStore } from '../store'

export function ArenaView() {
  const models = usePromptOptimizerStore((s) => s.models)
  const [prompt, setPrompt] = useState('')
  const [contestants, setContestants] = useState<ArenaContestant[]>([
    { id: 'a1', kind: 'text', modelId: '' },
    { id: 'a2', kind: 'text', modelId: '' },
  ])
  const [results, setResults] = useState<Record<string, ArenaResult>>({})
  const [running, setRunning] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void promptOptimizerApi.arena().then((state) => {
      if (!state) return
      setPrompt(state.prompt)
      setContestants(state.contestants)
      setResults(state.results)
    }).catch(() => {
      // A saved arena that cannot be read is simply an empty one; the next run writes a fresh state.
    }).finally(() => {
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (!models.text.length) return
    setContestants((current) => current.map((contestant, index) => ({
      ...contestant,
      modelId: contestant.modelId || models.text[index % models.text.length]?.id || '',
    })))
  }, [models.text])

  useEffect(() => {
    if (!loaded) return
    if (!prompt.trim() && !contestants.length) return
    const timer = setTimeout(() => {
      void promptOptimizerApi.saveArena({
        schemaVersion: 1,
        prompt,
        images: [],
        contestants,
        results: results as unknown as Record<string, unknown>,
        lastActiveAt: Date.now(),
      }).catch(() => {
        useUiStore.getState().toast(t('tools.prompt_optimizer.arena.save_failed'), 'error')
      })
    }, 800)
    return () => clearTimeout(timer)
  }, [prompt, contestants, results])

  const persist = async (next: { prompt: string; contestants: ArenaContestant[]; results: Record<string, ArenaResult> }) => {
    try {
      await promptOptimizerApi.saveArena({
        schemaVersion: 1,
        prompt: next.prompt,
        images: [],
        contestants: next.contestants,
        results: next.results as unknown as Record<string, unknown>,
        lastActiveAt: Date.now(),
      })
    } catch {
      useUiStore.getState().toast(t('tools.prompt_optimizer.arena.save_failed'), 'error')
    }
  }

  const run = async () => {
    if (!prompt.trim() || !contestants.length) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    const started = Date.now()
    const pending: Record<string, ArenaResult> = {}
    for (const contestant of contestants) {
      pending[contestant.id] = {
        runId: contestant.id,
        fingerprint: contestant.modelId,
        prompt,
        model: contestant,
        status: 'running',
        output: { result: '', reasoning: '', status: 'streaming' },
        images: [],
        startedAt: started,
        durationMs: 0,
      }
    }
    setResults(pending)
    await Promise.all(contestants.map(async (contestant) => {
      try {
        const result = await promptOptimizerApi.test({ system: '', user: prompt, modelId: contestant.modelId }, controller.signal)
        if (controller.signal.aborted) return
        setResults((current) => ({
          ...current,
          [contestant.id]: {
            ...pending[contestant.id]!,
            status: 'success',
            output: { result: result.text, reasoning: result.reasoning, status: 'complete' },
            durationMs: Date.now() - started,
          },
        }))
      } catch (error) {
        if (controller.signal.aborted) return
        setResults((current) => ({
          ...current,
          [contestant.id]: {
            ...pending[contestant.id]!,
            status: 'error',
            error: error instanceof Error ? error.message : t('tools.prompt_optimizer.arena.failed'),
            durationMs: Date.now() - started,
          },
        }))
      }
    }))
    if (abortRef.current === controller) abortRef.current = null
    setRunning(false)
  }

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
    setResults((current) => Object.fromEntries(Object.entries(current).map(([id, result]) => [
      id,
      result.status === 'running'
        ? { ...result, status: 'cancelled' as const, output: { ...result.output, status: 'cancelled' as const }, durationMs: Date.now() - result.startedAt }
        : result,
    ])))
  }

  const modelOptions = models.text.map((model) => ({ value: model.id, label: model.label || model.model }))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <header className="mb-4">
        <h1 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
          {t('tools.prompt_optimizer.arena.title')}
        </h1>
        <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.arena.subtitle')}
        </p>
      </header>

      <Field label={t('tools.prompt_optimizer.arena.prompt')} hint={!prompt.trim() ? t('tools.prompt_optimizer.arena.empty') : undefined}>
        <Textarea
          value={prompt}
          rows={6}
          onChange={(event) => { setPrompt(event.target.value) }}
          className="w-full font-mono text-[length:var(--text-13)]"
        />
      </Field>

      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.prompt_optimizer.arena.contestants')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setContestants((current) => [...current, { id: `a${Date.now().toString(36)}`, kind: 'text', modelId: models.text[0]?.id ?? '' }])}
            disabled={contestants.length >= 6}
          >
            <Plus size={13} />
            {t('tools.prompt_optimizer.arena.add_contestant')}
          </Button>
        </div>
        {contestants.map((contestant) => (
          <div key={contestant.id} className="flex items-center gap-2">
            <SelectMenu
              label={t('tools.prompt_optimizer.workspace.model')}
              value={contestant.modelId}
              options={modelOptions.length ? modelOptions : [{ value: '', label: t('tools.prompt_optimizer.arena.no_model') }]}
              onChange={(modelId) => setContestants((current) => current.map((entry) => entry.id === contestant.id ? { ...entry, modelId } : entry))}
              width={260}
            />
            <IconButton
              label={t('tools.prompt_optimizer.common.delete')}
              size="sm"
              disabled={contestants.length <= 1}
              onClick={() => setContestants((current) => current.filter((entry) => entry.id !== contestant.id))}
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('tools.prompt_optimizer.arena.image_disabled')}
        </p>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          loading={running}
          disabled={!prompt.trim() || !contestants.some((contestant) => contestant.modelId) || running}
          onClick={() => void run()}
        >
          <Play size={14} />
          {running ? t('tools.prompt_optimizer.arena.running') : t('tools.prompt_optimizer.arena.run')}
        </Button>
        {running && (
          <Button variant="secondary" size="md" onClick={stop}>
            <Square size={13} />
            {t('tools.prompt_optimizer.arena.stop')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => {
          setResults({})
          void persist({ prompt, contestants, results: {} })
        }}>
          {t('tools.prompt_optimizer.workspace.clear')}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {contestants.map((contestant) => {
          const result = results[contestant.id]
          return (
            <div key={contestant.id} className="flex min-h-[160px] flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <Badge tone={result?.status === 'error' ? 'danger' : result?.status === 'success' ? 'success' : 'neutral'}>
                  {models.text.find((model) => model.id === contestant.modelId)?.label || contestant.modelId}
                </Badge>
                {result && result.status === 'success' && (
                  <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    {t('tools.prompt_optimizer.arena.duration').replace('{ms}', String(result.durationMs))}
                  </span>
                )}
              </div>
              {result?.status === 'running' ? (
                <div className="flex flex-1 items-center justify-center"><Spinner size={16} /></div>
              ) : result?.status === 'cancelled' ? (
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.prompt_optimizer.arena.cancelled')}</p>
              ) : result?.status === 'error' ? (
                <p className="text-[length:var(--text-12)] text-[var(--danger)]">{t('tools.prompt_optimizer.arena.failed')}: {result.error}</p>
              ) : (
                <pre className="flex-1 overflow-auto whitespace-pre-wrap text-[length:var(--text-12)] text-[var(--text-secondary)]">
                  {result?.output.result || t('tools.prompt_optimizer.test.no_output')}
                </pre>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void persist({ prompt, contestants, results })
          }}
        >
          {t('tools.prompt_optimizer.common.save')}
        </Button>
      </div>
    </div>
  )
}

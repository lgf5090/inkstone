/**
 * The AI column beside one terminal session.
 *
 * Three jobs, each one press: turn a sentence into a command, explain why the last command failed,
 * and keep a handoff note for the next connection. The panel never runs a command by itself; a
 * proposed command is pasted at the prompt so the reader still decides to press Enter.
 *
 * The context is the terminal's own tail, read from the xterm buffer on demand. Nothing is captured
 * in the background and no transcript is stored on the server.
 */

import { useEffect, useMemo, useState } from 'react'
import { Copy, CornerDownLeft, RefreshCw, Sparkles, TriangleAlert, X } from 'lucide-react'
import type { WebsshAiConfig, WebsshAiDiagnoseResult, WebsshAiRiskResult, WebsshAiSummaryResult, WebsshAiHandoffView } from '@shared/webssh/ai'
import type { WebsshHost } from '@shared/webssh/types'
import { Badge, Button, IconButton, Spinner } from '../../components/primitives'
import { Field, Input, Textarea } from '../../components/form'
import { Empty } from '../../components/feedback'
import { copyText } from '../../lib/clipboard'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { websshAiApi } from './ai-client'
import { websshAiErrorText } from './ai-error'

/** What the pane can read from its terminal, read at the moment a button is pressed. */
export interface WebsshAiTerminalSource {
  transcript: () => string
  currentLine: () => string
  lastCommand: () => string
  lastOutput: () => string
}

type AiTab = 'command' | 'session'

function riskLabel(level: 'safe' | 'caution' | 'danger'): string {
  if (level === 'danger') return t('webssh.ai.risk.danger')
  if (level === 'caution') return t('webssh.ai.risk.caution')
  return t('webssh.ai.risk.safe')
}

function confidenceLabel(confidence: 'low' | 'medium' | 'high'): string {
  if (confidence === 'high') return t('webssh.ai.confidence.high')
  if (confidence === 'medium') return t('webssh.ai.confidence.medium')
  return t('webssh.ai.confidence.low')
}

function riskTone(level: 'safe' | 'caution' | 'danger'): 'success' | 'warning' | 'danger' {
  if (level === 'danger') return 'danger'
  if (level === 'caution') return 'warning'
  return 'success'
}

function RiskBadge({ level }: { level: 'safe' | 'caution' | 'danger' }) {
  return <Badge tone={riskTone(level)}>{riskLabel(level)}</Badge>
}

export function WebsshAiPanel({ host, sessionId, source, onInsert, onClose, initialTab = 'command' }: {
  host: WebsshHost
  sessionId: string | null
  source: WebsshAiTerminalSource
  onInsert: (text: string) => void
  onClose: () => void
  /** The handoff card opens the session half; the toolbar opens the command half. */
  initialTab?: AiTab
}) {
  const [tab, setTab] = useState<AiTab>(initialTab)
  // The handoff card can ask for the session half after the panel is already open.
  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])
  const [config, setConfig] = useState<WebsshAiConfig | null>(null)
  const [prompt, setPrompt] = useState('')
  const [commandResult, setCommandResult] = useState<Awaited<ReturnType<typeof websshAiApi.command>> | null>(null)
  const [commandBusy, setCommandBusy] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [exitCode, setExitCode] = useState('')
  const [diagnoseResult, setDiagnoseResult] = useState<WebsshAiDiagnoseResult | null>(null)
  const [diagnoseBusy, setDiagnoseBusy] = useState(false)
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null)
  const [riskResult, setRiskResult] = useState<WebsshAiRiskResult | null>(null)
  const [riskBusy, setRiskBusy] = useState(false)
  const [riskError, setRiskError] = useState<string | null>(null)
  const [summaryResult, setSummaryResult] = useState<WebsshAiSummaryResult | null>(null)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<WebsshAiHandoffView | null>(null)
  const [handoffLoading, setHandoffLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    websshAiApi.config()
      .then((next) => {
        if (!cancelled) setConfig(next)
      })
      .catch(() => {
        // The panel still opens: pressing a button reports the real failure with a readable code.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const loadHandoff = useMemo(() => async () => {
    setHandoffLoading(true)
    try {
      setHandoff(await websshAiApi.handoff(host.id))
    } catch {
      // A missing handoff is not an error; a failed read is also kept quiet here because the tab
      // has a visible retry control and the reader may simply not have written one yet.
      setHandoff(null)
    } finally {
      setHandoffLoading(false)
    }
  }, [host.id])

  useEffect(() => {
    if (tab !== 'session') return
    void loadHandoff()
  }, [tab, loadHandoff])

  const insert = (text: string) => {
    const command = text.trim()
    if (!command) return
    onInsert(command)
    useUi.getState().toast({ title: t('webssh.ai.inserted'), tone: 'success' })
  }

  const copy = async (text: string) => {
    const ok = await copyText(text)
    useUi.getState().toast({
      title: ok ? t('webssh.toast.copied') : t('webssh.toast.copy_failed'),
      tone: ok ? 'success' : 'danger',
    })
  }

  const askCommand = async () => {
    const text = prompt.trim()
    if (!text) return
    setCommandBusy(true)
    setCommandError(null)
    setCommandResult(null)
    try {
      setCommandResult(await websshAiApi.command({
        prompt: text,
        transcript: source.transcript(),
        hostId: host.id,
        ...(sessionId ? { sessionId } : {}),
      }))
    } catch (caught) {
      setCommandError(websshAiErrorText(caught))
    } finally {
      setCommandBusy(false)
    }
  }

  const diagnose = async () => {
    const command = source.lastCommand()
    if (!command) return
    setDiagnoseBusy(true)
    setDiagnoseError(null)
    setDiagnoseResult(null)
    try {
      const parsedExit = exitCode.trim() ? Number(exitCode) : null
      setDiagnoseResult(await websshAiApi.diagnose({
        command,
        exitCode: parsedExit !== null && Number.isInteger(parsedExit) && parsedExit >= 0 && parsedExit <= 255 ? parsedExit : null,
        transcript: source.lastOutput() || source.transcript(),
        hostId: host.id,
        ...(sessionId ? { sessionId } : {}),
      }))
    } catch (caught) {
      setDiagnoseError(websshAiErrorText(caught))
    } finally {
      setDiagnoseBusy(false)
    }
  }

  const analyzeRisk = async () => {
    const command = source.currentLine()
    if (!command) return
    setRiskBusy(true)
    setRiskError(null)
    setRiskResult(null)
    try {
      setRiskResult(await websshAiApi.risk({
        command,
        transcript: source.transcript(),
        hostId: host.id,
        ...(sessionId ? { sessionId } : {}),
      }))
    } catch (caught) {
      setRiskError(websshAiErrorText(caught))
    } finally {
      setRiskBusy(false)
    }
  }

  const summarize = async (mode: 'session' | 'handoff') => {
    const transcript = source.transcript()
    if (!transcript) {
      setSummaryError(t('webssh.ai.error.no_transcript'))
      return
    }
    setSummaryBusy(true)
    setSummaryError(null)
    setSummaryResult(null)
    try {
      const result = await websshAiApi.summary({
        transcript,
        mode,
        hostId: host.id,
        ...(sessionId ? { sessionId } : {}),
      })
      setSummaryResult(result)
      if (result.savedAt) setHandoff({
        summary: result.summary,
        highlights: result.highlights,
        openIssues: result.openIssues,
        nextSteps: result.nextSteps,
        model: result.model,
        createdAt: result.savedAt,
      })
    } catch (caught) {
      setSummaryError(websshAiErrorText(caught))
    } finally {
      setSummaryBusy(false)
    }
  }

  const currentCommand = source.currentLine()
  const lastCommand = source.lastCommand()
  const available = config?.available !== false

  return (
    <section
      aria-label={t('webssh.ai.title')}
      className="flex min-h-0 w-full flex-col border-[var(--border-subtle)] bg-[var(--bg-surface)] md:w-[380px] md:shrink-0 md:border-s"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <Sparkles size={14} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {t('webssh.ai.title')}
        </h2>
        {config?.modelLabel && (
          <span className="min-w-0 max-w-[120px] truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {config.modelLabel}
          </span>
        )}
        <IconButton label={t('webssh.actions.close')} size="sm" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <div role="group" aria-label={t('webssh.ai.tabs')} className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <Button size="sm" variant={tab === 'command' ? 'primary' : 'secondary'} onClick={() => setTab('command')}>
          {t('webssh.ai.tab_command')}
        </Button>
        <Button size="sm" variant={tab === 'session' ? 'primary' : 'secondary'} onClick={() => setTab('session')}>
          {t('webssh.ai.tab_session')}
        </Button>
        <span className="ms-auto min-w-0 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {host.name}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {!available && config && (
          <p role="alert" className="rounded-[var(--r-md)] border border-[var(--warning)]/40 bg-[var(--warning-softer)] p-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
            {t('webssh.ai.error.unavailable')}
          </p>
        )}

        {tab === 'command' ? (
          <>
            <section aria-label={t('webssh.ai.command.section')} className="space-y-1.5">
              <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.command.section')}</h3>
              <Textarea
                value={prompt}
                aria-label={t('webssh.ai.command.prompt_label')}
                placeholder={t('webssh.ai.command.prompt_placeholder')}
                rows={3}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <div className="flex items-center gap-1">
                <Button size="sm" variant="primary" loading={commandBusy} disabled={!available || !prompt.trim()} onClick={() => void askCommand()} icon={<Sparkles size={13} aria-hidden="true" />}>
                  {t('webssh.ai.command.generate')}
                </Button>
                {commandBusy && <span role="status" aria-live="polite" className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Spinner size={12} />{t('webssh.ai.thinking')}</span>}
              </div>
              {commandError && <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{commandError}</p>}
              {commandResult && (
                <div className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
                  <div className="flex items-start gap-1">
                    <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">{commandResult.command || '—'}</pre>
                    <RiskBadge level={commandResult.risk} />
                  </div>
                  {commandResult.explanation && <p className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{commandResult.explanation}</p>}
                  {commandResult.riskReason && <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{commandResult.riskReason}</p>}
                  <div className="flex flex-wrap items-center gap-1">
                    <Button size="sm" variant="secondary" disabled={!commandResult.command} onClick={() => insert(commandResult.command)} icon={<CornerDownLeft size={12} aria-hidden="true" />}>
                      {t('webssh.ai.insert_terminal')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!commandResult.command} onClick={() => void copy(commandResult.command)} icon={<Copy size={12} aria-hidden="true" />}>
                      {t('webssh.ai.copy')}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <section aria-label={t('webssh.ai.diagnose.section')} className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
              <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.diagnose.section')}</h3>
              <p className="break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{lastCommand || t('webssh.ai.diagnose.no_command')}</p>
              <div className="flex items-end gap-1">
                <Field label={t('webssh.ai.diagnose.exit_code')} hint={t('webssh.ai.diagnose.exit_code_hint')} className="w-[110px] shrink-0">
                  <Input
                    value={exitCode}
                    aria-label={t('webssh.ai.diagnose.exit_code')}
                    inputMode="numeric"
                    placeholder="1"
                    onChange={(event) => setExitCode(event.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                  />
                </Field>
                <Button size="sm" loading={diagnoseBusy} disabled={!available || !lastCommand} onClick={() => void diagnose()} icon={<TriangleAlert size={13} aria-hidden="true" />}>
                  {t('webssh.ai.diagnose.run')}
                </Button>
              </div>
              {diagnoseError && <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{diagnoseError}</p>}
              {diagnoseResult && (
                <div className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-primary)]">{diagnoseResult.summary || t('webssh.ai.diagnose.empty')}</p>
                  {diagnoseResult.needsMoreOutput && <p className="text-[length:var(--text-11)] text-[var(--warning)]">{t('webssh.ai.diagnose.more_output')}</p>}
                  {diagnoseResult.causes.length > 0 && (
                    <ul className="list-inside list-disc text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                      {diagnoseResult.causes.map((cause) => <li key={cause}>{cause}</li>)}
                    </ul>
                  )}
                  {diagnoseResult.fixes.length > 0 && (
                    <div className="space-y-1">
                      {diagnoseResult.fixes.map((fix) => (
                        <div key={fix.command} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-1.5">
                          <div className="flex items-start gap-1">
                            <code className="min-w-0 flex-1 break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{fix.command}</code>
                            <RiskBadge level={fix.risk} />
                          </div>
                          {fix.explanation && <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{fix.explanation}</p>}
                          <div className="mt-1 flex items-center gap-1">
                            <Button size="sm" variant="ghost" onClick={() => insert(fix.command)} icon={<CornerDownLeft size={12} aria-hidden="true" />}>{t('webssh.ai.insert_terminal')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => void copy(fix.command)} icon={<Copy size={12} aria-hidden="true" />}>{t('webssh.ai.copy')}</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                    {t('webssh.ai.diagnose.confidence')}: {confidenceLabel(diagnoseResult.confidence)}
                  </p>
                </div>
              )}
            </section>

            <section aria-label={t('webssh.ai.risk.section')} className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
              <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.risk.section')}</h3>
              <p className="break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{currentCommand || t('webssh.ai.risk.no_command')}</p>
              <Button size="sm" variant="secondary" loading={riskBusy} disabled={!available || !currentCommand} onClick={() => void analyzeRisk()} icon={<TriangleAlert size={13} aria-hidden="true" />}>
                {t('webssh.ai.risk.analyze')}
              </Button>
              {riskError && <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{riskError}</p>}
              {riskResult && (
                <div className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
                  <RiskBadge level={riskResult.level} />
                  {riskResult.reasons.length > 0 && (
                    <ul className="list-inside list-disc text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                      {riskResult.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                  )}
                  {riskResult.saferAlternative && (
                    <div className="space-y-1">
                      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('webssh.ai.risk.safer')}</p>
                      <div className="flex items-start gap-1">
                        <code className="min-w-0 flex-1 break-all font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{riskResult.saferAlternative}</code>
                        <Button size="sm" variant="ghost" onClick={() => insert(riskResult.saferAlternative!)}>{t('webssh.ai.insert_terminal')}</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <section aria-label={t('webssh.ai.session.section')} className="space-y-1.5">
              <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.session.section')}</h3>
              <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('webssh.ai.session.description')}</p>
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="primary" loading={summaryBusy} disabled={!available} onClick={() => void summarize('session')} icon={<Sparkles size={13} aria-hidden="true" />}>
                  {t('webssh.ai.session.summarize')}
                </Button>
                <Button size="sm" variant="secondary" loading={summaryBusy} disabled={!available} onClick={() => void summarize('handoff')} icon={<CornerDownLeft size={13} aria-hidden="true" />}>
                  {t('webssh.ai.session.handoff')}
                </Button>
                {summaryBusy && <span role="status" aria-live="polite" className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Spinner size={12} />{t('webssh.ai.thinking')}</span>}
              </div>
              {summaryError && <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{summaryError}</p>}
              {summaryResult && (
                <div className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-primary)]">{summaryResult.summary}</p>
                  {summaryResult.highlights.length > 0 && (
                    <div>
                      <p className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.session.highlights')}</p>
                      <ul className="list-inside list-disc text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {summaryResult.highlights.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  )}
                  {summaryResult.openIssues.length > 0 && (
                    <div>
                      <p className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.session.open_issues')}</p>
                      <ul className="list-inside list-disc text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {summaryResult.openIssues.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  )}
                  {summaryResult.nextSteps.length > 0 && (
                    <div>
                      <p className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.session.next_steps')}</p>
                      <ul className="list-inside list-disc text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {summaryResult.nextSteps.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  )}
                  {summaryResult.savedAt && (
                    <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {t('webssh.ai.session.saved', { date: new Date(summaryResult.savedAt).toLocaleString() })}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section aria-label={t('webssh.ai.handoff.section')} className="space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
              <div className="flex items-center gap-1">
                <h3 className="min-w-0 flex-1 text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('webssh.ai.handoff.section')}</h3>
                <IconButton label={t('webssh.ai.handoff.refresh')} size="xs" onClick={() => void loadHandoff()}>
                  <RefreshCw size={12} aria-hidden="true" />
                </IconButton>
              </div>
              {handoffLoading ? (
                <div className="flex items-center gap-1 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Spinner size={12} />{t('webssh.ai.thinking')}</div>
              ) : handoff ? (
                <div className="space-y-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
                  <p className="text-[length:var(--text-12)] text-[var(--text-primary)]">{handoff.summary}</p>
                  {handoff.openIssues.length > 0 && (
                    <ul className="list-inside list-disc text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                      {handoff.openIssues.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  )}
                  {handoff.nextSteps.length > 0 && (
                    <ul className="list-inside list-disc text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                      {handoff.nextSteps.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  )}
                  <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                    {t('webssh.ai.handoff.saved_at', { date: new Date(handoff.createdAt).toLocaleString() })}
                  </p>
                </div>
              ) : (
                <Empty art="select" compact title={t('webssh.ai.handoff.empty')} description={t('webssh.ai.handoff.empty_description')} />
              )}
            </section>
          </>
        )}
      </div>
    </section>
  )
}

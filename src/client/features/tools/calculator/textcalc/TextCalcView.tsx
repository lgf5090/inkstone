import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Copy, Eraser, History, Play, Settings, Sparkles, Trash2 } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { Button, IconButton } from '../../../../components/primitives'
import { Textarea, Segmented, Switch } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Drawer, Menu, Modal, Tooltip, confirm } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { calcT } from '../lib/calc-i18n'
import { copyToClipboard } from '../lib/clipboard'
import {
  evaluateDocument,
  type TextCalcError,
  type TextCalcErrorCode,
  type TextCalcEvaluation,
  type TextCalcLineResult,
  type TextCalcSettings,
} from './engine'
import {
  TEXTCALC_HISTORY_LIMIT,
  loadDocument,
  loadHistory,
  loadSettings,
  newHistoryEntry,
  saveDocument,
  saveHistory,
  saveSettings,
} from './storage'
import { TEXTCALC_TEMPLATES } from './templates'

const ERROR_KEYS: Record<TextCalcErrorCode, MessageKey> = {
  syntax: 'tools.calculator.textcalc.error.syntax',
  undefined_symbol: 'tools.calculator.textcalc.error.undefined_symbol',
  undefined_function: 'tools.calculator.textcalc.error.undefined_function',
  cycle: 'tools.calculator.textcalc.error.cycle',
  unit_mismatch: 'tools.calculator.textcalc.error.unit_mismatch',
  evaluate: 'tools.calculator.textcalc.error.evaluate',
}

const PRECISION_OPTIONS = [6, 8, 10, 12, 14] as const

function errorText(error: TextCalcError): string {
  const label = calcT(ERROR_KEYS[error.code])
  return error.detail ? `${label}: ${error.detail}` : label
}

function lineText(line: TextCalcLineResult): string {
  if (line.error) return errorText(line.error)
  if (line.kind === 'comment') return calcT('tools.calculator.textcalc.comment')
  return line.value ?? ''
}

function resultsText(evaluation: TextCalcEvaluation): string {
  return evaluation.lines
    .filter((line) => line.kind !== 'empty')
    .map((line) => {
      const text = lineText(line)
      return text ? `${line.index + 1}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

function timestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export function TextCalcView() {
  const [text, setText] = useState(loadDocument)
  const [settings, setSettings] = useState(loadSettings)
  const [history, setHistory] = useState(loadHistory)
  const [evaluation, setEvaluation] = useState(() => evaluateDocument(loadDocument(), loadSettings()))
  const [cursorLine, setCursorLine] = useState(1)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const editorRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const examplesAnchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setEvaluation(evaluateDocument(text, settings))
      saveDocument(text)
    }, 140)
    return () => window.clearTimeout(timer)
  }, [text, settings])

  useEffect(() => {
    // A bulk insert settles its caret after the input event, so the line is read once the browser owns it.
    const timer = window.setTimeout(() => {
      const editor = editorRef.current
      if (!editor) return
      const before = editor.value.slice(0, editor.selectionStart ?? 0)
      setCursorLine(before.split('\n').length)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [text])

  const updateSettings = (patch: Partial<TextCalcSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch }
      saveSettings(next)
      return next
    })
  }

  const recordHistory = (nextText: string, result: TextCalcEvaluation) => {
    if (!nextText.trim() || result.limit || !result.lastValue) return
    setHistory((current) => {
      if (current[0]?.text === nextText) return current
      const next = [newHistoryEntry(nextText, result.lastValue!.text), ...current].slice(0, TEXTCALC_HISTORY_LIMIT)
      saveHistory(next)
      return next
    })
  }

  const commitEvaluation = () => {
    const current = editorRef.current?.value ?? text
    const result = evaluateDocument(current, settings)
    setEvaluation(result)
    saveDocument(current)
    recordHistory(current, result)
  }

  const applyDocument = (nextText: string) => {
    setText(nextText)
    const result = evaluateDocument(nextText, settings)
    setEvaluation(result)
    saveDocument(nextText)
    setCursorLine(1)
    requestAnimationFrame(() => editorRef.current?.focus())
  }

  const syncCursor = () => {
    const editor = editorRef.current
    if (!editor) return
    const before = editor.value.slice(0, editor.selectionStart ?? 0)
    setCursorLine(before.split('\n').length)
  }

  const syncScroll = () => {
    const editor = editorRef.current
    if (!editor) return
    if (gutterRef.current) gutterRef.current.scrollTop = editor.scrollTop
    if (railRef.current) railRef.current.scrollTop = editor.scrollTop
  }

  const insertTab = () => {
    const editor = editorRef.current
    if (!editor) return
    const start = editor.selectionStart ?? 0
    const end = editor.selectionEnd ?? start
    const next = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`
    setText(next)
    requestAnimationFrame(() => {
      editor.selectionStart = start + 2
      editor.selectionEnd = start + 2
      syncCursor()
    })
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault()
      insertTab()
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      window.setTimeout(commitEvaluation, 0)
    }
  }

  const copyResults = () => {
    const payload = resultsText(evaluation)
    if (!payload) return
    void copyToClipboard(payload).then((ok) => {
      useUi.getState().toast({
        title: calcT(ok ? 'tools.calculator.textcalc.copy_done' : 'tools.calculator.textcalc.copy_failed'),
        tone: ok ? 'success' : 'danger',
      })
    })
  }

  const clearDocument = async () => {
    if (!text.trim()) return
    const accepted = await confirm({
      title: calcT('tools.calculator.textcalc.clear_confirm'),
      confirmLabel: calcT('tools.calculator.common.clear'),
      cancelLabel: calcT('tools.calculator.common.cancel'),
      tone: 'danger',
    })
    if (accepted) applyDocument('')
  }

  const loadTemplate = async (body: string) => {
    if (text.trim() && text !== body) {
      const accepted = await confirm({
        title: calcT('tools.calculator.textcalc.example.confirm'),
        confirmLabel: calcT('tools.calculator.common.ok'),
        cancelLabel: calcT('tools.calculator.common.cancel'),
      })
      if (!accepted) return
    }
    applyDocument(body)
    useUi.getState().toast({ title: calcT('tools.calculator.textcalc.example.loaded'), tone: 'success' })
  }

  const clearHistory = async () => {
    if (!history.length) return
    const accepted = await confirm({
      title: calcT('tools.calculator.textcalc.history.clear_confirm'),
      confirmLabel: calcT('tools.calculator.common.clear'),
      cancelLabel: calcT('tools.calculator.common.cancel'),
      tone: 'danger',
    })
    if (!accepted) return
    setHistory([])
    saveHistory([])
  }

  const removeHistory = (id: string) => {
    setHistory((current) => {
      const next = current.filter((entry) => entry.id !== id)
      saveHistory(next)
      return next
    })
  }

  const sourceLines = text.split(/\r?\n/)
  const lineCount = Math.max(1, sourceLines.length)
  const selected = evaluation.lines[cursorLine - 1]
  const selectedText = selected && selected.kind !== 'empty'
    ? lineText(selected)
    : calcT('tools.calculator.textcalc.none')
  const lastText = evaluation.lastValue?.text ?? calcT('tools.calculator.textcalc.none')
  const lastDetail = evaluation.lastValue ? evaluation.lines[evaluation.lastValue.line]?.detail : undefined
  const canCopy = Boolean(evaluation.lastValue)

  const railRow = (line: TextCalcLineResult) => {
    if (line.kind === 'empty') return <div key={line.index} className="h-[22px]" />
    const content = lineText(line)
    const tone = line.error
      ? 'text-[var(--danger)]'
      : line.kind === 'comment'
        ? 'text-[var(--text-quaternary)]'
        : line.kind === 'function'
          ? 'text-[var(--text-tertiary)] italic'
          : 'text-[var(--text-primary)] font-medium'
    return (
      <div
        key={line.index}
        data-testid={`textcalc-line-${line.index}`}
        title={line.error?.detail ?? line.detail ?? content}
        className={`flex h-[22px] items-center justify-end gap-1 overflow-hidden border-b border-[var(--border-subtle)] px-2 text-right font-mono text-[length:var(--text-11)] tabular-nums ${tone}`}
      >
        <span className="truncate">{content}</span>
      </div>
    )
  }

  return (
    <div data-testid="textcalc-root" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg-base)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="min-w-0">
          <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
            {calcT('tools.calculator.textcalc.title')}
          </h1>
          <p className="mt-0.5 hidden text-[length:var(--text-11)] text-[var(--text-tertiary)] sm:block">
            {calcT('tools.calculator.textcalc.note')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" icon={<Play size={13} />} onClick={commitEvaluation}>
            {calcT('tools.calculator.textcalc.evaluate')}
          </Button>
          <div ref={examplesAnchor} className="inline-flex">
            <Tooltip label={calcT('tools.calculator.textcalc.examples')}>
              <IconButton
                label={calcT('tools.calculator.textcalc.examples')}
                size="sm"
                onClick={() => setExamplesOpen(true)}
              >
                <Sparkles size={14} />
              </IconButton>
            </Tooltip>
          </div>
          <Tooltip label={calcT('tools.calculator.textcalc.copy')}>
            <IconButton
              label={calcT('tools.calculator.textcalc.copy')}
              size="sm"
              disabled={!canCopy}
              onClick={copyResults}
            >
              <Copy size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label={calcT('tools.calculator.textcalc.history.title')}>
            <IconButton
              label={calcT('tools.calculator.textcalc.history.title')}
              size="sm"
              onClick={() => setHistoryOpen(true)}
            >
              <History size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label={calcT('tools.calculator.textcalc.settings.title')}>
            <IconButton
              label={calcT('tools.calculator.textcalc.settings.title')}
              size="sm"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip label={calcT('tools.calculator.textcalc.clear')}>
            <IconButton
              label={calcT('tools.calculator.textcalc.clear')}
              size="sm"
              disabled={!text}
              onClick={() => void clearDocument()}
            >
              <Eraser size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      {evaluation.limit && (
        <div role="alert" data-testid="textcalc-limit" className="shrink-0 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
          <p className="font-medium">{calcT('tools.calculator.textcalc.limit.title')}</p>
          <p className="mt-0.5">
            {calcT(
              evaluation.limit.kind === 'lines'
                ? 'tools.calculator.textcalc.limit.lines'
                : 'tools.calculator.textcalc.limit.chars',
              { actual: evaluation.limit.actual, max: evaluation.limit.max },
            )}
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            ref={gutterRef}
            aria-hidden="true"
            className="hidden w-10 shrink-0 overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-2 font-mono text-[length:var(--text-11)] leading-[22px] text-[var(--text-quaternary)] sm:block"
          >
            {Array.from({ length: lineCount }, (_unused, index) => (
              <div key={index} className="h-[22px] pr-2 text-right tabular-nums">
                {index + 1}
              </div>
            ))}
          </div>
          <Textarea
            ref={editorRef}
            data-testid="textcalc-editor"
            value={text}
            onChange={(event) => {
              setText(event.target.value)
            }}
            onScroll={syncScroll}
            onKeyDown={handleKeyDown}
            onClick={syncCursor}
            onKeyUp={syncCursor}
            onSelect={syncCursor}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={calcT('tools.calculator.textcalc.editor')}
            placeholder={calcT('tools.calculator.textcalc.placeholder')}
            className="h-full min-h-0 w-full resize-none rounded-none border-0 bg-transparent px-2 py-2 font-mono text-[length:var(--text-13)] leading-[22px] whitespace-pre focus:border-0 focus:shadow-none"
          />
          <div
            ref={railRef}
            data-testid="textcalc-results-rail"
            aria-label={calcT('tools.calculator.textcalc.results')}
            className="hidden w-[34%] max-w-[280px] shrink-0 overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-2 md:block"
          >
            {evaluation.lines.map(railRow)}
          </div>
        </div>

        <div data-testid="textcalc-mobile-results" className="max-h-[45%] shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] md:hidden">
          {evaluation.lines.every((line) => line.kind === 'empty') ? (
            <p className="px-3 py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {calcT('tools.calculator.textcalc.none')}
            </p>
          ) : (
            evaluation.lines.filter((line) => line.kind !== 'empty').map((line) => (
              <div key={line.index} className="flex items-start gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
                <span className="w-6 shrink-0 text-right font-mono text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
                  {line.index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">{line.source}</div>
                  <div className={`truncate font-mono text-[length:var(--text-12)] ${line.error ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'}`}>
                    {lineText(line)}
                  </div>
                  {line.detail && (
                    <div className="truncate font-mono text-[length:var(--text-10)] text-[var(--text-quaternary)]">{line.detail}</div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span className="inline-flex min-w-0 items-center gap-1">
          <span>{calcT('tools.calculator.textcalc.last')}</span>
          <span role="status" aria-live="polite" data-testid="textcalc-last-result" className="max-w-[220px] truncate font-mono font-medium text-[var(--text-primary)]">
            {lastText}
          </span>
          {lastDetail && (
            <span className="hidden max-w-[300px] truncate font-mono text-[var(--text-quaternary)] md:inline">
              {lastDetail}
            </span>
          )}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1">
          <span>{calcT('tools.calculator.textcalc.cursor', { line: cursorLine })}</span>
          <span className="max-w-[220px] truncate font-mono font-medium text-[var(--text-primary)]">{selectedText}</span>
        </span>
        <span className="hidden md:ml-auto md:inline">{calcT('tools.calculator.textcalc.hint')}</span>
      </footer>

      <Menu
        anchor={examplesAnchor}
        open={examplesOpen}
        onClose={() => setExamplesOpen(false)}
        align="end"
        width={220}
        label={calcT('tools.calculator.textcalc.examples')}
        items={TEXTCALC_TEMPLATES.map((template) => ({
          id: template.id,
          label: calcT(template.labelKey),
          onSelect: () => { void loadTemplate(template.body) },
        }))}
      />

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={calcT('tools.calculator.textcalc.settings.title')}
        width={430}
      >
        <div className="space-y-4 py-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {calcT('tools.calculator.textcalc.settings.angle')}
            </span>
            <Segmented
              value={settings.angleMode}
              onChange={(value) => updateSettings({ angleMode: value })}
              size="sm"
              label={calcT('tools.calculator.textcalc.settings.angle')}
              options={[
                { value: 'deg', label: calcT('tools.calculator.textcalc.settings.deg') },
                { value: 'rad', label: calcT('tools.calculator.textcalc.settings.rad') },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {calcT('tools.calculator.textcalc.settings.precision')}
            </span>
            <SelectMenu
              label={calcT('tools.calculator.textcalc.settings.precision')}
              value={String(settings.precision)}
              onChange={(value) => updateSettings({ precision: Number(value) })}
              width={180}
              options={PRECISION_OPTIONS.map((value) => ({
                value: String(value),
                label: calcT('tools.calculator.textcalc.settings.precision_value', { value }),
              }))}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {calcT('tools.calculator.textcalc.settings.thousands')}
            </span>
            <Switch
              checked={settings.thousands}
              onChange={(next) => updateSettings({ thousands: next })}
              label={calcT('tools.calculator.textcalc.settings.thousands')}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {calcT('tools.calculator.textcalc.settings.bases')}
            </span>
            <Switch
              checked={settings.bases}
              onChange={(next) => updateSettings({ bases: next })}
              label={calcT('tools.calculator.textcalc.settings.bases')}
            />
          </div>
        </div>
      </Modal>

      <Drawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        side="right"
        width={340}
        title={calcT('tools.calculator.textcalc.history.title')}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {calcT('tools.calculator.textcalc.history.count', { count: history.length })}
            </span>
            {history.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => void clearHistory()}>
                {calcT('tools.calculator.textcalc.history.clear')}
              </Button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="px-3 py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {calcT('tools.calculator.textcalc.history.empty')}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto p-2">
              {history.map((entry) => (
                <li key={entry.id} className="group flex items-start gap-1 rounded-[var(--r-sm)] hover:bg-[var(--bg-hover)]">
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-2 py-1.5 text-left"
                    onClick={() => {
                      applyDocument(entry.text)
                      setHistoryOpen(false)
                    }}
                  >
                    <span className="block truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {timestamp(entry.at)} · {calcT('tools.calculator.textcalc.history.lines', { count: entry.lines })}
                    </span>
                    <span className="block truncate font-mono text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                      {entry.summary}
                    </span>
                  </button>
                  <IconButton
                    label={calcT('tools.calculator.textcalc.history.delete')}
                    size="xs"
                    className="mt-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => removeHistory(entry.id)}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Drawer>
    </div>
  )
}

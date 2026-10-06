import { escapeAttr, escapeHtml } from '../../lib/markdown/renderer'
import { fenceAt } from '../../lib/markdown/fence-edit'
import { t } from '../../lib/i18n'
import type { BlockToast } from './block-overlay'
import type { JsRunOutcome } from './js-runner-core'

export { formatJsValue } from './js-runner-core'

export const JS_RUN_TIMEOUT_MS = 2000

const JS_EXAMPLE_LANGUAGES = ['javascript-example', 'js-example'] as const

interface JsLogItem {
  type: 'log' | 'info' | 'warn' | 'error'
  text: string
}

interface JsExecutionResult {
  logs: JsLogItem[]
  result?: string
  error?: string
  durationMs: number
}

export interface JsRunnerWorker {
  postMessage(code: string): void
  terminate(): void
  onmessage: ((event: { data: JsRunOutcome }) => void) | null
  onerror: (() => void) | null
}

function spawnDefaultWorker(): JsRunnerWorker {
  return new Worker(new URL('./js-runner.worker.ts', import.meta.url), { type: 'module' }) as unknown as JsRunnerWorker
}

/**
 * The Worker thread is the sandbox: user code has no DOM and no parent reference, and `terminate()`
 * is the only hard stop for an endless loop. The page-side timeout is what bounds a run.
 */
export function executeJsExample(
  code: string,
  spawnWorker: () => JsRunnerWorker = spawnDefaultWorker,
): Promise<JsExecutionResult> {
  return new Promise((resolve) => {
    let worker: JsRunnerWorker
    try {
      worker = spawnWorker()
    } catch (err) {
      resolve({ logs: [], error: formatSpawnError(err), durationMs: 0 })
      return
    }
    const timer = setTimeout(() => {
      worker.terminate()
      resolve({
        logs: [],
        error: `TimeoutError: execution exceeded ${JS_RUN_TIMEOUT_MS}ms and was terminated`,
        durationMs: JS_RUN_TIMEOUT_MS,
      })
    }, JS_RUN_TIMEOUT_MS)

    worker.onmessage = (event) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(toExecutionResult(event.data))
    }
    worker.onerror = () => {
      clearTimeout(timer)
      worker.terminate()
      resolve({ logs: [], error: 'WorkerError: the runner terminated unexpectedly', durationMs: 0 })
    }
    worker.postMessage(code)
  })
}

function toExecutionResult(outcome: JsRunOutcome): JsExecutionResult {
  const result: JsExecutionResult = {
    logs: outcome.logs.map((item) => ({ type: item.type as JsLogItem['type'], text: item.text })),
    durationMs: outcome.durationMs,
  }
  if (outcome.resultText) result.result = outcome.resultText
  if (outcome.errorText) result.error = outcome.errorText
  return result
}

function formatSpawnError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

function jsExampleBlocks(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.markdown-example.js-example-block[data-line]')]
    .filter((block) => !block.closest('.note-embed-body'))
}

/**
 * The switch and the run button live here rather than in the rendered markup: a share page and an
 * export draw the same block with no controls nobody can press, and the code only ever runs on the
 * surface where the reader is the author.
 */
export function enhanceJsExampleControlsInRoot(root: HTMLElement): void {
  jsExampleBlocks(root).forEach((block) => {
    const head = block.querySelector<HTMLElement>(':scope > .markdown-example-head')
    const output = block.querySelector<HTMLElement>('[data-js-example-output]')
    if (!head || !output || head.querySelector('.js-example-controls')) return
    const switchLabel = escapeAttr(t('workspace.line_numbers'))
    const runLabel = escapeAttr(t('workspace.run_code'))
    const controls = document.createElement('div')
    controls.className = 'js-example-controls'
    controls.innerHTML = [
      `<label class="js-example-switch-wrap" title="${switchLabel}">`,
      `<span class="js-example-switch-label">${escapeHtml(t('workspace.line_numbers'))}</span>`,
      `<button type="button" role="switch" class="js-example-switch is-checked" data-js-switch="line-numbers" aria-checked="true" aria-label="${switchLabel}">`,
      '<span class="js-example-switch-thumb"></span>',
      '</button>',
      '</label>',
      `<button type="button" class="js-example-run-btn" data-js-run title="${runLabel}">`,
      '<span class="js-example-run-icon">▶</span>',
      `<span>${escapeHtml(t('workspace.run'))}</span>`,
      '</button>',
    ].join('')
    head.append(controls)
    const placeholder = document.createElement('div')
    placeholder.className = 'js-example-placeholder'
    placeholder.textContent = t('workspace.click_run_to_execute')
    output.append(placeholder)
  })
}

export function handleJsExampleSwitch(switchBtn: HTMLButtonElement): void {
  const nextChecked = !switchBtn.classList.contains('is-checked')
  switchBtn.classList.toggle('is-checked', nextChecked)
  switchBtn.setAttribute('aria-checked', String(nextChecked))

  const codeBlock = switchBtn.closest<HTMLElement>('.js-example-block')?.querySelector<HTMLElement>('.code-block')
  if (codeBlock) {
    codeBlock.classList.toggle('has-line-numbers', nextChecked)
    codeBlock.dataset.lineNumbers = String(nextChecked)
  }
}

/**
 * The code comes from the note's own fence rather than the rendered `<code>`: the line decoration
 * pads an empty line with a space so the gutter has something to draw, and that space would land
 * inside a multi-line string the note never wrote.
 */
function jsExampleSource(block: HTMLElement, content: string): string | null {
  const line = Number(block.dataset.line)
  if (!Number.isInteger(line) || line < 0) return null
  return fenceAt(content, line, JS_EXAMPLE_LANGUAGES)?.body ?? null
}

export function handleJsExampleRun(
  runBtn: HTMLButtonElement,
  content: string,
  toast: BlockToast,
  spawnWorker: () => JsRunnerWorker = spawnDefaultWorker,
): void {
  const block = runBtn.closest<HTMLElement>('.js-example-block')
  const outputBody = block?.querySelector<HTMLElement>('[data-js-example-output]')
  const statusEl = block?.querySelector<HTMLElement>('.js-example-output-status')
  if (!block || !outputBody || !statusEl) return
  if (block.classList.contains('is-js-running')) return
  const code = jsExampleSource(block, content)
  if (code === null) {
    toast({ title: t('preview.code_edit_unavailable'), tone: 'warning' })
    return
  }

  block.classList.add('is-js-running')
  runBtn.disabled = true
  void executeJsExample(code, spawnWorker).then(({ logs, result, error, durationMs }) => {
    block.classList.remove('is-js-running')
    if (runBtn.isConnected) runBtn.disabled = false
    updateRunStatus(statusEl, error, durationMs)
    outputBody.replaceChildren()

    if (logs.length === 0 && result === undefined && !error) {
      const emptyRow = document.createElement('div')
      emptyRow.className = 'js-example-empty-hint'
      emptyRow.textContent = t('workspace.executed_no_output')
      outputBody.append(emptyRow)
      return
    }
    logs.forEach((item) => {
      appendLogRow(outputBody, item.type, item.type === 'error' ? '✖' : item.type === 'warn' ? '▲' : '›', item.text)
    })
    if (result !== undefined) appendLogRow(outputBody, 'return', '←', result)
    if (error) appendLogRow(outputBody, 'error-banner', '✖', error)
  })
}

function updateRunStatus(statusEl: HTMLElement, error: string | undefined, durationMs: number): void {
  if (error) {
    statusEl.className = 'js-example-output-status is-error'
    statusEl.textContent = `✕ ${durationMs}ms`
  } else {
    statusEl.className = 'js-example-output-status is-success'
    statusEl.textContent = `✓ ${durationMs}ms`
  }
}

function appendLogRow(outputBody: HTMLElement, type: string, prefix: string, text: string): void {
  const row = document.createElement('div')
  row.className = `js-example-log-row is-${type}`
  const prefixEl = document.createElement('span')
  prefixEl.className = 'js-example-log-prefix'
  prefixEl.textContent = prefix
  const textEl = document.createElement('pre')
  textEl.className = 'js-example-log-text'
  textEl.textContent = text
  row.append(prefixEl, textEl)
  outputBody.append(row)
}

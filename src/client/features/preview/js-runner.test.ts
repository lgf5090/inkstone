import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { executeUserCode, formatJsValue, hardenWorkerScope } from './js-runner-core'
import type { JsRunOutcome } from './js-runner-core'
import {
  JS_RUN_TIMEOUT_MS,
  enhanceJsExampleControlsInRoot,
  executeJsExample,
  handleJsExampleRun,
  handleJsExampleSwitch,
  type JsRunnerWorker,
} from './js-runner'

function outcome(over: Partial<JsRunOutcome> = {}): JsRunOutcome {
  return { logs: [], resultText: '', errorText: '', durationMs: 3, ...over }
}

function stubWorker(reply: JsRunOutcome): { current: () => JsRunnerWorker; posted: () => string; terminated: () => number } {
  let posted = ''
  let terminated = 0
  let sink: ((event: { data: JsRunOutcome }) => void) | null = null
  const worker: JsRunnerWorker = {
    postMessage(code) {
      posted = code
      queueMicrotask(() => sink?.({ data: reply }))
    },
    terminate() { terminated += 1 },
    set onmessage(handler) { sink = handler },
    get onmessage() { return sink },
    onerror: null,
  }
  return { current: () => worker, posted: () => posted, terminated: () => terminated }
}

function silentWorker(): { current: () => JsRunnerWorker; terminated: () => number } {
  let terminated = 0
  const worker: JsRunnerWorker = {
    postMessage() {},
    terminate() { terminated += 1 },
    onmessage: null,
    onerror: null,
  }
  return { current: () => worker, terminated: () => terminated }
}

function jsRoot(markdown: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ink-prose'
  root.innerHTML = renderMarkdown(markdown).html
  document.body.append(root)
  return root
}

afterEach(() => { document.body.replaceChildren() })

describe('executeUserCode', () => {
  it('collects console output, and only a returned value counts as a result', () => {
    const trailing = executeUserCode('console.log("n", 1); console.warn("careful"); 2 + 2')
    expect(trailing.logs.map((entry) => `${entry.type}:${entry.text}`)).toEqual(['log:n 1', 'warn:careful'])
    expect(trailing.resultText).toBe('')
    expect(trailing.errorText).toBe('')
    expect(executeUserCode('return 2 + 2').resultText).toBe('4')
  })

  it('formats the values a reader needs to recognise', () => {
    expect(formatJsValue(null)).toBe('null')
    expect(formatJsValue(undefined)).toBe('undefined')
    expect(formatJsValue('raw')).toBe('raw')
    expect(formatJsValue({ a: [1] })).toContain('"a"')
    expect(formatJsValue(Symbol('s'))).toBe('Symbol(s)')
    expect(formatJsValue(new Error('boom'))).toBe('Error: boom')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatJsValue(cyclic)).toBe('[object Object]')
  })

  it('reports a thrown error instead of rejecting', () => {
    const ran = executeUserCode('throw new TypeError("nope")')
    expect(ran.errorText).toBe('TypeError: nope')
    expect(ran.resultText).toBe('')
  })

  it('shadows the ambient console and the network globals inside the note code', () => {
    const ran = executeUserCode('console.log(typeof globalThis, typeof fetch, typeof importScripts, typeof XMLHttpRequest)')
    expect(ran.logs[0]!.text).toBe('undefined undefined undefined undefined')
  })

  it('keeps strict mode, so a stray this is not the worker scope', () => {
    const ran = executeUserCode('console.log(typeof this)')
    expect(ran.logs[0]!.text).toBe('undefined')
  })
})

describe('hardenWorkerScope', () => {
  it('takes the egress globals away from the scope itself, not just the parameter names', () => {
    const scope: Record<string, unknown> = {
      fetch: () => 'network',
      importScripts: () => 'network',
      postMessage: () => 'reply',
      close: () => 'stop',
      indexedDB: {},
      WebSocket: class {},
      navigator: { sendBeacon: () => true },
    }
    hardenWorkerScope(scope)
    for (const name of ['fetch', 'importScripts', 'postMessage', 'close', 'indexedDB', 'WebSocket', 'XMLHttpRequest'])
      expect(scope[name], name).toBeUndefined()
    expect((scope.navigator as Record<string, unknown>).sendBeacon).toBeUndefined()
  })

  it('survives a scope that refuses to be redefined', () => {
    const scope: Record<string, unknown> = {}
    Object.defineProperty(scope, 'fetch', { value: () => 'x', configurable: false, writable: false })
    expect(() => hardenWorkerScope(scope)).not.toThrow()
    expect(typeof scope.fetch).toBe('function')
  })

  it('leaves a scope with no navigator alone', () => {
    expect(() => hardenWorkerScope({})).not.toThrow()
  })
})

describe('executeJsExample', () => {
  it('posts the code and hands the reply back as a result', async () => {
    const stub = stubWorker(outcome({ logs: [{ type: 'log', text: 'hi' }], resultText: '7' }))
    const ran = await executeJsExample('console.log("hi"); 7', stub.current)
    expect(stub.posted()).toBe('console.log("hi"); 7')
    expect(ran).toEqual({ logs: [{ type: 'log', text: 'hi' }], result: '7', durationMs: 3 })
    expect(stub.terminated()).toBe(1)
  })

  it('terminates a worker that never answers', async () => {
    vi.useFakeTimers()
    try {
      const stub = silentWorker()
      const pending = executeJsExample('while (true) {}', stub.current)
      await vi.advanceTimersByTimeAsync(JS_RUN_TIMEOUT_MS)
      const ran = await pending
      expect(ran.error).toContain('TimeoutError')
      expect(ran.error).toContain(String(JS_RUN_TIMEOUT_MS))
      expect(stub.terminated()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a worker that dies, and a page that cannot spawn one', async () => {
    const dead = silentWorker()
    const pending = executeJsExample('1', dead.current)
    queueMicrotask(() => dead.current().onerror?.())
    expect((await pending).error).toContain('WorkerError')
    const refused = await executeJsExample('1', () => { throw new Error('blocked') })
    expect(refused.error).toBe('Error: blocked')
  })

  it('omits the result and error keys when there is nothing to show', async () => {
    const stub = stubWorker(outcome())
    const ran = await executeJsExample('void 0', stub.current)
    expect(ran).toEqual({ logs: [], durationMs: 3 })
  })
})

describe('runnable block controls', () => {
  const SOURCE = '~~~~javascript-example title="Sum"\nconsole.log(1);\n~~~~'

  it('injects the switch, the run button and the waiting hint', () => {
    const root = jsRoot(SOURCE)
    enhanceJsExampleControlsInRoot(root)
    const controls = root.querySelector('.js-example-controls')!
    expect(controls.querySelector('[data-js-switch="line-numbers"]')!.getAttribute('aria-checked')).toBe('true')
    expect(controls.querySelector('[data-js-run]')).not.toBeNull()
    expect(root.querySelector('.js-example-placeholder')!.textContent).toBe('workspace.click_run_to_execute')
    enhanceJsExampleControlsInRoot(root)
    expect(root.querySelectorAll('.js-example-controls').length).toBe(1)
    expect(root.querySelectorAll('.js-example-placeholder').length).toBe(1)
  })

  it('leaves a nested example and a note embed without controls', () => {
    const nested = jsRoot('~~~~~md-example\n~~~~javascript-example\nx\n~~~~\n~~~~~')
    enhanceJsExampleControlsInRoot(nested)
    expect(nested.querySelectorAll('.js-example-controls').length).toBe(0)
    const embed = document.createElement('div')
    embed.className = 'note-embed-body'
    embed.innerHTML = renderMarkdown(SOURCE).html
    enhanceJsExampleControlsInRoot(embed)
    expect(embed.querySelectorAll('.js-example-controls').length).toBe(0)
  })

  it('the switch moves the gutter on the source panel only', () => {
    const root = jsRoot(SOURCE)
    enhanceJsExampleControlsInRoot(root)
    const switchBtn = root.querySelector<HTMLButtonElement>('[data-js-switch]')!
    const code = root.querySelector<HTMLElement>('.code-block')!
    handleJsExampleSwitch(switchBtn)
    expect(code.classList.contains('has-line-numbers')).toBe(false)
    expect(code.dataset.lineNumbers).toBe('false')
    expect(switchBtn.getAttribute('aria-checked')).toBe('false')
    handleJsExampleSwitch(switchBtn)
    expect(code.classList.contains('has-line-numbers')).toBe(true)
    expect(switchBtn.getAttribute('aria-checked')).toBe('true')
  })

  it('runs the fence body, blank lines and all, not the decorated markup', async () => {
    const withBlank = '~~~~javascript-example\nconsole.log(`a\n\nb`);\n~~~~'
    const root = jsRoot(withBlank)
    enhanceJsExampleControlsInRoot(root)
    const stub = stubWorker(outcome({ resultText: 'ok' }))
    handleJsExampleRun(root.querySelector<HTMLButtonElement>('[data-js-run]')!, withBlank, vi.fn(), stub.current)
    expect(stub.posted()).toBe('console.log(`a\n\nb`);')
    await vi.waitFor(() => {
      expect(root.querySelector('.js-example-output-status')!.textContent).toContain('ms')
    })
  })

  it('paints the log rows and the return value as text, never as markup', async () => {
    const root = jsRoot(SOURCE)
    enhanceJsExampleControlsInRoot(root)
    const stub = stubWorker(outcome({
      logs: [
        { type: 'log', text: '<img src=x onerror=alert(1)>' },
        { type: 'error', text: 'bad' },
      ],
      resultText: 'done',
    }))
    handleJsExampleRun(root.querySelector<HTMLButtonElement>('[data-js-run]')!, SOURCE, vi.fn(), stub.current)
    await vi.waitFor(() => expect(root.querySelectorAll('.js-example-log-row').length).toBe(3))
    const body = root.querySelector('[data-js-example-output]')!
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>')
    expect([...body.querySelectorAll('.js-example-log-row')].map((row) => row.className)).toEqual([
      'js-example-log-row is-log',
      'js-example-log-row is-error',
      'js-example-log-row is-return',
    ])
    expect(root.querySelector('.js-example-placeholder')).toBeNull()
  })

  it('says so when the code ran but printed nothing', async () => {
    const root = jsRoot(SOURCE)
    enhanceJsExampleControlsInRoot(root)
    handleJsExampleRun(root.querySelector<HTMLButtonElement>('[data-js-run]')!, SOURCE, vi.fn(), stubWorker(outcome()).current)
    await vi.waitFor(() => expect(root.querySelector('.js-example-empty-hint')).not.toBeNull())
    expect(root.querySelector('.js-example-output-status')!.className).toContain('is-success')
  })

  it('marks an error run and re-arms the button', async () => {
    const root = jsRoot(SOURCE)
    enhanceJsExampleControlsInRoot(root)
    const button = root.querySelector<HTMLButtonElement>('[data-js-run]')!
    handleJsExampleRun(button, SOURCE, vi.fn(), stubWorker(outcome({ errorText: 'TypeError: x' })).current)
    expect(button.disabled).toBe(true)
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    expect(root.querySelector('.js-example-output-status')!.className).toContain('is-error')
    expect(root.querySelector('.js-example-log-row.is-error-banner')).not.toBeNull()
  })

  it('ignores a second click while a run is still going', () => {
    const root = jsRoot(SOURCE)
    enhanceJsExampleControlsInRoot(root)
    const button = root.querySelector<HTMLButtonElement>('[data-js-run]')!
    const block = root.querySelector('.js-example-block')!
    let posts = 0
    const held = () => ({
      postMessage() { posts += 1 },
      terminate() {},
      onmessage: null,
      onerror: null,
    }) as unknown as JsRunnerWorker
    handleJsExampleRun(button, SOURCE, vi.fn(), held)
    handleJsExampleRun(button, SOURCE, vi.fn(), held)
    expect(posts).toBe(1)
    expect(block.classList.contains('is-js-running')).toBe(true)
  })

  it('refuses to run when the fence the block came from is gone', () => {
    const root = jsRoot(SOURCE)
    enhanceJsExampleControlsInRoot(root)
    const toast = vi.fn()
    handleJsExampleRun(root.querySelector<HTMLButtonElement>('[data-js-run]')!, '# only prose\n', toast, stubWorker(outcome()).current)
    expect(toast).toHaveBeenCalled()
    expect(root.querySelector('.js-example-placeholder')).not.toBeNull()
  })
})

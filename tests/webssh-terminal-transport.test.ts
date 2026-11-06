// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeTerminalTransport } from '../src/client/features/webssh/transport/fake-transport'
import type { TransportPhaseEvent } from '../src/client/features/webssh/transport/types'

function createHarness() {
  const phases: TransportPhaseEvent[] = []
  const chunks: string[] = []
  const transport = new FakeTerminalTransport({
    onPhase: (event) => phases.push(event),
    onOutput: (data) => chunks.push(data),
  })
  return { transport, phases, output: () => chunks.join('') }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the demo transport', () => {
  it('reports connecting, then opens and introduces itself as a fake shell', () => {
    const harness = createHarness()
    harness.transport.connect({ cols: 100, rows: 30 })
    expect(harness.phases).toEqual([{ phase: 'connecting' }])
    vi.advanceTimersByTime(400)
    expect(harness.phases.at(-1)).toEqual({ phase: 'open' })
    expect(harness.output()).toContain('fake')
    expect(harness.output()).toContain('not a real SSH connection')
  })

  it('echoes typed characters and runs the echo command on Enter', () => {
    const harness = createHarness()
    harness.transport.connect({ cols: 80, rows: 24 })
    vi.advanceTimersByTime(400)
    harness.transport.send('echo')
    harness.transport.send(' hello')
    harness.transport.send('\r')
    expect(harness.output().endsWith('hello\r\ndemo@inkstone:~$ ')).toBe(true)
  })

  it('erases with backspace and cancels the line with Ctrl+C', () => {
    const harness = createHarness()
    harness.transport.connect({ cols: 80, rows: 24 })
    vi.advanceTimersByTime(400)
    harness.transport.send('ab\x7fc')
    expect(harness.output()).toContain('ab\b \bc')
    harness.transport.send('\x03')
    expect(harness.output()).toContain('^C\r\ndemo@inkstone:~$ ')
  })

  it('answers "stty size" with the last reported dimensions', () => {
    const harness = createHarness()
    harness.transport.connect({ cols: 80, rows: 24 })
    vi.advanceTimersByTime(400)
    harness.transport.resize(132, 43)
    harness.transport.send('stty size\r')
    expect(harness.output()).toContain('43 132\r\n')
  })

  it('drops on demand so the reconnect path can be exercised', () => {
    const harness = createHarness()
    harness.transport.connect({ cols: 80, rows: 24 })
    vi.advanceTimersByTime(400)
    harness.transport.simulateDrop()
    expect(harness.phases.at(-1)).toEqual({ phase: 'closed', reason: 'demo-drop' })
    expect(harness.output()).toContain('Connection dropped')
  })

  it('closes on exit and stops writing after dispose', () => {
    const first = createHarness()
    first.transport.connect({ cols: 80, rows: 24 })
    vi.advanceTimersByTime(400)
    first.transport.send('exit\r')
    expect(first.phases.at(-1)).toEqual({ phase: 'closed', reason: 'eof' })

    const second = createHarness()
    second.transport.connect({ cols: 80, rows: 24 })
    second.transport.dispose()
    vi.advanceTimersByTime(400)
    expect(second.phases).toEqual([{ phase: 'connecting' }])
    second.transport.send('echo nope\r')
    expect(second.output()).toBe('')
  })

  it('walks the command history with the arrow keys', () => {
    const harness = createHarness()
    harness.transport.connect({ cols: 80, rows: 24 })
    vi.advanceTimersByTime(400)
    harness.transport.send('pwd\r')
    harness.transport.send('\x1b[A')
    expect(harness.output()).toContain('\r\x1b[2Kdemo@inkstone:~$ pwd')
  })
})

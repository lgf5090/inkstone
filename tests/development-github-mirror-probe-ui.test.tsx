// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement } from '../src/client/lib/test-render'
import { MirrorDialog } from '../src/client/features/development/github/components/MirrorDialog'
import type { GithubMirrorProbeResult, GithubMirrorSource } from '@shared/development/github/types'

const mirrors: GithubMirrorSource[] = [
  { id: 'fast', name: 'Fast', url: 'https://fast.example.com', enabled: true, createdAt: 0 },
  { id: 'slow', name: 'Slow', url: 'https://slow.example.com', enabled: false, createdAt: 0 },
]

beforeEach(async () => {
  await initI18n()
})

describe('mirror speed test', () => {
  it('shows progress, then per-mirror latency and failure reason', async () => {
    let release: (results: GithubMirrorProbeResult[]) => void = () => undefined
    const gate = new Promise<GithubMirrorProbeResult[]>((resolve) => {
      release = resolve
    })
    const onProbe = vi.fn(() => gate)
    const view = renderElement(
      <MirrorDialog
        open
        onClose={() => undefined}
        mirrors={mirrors}
        currentMirrorId="fast"
        onSave={() => undefined}
        onCurrentChange={() => undefined}
        onProbe={onProbe}
      />,
    )

    const probeButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => (button.textContent ?? '').trim() === t('development.github.mirrors.probe'))
    expect(probeButton).toBeTruthy()
    act(() => probeButton!.click())
    expect(onProbe).toHaveBeenCalledWith(mirrors)
    expect(document.body.textContent).toContain(t('development.github.mirrors.probing'))

    await act(async () => {
      release([
        { id: 'fast', ok: true, status: 200, latencyMs: 128, error: '' },
        { id: 'slow', ok: false, status: 0, latencyMs: null, error: 'timeout' },
      ])
    })
    expect(document.body.textContent).toContain(t('development.github.mirrors.probe_ok', { ms: 128 }))
    expect(document.body.textContent).toContain(t('development.github.mirrors.probe_timeout'))
    expect(document.body.textContent).not.toContain(t('development.github.mirrors.probing'))
    view.unmount()
  })
})

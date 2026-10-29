// @vitest-environment node
/**
 * The pointer handlers are the hot path: they run for every sample of a stroke. A serialisation, an
 * await or a React write inside one turns a 120 Hz pen into a slideshow, and no timing assertion in
 * jsdom would notice because jsdom draws nothing. This scans the source instead, and fails loudly if
 * the handlers are renamed so the region it reads cannot silently become empty.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ENGINE = path.join(process.cwd(), 'src/client/features/inknote/engine/inknote-engine.ts')

const FORBIDDEN = ['await ', 'JSON.', 'fetch(', 'localStorage', 'setState(', '.prepare(']

function handlerRegion(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start + from.length)
  expect(start, `${from} was not found`).toBeGreaterThan(-1)
  expect(end, `${to} was not found after ${from}`).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('the inknote pointer hot path', () => {
  const source = fs.readFileSync(ENGINE, 'utf8')

  it('keeps the down and move handlers free of blocking work', () => {
    const region = handlerRegion(source, 'private handlePointerDown', 'private handlePointerUp')
    expect(region.length, 'the scanned region is too small to be the handlers').toBeGreaterThan(2_000)
    for (const token of FORBIDDEN) {
      expect(region.includes(token), `${token} appears between pointerdown and pointerup`).toBe(false)
    }
  })

  it('keeps the up handler free of blocking work', () => {
    const region = handlerRegion(source, 'private handlePointerUp', 'private normalizedBox')
    expect(region.length, 'the scanned region is too small to be the up handler').toBeGreaterThan(500)
    for (const token of FORBIDDEN) {
      expect(region.includes(token), `${token} appears in the pointerup handler`).toBe(false)
    }
  })
})

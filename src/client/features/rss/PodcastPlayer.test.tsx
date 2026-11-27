import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { RssEntry } from '@shared/rss/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { PodcastPlayer } from './PodcastPlayer'

const entry: RssEntry = {
  id: 'e1', feedId: 'f1', title: 'Episode one', link: 'https://example.com/1', author: '',
  publishedTs: 1, summary: '', content: '', imageUrl: '', audioUrl: 'https://cdn.example/one.mp3', duration: 120,
}
const next: RssEntry = { ...entry, id: 'e2', title: 'Episode two', audioUrl: 'https://cdn.example/two.mp3' }

beforeAll(async () => {
  await initI18n()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

describe('podcast controls', () => {
  it('changes speed and moves through the queue with named buttons', () => {
    const onSelect = vi.fn()
    const rendered = renderElement(createElement(PodcastPlayer, { entry, queue: [entry, next], onSelect }))
    const speed = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === t('rss.audio_speed'))
    expect(speed?.textContent).toBe('1×')
    act(() => { speed?.click() })
    expect(speed?.textContent).toBe('1.25×')
    const nextButton = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === t('rss.audio_next'))
    act(() => { nextButton?.click() })
    expect(onSelect).toHaveBeenCalledWith('e2')
    expect(rendered.container.querySelector('input[type="range"]')).not.toBeNull()
    rendered.unmount()
  })
})

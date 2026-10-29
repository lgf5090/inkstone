import { act, type ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import type { YouTubeTag, YouTubeVideo } from '@shared/youtube/model'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { useYoutubeStore } from '../store'
import { TagAssignBar } from './TagAssignBar'
import { TagManagerModal } from './TagManagerModal'

const video: YouTubeVideo = {
  id: 'video-one',
  title: 'A video title',
  description: '',
  publishedAt: '2026-05-01T00:00:00.000Z',
  channelId: 'channel',
  channelTitle: 'Channel',
  thumbnailUrl: '',
  thumbnailHighUrl: '',
  duration: 'PT1M',
  viewCount: 1,
  likeCount: 0,
  commentCount: 0,
  tags: [],
  categoryId: '',
  isLive: false,
}

const tags: YouTubeTag[] = [
  { id: 'parent', name: 'Parent', color: ORGANIZER_COLORS[15], parentId: null, sortOrder: 0, pinned: false, createdAt: 1 },
  { id: 'child', name: 'Child', color: ORGANIZER_COLORS[21], parentId: 'parent', sortOrder: 0, pinned: false, createdAt: 2 },
  { id: 'other', name: 'Other', color: ORGANIZER_COLORS[0], parentId: null, sortOrder: 1, pinned: false, createdAt: 3 },
]

let mounted: RenderedElement[] = []

function render(node: ReactNode): RenderedElement {
  const rendered = renderElement(node)
  mounted.push(rendered)
  return rendered
}

function click(element: Element | null): void {
  expect(element).not.toBeNull()
  element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  useYoutubeStore.setState({
    library: { tags, videos: [], channels: [], playlists: [], truncated: false },
    libraryStatus: 'ready',
    libraryError: null,
    pending: [],
  })
})

afterEach(() => {
  for (const rendered of mounted) rendered.unmount()
  mounted = []
  document.body.innerHTML = ''
})

describe('TagAssignBar', () => {
  it('toggles a tag from the popover and returns focus to the trigger on Escape', () => {
    const onToggle = vi.fn()
    const rendered = render(
      <TagAssignBar video={video} assignedTags={[tags[0]!]} allTags={tags} onToggle={onToggle} />,
    )
    const trigger = rendered.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('youtube.tags.add_tag')}"]`,
    )
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')

    act(() => click(trigger))

    const panelId = trigger!.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    const panel = document.getElementById(panelId!)
    expect(panel).not.toBeNull()
    const rows = Array.from(panel!.querySelectorAll('button'))
    expect(rows).toHaveLength(tags.length)

    const childRow = rows.find((row) => row.textContent?.includes('Child'))
    expect(childRow).toBeTruthy()
    act(() => click(childRow!))

    expect(onToggle).toHaveBeenCalledWith('child')
    expect(document.getElementById(panelId!)).not.toBeNull()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    expect(document.getElementById(panelId!)).toBeNull()
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('TagManagerModal', () => {
  it('keeps the edited tag and its descendants out of the parent choices', () => {
    render(<TagManagerModal open onClose={() => {}} tags={tags} />)

    const edit = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('youtube.tags.edit')}"]`,
    )
    act(() => click(edit))

    const editName = document.querySelector<HTMLInputElement>(
      `input[aria-label="${t('youtube.tags.name')}"]`,
    )
    expect(editName).not.toBeNull()
    const select = editName!.closest('form')?.querySelector<HTMLSelectElement>('select')
    expect(select).not.toBeNull()

    const values = Array.from(select!.options).map((option) => option.value)
    expect(values).not.toContain('parent')
    expect(values).not.toContain('child')
    expect(values).toContain('')
    expect(values).toContain('other')
  })
})

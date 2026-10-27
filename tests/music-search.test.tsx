// @vitest-environment jsdom
/**
 * Search's two new result shapes and the typed suggestion list.
 *
 * The page state is driven by the address, so a test renders it with a committed query and waits
 * for the mocked API. A suggestion pick is asserted at the boundary the box promises: an entity
 * is handed to `onPickSuggestion`, and a term falls back to a normal search commit.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MusicArtistSummary, MusicSearchResult, MusicUserSummary } from '../src/shared/music/api'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { musicApi } from '../src/client/features/music/api'
import { MusicSearchBox } from '../src/client/features/music/components/MusicSearchBox'
import { musicText } from '../src/client/features/music/components/labels'
import { SearchPage } from '../src/client/features/music/pages/SearchPage'
import { useMusicUi } from '../src/client/features/music/store/ui'

function emptyResult(type: MusicSearchResult['type']): MusicSearchResult {
  return {
    type,
    tracks: [],
    artists: [],
    albums: [],
    playlists: [],
    users: [],
    mvs: [],
    radios: [],
    total: 0,
    hasMore: false,
  }
}

const artist: MusicArtistSummary = {
  id: 'artist-1',
  name: 'Artist one',
  coverUrl: 'https://provider.example/artist.jpg',
  albumCount: 4,
  followCount: 12_300,
}

const user: MusicUserSummary = {
  id: 'user-1',
  nickname: 'Listener one',
  avatarUrl: 'https://provider.example/user.jpg',
  signature: 'Listening since 2019',
}

function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').trim() === text,
  )
}

function buttonContaining(scope: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.textContent ?? '').includes(text),
  )
}

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  localStorage.clear()
  await initI18n()
  useMusicUi.setState({ searchHistory: [], nowPlayingTab: 'lyrics' })
  vi.spyOn(musicApi, 'hot').mockResolvedValue({ items: [] })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SearchPage', () => {
  it('renders artist results as round cards that open the artist page', async () => {
    vi.spyOn(musicApi, 'search').mockResolvedValue({
      ...emptyResult('artist'),
      artists: [artist],
      total: 1,
    })
    window.history.replaceState(null, '', '/music/search')
    rendered = renderElement(createElement(SearchPage, { query: 'artist' }))
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      buttonByText(rendered!.container, musicText('music.search.type.artist'))!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(rendered.container.textContent).toContain(artist.name)
    const card = buttonContaining(rendered.container, artist.name)!
    expect(card.querySelector('img')?.getAttribute('src')).toContain('/api/music/media/provider-cover')
    act(() => card.click())
    expect(window.location.pathname).toBe('/music/artist/artist-1')
  })

  it('renders listener results with the signature as the fact line', async () => {
    vi.spyOn(musicApi, 'search').mockResolvedValue({
      ...emptyResult('user'),
      users: [user],
      total: 1,
    })
    window.history.replaceState(null, '', '/music/search')
    rendered = renderElement(createElement(SearchPage, { query: 'listener' }))
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      buttonByText(rendered!.container, musicText('music.search.type.user'))!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(rendered.container.textContent).toContain(user.nickname)
    expect(rendered.container.textContent).toContain(user.signature)
    const card = buttonContaining(rendered.container, user.nickname)!
    act(() => card.click())
    expect(window.location.pathname).toBe('/music/user/user-1')
  })
})

describe('MusicSearchBox', () => {
  it('hands a typed suggestion to the page instead of searching its name', async () => {
    vi.spyOn(musicApi, 'suggest').mockResolvedValue({
      items: [
        { kind: 'album', id: 'album-9', name: 'Album nine', detail: 'Artist one' },
        { kind: 'song', id: 'song-9', name: 'Song nine', detail: 'Artist one' },
      ],
    })
    const onCommit = vi.fn()
    const onPickSuggestion = vi.fn()
    rendered = renderElement(createElement(MusicSearchBox, {
      value: 'nine',
      onChange: () => undefined,
      onCommit,
      onPickSuggestion,
    }))
    const input = rendered.container.querySelector<HTMLInputElement>('input')!

    act(() => {
      input.focus()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 220))
    })

    const option = [...rendered.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => (button.textContent ?? '').includes('Album nine'))
    expect(option, 'the typed suggestion was not rendered').toBeTruthy()
    act(() => option!.click())
    expect(onPickSuggestion).toHaveBeenCalledWith(expect.objectContaining({ kind: 'album', id: 'album-9' }))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('falls back to committing the name when the page offers no entity handler', async () => {
    vi.spyOn(musicApi, 'suggest').mockResolvedValue({
      items: [{ kind: 'artist', id: 'artist-9', name: 'Artist nine', detail: '' }],
    })
    const onCommit = vi.fn()
    rendered = renderElement(createElement(MusicSearchBox, {
      value: 'nine',
      onChange: () => undefined,
      onCommit,
    }))
    const input = rendered.container.querySelector<HTMLInputElement>('input')!

    act(() => {
      input.focus()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 220))
    })

    const option = [...rendered.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => (button.textContent ?? '').includes('Artist nine'))
    act(() => option!.click())
    expect(onCommit).toHaveBeenCalledWith('Artist nine')
  })

  it('moves the active row with Home and End without committing', async () => {
    vi.spyOn(musicApi, 'suggest').mockResolvedValue({
      items: [
        { kind: 'artist', id: 'a1', name: 'First', detail: '' },
        { kind: 'artist', id: 'a2', name: 'Last', detail: '' },
      ],
    })
    const onCommit = vi.fn()
    rendered = renderElement(createElement(MusicSearchBox, {
      value: 'nine',
      onChange: () => undefined,
      onCommit,
    }))
    const input = rendered.container.querySelector<HTMLInputElement>('input')!
    act(() => {
      input.focus()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 220))
    })

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    })
    expect(input.getAttribute('aria-activedescendant')).toContain('-1')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(onCommit).toHaveBeenCalledWith('Last')
  })
})

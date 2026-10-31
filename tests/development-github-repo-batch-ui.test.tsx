// @vitest-environment jsdom
import { useState } from 'react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement } from '../src/client/lib/test-render'
import { RepoList } from '../src/client/features/development/github/components/RepoList'
import type { GithubCollection, GithubRepo, GithubTag, SavedGithubRepo } from '@shared/development/github/types'

function repo(id: number): GithubRepo {
  return {
    id,
    name: `repo-${id}`,
    fullName: `acme/repo-${id}`,
    url: `https://github.com/acme/repo-${id}`,
    description: null,
    homepage: null,
    owner: { login: 'acme', avatarUrl: '' },
    language: null,
    stargazersCount: 0,
    forksCount: 0,
    openIssuesCount: 0,
    topics: [],
    license: null,
    isArchived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    defaultBranch: 'main',
    size: 0,
  }
}

function savedOf(source: GithubRepo, pinned = false): SavedGithubRepo {
  return {
    id: String(source.id),
    fullName: source.fullName,
    url: source.url,
    data: source,
    tagIds: [],
    pinned,
    favorited: false,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

function renderList(options: { explore?: boolean; pinned?: boolean; collection?: GithubCollection | null; onBatchPin?: (value: boolean) => void; onBatchRemove?: () => void; onToggleCollectionRepo?: (id: string, checked: boolean) => void } = {}) {
  const repos = [repo(1), repo(2), repo(3)]
  const saved = new Map(repos.map((entry) => [String(entry.id), savedOf(entry, options.pinned)]))
  const onBatchPin = options.onBatchPin ?? vi.fn()
  const onBatchRemove = options.onBatchRemove ?? vi.fn()
  const onToggleCollectionRepo = options.onToggleCollectionRepo ?? vi.fn()

  function Harness() {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const check = (id: string, next: boolean) => setSelectedIds((previous) => {
      const updated = new Set(previous)
      if (next) updated.add(id)
      else updated.delete(id)
      return updated
    })
    const selectAll = () => setSelectedIds((previous) => {
      const all = repos.every((entry) => previous.has(String(entry.id)))
      const updated = new Set(previous)
      for (const entry of repos) {
        if (all) updated.delete(String(entry.id))
        else updated.add(String(entry.id))
      }
      return updated
    })
    return (
      <RepoList
        isExplore={options.explore ?? false}
        query=""
        onQueryChange={() => undefined}
        onCommitSearch={() => undefined}
        onClear={() => undefined}
        onGoDiscover={() => undefined}
        searchHistory={[]}
        onPickSearchHistory={() => undefined}
        loading={false}
        error={null}
        prefs={{ range: 'today', sort: 'stars', order: 'desc', language: '' }}
        onUpdatePrefs={() => undefined}
        mirrors={[{ id: 'm', name: 'm', url: 'https://mirror.example', enabled: true, createdAt: 0 }]}
        currentMirrorId="m"
        onCurrentMirrorChange={() => undefined}
        onManageMirrors={() => undefined}
        onRefresh={() => undefined}
        items={repos}
        totalCount={repos.length}
        page={1}
        onPageChange={() => undefined}
        repoMap={saved}
        tags={[] as GithubTag[]}
        collection={options.collection ?? null}
        onToggleCollectionRepo={onToggleCollectionRepo}
        selectedRepoId={null}
        selectedIds={selectedIds}
        onCheckRepo={check}
        onSelectAllRepos={selectAll}
        onBatchPin={onBatchPin}
        onBatchFav={() => undefined}
        onBatchTag={() => undefined}
        onBatchRemove={onBatchRemove}
        onSelectRepo={() => undefined}
        onTogglePin={() => undefined}
        onToggleFav={() => undefined}
        onToggleTag={() => undefined}
        onRemoveRepo={() => undefined}
        onSyncStars={() => undefined}
        syncingStars={false}
        onExportLibrary={() => undefined}
        toggleSidebar={() => undefined}
        toggleDetail={() => undefined}
        detailDisabled
      />
    )
  }

  return { view: renderElement(<Harness />), onBatchPin, onBatchRemove, onToggleCollectionRepo }
}

function checkbox(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'))
    .find((button) => button.getAttribute('aria-label') === label)
  expect(found).toBeTruthy()
  return found!
}

beforeEach(async () => {
  await initI18n()
})

describe('saved repository batch actions', () => {
  it('selects rows, reports the count and toggles pin from the selection', () => {
    const { view, onBatchPin } = renderList()
    expect(view.container.querySelector('[role="checkbox"]')).not.toBeNull()
    expect(view.container.textContent).not.toContain(t('development.github.repos.selected', { count: 1 }))

    act(() => checkbox(view.container, t('development.github.repos.select_item', { name: 'acme/repo-1' })).click())
    expect(view.container.textContent).toContain(t('development.github.repos.selected', { count: 1 }))

    const pin = Array.from(view.container.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').trim() === t('development.github.repos.pin'))
    expect(pin).toBeTruthy()
    act(() => pin!.click())
    expect(onBatchPin).toHaveBeenCalledWith(true)
    view.unmount()
  })

  it('inverts an all-pinned selection and confirms the batch removal', () => {
    const { view, onBatchPin, onBatchRemove } = renderList({ pinned: true })
    act(() => checkbox(view.container, t('development.github.repos.select_all')).click())
    expect(view.container.textContent).toContain(t('development.github.repos.selected', { count: 3 }))

    const unpin = Array.from(view.container.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').trim() === t('development.github.repos.unpin'))
    expect(unpin).toBeTruthy()
    act(() => unpin!.click())
    expect(onBatchPin).toHaveBeenCalledWith(false)

    const remove = Array.from(view.container.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').trim() === t('common.delete'))
    act(() => remove!.click())
    expect(onBatchRemove).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('keeps selection controls out of the explore list', () => {
    const { view } = renderList({ explore: true })
    expect(view.container.querySelector('[role="checkbox"]')).toBeNull()
    view.unmount()
  })

  it('adds a repository to the selected collection from its member menu', () => {
    const collection: GithubCollection = {
      id: 'c1',
      name: 'Curated',
      description: 'Picked repositories',
      repoIds: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const { view, onToggleCollectionRepo } = renderList({ collection })
    expect(view.container.textContent).toContain('Picked repositories')
    const manage = Array.from(view.container.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').trim() === t('development.github.collections.members'))
    expect(manage).toBeTruthy()
    act(() => manage!.click())
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'))
      .find((entry) => (entry.textContent ?? '').trim() === 'acme/repo-1')
    expect(item).toBeTruthy()
    act(() => item!.click())
    expect(onToggleCollectionRepo).toHaveBeenCalledWith('1', true)
    view.unmount()
  })
})

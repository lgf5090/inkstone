// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeFileSummary } from '@shared/office/model'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { setLocale, t } from '../../lib/i18n'
import { OfficeFileList, type OfficeFileListProps } from './OfficeFileList'

/**
 * The list's three states and its type tabs.
 *
 * Every callback is a spy: the component's contract is "one object of actions", so a test that renders
 * it without one would prove nothing about the tabs, the empty copy or the retry path.
 */

let view: RenderedElement | null = null

function file(overrides: Partial<OfficeFileSummary> = {}): OfficeFileSummary {
  return {
    id: 'file-1',
    type: 'sheets',
    title: 'Quarterly sheet',
    folderId: null,
    rev: 2,
    size: 120,
    isPinned: false,
    isStarred: false,
    position: 1000,
    lastOpenedAt: 0,
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    tagIds: [],
    ...overrides,
  } as OfficeFileSummary
}

function props(overrides: Partial<OfficeFileListProps> = {}): OfficeFileListProps {
  const handler = vi.fn()
  return {
    files: [],
    status: 'ready',
    error: null,
    query: '',
    typeFilter: 'all',
    viewMode: 'list',
    sortKey: 'updated',
    sortDir: 'desc',
    showCheckboxes: true,
    activeView: 'all',
    currentFolderId: null,
    breadcrumbs: [],
    tags: [],
    selected: new Set<string>(),
    clipboardHasFiles: false,
    onSearchChange: handler,
    onTypeChange: handler,
    onSortChange: handler,
    onViewModeChange: handler,
    onToggleCheckboxes: handler,
    onSelectChange: handler,
    onNavigate: handler,
    onOpenSettings: handler,
    onOpen: handler,
    onRename: handler,
    onDuplicate: handler,
    onDownload: handler,
    onToggleStar: handler,
    onTogglePin: handler,
    onCopy: handler,
    onCut: handler,
    onPaste: handler,
    onMove: handler,
    onAddTag: handler,
    onVersions: handler,
    onDetails: handler,
    onDelete: handler,
    onRestore: handler,
    onPurge: handler,
    onCreateFile: handler,
    onCreateFolder: handler,
    onImport: handler,
    onRefresh: handler,
    ...overrides,
  }
}

function text(): string {
  return view?.container.textContent ?? ''
}

beforeEach(async () => {
  await setLocale('en-US', false)
})

afterEach(() => {
  view?.unmount()
  view = null
})

describe('office file list states', () => {
  it('announces the loading state before any row exists', () => {
    view = renderElement(createElement(OfficeFileList, props({ status: 'loading' })))
    expect(text()).toContain(t('common.loading'))
  })

  it('shows the failure copy and retries through the shared action', () => {
    const onRefresh = vi.fn()
    view = renderElement(createElement(OfficeFileList, props({ status: 'error', error: 'network is down', onRefresh })))
    expect(text()).toContain(t('office.error.load'))
    expect(text()).toContain('network is down')

    const retry = [...(view.container.querySelectorAll('button'))].find((button) => button.textContent?.includes(t('office.error.retry')))
    expect(retry).toBeTruthy()
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('explains an empty listing instead of drawing nothing', () => {
    view = renderElement(createElement(OfficeFileList, props()))
    expect(text()).toContain(t('office.empty.title'))
  })

  it('renders the rows it is given and keeps the type tabs reachable', () => {
    const files = [file(), file({ id: 'file-2', type: 'docs', title: 'Meeting notes' })]
    view = renderElement(createElement(OfficeFileList, props({ files })))

    expect(text()).toContain('Quarterly sheet')
    expect(text()).toContain('Meeting notes')
    const tabs = [...(view.container.querySelectorAll('[role="tab"]'))].map((tab) => tab.textContent?.trim())
    expect(tabs).toContain(t('office.type.all'))
    expect(tabs).toContain(t('office.type.sheets'))
  })

  it('searches trash and search views with their own empty copy', () => {
    view = renderElement(createElement(OfficeFileList, props({ activeView: 'trash' })))
    expect(text()).toContain(t('office.empty.trash.title'))
  })
})

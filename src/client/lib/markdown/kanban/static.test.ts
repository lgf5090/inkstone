/**
 * A board on a surface that cannot run one: an exported document, a shared note, a slide, the
 * editor's live preview. Those channels used to leave the block at "Loading kanban…" with
 * `aria-busy` up forever — the fence had been rendered, but nothing would ever mount it. The
 * contract asserted here is the one every rich block in this repo already keeps: a still
 * rendering when the surface declares one, the source when it declares nothing, and never a
 * promise that is never kept.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../i18n'
import { installTestGlobals } from '../../test-render'
import { registerFenceBodies } from '../fence-bodies'
import { renderMarkdown } from '../renderer'
import { renderStaticKanbans } from './static'
import { showKanbanSourceAll } from './view'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  document.body.replaceChildren()
})

function boardBody(data: unknown): string {
  return JSON.stringify(data)
}

function kanbanHost(body: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'ink-prose'
  const rendered = renderMarkdown(['```kanban', body, '```'].join('\n'))
  host.innerHTML = rendered.html
  // Whoever inserts the markup registers what it was rendered from — the board the block draws is
  // read back out of here, not out of an attribute (P-01).
  registerFenceBodies(host, rendered.fences)
  document.body.append(host)
  return host
}

function boardNode(body: string): HTMLElement {
  const host = kanbanHost(body)
  const node = host.querySelector<HTMLElement>('[data-kanban]')
  if (!node) throw new Error('the renderer emitted no kanban block')
  return node
}

const BOARD = {
  title: 'Release plan',
  activeViewId: 'view-board',
  columns: [
    { id: 'title', name: 'Title', type: 'title' },
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'doing', label: 'In Progress', color: 'blue' },
      ],
    },
  ],
  views: [{ id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' }],
  items: [
    { id: 'i1', title: 'Write the changelog', properties: { status: 'todo' } },
    { id: 'i2', title: 'Tag the build', properties: { status: 'doing' } },
    { id: 'i3', title: 'A card with no status', properties: {} },
  ],
}

describe('renderStaticKanbans — the board it draws', () => {
  it('draws every card under its group instead of a placeholder that never resolves', () => {
    const node = boardNode(boardBody(BOARD))
    renderStaticKanbans(node.parentElement!)

    const snapshot = node.querySelector<HTMLElement>('[data-kanban-snapshot]')
    expect(snapshot, 'the block still holds no still rendering of the board').not.toBeNull()
    expect(snapshot?.textContent).toContain('Write the changelog')
    expect(snapshot?.textContent).toContain('Tag the build')
    expect(snapshot?.textContent).toContain('A card with no status')
    expect(snapshot?.textContent).toContain(t('preview.kanban_status_todo'))
    expect(node.querySelector('[data-kanban-placeholder]')?.textContent).not.toContain(t('preview.kanban_loading'))
  })

  it('carries the board title so a page with two boards reads as two boards', () => {
    const node = boardNode(boardBody(BOARD))
    renderStaticKanbans(node.parentElement!)

    expect(node.querySelector('.kanban-snapshot-title')?.textContent).toBe('Release plan')
  })

  it('draws a board held as an outline body through the same channel', () => {
    const node = boardNode('## To Do\n\n- [ ] Ship the snapshot')
    renderStaticKanbans(node.parentElement!)

    expect(node.querySelector('[data-kanban-snapshot]')?.textContent).toContain('Ship the snapshot')
    expect(node.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps a card the board filed away out of the still', () => {
    const body = boardBody({
      ...BOARD,
      items: [...BOARD.items, { id: 'i4', title: 'An old experiment', properties: { status: 'doing' }, archived: true }],
    })
    const node = boardNode(body)
    renderStaticKanbans(node.parentElement!)

    const snapshot = node.querySelector<HTMLElement>('[data-kanban-snapshot]')!
    expect(snapshot.textContent).toContain('Tag the build')
    expect(snapshot.textContent, 'a still of the live board resurrected an archived card').not.toContain('An old experiment')
  })

  it('says a board is empty rather than leaving an empty box', () => {
    const node = boardNode(boardBody({ ...BOARD, items: [] }))
    renderStaticKanbans(node.parentElement!)

    expect(node.querySelector('.kanban-snapshot-empty')?.textContent).toBe(t('preview.kanban_snapshot_empty'))
    expect(node.getAttribute('aria-busy')).toBe('false')
  })
})

/**
 * A board a projector has to carry. The list above answers a surface that only needs the cards to be
 * readable; a slide is read from several metres, and there the thing being communicated is the
 * *shape* — which column each card sits in, and what the card itself says (its tags, its priority,
 * how far its subtasks got). These are the same values the live board draws, reached through the same
 * helpers, so a card cannot read differently on the two surfaces.
 */
const PROJECTOR_BOARD = {
  title: 'Release plan',
  activeViewId: 'view-board',
  columns: [
    { id: 'title', name: 'Title', type: 'title' },
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'doing', label: 'In Progress', color: 'blue' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
    {
      id: 'priority',
      name: 'Priority',
      type: 'select',
      options: [{ id: 'high', label: 'High', color: 'red' }],
    },
    {
      id: 'tags',
      name: 'Tags',
      type: 'multi-select',
      options: [{ id: 'design', label: 'Design', color: 'purple' }],
    },
    { id: 'estimate', name: 'Estimate', type: 'text' },
  ],
  views: [{
    id: 'view-board',
    name: 'Board',
    type: 'board',
    groupBy: 'status',
    cardFields: ['estimate'],
    filters: [{ propertyId: 'status', operator: 'equals', value: 'todo' }],
  }],
  items: [
    {
      id: 'i1',
      title: 'Draw the board',
      cover: 'https://example.test/cover.png',
      properties: { status: 'todo', priority: 'high', tags: ['design'], estimate: '3d' },
      subtasks: [
        { id: 's1', title: 'Columns', completed: true },
        { id: 's2', title: 'Tints', completed: true },
        { id: 's3', title: 'Cards', completed: false },
      ],
    },
    { id: 'i2', title: 'Tag the build', properties: { status: 'doing' } },
  ],
}

function boardChannel(body: unknown, channel: 'list' | 'board'): HTMLElement {
  const host = kanbanHost(boardBody(body))
  renderStaticKanbans(host, channel)
  const node = host.querySelector<HTMLElement>('[data-kanban]')
  if (!node) throw new Error('the renderer emitted no kanban block')
  return node
}

describe('renderStaticKanbans — the columns a projector reads', () => {
  it('draws one column per group, each holding only its own cards', () => {
    const node = boardChannel(PROJECTOR_BOARD, 'board')
    const columns = [...node.querySelectorAll('.kanban-board-column')]

    expect(columns.map((column) => column.querySelector('.kanban-snapshot-group')?.textContent)).toEqual([
      t('preview.kanban_status_todo'),
      t('preview.kanban_status_in_progress'),
    ])
    expect(columns[0]?.querySelectorAll('.kanban-snapshot-card')).toHaveLength(1)
    expect(columns[1]?.querySelector('.kanban-snapshot-card')?.textContent).toContain('Tag the build')
    expect(columns[0]?.textContent, 'a card walked into the column beside it').not.toContain('Tag the build')
  })

  it('paints each column with the colour its own option carries', () => {
    const node = boardChannel(PROJECTOR_BOARD, 'board')
    const heads = [...node.querySelectorAll('.kanban-snapshot-group')] as HTMLElement[]

    expect(heads[0]?.style.backgroundColor).toBe('var(--kanban-tag-gray-bg)')
    expect(heads[1]?.style.backgroundColor).toBe('var(--kanban-tag-blue-bg)')
  })

  it('paints a column only from the colour its own option carries', () => {
    const node = boardChannel({
      ...PROJECTOR_BOARD,
      columns: PROJECTOR_BOARD.columns.map((column) => column.id === 'status'
        ? { ...column, options: [{ id: 'todo', label: 'To Do' }, { id: 'doing', label: 'In Progress', color: 'blue' }] }
        : column),
    }, 'board')
    const heads = [...node.querySelectorAll('.kanban-snapshot-group')] as HTMLElement[]

    expect(heads[0]?.style.backgroundColor, 'a column whose option names no colour grew a wash of its own anyway').toBe('')
    expect(heads[1]?.style.backgroundColor).toBe('var(--kanban-tag-blue-bg)')
  })
})

describe('renderStaticKanbans — what a card says about itself', () => {
  it('shows the tags, the priority and how far the subtasks got', () => {
    const card = boardChannel(PROJECTOR_BOARD, 'board').querySelector('.kanban-snapshot-card')!

    expect(card.querySelector('.kanban-snapshot-card-title')?.textContent).toBe('Draw the board')
    expect(card.querySelector('.kanban-snapshot-card-tags')?.textContent).toContain('Design')
    expect(card.querySelector('.kanban-snapshot-card-priority')?.textContent).toContain('High')
    expect(card.querySelector('.kanban-snapshot-card-subtasks')?.textContent).toContain('2/3')
  })

  it('wears the tag colour the live card would have picked for that tag', () => {
    const chip = boardChannel(PROJECTOR_BOARD, 'board').querySelector('.kanban-snapshot-card-tags li') as HTMLElement

    expect(chip.style.backgroundColor).toBe('var(--kanban-tag-purple-bg)')
    expect(chip.style.color).toBe('var(--kanban-tag-purple-fg)')
  })

  it('prints the fields the view asked for, by their own names', () => {
    const fields = boardChannel(PROJECTOR_BOARD, 'board').querySelector('[data-kanban-card-fields]')!

    expect(fields.querySelector('dt')?.textContent).toBe('Estimate')
    expect(fields.querySelector('dd')?.textContent).toBe('3d')
  })

  it('draws the cover the gallery tile draws, named by the card it belongs to', () => {
    const cover = boardChannel(PROJECTOR_BOARD, 'board').querySelector('img.kanban-cover')

    expect(cover?.getAttribute('src')).toBe('https://example.test/cover.png')
    expect(cover?.getAttribute('alt')).toBe('Draw the board')
  })

  it('keeps a card the reader filtered out, because a still cannot say it is looking at a subset', () => {
    const node = boardChannel(PROJECTOR_BOARD, 'board')

    expect(node.textContent, 'the view filter was applied to a surface that shows no filter control').toContain('Draw the board')
    expect(node.textContent).toContain('Tag the build')
  })
})

describe('renderStaticKanbans — the channel a surface asks for', () => {
  it('draws the plain list when a surface asks for a snapshot rather than a board', () => {
    const node = boardChannel(PROJECTOR_BOARD, 'list')

    expect(node.querySelector('.kanban-snapshot-board')).toBeNull()
    expect(node.querySelectorAll('.kanban-board-column')).toHaveLength(0)
    expect(node.querySelector('.kanban-snapshot-card')?.textContent).toBe('Draw the board')
  })

  it('keeps the list for the caller that names no channel at all', () => {
    const host = kanbanHost(boardBody(PROJECTOR_BOARD))
    renderStaticKanbans(host)

    expect(host.querySelector('.kanban-snapshot-board')).toBeNull()
    expect(host.querySelector('.kanban-snapshot-card')?.textContent).toBe('Draw the board')
  })
})

describe('renderStaticKanbans — the block it leaves behind', () => {
  it('marks the block finished and drops the controls a reader cannot press', () => {
    const node = boardNode(boardBody(BOARD))
    renderStaticKanbans(node.parentElement!)

    expect(node.getAttribute('aria-busy')).toBe('false')
    expect(node.classList.contains('loading')).toBe(false)
    expect(node.querySelector('[data-kanban-fullscreen]'), 'a fullscreen button with nothing to fullscreen').toBeNull()
  })

  it('reports a body it cannot read instead of hanging on it', () => {
    const node = boardNode('{ this is not a board }')
    renderStaticKanbans(node.parentElement!)

    expect(node.classList.contains('has-error')).toBe(true)
    expect(node.getAttribute('aria-busy')).toBe('false')
    expect(node.querySelector('.kanban-error-message')?.textContent).toContain(t('preview.kanban_render_failed'))
    expect(node.querySelector('[data-kanban-retry]'), 'a retry button only the live mount can answer').toBeNull()
  })

  it('draws the same board once, however often its markup is enhanced again', () => {
    const host = kanbanHost('## To Do\n\n- [ ] Ship the snapshot')
    const node = host.querySelector<HTMLElement>('[data-kanban]')!

    renderStaticKanbans(host)
    renderStaticKanbans(host)

    expect(host.querySelectorAll('[data-kanban-snapshot]')).toHaveLength(1)
    expect(node.getAttribute('aria-busy')).toBe('false')
  })
})

describe('showKanbanSourceAll', () => {
  it('shows the fence body where a surface knows nothing about boards', () => {
    const body = boardBody({ ...BOARD, items: [{ id: 'i1', title: 'Write the changelog', properties: {} }] })
    const node = boardNode(body)
    showKanbanSourceAll(node.parentElement!)

    expect(node.querySelector('code')?.textContent).toContain('Write the changelog')
    expect(node.classList.contains('kanban-source')).toBe(true)
    expect(node.getAttribute('aria-busy')).toBe('false')
    expect(node.querySelector('[data-kanban-fullscreen]')).toBeNull()
  })
})

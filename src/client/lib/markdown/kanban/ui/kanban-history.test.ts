import { act, createElement, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../../test-render'
import { useKanbanHistory } from './kanban-history'
import type { KanbanData } from '../types'

function makeData(title: string): KanbanData {
  return { title, views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }], columns: [], items: [] }
}

/** A board narrowed by a search, which is the shape a `view` commit writes. */
function makeSearchData(title: string | undefined, searchQuery: string): KanbanData {
  return {
    title,
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status', searchQuery }],
    columns: [],
    items: [],
  }
}

type HistoryApi = ReturnType<typeof useKanbanHistory>

interface Holder {
  a: HistoryApi | null
  b: HistoryApi | null
}

function Probe({ holder }: { holder: Holder }) {
  const refA = useRef<HTMLDivElement>(null)
  const apiA = useKanbanHistory(makeData('a1'), vi.fn(), refA)
  const refB = useRef<HTMLDivElement>(null)
  const apiB = useKanbanHistory(makeData('b1'), vi.fn(), refB)
  holder.a = apiA
  holder.b = apiB
  return createElement(
    'div',
    null,
    createElement('div', { ref: refA }, createElement('span', { id: 'inside-a' })),
    createElement('div', { ref: refB }, createElement('span', { id: 'inside-b' })),
  )
}

function pressCtrlZ(target: Element) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
  })
}

describe('useKanbanHistory keyboard scope', () => {
  it('undoes when the keydown bubbles through this instance container', () => {
    const holder: Holder = { a: null, b: null }
    const rendered = renderElement(createElement(Probe, { holder }))
    try {
      const initial = holder.a!.data
      act(() => {
        holder.a!.commitData(makeData('a2'))
      })
      expect(holder.a!.data.title).toBe('a2')
      pressCtrlZ(document.getElementById('inside-a')!)
      expect(holder.a!.data).toBe(initial)
    } finally {
      rendered.unmount()
    }
  })

  it('leaves global undo semantics alone when the keydown happens outside every board', () => {
    const holder: Holder = { a: null, b: null }
    const rendered = renderElement(createElement(Probe, { holder }))
    try {
      act(() => {
        holder.a!.commitData(makeData('a2'))
      })
      const afterCommit = holder.a!.data
      pressCtrlZ(document.body)
      expect(holder.a!.data).toBe(afterCommit)
    } finally {
      rendered.unmount()
    }
  })
})

describe('useKanbanHistory keyboard scope across boards', () => {
  it('two boards on screen: ctrl+z inside board A only reverts board A', () => {
    const holder: Holder = { a: null, b: null }
    const rendered = renderElement(createElement(Probe, { holder }))
    try {
      act(() => {
        holder.a!.commitData(makeData('a2'))
      })
      act(() => {
        holder.b!.commitData(makeData('b2'))
      })
      const bAfterCommit = holder.b!.data
      pressCtrlZ(document.getElementById('inside-a')!)
      expect(holder.a!.data.title).toBe('a1')
      expect(holder.b!.data).toBe(bAfterCommit)
    } finally {
      rendered.unmount()
    }
  })
})

function StabilityProbe({ holder, onUpdate }: { holder: { api: HistoryApi | null }; onUpdate: (next: KanbanData) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  holder.api = useKanbanHistory(makeData('s1'), onUpdate, ref)
  return createElement('div', { ref })
}

function renderStabilityProbe(onUpdate = vi.fn()) {
  const holder = { api: null as HistoryApi | null }
  const rendered = renderElement(createElement(StabilityProbe, { holder, onUpdate }))
  return { holder, rendered, onUpdate }
}

describe('useKanbanHistory commitData stability', () => {
  it('keeps the same commitData identity across commits so memoized children stay stable', () => {
    const { holder, rendered } = renderStabilityProbe()
    try {
      const commit = holder.api!.commitData
      act(() => {
        commit(makeData('s2'))
      })
      expect(holder.api!.commitData).toBe(commit)
    } finally {
      rendered.unmount()
    }
  })

  it('resolves functional updaters against the newest data even from a captured commitData', () => {
    const { holder, rendered } = renderStabilityProbe()
    try {
      const commit = holder.api!.commitData
      act(() => {
        commit((prev) => makeData(`${prev.title}+`))
      })
      act(() => {
        commit((prev) => makeData(`${prev.title}+`))
      })
      expect(holder.api!.data.title).toBe('s1++')
    } finally {
      rendered.unmount()
    }
  })

  it('forwards each resolved commit to onUpdateData', () => {
    const { holder, rendered, onUpdate } = renderStabilityProbe()
    try {
      act(() => {
        holder.api!.commitData((prev) => makeData(`${prev.title}+`))
      })
      expect(onUpdate).toHaveBeenCalledTimes(1)
      expect((onUpdate.mock.calls[0]![0] as KanbanData).title).toBe('s1+')
    } finally {
      rendered.unmount()
    }
  })
})

// A toast that offers a way back keeps the `undo` it was handed at the moment of the edit, and runs
// it later — that is the only way the reader can reach it after the board has re-rendered. Reading
// the step lists off the render-time state left that captured undo looking at the history from
// before its own edit, so the first delete of the session found nothing to undo and said nothing.
describe('useKanbanHistory undo outliving its render', () => {
  it('runs back the edit that was committed just before it was handed over', () => {
    const { holder, rendered, onUpdate } = renderStabilityProbe()
    const undo = holder.api!.undo
    const initial = holder.api!.data
    try {
      act(() => holder.api!.commitData(makeData('s2')))
      act(() => undo())
      expect(holder.api!.data).toBe(initial)
      expect((onUpdate.mock.calls.at(-1)![0] as KanbanData).title).toBe('s1')
    } finally {
      rendered.unmount()
    }
  })

  it('runs the edit forward again from a captured redo', () => {
    const { holder, rendered } = renderStabilityProbe()
    act(() => holder.api!.commitData(makeData('s2')))
    const redo = holder.api!.redo
    act(() => holder.api!.undo())
    try {
      act(() => redo())
      expect(holder.api!.data.title).toBe('s2')
    } finally {
      rendered.unmount()
    }
  })

  it('still leaves nothing alone when there is no step to run back', () => {
    const { holder, rendered, onUpdate } = renderStabilityProbe()
    const undo = holder.api!.undo
    const committed = holder.api!.data
    try {
      act(() => undo())
      expect(holder.api!.data).toBe(committed)
      expect(onUpdate).not.toHaveBeenCalled()
    } finally {
      rendered.unmount()
    }
  })
})

// Narrowing a board is not an edit. A reader who types three searches, opens the tag chip, sorts a
// column and switches to the table has done six things to the *look* of the board and nothing to the
// board, and Ctrl+Z after that run means the last card they touched — not a walk back through six
// lookups. The document is written either way (that is what keeps a view across a reload and lets a
// second reader open the same one); what a `view` commit does not do is take a step.
describe('useKanbanHistory view commits', () => {
  it('writes the view into the document without handing the reader a step back', () => {
    const { holder, rendered, onUpdate } = renderStabilityProbe()
    try {
      act(() => holder.api!.commitData(makeSearchData('s1', 'a'), 'view'))
      expect(holder.api!.data.views[0]!.searchQuery).toBe('a')
      expect(holder.api!.canUndo).toBe(false)
      expect((onUpdate.mock.calls.at(-1)![0] as KanbanData).views[0]!.searchQuery).toBe('a')
    } finally {
      rendered.unmount()
    }
  })

  it('takes back the last edit after a run of view commits, not the run itself', () => {
    const { holder, rendered } = renderStabilityProbe()
    const initial = holder.api!.data
    try {
      act(() => holder.api!.commitData(makeData('s2')))
      act(() => holder.api!.commitData((prev) => makeSearchData(prev.title, 'a'), 'view'))
      act(() => holder.api!.commitData((prev) => makeSearchData(prev.title, 'ab'), 'view'))
      expect(holder.api!.canUndo).toBe(true)
      act(() => holder.api!.undo())
      expect(holder.api!.data).toBe(initial)
    } finally {
      rendered.unmount()
    }
  })

  it('leaves the step lists alone when the view commit changes nothing', () => {
    const { holder, rendered } = renderStabilityProbe()
    const committed = holder.api!.data
    try {
      act(() => holder.api!.commitData(committed, 'view'))
      expect(holder.api!.data).toBe(committed)
      expect(holder.api!.canUndo).toBe(false)
      expect(holder.api!.canRedo).toBe(false)
    } finally {
      rendered.unmount()
    }
  })

})

// The two kinds interleaved, which is what a real session looks like. The price of a lookup not taking
// a step is that undo restores a whole document, view state and all — stated in `kanban-history.ts`
// rather than hidden, and asserted here so a change to the shape of it is a decision and not a surprise.
describe('useKanbanHistory steps and lookups interleaved', () => {
  it('comes back to the newest view state of its own, so the filter is not on the way back', () => {
    const { holder, rendered } = renderStabilityProbe()
    try {
      act(() => holder.api!.commitData(makeData('s2')))
      act(() => holder.api!.commitData((prev) => makeSearchData(prev.title, 'a'), 'view'))
      const narrowed = holder.api!.data
      act(() => holder.api!.undo())
      act(() => holder.api!.redo())
      expect(holder.api!.data).toBe(narrowed)
    } finally {
      rendered.unmount()
    }
  })

  it('keeps a step that an edit took after it, in the order it happened', () => {
    const { holder, rendered } = renderStabilityProbe()
    try {
      act(() => holder.api!.commitData(makeSearchData('s1', 'a'), 'view'))
      act(() => holder.api!.commitData(makeData('s2')))
      act(() => holder.api!.commitData((prev) => makeSearchData(prev.title, 'ab'), 'view'))
      act(() => holder.api!.undo())
      // The step belongs to the edit; the view state of that moment comes back with it.
      expect(holder.api!.data.title).toBe('s1')
      expect(holder.api!.canRedo).toBe(true)
    } finally {
      rendered.unmount()
    }
  })
})

import { describe, expect, it } from 'vitest'
import type { InkDocument } from '../../lib/inkpad/types'
import { InkHistory, MAX_UNDO_STEPS } from './ink-history'

function document(id: string): InkDocument {
    return {
        format: 'inkpad',
        version: 1,
        strokes: [{ id, tool: 'pen', color: '#000', width: 1, points: [{ x: 0, y: 0, p: 0.5, t: 0 }] }],
        shapes: [],
        elements: [{ id: `${id}-card`, kind: 'text', path: '', text: 'x', x: 0, y: 0, width: 120, height: 100 }],
    }
}

describe('InkHistory', () => {
    it('undoes and redoes a document', () => {
        const history = new InkHistory()
        const first = document('a')
        history.snapshot(first)
        expect(history.canUndo).toBe(true)
        const previous = history.undo(document('b'))
        expect(previous).toEqual(first)
        expect(history.canRedo).toBe(true)
        expect(history.redo(document('a'))).toEqual(document('b'))
    })

    it('drops redo entries when a new snapshot arrives', () => {
        const history = new InkHistory()
        history.snapshot(document('a'))
        history.undo(document('b'))
        history.snapshot(document('c'))
        expect(history.canRedo).toBe(false)
    })

    it('keeps element objects independent of later mutations', () => {
        const history = new InkHistory()
        const current = document('a')
        history.snapshot(current)
        current.elements[0]!.x = 999
        const previous = history.undo(current)!
        expect(previous.elements[0]!.x).toBe(0)
    })

    it('caps the stack and keeps the newest snapshots', () => {
        const history = new InkHistory()
        for (let index = 0; index < MAX_UNDO_STEPS + 5; index++) history.snapshot(document(`s${index}`))
        let current = document('current')
        let steps = 0
        while (history.canUndo) {
            current = history.undo(current)!
            steps += 1
        }
        expect(steps).toBe(MAX_UNDO_STEPS)
        expect(current.strokes[0]!.id).toBe('s5')
    })

    it('clears both directions', () => {
        const history = new InkHistory()
        history.snapshot(document('a'))
        history.undo(document('b'))
        history.clear()
        expect(history.canUndo).toBe(false)
        expect(history.canRedo).toBe(false)
    })
})

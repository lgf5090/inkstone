import { describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/constants'
import { INK_FILE_EXTENSION, createEmptyInkDocument, isInkNoteTitle, uniqueInkTitle } from './document'

describe('isInkNoteTitle', () => {
    it('accepts the extension in any casing and around whitespace', () => {
        expect(isInkNoteTitle('Sketch.ink')).toBe(true)
        expect(isInkNoteTitle('  Sketch.INK  ')).toBe(true)
    })

    it('rejects prose, empty values and other extensions', () => {
        expect(isInkNoteTitle('ink patterns')).toBe(false)
        expect(isInkNoteTitle('Sketch.ink copy')).toBe(false)
        expect(isInkNoteTitle('')).toBe(false)
        expect(isInkNoteTitle(undefined)).toBe(false)
        expect(isInkNoteTitle(null)).toBe(false)
    })

    it('uses the one extension constant', () => {
        expect(INK_FILE_EXTENSION).toBe('.ink')
    })
})

describe('createEmptyInkDocument', () => {
    it('writes the Inkpad envelope with three empty collections', () => {
        expect(JSON.parse(createEmptyInkDocument())).toEqual({
            format: 'inkpad',
            version: 1,
            strokes: [],
            shapes: [],
            elements: [],
        })
    })
})

describe('uniqueInkTitle', () => {
    it('keeps a free title as it is', () => {
        expect(uniqueInkTitle('Sketch.ink', [])).toBe('Sketch.ink')
    })

    it('counts before the extension, case-insensitively', () => {
        expect(uniqueInkTitle('Sketch.ink', ['sketch.INK'])).toBe('Sketch 2.ink')
        expect(uniqueInkTitle('Sketch.ink', ['Sketch.ink', 'Sketch 2.ink'])).toBe('Sketch 3.ink')
    })

    it('appends the counter to a title without the extension', () => {
        expect(uniqueInkTitle('Sketch', ['Sketch'])).toBe('Sketch 2')
    })

    it('stays inside the title ceiling', () => {
        const long = `${'x'.repeat(600)}.ink`
        const out = uniqueInkTitle(long, [long])
        expect(out.length).toBeLessThanOrEqual(LIMITS.titleMaxLength)
        expect(out.endsWith('.ink')).toBe(true)
    })
})

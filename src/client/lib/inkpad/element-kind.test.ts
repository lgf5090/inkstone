import { describe, expect, it } from 'vitest'
import { kindFromMime } from './element-kind'

describe('kindFromMime', () => {
    it('maps images, PDFs and audio by MIME', () => {
        expect(kindFromMime('image/png', 'x.bin')).toBe('image')
        expect(kindFromMime('application/pdf', 'x.bin')).toBe('pdf')
        expect(kindFromMime('audio/mpeg', 'x.bin')).toBe('audio')
    })

    it('falls back to filenames for generic MIME types', () => {
        expect(kindFromMime('application/octet-stream', 'Deck.PDF')).toBe('pdf')
        expect(kindFromMime('', 'voice.m4a')).toBe('audio')
    })

    it('refuses everything else', () => {
        expect(kindFromMime('text/markdown', 'note.md')).toBeNull()
        expect(kindFromMime('application/zip', 'archive.zip')).toBeNull()
        expect(kindFromMime(null, null)).toBeNull()
    })
})

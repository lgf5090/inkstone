import { describe, expect, it } from 'vitest'
import { classifyInkLink } from './link'

describe('classifyInkLink', () => {
    it('accepts http(s) and normalizes it', () => {
        expect(classifyInkLink('https://example.com/a b')).toEqual({ kind: 'url', url: 'https://example.com/a%20b' })
        expect(classifyInkLink('HTTP://example.com')).toEqual({ kind: 'url', url: 'http://example.com/' })
    })

    it('accepts note ids, wiki links and titles', () => {
        expect(classifyInkLink('/n/note-1')).toEqual({ kind: 'note', note: 'note-1' })
        expect(classifyInkLink('[[Topic|alias]]')).toEqual({ kind: 'note', note: 'Topic' })
        expect(classifyInkLink('Topic')).toEqual({ kind: 'note', note: 'Topic' })
    })

    it('refuses executable and protocol-relative links', () => {
        for (const value of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example', 'mailto:a@b.c', ' \u0000x ']) {
            expect(classifyInkLink(value), value).toEqual({ kind: 'invalid' })
        }
    })

    it('refuses empty, overlong and malformed values', () => {
        expect(classifyInkLink('')).toEqual({ kind: 'invalid' })
        expect(classifyInkLink('x'.repeat(513))).toEqual({ kind: 'invalid' })
        expect(classifyInkLink('/n/%E0%A4%A')).toEqual({ kind: 'invalid' })
        expect(classifyInkLink(null)).toEqual({ kind: 'invalid' })
    })
})

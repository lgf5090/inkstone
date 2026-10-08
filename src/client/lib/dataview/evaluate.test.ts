import { describe, expect, it } from 'vitest'
import { Context } from './context'
import { parseField } from './expression'
import { DvDuration, DvLink, type DataObject, type Literal } from './value'
import type { LinkHandler } from './context'
import { DEFAULT_QUERY_SETTINGS } from './functions'

const PAGES: Record<string, DataObject> = {
    'Notes/Alpha': { file: { name: 'Alpha', path: 'Notes/Alpha', day: new Date(2024, 4, 1), rating: 5 } },
}

function handler(pages: Record<string, DataObject> = PAGES): LinkHandler {
    return {
        resolve: (path) => pages[path] ?? null,
        normalize: (path) => (path in pages ? path : path),
        exists: (path) => path in pages,
    }
}

function context(pages?: Record<string, DataObject>): Context {
    return new Context({ linkHandler: handler(pages), settings: { ...DEFAULT_QUERY_SETTINGS, locale: 'en-US' } })
}

function run(expression: string, data: Record<string, Literal> = {}, pages?: Record<string, DataObject>): Literal {
    return context(pages).evaluate(parseField(expression), data)
}

describe('expression evaluation', () => {
    it('combines truth values with the symbol and the word spelling', () => {
        expect(run('true & false')).toBe(false)
        expect(run('true and false')).toBe(false)
        expect(run('true | false')).toBe(true)
        expect(run('false or true')).toBe(true)
        // Truthiness is the value model's, so 0 and the empty string are as false as false.
        expect(run('1 and 2')).toBe(true)
        expect(run('0 or 1')).toBe(true)
        expect(run('1 & 0')).toBe(false)
        expect(run('"" | "x"')).toBe(true)
        expect(run('a & b', { a: 3, b: 'yes' })).toBe(true)
        expect(run('a | b', { a: 0, b: '' })).toBe(false)
    })

    it('runs arithmetic with precedence and string concatenation', () => {
        expect(run('1 + 2 * 3')).toBe(7)
        expect(run('(1 + 2) * 3')).toBe(9)
        expect(run('10 / 4')).toBe(2.5)
        expect(run('10 % 3')).toBe(1)
        expect(run('"a" + 1')).toBe('a1')
        expect(run('1 + "a"')).toBe('1a')
    })

    it('treats a missing variable as null, and null arithmetic as an error', () => {
        expect(run('nothingHere')).toBeNull()
        expect(() => run('a + 1', { a: null })).toThrow(/No implementation for 'null \+ number'/)
    })

    it('short-circuits and/or so a guard can protect an index', () => {
        expect(run('a and a.b', { a: false })).toBe(false)
        expect(run('a or b', { a: true, b: false })).toBe(true)
        expect(run('!x', { x: 0 })).toBe(true)
        expect(run('not', {})).toBeNull()
    })

    it('compares across types with a total order', () => {
        expect(run('1 < 2')).toBe(true)
        expect(run('"abc" < "abd"')).toBe(true)
        expect(run('null < 1')).toBe(true)
        expect(run('date(2024-01-01) < date(2024-01-02)')).toBe(true)
        expect(run('date(2024-01-01) = date(2024-01-01)')).toBe(true)
        expect(run('[[A]] < [[B]]')).toBe(true)
        expect(run('[[A]] = [[A]]')).toBe(true)
        expect(run('[[A]] = "A"')).toBe(false)
    })

    it('sorts numbers embedded in text naturally', () => {
        expect(run('"Task 2" < "Task 10"')).toBe(true)
    })

    it('does date and duration arithmetic on calendar units', () => {
        expect(run('date(2024-01-31) + dur(1 month)')).toEqual(new Date(2024, 1, 29))
        expect(run('date(2024-03-01) - dur(1 day)')).toEqual(new Date(2024, 1, 29))
        expect(run('dur(1 week) + dur(2 days)')).toEqual(new DvDuration({ weeks: 1, days: 2 }))
        expect(run('dur(90 minutes)')).toEqual(new DvDuration({ minutes: 90 }))
        expect((run('dur(90 minutes) / 30') as DvDuration).minutes).toBe(3)
        expect(run('date(2024-01-01) - date(2024-01-01)')).toEqual(new DvDuration())
    })

    it('measures a date difference in borrowed calendar units', () => {
        const diff = run('date(2024-01-15) - date(2023-12-15)') as DvDuration
        expect(diff.months).toBe(1)
        expect(diff.days).toBe(0)
        const overshoot = run('date(2024-03-14) - date(2024-01-15)') as DvDuration
        expect(overshoot.months).toBe(1)
        expect(overshoot.weeks).toBe(4)
        expect(overshoot.days).toBe(0)
    })

    it('indexes an array by a string to map over it, and by a number to pick one', () => {
        expect(run('length(xs)', { xs: [1, 2, 3] })).toBe(3)
        expect(run('xs.text', { xs: [{ text: 'a' }, { text: 'b' }] })).toEqual(['a', 'b'])
        expect(run('xs[0]', { xs: [7, 8] })).toBe(7)
        expect(run('xs[9]', { xs: [7, 8] })).toBeNull()
    })

    it('indexes a link by resolving the target note', () => {
        expect(run('[[Notes/Alpha]].file.rating')).toBe(5)
        expect(run('[[Missing]].file.rating')).toBeNull()
    })

    it('exposes date and duration units as indexing', () => {
        expect(run('d.year', { d: new Date(2024, 4, 6) })).toBe(2024)
        expect(run('d.month', { d: new Date(2024, 4, 6) })).toBe(5)
        expect(run('d.weekday', { d: new Date(2024, 4, 6) })).toBe(1)
        expect(run('du.days', { du: new DvDuration({ hours: 48 }) })).toBe(2)
    })

    it('reads row.x from the row itself', () => {
        expect(run('row.file.name', { file: { name: 'Beta' } as unknown as Record<string, Literal> })).toBe('Beta')
    })
})

describe('function library', () => {
    it('constructs links, dates and durations', () => {
        expect(run('link("Notes/Alpha")')).toEqual(DvLink.file('Notes/Alpha'))
        expect(run('link("Notes/Alpha", "the first")')).toEqual(DvLink.file('Notes/Alpha', 'the first'))
        expect(run('embed(link("A"))')).toEqual(new DvLink('A', 'file', null, null, true))
        expect(run('elink("https://example.com", "site")')).toEqual(new DvLink('https://example.com', 'file', null, 'site'))
        expect(run('date("2024-02-03")')).toEqual(new Date(2024, 1, 3))
        expect(run('date("2024/02/03", "yyyy/MM/dd")')).toEqual(new Date(2024, 1, 3))
        expect(run('date("not a date")')).toBeNull()
        expect(run('dur("3 days")')).toEqual(new DvDuration({ days: 3 }))
        expect(run('number("42 kg")')).toBe(42)
        expect(run('string(42)')).toBe('42')
        expect(run('typeof([1])')).toBe('array')
    })

    it('reads a date out of the note a link points at', () => {
        expect(run('date([[Notes/Alpha]])')).toEqual(new Date(2024, 4, 1))
    })

    it('measures, joins and reshapes lists', () => {
        expect(run('length([1, 2, 3])')).toBe(3)
        expect(run('length({a: 1})')).toBe(1)
        expect(run('length(null)')).toBe(0)
        expect(run('join([1, 2, 3])')).toBe('1, 2, 3')
        expect(run('join([1, 2], "-")')).toBe('1-2')
        expect(run('reverse([1, 2, 3])')).toEqual([3, 2, 1])
        expect(run('flat([[1, [2]], 3])')).toEqual([1, [2], 3])
        expect(run('slice([1, 2, 3, 4], 1, 3)')).toEqual([2, 3])
        expect(run('unique([1, 1, 2])')).toEqual([1, 2])
        expect(run('nonnull([1, null, 2])')).toEqual([1, 2])
        expect(run('firstvalue([null, "x"])')).toBe('x')
    })

    it('maps, filters, sorts and reduces', () => {
        expect(run('map([1, 2], (x) => x * 2)')).toEqual([2, 4])
        expect(run('filter([1, 2, 3], (x) => x > 1)')).toEqual([2, 3])
        expect(run('sort([3, 1, 2])')).toEqual([1, 2, 3])
        expect(run('sort([1, 2], (x) => 0 - x)')).toEqual([2, 1])
        expect(run('sum([1, 2, 3])')).toBe(6)
        expect(run('product([2, 3])')).toBe(6)
        expect(run('average([2, 4])')).toBe(3)
        expect(run('reduce([1, 2, 3], "+")')).toBe(6)
        expect(run('reduce([true, false], "&")')).toBe(false)
        expect(run('min([3, 1, 2])')).toBe(1)
        expect(run('max([3, 1, 2])')).toBe(3)
        expect(run('minby([{v: 3, n: "c"}, {v: 1, n: "a"}], (x) => x.v).n')).toBe('a')
        expect(run('maxby([3, 9], (x) => x)')).toBe(9)
        expect(run('all([1, "a"])')).toBe(true)
        expect(run('any([0, false])')).toBe(false)
        expect(run('none([0, false])')).toBe(true)
    })

    it('runs the string toolkit', () => {
        expect(run('lower("AbC")')).toBe('abc')
        expect(run('upper("AbC")')).toBe('ABC')
        expect(run('replace("a.b.c", ".", "-")')).toBe('a-b-c')
        expect(run('split("a,b", ",")')).toEqual(['a', 'b'])
        expect(run('split("a1b2c", "[0-9]")')).toEqual(['a', 'b', 'c'])
        expect(run('startswith("note", "no")')).toBe(true)
        expect(run('endswith("note", "e")')).toBe(true)
        expect(run('padleft("7", 3, "0")')).toBe('007')
        expect(run('padright("7", 3, "0")')).toBe('700')
        expect(run('substring("abcdef", 2, 4)')).toBe('cd')
        expect(run('truncate("hello world", 8)')).toBe('hello...')
        expect(run('regextest("^a+$", "aaa")')).toBe(true)
        expect(run('regexmatch("a(b)c", "abc")')).toBe('abc')
        expect(run('regexreplace("abc", "b", "X")')).toBe('aXc')
        expect(run('contains("hello", "ell")')).toBe(true)
        expect(run('icontains("Hello", "ell")')).toBe(true)
        expect(run('contains(["a", ["b"]], "b")')).toBe(true)
        expect(run('econtains(["a", ["b"]], "b")')).toBe(false)
        expect(run('contains({a: 1}, "a")')).toBe(true)
        expect(run('contains([1, 2], 2)')).toBe(true)
        expect(run('containsword("the quick brown", "quick")')).toBe(true)
        expect(run('containsword("quickening", "quick")')).toBe(false)
    })

    it('refuses a catastrophic pattern instead of running it', () => {
        expect(() => run('regextest("(a+)+b", "aaaaaaaaaaaaaaaaaaaaaaaax")')).toThrow(/Refusing/)
        expect(() => run('split("a", "(x|x)+")')).toThrow(/Refusing/)
    })

    it('handles defaults, choices and display text', () => {
        expect(run('default(null, "x")')).toBe('x')
        expect(run('default("a", "x")')).toBe('a')
        expect(run('ldefault(null, "x")')).toBe('x')
        expect(run('choice(true, "y", "n")')).toBe('y')
        expect(run('display([[Note|label]])')).toBe('label')
        expect(run('display([])')).toBe('')
        expect(run('display("plain [[Note]] text")')).toBe('plain Note text')
        expect(run('typeof(link("x"))')).toBe('link')
    })

    it('formats dates, durations and money', () => {
        expect(run('dateformat(d, "yyyy-MM-dd")', { d: new Date(2024, 4, 6) })).toBe('2024-05-06')
        expect(run('striptime(d).hour', { d: new Date(2024, 4, 6, 13, 30) })).toBe(0)
        expect(run('localtime(d)', { d: new Date(2024, 4, 6, 1) })).toEqual(new Date(2024, 4, 6, 1))
        expect(run('currencyformat(12.5, "eur")')).toBe('€12.50')
        expect(run('round(3.14159, 2)')).toBe(3.14)
        expect(run('floor(3.7)')).toBe(3)
        expect(run('ceil(3.2)')).toBe(4)
        expect(run('trunc(-3.7)')).toBe(-3)
    })

    it('inspects links and objects', () => {
        expect(run('meta([[A#h|d]])')).toEqual({ display: 'd', embed: false, path: 'A', subpath: 'h', type: 'header' })
        expect(run('extract({a: 1, b: 2}, "a")')).toEqual({ a: 1 })
        expect(run('object("a", 1)')).toEqual({ a: 1 })
        expect(run('list(1, 2)')).toEqual([1, 2])
        expect(run('hash("seed", "text")')).toBeTypeOf('number')
    })

    it('vectorises over array arguments', () => {
        expect(run('link(["a", "b"])')).toEqual([DvLink.file('a'), DvLink.file('b')])
        expect(run('upper(["a", "b"])')).toEqual(['A', 'B'])
        expect(run('default([null, 1], "x")')).toEqual(['x', 1])
    })

    it('reports an unusable call as an error, not a silent null', () => {
        expect(() => run('nosuchfunction(1)')).toThrow(/Unrecognized function/)
        expect(() => run('upper(1)')).toThrow(/No implementation of 'upper'/)
    })
})

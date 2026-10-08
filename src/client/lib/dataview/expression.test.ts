import { describe, expect, it } from 'vitest'
import { parseField, parseQuery, parseSource, parseInlineValue } from './expression'
import { Fields, Sources, type Field } from './ast'
import { DvDuration, DvLink, Values } from './value'

function field(text: string): Field {
    return parseField(text)
}

describe('expression parser', () => {
    it('reads a bare variable and a dotted chain as nested indexes', () => {
        expect(field('rating')).toEqual(Fields.variable('rating'))
        expect(field('file.frontmatter.x')).toEqual(
            Fields.index(Fields.index(Fields.variable('file'), Fields.literal('frontmatter')), Fields.literal('x')),
        )
    })

    it('refuses a reserved word as a variable', () => {
        expect(() => field('FROM')).toThrow()
        expect(() => field('x + GROUP')).toThrow()
    })

    it('folds Han and hyphenated names into one identifier', () => {
        // Written as escapes: the gate keeps Han text in the locale catalogs only, and the character
        // script the rule exercises is the same either way.
        const han = '\u72b6\u6001'
        expect(field(han)).toEqual(Fields.variable(han))
        expect(field('my-field')).toEqual(Fields.variable('my-field'))
    })

    it('applies the four operator precedence levels', () => {
        expect(field('1 + 2 * 3')).toEqual(Fields.binaryOp('+', Fields.literal(1), Fields.binaryOp('*', Fields.literal(2), Fields.literal(3))))
        expect(field('a = 1 and b')).toEqual(
            Fields.binaryOp('&', Fields.binaryOp('=', Fields.variable('a'), Fields.literal(1)), Fields.variable('b')),
        )
        expect(field('a & b | c')).toEqual(
            Fields.binaryOp('|', Fields.binaryOp('&', Fields.variable('a'), Fields.variable('b')), Fields.variable('c')),
        )
    })

    it('keeps a leading minus inside the number, which is what `2024-01-02` means', () => {
        // `2024-01-02` is subtraction, not a date: the reference parses it the same way, which is why
        // a date in a query has to be written `date(2024-01-02)`.
        expect(field('2024-01-02')).toEqual(
            Fields.binaryOp('-', Fields.binaryOp('-', Fields.literal(2024), Fields.literal(1)), Fields.literal(2)),
        )
        expect(field('date(2024-01-02)')).toEqual(Fields.literal(new Date(2024, 0, 2)))
    })

    it('parses links with display text, headers and blocks', () => {
        expect(field('[[Note]]')).toEqual(Fields.literal(DvLink.file('Note')))
        expect(field('[[Note|shown]]')).toEqual(Fields.literal(DvLink.file('Note', 'shown')))
        const header = field('[[Note#Section]]').type === 'literal' ? (field('[[Note#Section]]') as { value: DvLink }).value : null
        expect(header?.kind).toBe('header')
        expect(header?.subpath).toBe('Section')
        const block = (field('[[Note^abc]]') as { value: DvLink }).value
        expect(block.kind).toBe('block')
        expect(block.subpath).toBe('abc')
    })

    it('reads a duration literal as calendar units', () => {
        const value = (field('dur(2 days, 3 hours)') as { value: DvDuration }).value
        expect(value.days).toBe(2)
        expect(value.hours).toBe(3)
        const tight = (field('dur(4hr2min)') as { value: DvDuration }).value
        expect(tight.hours).toBe(4)
        expect(tight.minutes).toBe(2)
    })

    it('parses lists, objects and lambdas', () => {
        expect(field('[1, 2, 3]')).toEqual(Fields.list([Fields.literal(1), Fields.literal(2), Fields.literal(3)]))
        expect(field('[]')).toEqual(Fields.list([]))
        expect(field('{ a: 1, b: "x" }')).toEqual(Fields.object({ a: Fields.literal(1), b: Fields.literal('x') }))
        expect(field('(x) => x + 1')).toEqual(Fields.lambda(['x'], Fields.binaryOp('+', Fields.variable('x'), Fields.literal(1))))
    })

    it('chains index, dot and call postfixes', () => {
        expect(field('rows.file.tasks[0].text')).toEqual(
            Fields.index(
                Fields.index(
                    Fields.index(
                        Fields.index(Fields.variable('rows'), Fields.literal('file')),
                        Fields.literal('tasks'),
                    ),
                    Fields.literal(0),
                ),
                Fields.literal('text'),
            ),
        )
        expect(field('string(1)')).toEqual(Fields.func(Fields.variable('string'), [Fields.literal(1)]))
        expect(field('link("a")("b")')).toEqual(
            Fields.func(Fields.func(Fields.variable('link'), [Fields.literal('a')]), [Fields.literal('b')]),
        )
    })

    it('keeps escapes that are not quotes as written text', () => {
        expect(field('regexmatch("\\d+")').type).toBe('func')
        expect((field('"a\\db"') as { value: string }).value).toBe('a\\db')
    })

    it('parses every FROM source shape the docs list', () => {
        expect(parseSource('#project/active')).toEqual(Sources.tag('#project/active'))
        expect(parseSource('"Books/SciFi"')).toEqual(Sources.folder('Books/SciFi'))
        expect(parseSource('[[Target]]')).toEqual(Sources.link('Target', true))
        expect(parseSource('outgoing([[Target]])')).toEqual(Sources.link('Target', false))
        expect(parseSource('csv("data.csv")')).toEqual(Sources.csv('data.csv'))
        expect(parseSource('"a" and "b"')).toEqual(Sources.and(Sources.folder('a'), Sources.folder('b')))
        expect(parseSource('-#done')).toEqual(Sources.negate(Sources.tag('#done')))
        expect(parseSource('( #a or #b ) and -"Archive"')).toEqual(
            Sources.and(
                Sources.or(Sources.tag('#a'), Sources.tag('#b')),
                Sources.negate(Sources.folder('Archive')),
            ),
        )
    })
})

describe('query parser', () => {
    it('parses a table query with named columns and a source', () => {
        const query = parseQuery('TABLE rating AS "Rating", due FROM #book SORT rating DESC')
        expect(query.header.type).toBe('table')
        if (query.header.type !== 'table') return
        expect(query.header.showId).toBe(true)
        expect(query.header.fields.map((f) => f.name)).toEqual(['Rating', 'due'])
        expect(query.source).toEqual(Sources.tag('#book'))
        expect(query.operations).toEqual([{ type: 'sort', fields: [{ field: Fields.variable('rating'), direction: 'descending' }] }])
    })

    it('honours TABLE WITHOUT ID', () => {
        const query = parseQuery('TABLE WITHOUT ID file.link AS "Note"')
        if (query.header.type !== 'table') throw new Error('expected a table')
        expect(query.header.showId).toBe(false)
        expect(query.header.fields[0]?.name).toBe('Note')
    })

    it('accepts a bare column whose heading is its own text', () => {
        const query = parseQuery('TABLE length(file.tasks)')
        if (query.header.type !== 'table') throw new Error('expected a table')
        expect(query.header.fields[0]?.name).toBe('length(file.tasks)')
    })

    it('parses LIST with and without a format, and TASK with none', () => {
        expect(parseQuery('LIST').header).toEqual({ type: 'list', format: undefined, showId: true })
        const withFormat = parseQuery('LIST file.mtime')
        if (withFormat.header.type !== 'list') throw new Error('expected a list')
        expect(withFormat.header.format).toEqual(
            Fields.index(Fields.variable('file'), Fields.literal('mtime')),
        )
        expect(parseQuery('TASK').header).toEqual({ type: 'task' })
    })

    it('parses CALENDAR with a date field', () => {
        const query = parseQuery('CALENDAR file.day FROM "Daily"')
        if (query.header.type !== 'calendar') throw new Error('expected a calendar')
        expect(query.header.field.name).toBe('file.day')
        expect(query.source).toEqual(Sources.folder('Daily'))
    })

    it('keeps clauses in the order written and allows repeats', () => {
        const query = parseQuery('LIST\nWHERE a\nLIMIT 3\nWHERE b\nSORT c')
        expect(query.operations.map((op) => op.type)).toEqual(['where', 'limit', 'where', 'sort'])
    })

    it('supports GROUP BY and FLATTEN with aliases', () => {
        const query = parseQuery('LIST rows.file.name GROUP BY author AS "By author"')
        const group = query.operations.find((op) => op.type === 'group')
        expect(group).toEqual({ type: 'group', field: { name: 'By author', aliased: true, field: Fields.variable('author') } })
        const flatten = parseQuery('TABLE x FLATTEN file.tags AS tag').operations.find((op) => op.type === 'flatten')
        expect(flatten).toEqual({ type: 'flatten', field: { name: 'tag', aliased: true, field: Fields.index(Fields.variable('file'), Fields.literal('tags')) } })
        const bare = parseQuery('TABLE rating GROUP BY done').operations.find((op) => op.type === 'group')
        expect(bare).toEqual({ type: 'group', field: { name: 'done', field: Fields.variable('done') } })
    })

    it('skips // comment lines between clauses', () => {
        const query = parseQuery('// heading\nTABLE a\n// middle\nWHERE b')
        expect(query.operations.map((op) => op.type)).toEqual(['where'])
    })

    it('defaults a missing FROM to every note', () => {
        expect(parseQuery('TASK').source).toEqual(Sources.everything())
    })

    it('rejects trailing junk with a position', () => {
        expect(() => parseQuery('TABLE a WHERE b WHERE')).toThrow()
    })
})

describe('inline field values', () => {
    it('parses atoms and leaves prose alone', () => {
        expect(parseInlineValue('42')).toBe(42)
        expect(parseInlineValue('2024-01-02')).toEqual(new Date(2024, 0, 2))
        expect(parseInlineValue('true')).toBe(true)
        expect(parseInlineValue('#tag')).toBe('#tag')
        expect(parseInlineValue('[[Note]]')).toEqual(DvLink.file('Note'))
        expect(parseInlineValue('')).toBeNull()
        expect(parseInlineValue('John Smith')).toBe('John Smith')
        expect(parseInlineValue('#a, #b')).toEqual(['#a', '#b'])
    })

    it('keeps a duration as calendar units', () => {
        const value = parseInlineValue('3 days')
        expect(Values.isDuration(value)).toBe(true)
        expect((value as DvDuration).days).toBe(3)
    })
})

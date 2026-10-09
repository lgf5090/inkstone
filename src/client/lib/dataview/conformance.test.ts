/**
 * Conformance against the reference plugin's own grammar corpus.
 *
 * The cases are the strings `obsidian-dataview`'s tests feed to its parser, plus the query shapes its
 * documentation uses. Each one is asserted here rather than printed, because the failure mode of a port
 * is a query that silently means something else: `LIST` + newline + `SORT file.name` once parsed `SORT`
 * as a variable and rejected the rest, which reads as a broken query to the author and as nothing at all
 * to the reader.
 */
import { describe, expect, it } from 'vitest'
import { buildDate, parseField, parseInlineValue, parseQuery, parseSource } from './expression'
import { DvDuration, Values } from './value'

const parses = (text: string) => {
    try {
        parseQuery(text)
        return true
    } catch {
        return false
    }
}

describe('query clauses after a bare header', () => {
    it.each([
        'LIST SORT rating',
        'LIST\nSORT rating',
        'LIST\nSORT rating DESC',
        'LIST\nSORT file.name',
        'LIST\nSORT 1',
        'LIST\nSORT rating DESC, file.name ASC',
        'LIST\nWHERE rating > 1',
        'LIST\nLIMIT 3',
        'LIST\nFLATTEN rating AS r',
        'LIST\nGROUP BY rating AS g',
        'TABLE\nSORT rating',
        'TABLE rating AS "R"\nFROM #a\nSORT rating DESC',
        'TASK\nWHERE !completed',
        'TASK',
        'CALENDAR file.day',
        'LIST FROM #a\nSORT file.name ASC',
        '// leading comment\nLIST\nSORT file.name',
    ])('accepts %j', (text) => {
        expect(parses(text)).toBe(true)
    })

    it.each([
        'LIST\nSORT rating ASC rating',
        'TABLE rating WHERE',
        'VEHICLE',
        'LIST FROM',
    ])('rejects %j', (text) => {
        expect(parses(text)).toBe(false)
    })

    it('reads a sorted list as a sort clause, not as a field named SORT', () => {
        const query = parseQuery('LIST\nSORT rating DESC')
        expect(query.header.type).toBe('list')
        expect(JSON.stringify(query.header)).not.toContain('"SORT"')
        expect(query.operations.map((op) => op.type)).toEqual(['sort'])
    })

    it('keeps a LIST format expression when it is not a clause word', () => {
        const query = parseQuery('LIST rating')
        expect(query.header.type === 'list' && query.header.format?.type).toBe('variable')
        const withoutId = parseQuery('LIST WITHOUT ID rating')
        expect(withoutId.header.type === 'list' && withoutId.header.showId).toBe(false)
    })

    it('keeps a TABLE field list intact when a clause follows on the same line', () => {
        const query = parseQuery('TABLE a, b SORT c')
        expect(query.header.type === 'table' && query.header.fields.map((field) => field.name)).toEqual(['a', 'b'])
        expect(query.operations.map((op) => op.type)).toEqual(['sort'])
    })
})

describe('date literals', () => {
    it('reads the offsets the reference reads', () => {
        expect(parseField('date(1985-12-06T19:40:10Z)')).toEqual({ type: 'literal', value: new Date('1985-12-06T19:40:10Z') })
        expect(parseField('date(1984-08-15T12:40:50-07:00)')).toEqual({ type: 'literal', value: new Date('1984-08-15T19:40:50Z') })
        expect(parseField('date(1984-08-15T12:40:50+9)')).toEqual({ type: 'literal', value: new Date('1984-08-15T03:40:50Z') })
        expect(parseField('date(1984-08-15T12:40:50+09:30)')).toEqual({ type: 'literal', value: new Date('1984-08-15T03:10:50Z') })
        expect(parseField('date(1984-08-15T12:42:59.123)').type).toBe('literal')
    })

    it('does not read a day of month as a zone', () => {
        expect(buildDate('1984-08-15').getTime()).toBe(new Date(1984, 7, 15).getTime())
        expect(buildDate('2021-03').getTime()).toBe(new Date(2021, 2, 1).getTime())
    })

    it('refuses an IANA zone name, which is a documented deviation', () => {
        expect(() => parseField('date(2021-08-15T12:40:50[Europe/Paris])')).toThrow()
    })

    it('keeps the shorthand table the reference has', () => {
        for (const name of ['now', 'today', 'yesterday', 'tomorrow', 'sow', 'start-of-week', 'eow', 'end-of-week', 'som', 'start-of-month', 'eom', 'end-of-month', 'soy', 'start-of-year', 'eoy', 'end-of-year']) {
            expect(parseField(`date(${name})`).type).toBe('literal')
        }
    })
})

describe('inline field values', () => {
    it.each([
        ['4 minutes', 'duration'],
        ['4 hours, 15 minutes', 'duration'],
        ['6 days', 'duration'],
        ['4h15m', 'duration'],
        ['2024-05-06', 'date'],
        ['1984-08-15T12:40:50Z', 'date'],
        ['#hello-from-marketing/yes', 'string'],
        ['#daily/2021-08-15', 'string'],
        ['#📷', 'string'],
        ['true', 'boolean'],
        ['42', 'number'],
        ['"quoted"', 'string'],
        ['John Smith', 'string'],
    ])('%j is read as a %s', (text, kind) => {
        const value = parseInlineValue(text)
        const actual = Values.isDate(value) ? 'date' : value instanceof DvDuration ? 'duration' : Values.typeOf(value)
        expect(actual).toBe(kind)
    })

    it('keeps a source tag with the shapes the reference accepts', () => {
        expect(parseSource('#hello-from-marketing/yes')).toEqual({ type: 'tag', tag: '#hello-from-marketing/yes' })
        expect(parseSource('#début')).toEqual({ type: 'tag', tag: '#début' })
        expect(parseSource('csv("a.csv")')).toEqual({ type: 'csv', path: 'a.csv' })
        expect(parseSource('outgoing([[X]])').type).toBe('link')
        expect(parseSource('"Reading"').type).toBe('folder')
    })
})

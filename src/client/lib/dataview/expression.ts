/**
 * The expression language and the DQL query grammar.
 *
 * The grammar is written to match Dataview's own Parsimmon language rule for rule, because a query
 * copied out of the Dataview docs has to mean the same thing here. Two differences are deliberate:
 * IANA zone names inside a date literal (`2024-01-01[Asia/Shanghai]`) are not accepted, and the
 * `dateformat`/`durationformat` tokens are a documented subset rather than luxon's whole table.
 */

import {
    alt, comment, keyword, lazy, lit, many, map, optional, parseAll, pattern, requiredWhitespace, seq, sepBy, sepBy1, trimmed, whitespace,
    type Parser,
} from './grammar'
import {
    Fields, NULL_FIELD, Sources,
    type BinaryOp, type Field, type NamedField, type Query, type QueryHeader, type QueryOperation, type QuerySortBy, type Source,
} from './ast'
import { DvDuration, DvLink, type Literal } from './value'

const KEYWORDS = ['FROM', 'WHERE', 'LIMIT', 'GROUP', 'FLATTEN']

interface DurationUnits {
    years?: number
    months?: number
    weeks?: number
    days?: number
    hours?: number
    minutes?: number
    seconds?: number
}

/** Units are tried longest-first so `months` is never read as `month` plus a stray `s`. */
const DURATION_UNITS: Record<string, DurationUnits> = {
    years: { years: 1 }, year: { years: 1 }, yrs: { years: 1 }, yr: { years: 1 }, y: { years: 1 },
    months: { months: 1 }, month: { months: 1 }, mos: { months: 1 }, mo: { months: 1 },
    weeks: { weeks: 1 }, week: { weeks: 1 }, wks: { weeks: 1 }, wk: { weeks: 1 }, w: { weeks: 1 },
    days: { days: 1 }, day: { days: 1 }, d: { days: 1 },
    hours: { hours: 1 }, hour: { hours: 1 }, hrs: { hours: 1 }, hr: { hours: 1 }, h: { hours: 1 },
    minutes: { minutes: 1 }, minute: { minutes: 1 }, mins: { minutes: 1 }, min: { minutes: 1 }, m: { minutes: 1 },
    seconds: { seconds: 1 }, second: { seconds: 1 }, secs: { seconds: 1 }, sec: { seconds: 1 }, s: { seconds: 1 },
}

const DURATION_UNIT_KEYS = Object.keys(DURATION_UNITS).sort((a, b) => b.length - a.length)

export const DATE_SHORTHANDS: Record<string, (now: Date) => Date> = {
    now: (now) => new Date(now.getTime()),
    today: (now) => startOfDay(now),
    yesterday: (now) => new Date(startOfDay(now).getTime() - 86_400_000),
    tomorrow: (now) => new Date(startOfDay(now).getTime() + 86_400_000),
    sow: (now) => startOfWeek(now),
    'start-of-week': (now) => startOfWeek(now),
    eow: (now) => endOfWeek(now),
    'end-of-week': (now) => endOfWeek(now),
    soy: (now) => new Date(now.getFullYear(), 0, 1),
    'start-of-year': (now) => new Date(now.getFullYear(), 0, 1),
    eoy: (now) => new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
    'end-of-year': (now) => new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
    som: (now) => new Date(now.getFullYear(), now.getMonth(), 1),
    'start-of-month': (now) => new Date(now.getFullYear(), now.getMonth(), 1),
    eom: (now) => endOfMonth(now),
    'end-of-month': (now) => endOfMonth(now),
}

const DATE_SHORTHAND_KEYS = Object.keys(DATE_SHORTHANDS).sort((a, b) => b.length - a.length)

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Weeks start on Monday, matching the calendar view and most readers' expectation. */
function startOfWeek(date: Date): Date {
    const day = startOfDay(date)
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
    return day
}

function endOfWeek(date: Date): Date {
    const start = startOfWeek(date)
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999)
}

function endOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999)
}

export function stripTime(date: Date): Date {
    return startOfDay(date)
}

/** Fold `13 months` into `1 year 1 month` the way `dur()` promises. */
export function normalizeDuration(duration: DvDuration): DvDuration {
    return duration.normalized()
}

const ws = whitespace

const numberParser: Parser<number> = map(pattern(/-?[0-9]+(?:\.[0-9]+)?/, 'a number'), (text) => Number.parseFloat(text))

/**
 * A quoted string with backslash escapes. Only `\"` and `\\` are consumed as escapes — anything else
 * keeps its backslash, so `regexreplace(x, "\d", "")` receives the pattern the author typed.
 */
const stringParser: Parser<string> = map(
    seq(lit('"'), pattern(/(?:\\.|[^"\\])*/, 'a string body'), lit('"')),
    ([, body]) => (body as string).replace(/\\(["\\])/g, '$1'),
)

const boolParser: Parser<boolean> = map(alt(keyword('true'), keyword('false')), (text) => text.toLowerCase() === 'true')

const nullParser: Parser<null> = map(keyword('null'), () => null)

/** `#` then anything that is not punctuation or space, which is what makes `#a/b/c` one tag. */
const tagParser: Parser<string> = map(
    seq(lit('#'), pattern(/[^\s\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\]*/)),
    ([, rest]) => `#${rest as string}`,
)

const identifierParser: Parser<string> = pattern(/(?:\p{Letter}|[\p{Emoji_Presentation}\p{Extended_Pictographic}])[0-9\p{Letter}_-]*/u, 'a name')

/** The inside of `[[…]]`: an unescaped `|` splits the target from its display text. */
export function parseInnerLink(raw: string): DvLink {
    let pipe = -1
    while ((pipe = raw.indexOf('|', pipe + 1)) >= 0) {
        if (pipe > 0 && raw[pipe - 1] === '\\') continue
        return DvLink.infer(raw.slice(0, pipe).replace(/\\\|/g, '|'), false, raw.slice(pipe + 1))
    }
    return DvLink.infer(raw.replace(/\\\|/g, '|'))
}

const linkParser: Parser<DvLink> = map(pattern(/\[\[[^[\]\n]*\]\]/, 'a link'), (text) => parseInnerLink(text.slice(2, -2)))

const embedLinkParser: Parser<DvLink> = map(seq(optional(lit('!')), linkParser), ([bang, link]) => {
    const typed = link as DvLink
    if (bang) typed.embed = true
    return typed
})

const dateShorthandParser: Parser<Date> = (input, pos, ctx) => {
    for (const key of DATE_SHORTHAND_KEYS) {
        const state = keyword(key)(input, pos, ctx)
        if (state.ok) return { ok: true, pos: state.pos, value: DATE_SHORTHANDS[key]!(new Date()) }
    }
    return { ok: false, pos, expected: 'a date shorthand' }
}

/** `YYYY-MM[-DD[T HH:mm[:ss[.ms]]]]` with an optional `Z` or `±H[H][:mm]` offset. */
export const dateParser: Parser<Date> = map(
    pattern(/\d{4}-\d{2}(?:-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{1,2}(?::?\d{2})?)?)?)?/, 'a date'),
    (text) => buildDate(text),
)

export function buildDate(text: string): Date {
    // The offset is read inside the time group, so `1984-08-15` cannot be mis-read as a `-15` zone.
    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{1,2}(?::?\d{2})?)?)?/.exec(text)
    if (!match) return new Date(NaN)
    const numeric = (value: string | undefined, fallback = 0) => (value === undefined || value === '' ? fallback : Number.parseInt(value, 10))
    const [, year, month, day, hour, minute, second, ms, zone] = match
    if (zone) {
        const shift = zone === 'Z' ? 0 : zoneMinutes(zone)
        return new Date(Date.UTC(numeric(year), numeric(month, 1) - 1, numeric(day, 1), numeric(hour), numeric(minute) - shift, numeric(second), numeric(ms)))
    }
    return new Date(numeric(year), numeric(month, 1) - 1, numeric(day, 1), numeric(hour), numeric(minute), numeric(second), numeric(ms))
}

function zoneMinutes(zone: string): number {
    const match = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(zone)
    if (!match) return 0
    const minutes = Number.parseInt(match[2]!, 10) * 60 + Number.parseInt(match[3] ?? '0', 10)
    return match[1] === '-' ? -minutes : minutes
}

const datePlusParser: Parser<Date> = alt<Date>(dateShorthandParser, dateParser)

/**
 * No boundary assertion after a unit: `4hr2min` is two runs with nothing between them, and the keys
 * are ordered longest-first, so `minutes` can never be read as `min` plus leftovers.
 */
const durationUnitParser: Parser<{ amount: number; units: DvDuration }> = map(
    seq(numberParser, ws, pattern(new RegExp(`(?:${DURATION_UNIT_KEYS.join('|')})`, 'u'), 'a duration unit')),
    ([amount, , name]) => ({ amount: amount as number, units: new DvDuration(DURATION_UNITS[name as string]) }),
)

/** `4hr2min`, `2 days, 3 hours` — repeated unit runs added together. */
export const durationParser: Parser<DvDuration> = map(
    sepBy1(durationUnitParser, alt(trimmed(lit(','), ws), ws)),
    (parts) => parts.reduce((total, part) => total.plus(part.units.scale(part.amount)), new DvDuration()),
)

const dateCallParser: Parser<Date> = map(seq(keyword('date'), lit('('), ws, datePlusParser, ws, lit(')')), ([, , , value]) => value)
const durationCallParser: Parser<DvDuration> = map(seq(keyword('dur'), lit('('), ws, durationParser, ws, lit(')')), ([, , , value]) => value)

const listParser: Parser<Field> = map(
    seq(lit('['), ws, sepBy(lazy(() => fieldParser), trimmed(lit(','), ws)), ws, lit(']')),
    ([, , values]) => Fields.list(values),
)

const objectEntryParser: Parser<[string, Field]> = map(
    seq(alt(identifierParser, stringParser), trimmed(lit(':'), ws), lazy(() => fieldParser)),
    ([name, , value]) => [name as string, value as Field],
)

const objectParser: Parser<Field> = map(
    seq(lit('{'), ws, sepBy(objectEntryParser, trimmed(lit(','), ws)), ws, lit('}')),
    ([, , entries]) => {
        const values: Record<string, Field> = {}
        for (const [name, value] of entries as [string, Field][]) values[name] = value
        return Fields.object(values)
    },
)

const lambdaParser: Parser<Field> = map(
    seq(lit('('), ws, sepBy(identifierParser, trimmed(lit(','), ws)), ws, lit(')'), ws, lit('=>'), ws, lazy(() => fieldParser)),
    ([, , params, , , , , , body]) => Fields.lambda(params, body),
)

const parensParser: Parser<Field> = map(seq(lit('('), ws, lazy(() => fieldParser), ws, lit(')')), ([, , value]) => value)

/** A reserved word is a parse failure rather than an exception, so the alternatives can back off. */
const variableParser: Parser<Field> = (input, pos, ctx) => {
    const state = identifierParser(input, pos, ctx)
    if (!state.ok) return state
    const name = state.value as string
    if (KEYWORDS.includes(name.toUpperCase())) return { ok: false, pos, expected: `a name that is not ${name}` }
    return { ok: true, pos: state.pos, value: Fields.variable(name) }
}

const atomParser: Parser<Field> = alt<Field>(
    map(embedLinkParser, (link) => Fields.literal(link)),
    map(seq(lit('!'), lazy(() => indexParser)), ([, child]) => Fields.negated(child as Field)),
    map(linkParser, (link) => Fields.literal(link)),
    listParser,
    objectParser,
    lambdaParser,
    parensParser,
    map(boolParser, (value) => Fields.literal(value)),
    map(dateCallParser, (value) => Fields.literal(value)),
    map(durationCallParser, (value) => Fields.literal(value)),
    map(nullParser, () => NULL_FIELD),
    map(numberParser, (value) => Fields.literal(value)),
    map(stringParser, (value) => Fields.literal(value)),
    variableParser,
)

type Postfix = { kind: 'dot'; name: string } | { kind: 'index'; field: Field } | { kind: 'call'; args: Field[] }

const dotPostfix: Parser<Postfix> = map(seq(trimmed(lit('.'), ws), identifierParser), ([, name]) => ({ kind: 'dot', name: name as string }))
const indexPostfix: Parser<Postfix> = map(seq(trimmed(lit('['), ws), lazy(() => fieldParser), trimmed(lit(']'), ws)), ([, field]) => ({ kind: 'index', field: field as Field }))
const callPostfix: Parser<Postfix> = map(
    seq(trimmed(lit('('), ws), sepBy(lazy(() => fieldParser), trimmed(lit(','), ws)), trimmed(lit(')'), ws)),
    ([, args]) => ({ kind: 'call', args: args as Field[] }),
)

/**
 * `x.y.z`, `x[1]`, `f(a)(b)` chain left to right. A dot index becomes a literal field so
 * `file.frontmatter.x` and `file["frontmatter"]["x"]` evaluate identically.
 */
const indexParser: Parser<Field> = map(seq(atomParser, many(alt<Postfix>(dotPostfix, indexPostfix, callPostfix))), ([object, postfixes]) => {
    let result = object as Field
    for (const post of postfixes as Postfix[]) {
        if (post.kind === 'dot') result = Fields.index(result, Fields.literal(post.name))
        else if (post.kind === 'index') result = Fields.index(result, post.field)
        else result = Fields.func(result, post.args)
    }
    return result
})

/**
 * One left-associative precedence level: `child (op child)*` folded to the left, with optional
 * whitespace on both sides of every operator.
 */
function binaryLevel(child: Parser<Field>, operators: Parser<BinaryOp>): Parser<Field> {
    return map(
        seq(child, many(map(seq(ws, operators, ws, child), ([, op, , right]) => [op, right] as [BinaryOp, Field]))),
        ([first, rest]) => {
            let result = first as Field
            for (const [op, right] of rest as [BinaryOp, Field][]) result = Fields.binaryOp(op, result, right)
            return result
        },
    )
}

const mulDivOperators: Parser<BinaryOp> = map(pattern(/\*|\/|%(?![0-9\p{Letter}_-])/u, "'*', '/' or '%'"), (text) => text as BinaryOp)
const addSubOperators: Parser<BinaryOp> = map(pattern(/[+-]/, "'+' or '-'"), (text) => text as BinaryOp)
const compareOperators: Parser<BinaryOp> = map(pattern(/>=|<=|!=|>|<|=/, "a comparison ('=', '!=', '<', '<=', '>', '>=')"), (text) => text as BinaryOp)

/** `and`/`or` as words or symbols, which is the one place a keyword doubles as an operator. */
const booleanOperators: Parser<BinaryOp> = (input, pos, ctx) => {
    const and = keyword('and')(input, pos, ctx)
    if (and.ok) return { ok: true, pos: and.pos, value: '&' as BinaryOp }
    const or = keyword('or')(input, pos, ctx)
    if (or.ok) return { ok: true, pos: or.pos, value: '|' as BinaryOp }
    const symbol = pattern(/[&|]/, "'and' or 'or'")(input, pos, ctx)
    return symbol.ok ? { ok: true, pos: symbol.pos, value: (symbol.value === '&' ? '&' : '|') as BinaryOp } : symbol
}

const fieldParser: Parser<Field> = binaryLevel(
    binaryLevel(
        binaryLevel(
            binaryLevel(indexParser, mulDivOperators),
            addSubOperators,
        ),
        compareOperators,
    ),
    booleanOperators,
)

/**
 * A `FROM` source: a tag, a quoted folder, a link, `csv("…")`, `outgoing(…)` — combined with
 * `and`/`or`/`&`/`|`, negated with `-` or `!`, and grouped with parentheses.
 */
const sourceAtomParser: Parser<Source> = alt<Source>(
    map(seq(lit('('), ws, lazy(() => sourceParser), ws, lit(')')), ([, , value]) => value),
    map(seq(alt(lit('-'), lit('!')), ws, lazy(() => sourceAtomParser)), ([, , child]) => Sources.negate(child)),
    map(seq(keyword('outgoing'), ws, lit('('), ws, linkParser, ws, lit(')')), ([, , , , link]) => Sources.link(link.path, false)),
    map(seq(keyword('csv'), ws, lit('('), ws, stringParser, ws, lit(')')), ([, , , , path]) => Sources.csv(path)),
    map(linkParser, (link) => Sources.link((link as DvLink).path, true)),
    map(stringParser, (path) => Sources.folder(path)),
    map(tagParser, (tag) => Sources.tag(tag)),
)

const sourceOperators: Parser<'&' | '|'> = (input, pos, ctx) => {
    const and = keyword('and')(input, pos, ctx)
    if (and.ok) return { ok: true, pos: and.pos, value: '&' as const }
    const or = keyword('or')(input, pos, ctx)
    if (or.ok) return { ok: true, pos: or.pos, value: '|' as const }
    const symbol = pattern(/[&|]/, "'and' or 'or'")(input, pos, ctx)
    return symbol.ok ? { ok: true, pos: symbol.pos, value: (symbol.value === '&' ? '&' : '|') as '&' | '|' } : symbol
}

const sourceParser: Parser<Source> = map(
    seq(sourceAtomParser, many(map(seq(ws, sourceOperators, ws, sourceAtomParser), ([, op, , right]) => [op, right] as ['&' | '|', Source]))),
    ([first, rest]) => {
        let result = first as Source
        for (const [op, right] of rest as ['&' | '|', Source][]) result = op === '&' ? Sources.and(result, right) : Sources.or(result, right)
        return result
    },
)

/**
 * A standalone expression is written without indent, but a caller that cut it out of a line
 * (`=( x )`, an inline field, a saved query) hands over the whitespace with it, so the entry points
 * trim rather than reject it.
 */
export function parseField(text: string): Field {
    return parseAll(fieldParser, text.trim())
}

export function parseSource(text: string): Source {
    return parseAll(sourceParser, text.trim())
}

/**
 * The value of an inline field (`[key:: value]`). Anything the strict atom grammar rejects stays the
 * raw string, which is what keeps `[author:: John Smith]` a name rather than a failed subtraction.
 */
export function parseInlineValue(text: string): Literal {
    if (text.trim() === '') return null
    try {
        return parseAll(inlineValueParser, text.trim())
    } catch {
        return text
    }
}

const inlineAtomParser: Parser<Literal> = alt<Literal>(
    dateParser,
    map(durationParser, (value) => normalizeDuration(value)),
    stringParser,
    tagParser,
    embedLinkParser,
    boolParser,
    numberParser,
    map(nullParser, () => null),
)

/** A comma run of atoms becomes an array, which is how `[tags:: #a, #b]` holds two tags. */
const inlineValueParser: Parser<Literal> = map(
    seq(inlineAtomParser, many(map(seq(trimmed(lit(','), ws), inlineAtomParser), ([, value]) => value))),
    ([first, rest]) => (rest.length ? [first, ...rest] : first),
)

///////////////////
// Query parsing //
///////////////////

/** `expr AS name`, or a bare expression whose displayed name is the text that produced it. */
const namedFieldParser: Parser<NamedField> = (input, pos, ctx) => {
    const field = trimmed(fieldParser, ws)(input, pos, ctx)
    if (!field.ok) return field
    const as = keyword('AS')(input, field.pos, ctx)
    if (as.ok) {
        const name = trimmed(alt(identifierParser, stringParser), ws)(input, as.pos, ctx)
        return name.ok ? { ok: true, pos: name.pos, value: { name: name.value as string, aliased: true, field: field.value as Field } } : name
    }
    return { ok: true, pos: field.pos, value: { name: collapseWhitespace(input.slice(pos, field.pos)), field: field.value as Field } }
}

/** A field's own text, with the newlines a multi-line expression carries folded away. */
function collapseWhitespace(text: string): string {
    return text.split(/[\r\n]+/).map((line) => line.trim()).join('')
}

const sortFieldParser: Parser<QuerySortBy> = map(
    seq(trimmed(fieldParser, ws), optional(alt(keyword('ascending'), keyword('descending'), keyword('asc'), keyword('desc')))),
    ([field, direction]) => ({
        field: field as Field,
        direction: ((direction as string | undefined) ?? '').toLowerCase().startsWith('desc') ? 'descending' : 'ascending',
    }),
)

const withoutIdParser: Parser<boolean> = map(optional(seq(trimmed(keyword('WITHOUT'), ws), trimmed(keyword('ID'), ws))), (value) => value !== undefined)

/**
 * The words the clause loop owns. A header field must not read `SORT` as a variable, or a query written
 * as `LIST` + newline + `SORT file.name DESC` — the shape the docs use — becomes a parse failure.
 */
const CLAUSE_WORDS = ['FROM', 'WHERE', 'SORT', 'LIMIT', 'GROUP', 'FLATTEN']
const notClauseWord: Parser<true> = (input, pos, ctx) => {
    const word = /^[ \t\r\n]*([A-Za-z]+)/.exec(input.slice(pos))?.[1] ?? ''
    if (CLAUSE_WORDS.includes(word.toUpperCase())) {
        if (ctx.furthest < pos) {
            ctx.furthest = pos
            ctx.expected = new Set(['a field'])
        }
        return { ok: false, pos, expected: 'a field' }
    }
    return { ok: true, pos, value: true }
}

const tableHeaderParser: Parser<QueryHeader> = map(
    seq(keyword('TABLE'), ws, withoutIdParser, optional(seq(notClauseWord, sepBy(namedFieldParser, trimmed(lit(','), ws))))),
    ([, , withoutId, fields]) => ({ type: 'table', fields: ((fields as NamedField[][] | undefined)?.[1] ?? []) as NamedField[], showId: !withoutId }),
)

/**
 * `LIST` takes at most one field, and must not swallow a following comma — the clause loop owns that.
 */
const listHeaderParser: Parser<QueryHeader> = map(
    seq(keyword('LIST'), ws, withoutIdParser, optional(seq(notClauseWord, trimmed(fieldParser, ws)))),
    ([, , withoutId, format]) => ({ type: 'list', format: (format as [true, Field] | undefined)?.[1], showId: !withoutId }),
)

const taskHeaderParser: Parser<QueryHeader> = map(keyword('TASK'), () => ({ type: 'task' }) as QueryHeader)

const calendarHeaderParser: Parser<QueryHeader> = map(
    seq(keyword('CALENDAR'), requiredWhitespace, namedFieldParser),
    ([, , field]) => ({ type: 'calendar', field }),
)

const headerParser: Parser<QueryHeader> = alt<QueryHeader>(tableHeaderParser, listHeaderParser, taskHeaderParser, calendarHeaderParser)

const spacer: Parser<string> = map(many(alt(pattern(/[ \t\r\n]+/, 'whitespace'), comment())), (parts) => parts.join(''))

const fromClause: Parser<Source> = map(seq(keyword('FROM'), requiredWhitespace, sourceParser), ([, , source]) => source)
const whereClause: Parser<QueryOperation> = map(seq(keyword('WHERE'), requiredWhitespace, fieldParser), ([, , clause]) => ({ type: 'where', clause }))
const sortClause: Parser<QueryOperation> = map(seq(keyword('SORT'), requiredWhitespace, sepBy1(sortFieldParser, trimmed(lit(','), ws))), ([, , fields]) => ({ type: 'sort', fields }))
const limitClause: Parser<QueryOperation> = map(seq(keyword('LIMIT'), requiredWhitespace, fieldParser), ([, , amount]) => ({ type: 'limit', amount }))
const flattenClause: Parser<QueryOperation> = map(seq(keyword('FLATTEN'), requiredWhitespace, namedFieldParser), ([, , field]) => ({ type: 'flatten', field }))
const groupClause: Parser<QueryOperation> = map(seq(keyword('GROUP'), requiredWhitespace, keyword('BY'), requiredWhitespace, namedFieldParser), ([, , , , field]) => ({ type: 'group', field }))

const clauseParser: Parser<QueryOperation> = alt<QueryOperation>(whereClause, sortClause, limitClause, flattenClause, groupClause)

interface RawQuery {
    header: QueryHeader
    source?: Source
    operations: QueryOperation[]
}

const queryParser: Parser<RawQuery> = map(
    seq(
        trimmed(headerParser, spacer),
        optional(trimmed(fromClause, spacer)),
        many(trimmed(clauseParser, spacer)),
    ),
    ([header, source, operations]) => ({ header: header as QueryHeader, source: source as Source | undefined, operations: operations as QueryOperation[] }),
)

/** Parse a full DQL query; a missing `FROM` means every note, which is `Sources.everything()`. */
export function parseQuery(text: string): Query {
    const raw = parseAll(queryParser, text, spacer)
    return { header: raw.header, source: raw.source ?? Sources.everything(), operations: raw.operations }
}

export { fieldParser, sourceParser, namedFieldParser, clauseParser, queryParser, tagParser, linkParser, stringParser, identifierParser, numberParser, boolParser, nullParser }

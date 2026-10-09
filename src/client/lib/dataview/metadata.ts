/**
 * Turn one note into the page metadata a Dataview query reads.
 *
 * The reference project gets its structure for free from Obsidian's cache API (sections, list items,
 * headings, frontmatter links). This app has no such cache — a note is a title, a folder id, a tag
 * list, timestamps and a Markdown string — so the structure is scanned here, line by line, once per
 * note and then kept in the index. The scan is deliberately cheap: a list-item regex, a heading regex,
 * and inline fields split on `::`, which is what the reference does too.
 *
 * Paths are a real question: a note here has no filename. The path is built as
 * `<folder path>/<Title>.md`, which makes `FROM "Reading"` and `file.path` mean what a reader with
 * folders expects, and makes two notes of the same title in different folders distinct.
 */

import { extractTags, parseFrontMatter } from '@shared/markdown-utils'
import { DvLink, Values, type DataObject, type Literal } from './value'
import { buildDate, normalizeDuration, parseInlineValue, stripTime } from './expression'

/** One `- [ ]` / `1. ` / `* ` line, with its children, its fields and the section it sits under. */
export interface ListItemData {
    symbol: string
    text: string
    /** Zero-based line in the whole note, front matter included, so it matches `data-line`. */
    line: number
    lineCount: number
    /** Column offset of the bullet, which is what rebuilds the list tree. */
    indent: number
    tags: string[]
    links: DvLink[]
    /** The heading-linked section, or the file when the item is above the first heading. */
    section: DvLink
    /** `^block-id` when the author wrote one, which is what a task link points at. */
    blockId: string | null
    link: DvLink
    children: number[]
    parent: number | null
    task: { status: string; completed: boolean; fullyCompleted: boolean } | null
    fields: Map<string, Literal[]>
}

export interface HeadingData {
    level: number
    text: string
    line: number
}

/** Everything the index knows about one note. */
export interface PageMetadata {
    noteId: string
    path: string
    name: string
    folder: string
    frontmatter: DataObject
    fields: Map<string, Literal>
    tags: Set<string>
    aliases: Set<string>
    links: DvLink[]
    lists: ListItemData[]
    headings: HeadingData[]
    ctime: Date
    mtime: Date
    size: number
    day: Date | null
    starred: boolean
    pinned: boolean
    archived: boolean
    wordCount: number
}

const LIST_ITEM_RE = /^[ \t]*(?:>\s*)*(?:(\d+)[.)]|([-+*]))\s+(\[([^\]])\])?\s?(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BLOCK_ID_RE = /(?:^|\s)\^([\w-]+)\s*$/
const FENCE_RE = /^[ \t]{0,3}(?:```|~~~)/
const WIKI_RE = /(!?)\[\[([^[\]|\n]{1,400})(?:\|([^[\]\n]{0,200}))?\]\]/g
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g

/**
 * Emoji shorthand dates on a task line (the Tasks-plugin convention Dataview reads), which become
 * fields the same way `[due:: …]` does. Written as escapes so the source stays free of Han/punctuation
 * surprises and the i18n gate has nothing to flag.
 */
const TASK_EMOJI_FIELDS: Array<{ regex: RegExp; key: string }> = [
    { regex: /✕\s*(\d{4}-\d{2}-\d{2})/, key: 'created' },
    { regex: /🛫\s*(\d{4}-\d{2}-\d{2})/, key: 'start' },
    { regex: /[⌛⌚]\s*(\d{4}-\d{2}-\d{2})/, key: 'scheduled' },
    { regex: /[📅📆🗓]️?\s*(\d{4}-\d{2}-\d{2})/, key: 'due' },
    { regex: /✅\s*(\d{4}-\d{2}-\d{2})/, key: 'completion' },
]

export interface InlineFieldHit {
    key: string
    value: string
    start: number
    end: number
    wrapping: string | null
}

const WRAPPERS: Record<string, string> = { '[': ']', '(': ')' }

/**
 * Inline fields of the form `[key:: value]` or `(key:: value)`, plus the special task emoji dates.
 * Scanning is positional rather than one regex: the wrapper body may contain nested brackets, links
 * and escaped characters, and Markdown around the field is not balanced.
 */
export function extractInlineFields(line: string, includeTaskEmoji = false): InlineFieldHit[] {
    const found: InlineFieldHit[] = []
    for (const open of Object.keys(WRAPPERS)) {
        let cursor = line.indexOf(open)
        while (cursor >= 0) {
            const hit = readWrappedField(line, cursor, open)
            if (!hit) {
                cursor = line.indexOf(open, cursor + 1)
                continue
            }
            found.push(hit)
            cursor = line.indexOf(open, hit.end)
        }
    }
    if (includeTaskEmoji) {
        for (const { regex, key } of TASK_EMOJI_FIELDS) {
            const match = regex.exec(line)
            if (!match || match.index < 0) continue
            found.push({ key, value: match[1]!, start: match.index, end: match.index + match[0].length, wrapping: 'emoji-shorthand' })
        }
    }
    found.sort((one, other) => one.start - other.start)
    const kept: InlineFieldHit[] = []
    for (const hit of found) {
        if (!kept.length || kept[kept.length - 1]!.end < hit.start) kept.push(hit)
    }
    return kept
}

function readWrappedField(line: string, start: number, open: string): InlineFieldHit | null {
    const close = WRAPPERS[open]!
    const separator = line.indexOf('::', start + 1)
    if (separator < 0) return null
    const key = line.slice(start + 1, separator).trim()
    for (const char of Object.keys(WRAPPERS).concat(Object.values(WRAPPERS))) {
        if (key.includes(char)) return null
    }
    let nesting = 0
    let escaped = false
    for (let index = separator + 2; index < line.length; index++) {
        const char = line[index]
        if (escaped) {
            escaped = false
            continue
        }
        if (char === '\\') {
            escaped = true
            continue
        }
        if (char === open) nesting += 1
        else if (char === close) {
            nesting -= 1
            if (nesting < 0) {
                return { key, value: line.slice(separator + 2, index).trim(), start, end: index + 1, wrapping: open }
            }
        }
    }
    return null
}

/**
 * A `Key:: Value` line that consumes the whole line. The key drops the Markdown that introduced it
 * (`**Daily**:: x` is `Daily`) and must survive as a word, or a table row `| a | b |` would read as a
 * field named `| a | b |`.
 */
export function extractFullLineField(text: string): InlineFieldHit | null {
    const separator = text.indexOf('::')
    if (separator < 0) return null
    const key = /^[^\p{Letter}\p{Number}]*(\S[^:]*)/u.exec(text.slice(0, separator))?.[1]?.replace(/[*_~`\s]+$/g, '').trim() ?? ''
    if (!key || !/\p{Letter}|\p{Number}/u.test(key)) return null
    return { key, value: text.slice(separator + 2).trim(), start: 0, end: text.length, wrapping: null }
}

/** `Some  Key` and `Some*Key*` address the same field as `Some Key`. */
/** A tag name is stored without its `#` in this app, and written with one in a note. */
export function normalizeTag(tag: string): string {
    return tag.startsWith('#') ? tag : `#${tag}`
}

export function canonicalizeVarName(name: string): string {
    return name.replace(/[*_~`]/g, '').split(/\s+/).join(' ').trim()
}

function addField(target: Map<string, Literal[]>, key: string, value: Literal): void {
    const existing = target.get(key)
    if (existing) existing.push(value)
    else target.set(key, [value])
}

function mergeFieldGroups(target: Map<string, Literal[]>, source: Map<string, Literal[]>): void {
    for (const [key, values] of source) {
        const existing = target.get(key)
        target.set(key, existing ? existing.concat(values) : [...values])
    }
}

/** One value per key, unless the key was written several times — then a list. */
function finalizeFields(fields: Map<string, Literal[]>): Map<string, Literal> {
    const normalized = new Map<string, Literal[]>()
    for (const [key, values] of fields) {
        const normKey = canonicalizeVarName(key)
        if (!normKey || normKey === key || fields.has(normKey)) continue
        const existing = normalized.get(normKey)
        normalized.set(normKey, existing ? existing.concat(values) : [...values])
    }
    const interim = new Map<string, Literal[]>()
    mergeFieldGroups(interim, fields)
    mergeFieldGroups(interim, normalized)
    const result = new Map<string, Literal>()
    for (const [key, values] of interim) result.set(key, values.length === 1 ? values[0]! : values)
    return result
}

/**
 * YAML hands back strings, numbers, booleans, dates, arrays and objects. A string that *looks* like a
 * date, a duration or a link is converted, which is what lets a `due: 2024-05-01` property be compared
 * against `today`.
 */
export function parseFrontmatterValue(value: unknown): Literal {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())
    if (Array.isArray(value)) return value.map((item) => parseFrontmatterValue(item))
    if (typeof value === 'object') {
        const result: DataObject = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = parseFrontmatterValue(item)
        return result
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value !== 'string') return null
    if (/^\d{4}-\d{2}(-\d{2}([T ].*)?)?$/.test(value)) {
        const date = buildDate(value)
        if (date && !Number.isNaN(date.getTime())) return date
    }
    const inline = parseInlineValue(value)
    if (Values.isDuration(inline)) return normalizeDuration(inline)
    if (Values.isLink(inline) && /^!?\[\[/.test(value)) return inline
    return value
}

/** `2024-05-01` anywhere in a path names the day that path is about. */
export function extractDate(text: string): Date | null {
    const match = /(\d{4})-(\d{2})-(\d{2})/.exec(text) ?? /(\d{4})(\d{2})(\d{2})/.exec(text)
    if (!match) return null
    const date = new Date(Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10) - 1, Number.parseInt(match[3]!, 10))
    return Number.isNaN(date.getTime()) ? null : date
}

export function extractSubtags(tag: string): string[] {
    const result = [tag]
    let cursor = tag
    while (cursor.includes('/')) {
        cursor = cursor.slice(0, cursor.lastIndexOf('/'))
        result.push(cursor)
    }
    return result
}

export interface NoteInput {
    id: string
    title: string
    content: string
    /** The folder chain joined with `/`, or `''` for the unfiled root. */
    folder: string
    tags: readonly string[]
    createdAt: number
    updatedAt: number
    charCount: number
    wordCount: number
    starred: boolean
    pinned: boolean
    archived: boolean
}

/** The path a note answers to in a query: `Folder/Sub/Title.md`. */
export function pathOfNote(input: Pick<NoteInput, 'title' | 'folder'>): string {
    const name = `${input.title || 'Untitled'}.md`
    return input.folder ? `${input.folder.replace(/\/+$/, '')}/${name}` : name
}

/** Parse one note into the metadata a query reads. */
export function parseNote(input: NoteInput): PageMetadata {
    const path = pathOfNote(input)
    const front = parseFrontMatter(input.content)
    const body = front.body
    const bodyLines = body.split(/\r?\n/)
    const offset = front.lineOffset

    const frontmatter: DataObject = {}
    for (const [key, value] of Object.entries(front.data)) {
        if (key === 'position') continue
        frontmatter[key] = parseFrontmatterValue(value)
    }

    const tags = new Set<string>()
    for (const tag of input.tags) tags.add(normalizeTag(tag))
    // The front matter list is the tag source a reader writes as `tags: [a, b]`; a body scan never
    // sees it, and the reference project takes it from Obsidian's frontmatter cache instead.
    for (const tag of frontmatterList(front.data, ['tag', 'tags'])) tags.add(normalizeTag(tag))
    for (const tag of extractTags(body)) tags.add(normalizeTag(tag))

    const aliases = new Set<string>(frontmatterList(front.data, ['alias', 'aliases']))

    const fields = new Map<string, Literal[]>()
    for (const [key, value] of Object.entries(frontmatter)) addField(fields, key, value)

    const links: DvLink[] = []
    for (const match of front.raw.matchAll(WIKI_RE)) {
        links.push(DvLink.infer(match[2]!.trim(), match[1] === '!', match[3]?.trim() || null))
    }
    const linksByLine = new Map<number, DvLink[]>()
    collectBodyLinks(bodyLines, links, linksByLine, offset)

    const headings = scanHeadings(bodyLines, offset)
    const { lists, listFields } = scanLists(bodyLines, offset, headings, linksByLine, path)
    mergeFieldGroups(fields, listFields)
    collectParagraphFields(bodyLines, lists, offset, fields)

    return {
        noteId: input.id,
        path,
        name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, ''),
        folder: input.folder,
        frontmatter,
        fields: finalizeFields(fields),
        tags,
        aliases,
        links,
        lists,
        headings,
        ctime: new Date(input.createdAt),
        mtime: new Date(input.updatedAt),
        size: input.charCount,
        day: findDay(path, fields),
        starred: input.starred,
        pinned: input.pinned,
        archived: input.archived,
        wordCount: input.wordCount,
    }
}

/** A frontmatter `tags:`/`aliases:` value may be a list, a comma string, or a bare scalar. */
export function frontmatterList(data: Record<string, unknown>, keys: readonly string[]): string[] {
    const out: string[] = []
    for (const [key, value] of Object.entries(data)) {
        if (!keys.includes(key.toLowerCase())) continue
        for (const item of splitList(value)) out.push(item)
    }
    return out.filter((item) => item.length > 0)
}

function splitList(value: unknown): string[] {
    if (value === null || value === undefined) return []
    if (Array.isArray(value)) return value.flatMap((item) => splitList(item))
    return String(value).split(/[,\uFF0C\u3001]+/).map((item) => item.trim()).filter((item) => item.length > 0)
}

function collectBodyLinks(lines: string[], links: DvLink[], byLine: Map<number, DvLink[]>, offset: number): void {
    let inFence = false
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!
        if (FENCE_RE.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        const found: DvLink[] = []
        for (const match of line.matchAll(WIKI_RE)) {
            found.push(DvLink.infer(match[2]!.trim(), match[1] === '!', match[3]?.trim() || null))
        }
        for (const match of line.matchAll(MARKDOWN_LINK_RE)) {
            const target = match[2]!.trim()
            if (!target || /^(?:https?:|mailto:|data:|\/\/)/.test(target)) continue
            found.push(DvLink.infer(target.replace(/\.md$/i, ''), false, match[1] || null))
        }
        if (!found.length) continue
        for (const link of found) links.push(link)
        byLine.set(index + offset, [...(byLine.get(index + offset) ?? []), ...found])
    }
}

function scanHeadings(lines: string[], offset: number): HeadingData[] {
    const out: HeadingData[] = []
    let inFence = false
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!
        if (FENCE_RE.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        const match = HEADING_RE.exec(line)
        if (!match) continue
        out.push({ level: match[1]!.length, text: match[2]!.trim(), line: index + offset })
    }
    return out
}

function previousHeading(headings: HeadingData[], line: number): string | null {
    let best: HeadingData | null = null
    for (const heading of headings) {
        if (heading.line > line) break
        best = heading
    }
    return best?.text ?? null
}

/**
 * List items and tasks with parents, children, block ids and inline fields. A wrapped item keeps its
 * continuation lines in `text`, and `lineCount` tells the paragraph pass which lines are already taken.
 */
function scanLists(
    lines: string[],
    offset: number,
    headings: HeadingData[],
    linksByLine: Map<number, DvLink[]>,
    path: string,
): { lists: ListItemData[]; listFields: Map<string, Literal[]> } {
    const byLine = new Map<number, ListItemData>()
    const order: ListItemData[] = []
    const literalFields = new Map<string, Literal[]>()
    let inFence = false

    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index]!
        if (FENCE_RE.test(raw)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        const match = LIST_ITEM_RE.exec(raw)
        if (!match) continue

        const line = index + offset
        const symbol = match[1] ?? match[2] ?? '-'
        const status = match[4] ?? null
        const parts: string[] = [match[5] ?? '']
        let extra = index + 1
        for (; extra < lines.length; extra++) {
            const next = lines[extra]!
            if (!next.trim() || LIST_ITEM_RE.test(next) || FENCE_RE.test(next) || HEADING_RE.test(next)) break
            if (!/^\s{2,}\S/.test(next)) break
            parts.push(next.trim())
        }
        const flat = parts.join(' ')
        const sectionTitle = previousHeading(headings, line)
        const section = sectionTitle === null ? DvLink.file(path) : DvLink.header(path, sectionTitle)
        const blockId = BLOCK_ID_RE.exec(match[5] ?? '')?.[1] ?? null

        const item: ListItemData = {
            symbol,
            text: parts.join('\n'),
            line,
            lineCount: extra - index,
            indent: /^[ \t]*/.exec(raw)![0].length,
            tags: extractTags(flat).map(normalizeTag),
            links: linksByLine.get(line) ?? [],
            section,
            blockId,
            link: blockId ? DvLink.block(path, blockId) : section,
            children: [],
            parent: null,
            task: status === null ? null : { status, completed: status !== ' ', fullyCompleted: status === 'x' || status === 'X' },
            fields: new Map(),
        }

        for (const hit of extractInlineFields(flat, true)) addField(item.fields, hit.key, parseInlineValue(hit.value))
        if (item.task === null && item.fields.size === 0) {
            const fullLine = extractFullLineField(flat)
            if (fullLine) addField(item.fields, fullLine.key, parseInlineValue(fullLine.value))
        }

        byLine.set(line, item)
        order.push(item)
        index = extra - 1
    }

    for (const item of order) {
        const parent = findParent(byLine, item)
        if (parent) {
            item.parent = parent.line
            parent.children.push(item.line)
        }
        // A plain list item's fields belong to the page; a task's stay with the task.
        if (!item.task) mergeFieldGroups(literalFields, item.fields)
        if (item.task) {
            let cursor: ListItemData | undefined = item
            while (cursor) {
                if (cursor.task) cursor.task.fullyCompleted = cursor.task.fullyCompleted && item.task.completed
                cursor = cursor.parent === null ? undefined : byLine.get(cursor.parent)
            }
        }
    }

    return { lists: order, listFields: literalFields }
}

/** The closest earlier item indented strictly less than this one — the list tree, rebuilt from columns. */
function findParent(byLine: Map<number, ListItemData>, item: ListItemData): ListItemData | null {
    let candidate: ListItemData | null = null
    for (const [otherLine, other] of byLine) {
        if (otherLine >= item.line) continue
        if (other.indent >= item.indent) continue
        if (!candidate || otherLine > candidate.line) candidate = other
    }
    return candidate
}

/** Inline fields in prose: every line outside a list item that carries a `::`. */
function collectParagraphFields(lines: string[], lists: ListItemData[], offset: number, fields: Map<string, Literal[]>): void {
    const claimed = new Set<number>()
    for (const item of lists) {
        for (let index = 0; index < item.lineCount; index++) claimed.add(item.line + index)
    }
    let inFence = false
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!
        if (FENCE_RE.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        if (claimed.has(index + offset)) continue
        if (!line.includes('::') || line.length > 32_768) continue
        const trimmed = line.trim().replace(/^[#>*\s-]+/, '')
        const hits = extractInlineFields(trimmed)
        if (hits.length) {
            for (const hit of hits) addField(fields, hit.key, parseInlineValue(hit.value))
            continue
        }
        const fullLine = extractFullLineField(trimmed)
        if (fullLine) addField(fields, fullLine.key, parseInlineValue(fullLine.value))
    }
}

/** The day a note is *about*: an explicit `day`/`date` field, else a date in its title. */
function findDay(path: string, fields: Map<string, Literal[]>): Date | null {
    for (const [key, values] of fields) {
        const lower = key.toLowerCase()
        if (lower !== 'day' && lower !== 'date') continue
        for (const value of values) {
            if (Values.isDate(value)) return value
            if (Values.isArray(value) && value.length > 0 && Values.isDate(value[0])) return value[0] as Date
            if (Values.isLink(value)) {
                const fromLink = extractDate(value.path) ?? extractDate(value.subpath ?? '') ?? extractDate(value.display ?? '')
                if (fromLink) return fromLink
            }
            if (Values.isString(value)) {
                const fromText = extractDate(value)
                if (fromText) return fromText
            }
        }
    }
    return extractDate(path.slice(path.lastIndexOf('/') + 1))
}

function distinctFileLinks(links: DvLink[]): DvLink[] {
    const seen = new Map<string, DvLink>()
    for (const link of links) {
        const key = `${link.path.toLocaleLowerCase()}\u0000${link.subpath ?? ''}`
        if (!seen.has(key)) seen.set(key, new DvLink(link.path, 'file', link.subpath, link.display, link.embed))
    }
    return [...seen.values()]
}

function serializeListItem(item: ListItemData, page: PageMetadata, cache: Map<number, DataObject>): DataObject {
    const out: DataObject = {
        text: item.text,
        task: item.task !== null,
        status: item.task?.status ?? item.symbol,
        completed: item.task?.completed ?? false,
        fullyCompleted: item.task?.fullyCompleted ?? false,
        link: item.link,
        line: item.line,
        lineCount: item.lineCount,
        section: item.section,
        parent: item.parent,
        children: item.children.map((line) => cache.get(line)).filter((value): value is DataObject => value !== undefined),
        tags: item.tags,
        outgoing: item.links,
        path: page.path,
    }
    if (item.blockId) out.id = item.blockId
    for (const [key, values] of item.fields) out[key] = values.length === 1 ? values[0]! : values
    return out
}

/**
 * The object a query sees for this page: `file.*` for the note itself, then every inline field at the
 * top level. A field never displaces `file`, matching the reference.
 */
export function serializePage(page: PageMetadata, inLinks: DvLink[] = []): DataObject {
    const cache = new Map<number, DataObject>()
    for (const item of page.lists) cache.set(item.line, serializeListItem(item, page, cache))
    const lists = page.lists.map((item) => cache.get(item.line)!)
    const tasks = page.lists.filter((item) => item.task !== null).map((item) => cache.get(item.line)!)

    const file: DataObject = {
        path: page.path,
        name: page.name,
        folder: page.folder,
        link: DvLink.file(page.path),
        outlinks: distinctFileLinks(page.links),
        inlinks: inLinks,
        etags: [...page.tags],
        tags: [...new Set([...page.tags].flatMap((tag) => extractSubtags(tag)))],
        aliases: [...page.aliases],
        lists,
        tasks,
        ctime: page.ctime,
        cday: stripTime(page.ctime),
        mtime: page.mtime,
        mday: stripTime(page.mtime),
        size: page.size,
        starred: page.starred,
        pinned: page.pinned,
        archived: page.archived,
        wordCount: page.wordCount,
        frontmatter: Values.deepCopy(page.frontmatter) as DataObject,
        ext: 'md',
    }
    if (page.day) file.day = page.day

    const result: DataObject = { file }
    for (const [key, value] of page.fields) {
        if (key in result) continue
        result[key] = value
    }
    return result
}

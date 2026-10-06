/**
 * Fence surgery for the block languages that write themselves back into the note: locating the fence a
 * rendered instance came from, and rewriting it without touching a byte outside it.
 *
 * DOM-free and dependency-free on purpose — a chart block resolves its fence against the note's
 * *current* text on every write, so this runs on the preview's hot path and is unit-tested on its own.
 */
export interface FenceTarget {
    /** 0-based line index of the opening fence, matching the renderer's `data-line`. */
    line: number
    /** Fence body, EOL-normalized to `\n`. */
    body: string
}

/** What one action asks of a fence; an omitted field is left exactly as the note has it. */
export interface FencePatch {
    body?: string
    /** Replacement for the opening fence's info string; omitted keeps it. */
    info?: string
}

interface FenceOpening {
    indent: string
    marker: string
    length: number
    info: string
}

interface FenceLocation {
    line: number
    closing: number
    opening: FenceOpening
}

export function splitLines(content: string): { lines: string[], eol: string, trailingNewline: boolean } {
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const trailingNewline = /\r?\n$/.test(content)
    const lines = content.split(/\r?\n/)
    if (trailingNewline && lines[lines.length - 1] === '')
        lines.pop()
    return { lines, eol, trailingNewline }
}

export function joinLines(lines: string[], eol: string, trailingNewline: boolean): string {
    return `${lines.join(eol)}${trailingNewline && lines.length > 0 ? eol : ''}`
}

/** Fence bodies reach us from markdown-it (which keeps the document's EOLs) and from our own serializers (LF). */
export function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, '\n')
}

function isRecordedLanguage(info: string, languages: readonly string[]): boolean {
    const language = /^([A-Za-z0-9_-]+)/.exec(info.trim())?.[1]?.toLowerCase() ?? ''
    return (languages as readonly string[]).includes(language)
}

function parseFenceOpening(line: string, languages: readonly string[]): FenceOpening | null {
    const match = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*)$/.exec(line)
    if (!match)
        return null
    const info = match[3]!
    if (languages.length > 0 && !isRecordedLanguage(info, languages))
        return null
    return { indent: match[1]!, marker: match[2]!.charAt(0), length: match[2]!.length, info }
}

function isClosingFence(line: string, marker: string, minLength: number): boolean {
    const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line)
    if (!match)
        return false
    return match[2]!.charAt(0) === marker && match[2]!.length >= minLength
}

function findClosingLine(lines: string[], line: number, opening: FenceOpening): number {
    for (let index = line + 1; index < lines.length; index++) {
        if (isClosingFence(lines[index]!, opening.marker, opening.length))
            return index
    }
    return -1
}

/**
 * The body as markdown-it would hand it over: a fence indented inside a list item or a blockquote
 * de-indents its content by the fence's own run of spaces, and the block compares this against what the
 * renderer encoded. Without the strip the two disagree for every indented fence and the block declines to
 * write a note it is looking straight at.
 */
function fenceBody(lines: string[], line: number, closing: number, indent: number): string {
    const strip = (text: string) => {
        const leading = /^ {1,3}/.exec(text)?.[0].length ?? 0;
        return text.slice(Math.min(leading, indent));
    };
    return normalizeEol(lines.slice(line + 1, closing === -1 ? lines.length : closing).map(strip).join('\n'));
}

/** The run length a body line would need before it could close the surrounding fence. */
function widestBodyFenceRun(body: string, marker: string): number {
    let widest = 0
    for (const line of body.split('\n')) {
        const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
        if (match && match[1]!.charAt(0) === marker)
            widest = Math.max(widest, match[1]!.length)
    }
    return widest
}

function buildFenceLines(opening: FenceOpening, lines: string[], closing: number, nextBody: string): string[] {
    const length = Math.max(opening.length, widestBodyFenceRun(nextBody, opening.marker) + 1)
    const marker = opening.marker.repeat(length)
    const head = `${opening.indent}${marker}${opening.info}`
    const keepClosing = closing !== -1 && lines[closing]!.length >= length && isClosingFence(lines[closing]!, opening.marker, length)
    const tail = keepClosing ? lines[closing]! : `${opening.indent}${marker}`
    // The body goes back at the fence's own indentation, which is where it was read from: a block inside
    // a list item has to stay inside it, and a body line at column zero would end the list around it.
    const body = nextBody.length > 0
        ? nextBody.split('\n').map((text) => (text.length > 0 ? `${opening.indent}${text}` : text))
        : []
    return [head, ...body, tail]
}

/**
 * Where the fence is *now*. The recorded line is tried first; when the fence moved (someone edited
 * above it) the single fence whose body still matches `target.body` is the one. Returns null when
 * neither holds — guessing would overwrite whatever the user typed since the block was rendered, so
 * every caller must then decline to write.
 */
function locateFence(lines: string[], target: FenceTarget, languages: readonly string[]): FenceLocation | null {
    const expectedBody = normalizeEol(target.body)
    const matchAt = (line: number): FenceLocation | null => {
        const opening = parseFenceOpening(lines[line] ?? '', languages)
        if (!opening)
            return null
        const closing = findClosingLine(lines, line, opening)
        return fenceBody(lines, line, closing, opening.indent.length) === expectedBody ? { line, closing, opening } : null
    }
    const direct = matchAt(target.line)
    if (direct)
        return direct
    const moved: number[] = []
    for (let index = 0; index < lines.length; index++) {
        if (matchAt(index))
            moved.push(index)
    }
    return moved.length === 1 ? matchAt(moved[0]!) : null
}

/**
 * The fence the renderer drew at `line`, read straight from the note: the opening line is a fence of
 * one of `languages` and the body runs to its closing line. Callers whose markup is known to match this
 * text (the preview only writes while the rendered document and the note agree) use it instead of
 * comparing a body, which would have to be scraped back out of the DOM.
 */
export function fenceAt(content: string, line: number, languages: readonly string[]): { info: string, body: string } | null {
    const { lines } = splitLines(content)
    const opening = parseFenceOpening(lines[line] ?? '', languages)
    if (!opening)
        return null
    return { info: opening.info, body: fenceBody(lines, line, findClosingLine(lines, line, opening), opening.indent.length) }
}

/**
 * Rewrites one fence, keeping the note's EOL style and every line outside the block byte-identical. A
 * fence is widened when the new body contains a line that would otherwise close it early. Returns null
 * when the fence is no longer where the block last saw it, for the reason given in {@link locateFence}.
 */
export function applyFencePatchAtSource(
    content: string,
    target: FenceTarget,
    patch: FencePatch,
    languages: readonly string[],
): string | null {
    const { lines, eol, trailingNewline } = splitLines(content)
    const at = locateFence(lines, target, languages)
    if (!at)
        return null
    const opening = patch.info === undefined ? at.opening : { ...at.opening, info: patch.info }
    const body = patch.body === undefined ? normalizeEol(target.body) : normalizeEol(patch.body)
    const replaced = buildFenceLines(opening, lines, at.closing, body)
    const next = at.closing === -1
        ? [...lines.slice(0, at.line), ...replaced]
        : [...lines.slice(0, at.line), ...replaced, ...lines.slice(at.closing + 1)]
    return joinLines(next, eol, trailingNewline)
}

export type InkLinkTarget =
    | { kind: 'url'; url: string }
    | { kind: 'note'; note: string }
    | { kind: 'invalid' }

const MAX_LINK_LENGTH = 512
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
const NOTE_LINK = /^\/n\/([^/?#]+)$/
const WIKI_LINK = /^\[\[([^\]]+)\]\]$/

/**
 * Where a selection link points. Only http(s) leaves the app; everything else is either a
 * note id/title or refused. The note branch is resolved against the local notebook, so a
 * value that merely looks like a path cannot become a navigation.
 */
export function classifyInkLink(value: string | null | undefined): InkLinkTarget {
    if (typeof value !== 'string') return { kind: 'invalid' }
    const raw = value.trim()
    if (!raw || raw.length > MAX_LINK_LENGTH || CONTROL_CHARS.test(raw)) return { kind: 'invalid' }
    if (raw.startsWith('//')) return { kind: 'invalid' }
    const scheme = SCHEME.exec(raw)
    if (scheme) {
        const protocol = scheme[1]!.toLowerCase()
        if (protocol !== 'http' && protocol !== 'https') return { kind: 'invalid' }
        try {
            const parsed = new URL(raw)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'invalid' }
            return { kind: 'url', url: parsed.href }
        } catch {
            return { kind: 'invalid' }
        }
    }
    const note = NOTE_LINK.exec(raw)
    if (note) {
        try {
            return { kind: 'note', note: decodeURIComponent(note[1]!) }
        } catch {
            return { kind: 'invalid' }
        }
    }
    const wiki = WIKI_LINK.exec(raw)
    if (wiki) {
        const title = wiki[1]!.split('|')[0]!.trim()
        return title ? { kind: 'note', note: title } : { kind: 'invalid' }
    }
    return { kind: 'note', note: raw }
}

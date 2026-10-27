import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'

export const INK_FILE_EXTENSION = '.ink'

/** A note is an Inkpad drawing when its title ends in the registered extension. */
export function isInkNoteTitle(title: string | null | undefined): boolean {
    return typeof title === 'string' && title.trim().toLowerCase().endsWith(INK_FILE_EXTENSION)
}

/** The smallest valid `.ink` body: a new drawing with no ink and no cards. */
export function createEmptyInkDocument(): string {
    return JSON.stringify({ format: 'inkpad', version: 1, strokes: [], shapes: [], elements: [] })
}

/**
 * A title no other note already holds. The extension stays at the end and the counter goes
 * before it, so `Sketch.ink` becomes `Sketch 2.ink` rather than an ordinary Markdown note.
 */
export function uniqueInkTitle(title: string, existingTitles: Iterable<string>): string {
    const base = title.trim() || 'Ink'
    const taken = new Set<string>()
    for (const existing of existingTitles) taken.add(existing.trim().toLowerCase())
    if (!taken.has(base.toLowerCase())) return truncateText(base, LIMITS.titleMaxLength)
    const hasExtension = base.toLowerCase().endsWith(INK_FILE_EXTENSION)
    const extension = hasExtension ? base.slice(-INK_FILE_EXTENSION.length) : ''
    const head = hasExtension ? base.slice(0, -INK_FILE_EXTENSION.length) : base
    let counter = 2
    for (;;) {
        const suffix = ` ${counter}`
        const room = Math.max(0, LIMITS.titleMaxLength - suffix.length - extension.length)
        const candidate = `${truncateText(head, room)}${suffix}${extension}`
        if (!taken.has(candidate.toLowerCase())) return candidate
        counter += 1
    }
}

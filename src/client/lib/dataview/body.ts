/**
 * The fence-side half of a query block: what the Markdown renderer emits and how the block's own text
 * is found again in the note.
 *
 * The renderer's job here is deliberately small — an empty host that carries the query text — because
 * the answer depends on other notes, and those are behind a store and a throttled endpoint. Everything
 * that can be decided without them is decided here, in a string builder that runs inside the sanitizer
 * pass, so the host survives with its attributes intact and `blocks.ts` fills it in afterwards.
 */

import { decodeDataValue, encodeDataValue, escapeAttr, escapeHtml } from '../markdown/data-attr'
import { t } from '../i18n'

/** A DQL block: `TABLE`, `LIST`, `TASK` or `CALENDAR`, one clause per line. */
export const DATAVIEW_LANGUAGES = ['dataview', 'dv'] as const

/** A DML block, whose body is JavaScript run against the same index inside the worker sandbox. */
export const DATAVIEW_JS_LANGUAGES = ['dataviewjs', 'dvjs', 'dv-js'] as const

export type DataviewMode = 'query' | 'js'

export function dataviewModeOf(language: string): DataviewMode | null {
    if ((DATAVIEW_LANGUAGES as readonly string[]).includes(language)) return 'query'
    if ((DATAVIEW_JS_LANGUAGES as readonly string[]).includes(language)) return 'js'
    return null
}

/** True when a fence line names a Dataview block, used by the editor's own fence readers. */
export function isDataviewLanguage(language: string): boolean {
    return dataviewModeOf(language) !== null
}

/**
 * What a surface that cannot answer shows instead: the query's own text. A share page and a printed
 * sheet must not reach into another reader's notes, and a note card has no room for a table, so both
 * show what was asked rather than a placeholder that never resolves.
 */
export function showDataviewSource(root: ParentNode): void {
    for (const host of root.querySelectorAll<HTMLElement>('[data-dataview]')) {
        if (host.dataset.dataviewShown === 'source') continue
        const source = decodeDataValue(host.dataset.dataview ?? '')
        host.classList.remove('loading')
        host.classList.add('is-source')
        host.setAttribute('aria-busy', 'false')
        const pre = document.createElement('pre')
        pre.className = 'dataview-source'
        pre.textContent = source
        host.replaceChildren(pre)
        host.dataset.dataviewShown = 'source'
    }
}

/**
 * The placeholder markup. `data-line` is how the block finds its fence again when a toolbar writes the
 * note back, and the body rides encoded for the same reason a chart's does — a query's own pipes and
 * quotes would otherwise be read back out of markup the sanitizer has already rewritten.
 */
export function dataviewHostMarkup(mode: DataviewMode, line: string, body: string): string {
    const label = t(mode === 'js' ? 'dataview.js_block' : 'dataview.query_block')
    return [
        `<div class="dataview-block loading"${line} data-dataview="${escapeAttr(encodeDataValue(body))}" data-dataview-mode="${mode}" aria-busy="true">`,
        `<div class="dataview-block-body" data-dataview-body>${escapeHtml(label)}</div>`,
        `</div>`,
    ].join('')
}

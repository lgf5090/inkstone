/**
 * The wiring between the Markdown layer and the query layer: what a fence becomes, what survives the
 * sanitizer, and what the mount pass draws into it.
 *
 * The service is stubbed, so these cases pin the *contract between the modules* — the attribute a
 * placeholder carries, the class a surface that cannot answer must end up with, the fact that a block
 * whose query does not parse says so rather than vanishing. The query semantics are covered by
 * `engine.test.ts` and `evaluate.test.ts`; the value shapes by `render.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../markdown/renderer'
import { enhancePreview } from '../markdown/enhance'
import { dataviewModeOf, showDataviewSource } from './body'
import { resetDataviewMounts } from './blocks'
import { decodeDataValue, encodeDataValue } from '../markdown/data-attr'
import { DEFAULT_QUERY_SETTINGS } from './functions'

const state = vi.hoisted(() => {
    const rail = (name: string, rating: number) => {
        const file: Record<string, unknown> = { name, path: `Reading/${name}.md`, link: { path: `Reading/${name}.md`, kind: 'file' }, mtime: new Date(2024, 4, 6) }
        return {
            id: { path: `Reading/${name}.md`, kind: 'file', subpath: null, display: null, embed: false },
            data: { file, rating },
        }
    }
    const alpha = rail('Alpha', 5)
    const beta = rail('Beta', 6)
    alpha.data.file.tasks = [{ text: 'buy milk', line: 3, path: 'Reading/Alpha.md', completed: false, task: true, status: ' ' }]
    return { alpha, beta, toggles: [] as string[], toggleResult: 'written', rails: [alpha] as unknown[], needBodies: [] as string[], pending: false, parsed: 1, total: 1, jsRuns: 0, batchRuns: 0, jsCodes: [] as string[], inlineJs: false, livePreviewChips: true, jsBlocks: true, railsCalls: 0, version: 0, defer: false, release: null as null | (() => void), liveRefresh: true, refuse: false, loaded: [] as string[], current: null as Record<string, unknown> | null, notify: null as null | (() => void) }
})

vi.mock('./service', () => ({
    querySettings: () => ({ renderNullAs: '—', dateFormat: 'yyyy-MM-dd', datetimeFormat: 'yyyy-MM-dd HH:mm', durationFormat: 'long', locale: 'en-US', tableIdColumnName: 'File', tableGroupColumnName: 'Group', maxRecursiveRenderDepth: 4, showResultCount: false, warnOnEmptyResult: true, allowHtmlInExports: false }),
    dataviewSettings: () => ({
        enabled: true, inlineQueries: true, inlineFields: true, jsBlocks: state.jsBlocks, renderNullAs: '',
        dateFormat: 'yyyy-MM-dd', datetimeFormat: 'yyyy-MM-dd HH:mm', durationFormat: 'long',
        maxRows: 200, bodyLimit: 500, includeArchived: false, showErrorDetails: true, liveRefresh: state.liveRefresh, savedQueries: [],
        inlineJsQueries: state.inlineJs, inlineJsQueryPrefix: '$=', inlineQueriesInCodeblocks: false, prettyInlineFieldsLivePreview: state.livePreviewChips,
    }),
    dataviewIndex: {
        rails: () => {
            state.railsCalls += 1
            return { rails: state.rails, needBodies: state.needBodies, pending: state.pending }
        },
        resolveRails: async () => ({ rails: state.rails, truncated: false }),
        currentData: () => state.current as never,
        load: async (ids: readonly string[]) => {
            state.loaded.push(ids.join(','))
            if (state.refuse) return false
            state.rails = [state.alpha, state.beta]
            state.needBodies = []
            state.pending = false
            state.parsed = 2
            state.version += 1
            return false
        },
        allNoteIds: () => ['a'],
        noteIdForLink: () => 'a',
        noteIdForPath: () => 'a',
        pageOf: () => undefined,
        serialize: () => null,
        sync: () => {},
        get currentVersion() { return state.version },
        getStatus: () => ({ phase: state.parsed < state.total ? 'loading' : 'ready', parsed: state.parsed, total: state.total, truncated: false }),
        subscribe: (listener: () => void) => {
            state.notify = listener
            return () => { state.notify = null }
        },
    },
    startDataview: () => {},
    toggleTask: async (id: string, line: number, text: string, completed: boolean) => {
        state.toggles.push(`${id}:${line}:${text}:${completed}`)
        return state.toggleResult
        },
}))

vi.mock('./js', () => ({
    DV_RUN_TIMEOUT_MS: 2000,
    runDataviewJs: async () => {
        state.jsRuns += 1
        const reply = { nodes: [{ kind: 'text', text: `DML over ${state.rails.length}` }], errorText: '', logs: [], truncated: false, snapshotShort: false, snapshotOwes: state.parsed < state.total }
        if (!state.defer) return reply
        return await new Promise((resolve) => { state.release = () => resolve(reply) })
    },
    renderDvNodes: (nodes: { text: string }[]) => {
        const fragment = document.createDocumentFragment()
        for (const node of nodes) fragment.append(node.text)
        return fragment
    },
    runDataviewJsBatch: async (codes: string[]) => {
        state.batchRuns += 1
        state.jsCodes = codes
        return codes.map((code) => ({ nodes: [{ kind: 'text', text: `ran ${code}` }], errorText: '', logs: [], truncated: false, snapshotShort: false, snapshotOwes: false }))
    },
    dvTruncatedNotice: () => document.createElement('div'),
    dvLogPanel: () => null,
}))

async function host(html: string): Promise<HTMLElement> {
    const root = document.createElement('div')
    root.className = 'ink-prose'
    root.innerHTML = html
    document.body.append(root)
    return root
}

beforeEach(() => {
    document.body.replaceChildren()
    state.current = null
    state.liveRefresh = true
    state.refuse = false
    state.loaded = []
    state.rails = [state.alpha]
    state.needBodies = []
    state.pending = false
    state.parsed = 1
    state.total = 1
    state.version = 0
    state.inlineJs = false
    state.jsCodes = []
    state.batchRuns = 0
    state.livePreviewChips = true
    state.jsBlocks = true
})

describe('the dataview fence', () => {
    it('renders both block languages as an empty host carrying its own body', () => {
        const query = renderMarkdown('```dataview\nLIST\n```').html
        expect(query).toContain('data-dataview=')
        expect(query).toContain('data-dataview-mode="query"')
        expect(query).toContain('dataview-block loading')
        const js = renderMarkdown('```dataviewjs\ndv.header(1, "x")\n```').html
        expect(js).toContain('data-dataview-mode="js"')
    })

    it('keeps a query that contains quotes, pipes and brackets intact through the attribute', () => {
        const source = 'TABLE "a|b" AS "Q \"x\"", file.link\nWHERE contains(text, "]")'
        const html = renderMarkdown('```dataview\n' + source + '\n```').html
        const encoded = /data-dataview="([^"]*)"/.exec(html)?.[1]
        expect(encoded).toBeTruthy()
        // The fence body arrives with the newline that closed it, which the parser skips and a test
        // comparing raw text has to account for.
        expect(decodeDataValue(encoded!)).toBe(source + '\n')
    })

    it('recognizes every language alias and nothing else', () => {
        expect(dataviewModeOf('dataview')).toBe('query')
        expect(dataviewModeOf('dv')).toBe('query')
        expect(dataviewModeOf('dataviewjs')).toBe('js')
        expect(dataviewModeOf('dvjs')).toBe('js')
        expect(dataviewModeOf('js')).toBeNull()
        expect(dataviewModeOf('mermaid')).toBeNull()
    })

    it('survives the sanitizer with the attributes the mount reads', async () => {
        const root = await host(renderMarkdown('```dataview\nLIST\n```').html)
        await enhancePreview(root, {
            math: false, mermaid: false, chart: false, kanban: 'source', mindmap: 'source', dataview: 'live', dark: false,
        })
        const block = root.querySelector('[data-dataview]')
        expect(block?.getAttribute('data-dataview')).toBeTruthy()
        expect(block?.getAttribute('data-dataview-mode')).toBe('query')
    })

    it('shows the query text on a surface that must not answer', async () => {
        const root = await host(renderMarkdown('```dataview\nLIST FROM #x\n```').html)
        await enhancePreview(root, {
            math: false, mermaid: false, chart: false, kanban: 'source', mindmap: 'source', dataview: 'source', dark: false,
        })
        const pre = root.querySelector('.dataview-source')
        expect(pre?.textContent?.trimEnd()).toBe('LIST FROM #x')
        expect(root.querySelector('[data-dataview]')?.classList.contains('is-source')).toBe(true)
        expect(root.querySelector('.loading')).toBeNull()
    })

    it('leaves a live host alone in the enhancement pass, so the mount can fill it', async () => {
        const root = await host(renderMarkdown('```dataview\nLIST\n```').html)
        await enhancePreview(root, {
            math: false, mermaid: false, chart: false, kanban: 'source', mindmap: 'source', dataview: 'live', dark: false,
        })
        expect(root.querySelector('.dataview-source')).toBeNull()
        expect(root.querySelector('[data-dataview]')?.classList.contains('loading')).toBe(true)
    })

    it('is idempotent when the same host is shown source twice', async () => {
        const root = await host(renderMarkdown('```dataview\nLIST\n```').html)
        showDataviewSource(root)
        const first = root.querySelector('.dataview-source')?.textContent
        showDataviewSource(root)
        expect(root.querySelectorAll('.dataview-source')).toHaveLength(1)
        expect(root.querySelector('.dataview-source')?.textContent).toBe(first)
    })

    it('round-trips a body through the data attribute encoding', () => {
        const tricky = 'TABLE "quote\\"" AS "x"\n// a comment\n'
        expect(decodeDataValue(encodeDataValue(tricky))).toBe(tricky)
    })
})

/** Let queued microtasks and timers run, which is what a mounted block needs to settle. */
const settle = async () => {
    for (let round = 0; round < 4; round++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the mount pass', () => {
    it('draws a table into the host and clears the loading state', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataview\nTABLE rating\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        const block = root.querySelector('[data-dataview]')!
        expect(block.classList.contains('loading')).toBe(false)
        expect(block.querySelector('table.dataview-table')).not.toBeNull()
        expect(block.querySelector('thead th')?.textContent).toBe('File')
        expect(block.textContent).toContain('Alpha')
        expect(block.textContent).toContain('5')
    })

    it('answers a $= line through one batch run, in order', async () => {
        state.inlineJs = true
        const { mountDataview } = await import('./blocks')
        const root = await host('<p>$= dv.paragraph("one")</p><p>$= dv.paragraph("two")</p>')
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.jsCodes).toEqual(['dv.paragraph("one")', 'dv.paragraph("two")'])
        expect(state.batchRuns).toBe(1)
        const marks = root.querySelectorAll('.dataview-inline-js')
        expect(marks).toHaveLength(2)
        expect(marks[0]?.textContent).toBe('ran dv.paragraph("one")')
        expect(marks[1]?.textContent).toBe('ran dv.paragraph("two")')
        expect(marks[0]?.classList.contains('loading')).toBe(false)
    })

    it('leaves a $= line as written text while inline script is off', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host('<p>$= dv.paragraph("one")</p>')
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.jsCodes).toEqual([])
        expect(root.querySelector('.dataview-inline-js')).toBeNull()
        expect(root.querySelector('p')?.textContent).toBe('$= dv.paragraph("one")')
    })

    it('reuses the last script batch when a re-render leaves the code alone', async () => {
        state.inlineJs = true
        const { mountDataview } = await import('./blocks')
        const html = '<p>$= dv.paragraph("one")</p>'
        const root = await host(html)
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.batchRuns).toBe(1)
        root.innerHTML = html
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.batchRuns).toBe(1)
        expect(root.querySelector('.dataview-inline-js')?.textContent).toBe('ran dv.paragraph("one")')
        state.version += 1
        root.innerHTML = html
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.batchRuns).toBe(2)
        // Different code on an index that has not moved is still new work.
        root.innerHTML = '<p>$= dv.paragraph("two")</p>'
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.batchRuns).toBe(3)
        expect(root.querySelector('.dataview-inline-js')?.textContent).toBe('ran dv.paragraph("two")')
    })

    it('refuses an inline script line while script blocks are turned off', async () => {
        state.inlineJs = true
        state.jsBlocks = false
        const { mountDataview } = await import('./blocks')
        const root = await host('<p>$= dv.paragraph("one")</p>')
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.batchRuns).toBe(0)
        expect(root.querySelector('.dataview-inline-js')).toBeNull()
        expect(root.querySelector('p')?.textContent).toBe('$= dv.paragraph("one")')
    })

    it('takes the live-preview chip switch on the surface it names', async () => {
        state.livePreviewChips = false
        const { mountDataview } = await import('./blocks')
        const live = await host('<p>Status [state:: shipped].</p>')
        mountDataview(live, { originNoteId: null, editable: false, live: true })
        expect(live.querySelector('.dataview-inline-field')).toBeNull()
        expect(live.querySelector('p')?.textContent).toBe('Status [state:: shipped].')

        const read = await host('<p>Status [state:: shipped].</p>')
        mountDataview(read, { originNoteId: null, editable: false })
        expect(read.querySelector('.dataview-inline-field')?.textContent).toContain('shipped')
    })

    it('takes the source toggle without asking the surface to fold anything', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataview\nTABLE rating\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        const block = root.querySelector('[data-dataview]')!
        const toggle = block.querySelector('[data-dataview-source-toggle]') as HTMLButtonElement
        let folded = 0
        root.addEventListener('click', () => { folded += 1 })
        toggle.click()
        expect(block.querySelector('.dataview-source')?.textContent?.trimEnd()).toBe('TABLE rating')
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
        expect(folded).toBe(0)
        toggle.click()
        expect(block.querySelector('.dataview-source')).toBeNull()
        expect(block.querySelector('table')).not.toBeNull()
    })

    it('reports a query that cannot be read, with the place it stopped', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataview\nTABLE a WHERE\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        const notice = root.querySelector('.dataview-notice.is-error')
        expect(notice).not.toBeNull()
        // The catalog is not loaded in a unit run, so what is pinned is that the parser's own reason
        // reached the notice: a block that only said "failed" would be much harder to act on.
        expect(notice?.querySelector('pre')?.textContent).toContain('Expected')
    })

    it('writes a tick back through the service, and says so when the note moved', async () => {
        const { mountDataview } = await import('./blocks')
        state.toggles = []
        const root = await host(renderMarkdown('```dataview\nTASK\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        const box = root.querySelector('input[data-dataview-task]') as HTMLInputElement
        expect(box).not.toBeNull()
        expect(box.checked).toBe(false)
        box.click()
        await settle()
        expect(state.toggles).toEqual(['a:3:buy milk:true'])
        expect(box.checked).toBe(true)
        state.toggleResult = 'conflict'
        box.click()
        await settle()
        expect(state.toggles.length).toBe(2)
        expect(box.checked).toBe(false)
    })

    it('draws a static mark where the surface cannot write', async () => {
        const { renderResult } = await import('./render')
        const statics = renderResult({ kind: 'task', tasks: [{ task: { text: 'x', line: 1, path: 'A.md', completed: true } as never, source: null as never }] }, { settings: { ...DEFAULT_QUERY_SETTINGS, renderNullAs: '', dateFormat: 'yyyy-MM-dd', datetimeFormat: '', durationFormat: 'long', locale: 'en-US' }, originPath: null })
        expect(statics.querySelector('input')).toBeNull()
        expect(statics.querySelector('span.dataview-task-checkbox.is-checked')).not.toBeNull()
    })

    it('shows a DML block its own code when the head asks it to', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataviewjs\ndv.paragraph("x")\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        await new Promise((resolve) => setTimeout(resolve, 0))
        const toggle = root.querySelector('[data-dataview-source-toggle]') as HTMLButtonElement
        toggle.click()
        expect(root.querySelector('.dataview-source')?.textContent).toContain('dv.paragraph')
        expect(state.jsRuns).toBe(1)
    })
})

describe('a block drawn before the index finished', () => {
    // The index bumps its own version on every publish, so a notification without one is a pump that
    // has nothing new to answer.
    const indexMoved = () => {
        state.version += 1
        state.notify?.()
    }

    beforeEach(() => {
        resetDataviewMounts()
        state.rails = [state.alpha]
        state.needBodies = ['beta']
        state.pending = true
        state.parsed = 1
        state.total = 2
        state.jsRuns = 0
        state.railsCalls = 0
        state.defer = false
        state.release = null
        state.version = 0
        state.notify = null
    })

    it('grows its table when the bodies it was waiting on arrive', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataview\nTABLE rating\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        expect(root.querySelectorAll('tbody tr')).toHaveLength(1)
        expect(root.querySelector('.dataview-block')?.classList.contains('loading')).toBe(false)
        state.rails = [state.alpha, state.beta]
        state.needBodies = []
        state.pending = false
        state.parsed = 2
        indexMoved()
        await settle()
        expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
        expect(root.textContent).toContain('Beta')
    })

    it('does not re-answer on a notification that changed nothing', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataview\nTABLE rating\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        state.rails = [state.alpha, state.beta]
        state.needBodies = []
        state.pending = false
        state.parsed = 2
        indexMoved()
        await settle()
        expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
        const calls = state.railsCalls
        state.notify?.()
        await settle()
        expect(state.railsCalls).toBe(calls)
    })

    it('takes rows away when the index loses one', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataview\nTABLE rating\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        expect(root.querySelectorAll('tbody tr')).toHaveLength(1)
        state.rails = []
        state.needBodies = []
        state.pending = false
        indexMoved()
        await settle()
        expect(root.querySelectorAll('tbody tr')).toHaveLength(0)
        expect(root.querySelector('[data-dataview]')?.classList.contains('loading')).toBe(false)
    })

    it('answers an inline line once the note itself has a page', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host('<p>= this.file.name</p>')
        mountDataview(root, { originNoteId: 'lab', editable: false })
        expect(root.querySelector('.dataview-inline-query')?.textContent).toBe('—')
        state.current = { file: { name: 'Lab', path: 'Lab.md' } }
        indexMoved()
        await settle()
        expect(root.querySelectorAll('.dataview-inline-query')).toHaveLength(1)
        expect(root.querySelector('.dataview-inline-query')?.textContent).toBe('Lab')
    })

    it('folds a second request into the DML run already in flight', async () => {
        const { mountDataview, rerenderDataviewHost } = await import('./blocks')
        const root = await host(renderMarkdown('```dataviewjs\ndv.paragraph("x")\n```').html)
        state.defer = true
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.jsRuns).toBe(1)
        expect(typeof state.release).toBe('function')
        rerenderDataviewHost(root.querySelector('[data-dataview]') as HTMLElement)
        await settle()
        expect(state.jsRuns).toBe(1)
        state.release?.()
        await settle()
        expect(state.jsRuns).toBe(2)
    })

    it('runs a DML block once per index state, not once per draw', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataviewjs\ndv.paragraph("x")\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        expect(state.jsRuns).toBe(1)
        expect(root.querySelector('.dataview-block')?.textContent).toContain('DML over 1')
        state.rails = [state.alpha, state.beta]
        state.parsed = 2
        indexMoved()
        await settle()
        expect(state.jsRuns).toBe(2)
        expect(root.querySelector('.dataview-block')?.textContent).toContain('DML over 2')
        // A notification that did not move the version must not spawn another run.
        state.notify?.()
        await settle()
        expect(state.jsRuns).toBe(2)
        indexMoved()
        await settle()
        expect(state.jsRuns).toBe(3)
    })
})

describe('a cold block with live refresh off', () => {
    const settle = async () => {
        for (let round = 0; round < 6; round++) await new Promise((resolve) => setTimeout(resolve, 0))
    }

    beforeEach(() => {
        resetDataviewMounts()
        state.rails = []
        state.needBodies = ['alpha']
        state.pending = true
        state.liveRefresh = false
        state.refuse = false
        state.loaded = []
        state.version = 0
        state.notify = null
    })

    it('answers itself once its bodies arrive instead of waiting for a change', async () => {
        const { mountDataview } = await import('./blocks')
        const root = await host(renderMarkdown('```dataview\nTABLE rating\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        const block = root.querySelector('[data-dataview]')!
        expect(block.classList.contains('loading')).toBe(true)
        expect(block.querySelector('table')).toBeNull()
        await settle()
        expect(state.loaded).toEqual(['alpha'])
        expect(block.classList.contains('loading')).toBe(false)
        expect(block.querySelectorAll('tbody tr')).toHaveLength(2)
    })

    it('stops asking when the index keeps refusing the body', async () => {
        const { mountDataview } = await import('./blocks')
        state.refuse = true
        const root = await host(renderMarkdown('```dataview\nTABLE rating\n```').html)
        mountDataview(root, { originNoteId: null, editable: false })
        await settle()
        const block = root.querySelector('[data-dataview]')!
        expect(block.classList.contains('loading')).toBe(true)
        expect(block.querySelector('.dataview-notice')).not.toBeNull()
        expect(block.querySelectorAll('tbody tr')).toHaveLength(0)
        expect(state.loaded.length).toBeLessThanOrEqual(4)
    })
})

/**
 * F-08. A board that cannot leave for a spreadsheet has to be retyped by hand, and one that cannot
 * take a spreadsheet in cannot start from the rows someone else already wrote. These cases read the
 * header's CSV detour end to end: what lands in the browser's download, how a chosen file travels
 * into the document through the board's single commit path, and what the panel says when a file is
 * not what a board can swallow.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { downloadTextFile } from '../../../export-note'
import { KANBAN_MAX_ITEMS } from '../body'
import { KANBAN_CSV_MAX_ROWS } from '../csv'
import { KanbanRoot } from './kanban-root'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'

vi.mock('../../../export-note', () => ({
  downloadTextFile: vi.fn(),
}))

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  vi.mocked(downloadTextFile).mockClear()
})

const COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'description', name: 'Description', type: 'text' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', label: 'To Do', color: 'gray' },
      { id: 'doing', label: 'In Progress', color: 'blue' },
    ],
  },
  { id: 'files', name: 'Files', type: 'files' },
]

function card(id: string, archived = false): KanbanItem {
  return { id, title: `Card ${id}`, properties: { status: 'todo' }, ...(archived ? { archived: true } : {}) }
}

function board(items: KanbanItem[], title = 'Q3 Roadmap'): KanbanData {
  return { title, columns: COLUMNS, items, views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }] } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard(data: KanbanData) {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

/** The document the host was last handed — what one step of the board history wrote. */
function committed(onUpdateData: ReturnType<typeof vi.fn>): KanbanData {
  const calls = onUpdateData.mock.calls
  return (calls.at(-1) as [KanbanData])[0]
}

function openPanel(): HTMLElement {
  const trigger = document.querySelector<HTMLButtonElement>('[data-kanban-csv]')
  if (!trigger) throw new Error('the header offers no CSV control')
  act(() => {
    trigger.click()
  })
  const panel = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${t('preview.kanban_csv_panel')}"]`)
  if (!panel) throw new Error('the CSV panel did not open')
  return panel
}

function exportedFile(): string {
  const calls = vi.mocked(downloadTextFile).mock.calls
  if (calls.length !== 1) throw new Error(`the export handed the browser ${calls.length} file(s)`)
  return calls[0][1]
}

/** The file without its byte order mark: the rows below it are what the cases here read. */
function exportedText(): string {
  const text = exportedFile()
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

function statusLines(panel: HTMLElement): string {
  return panel.querySelector('[role="status"]')?.textContent ?? ''
}

async function pickCsv(csv: string): Promise<HTMLElement> {
  const panel = openPanel()
  const input = panel.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('the CSV panel offers no file chooser')
  Object.defineProperty(input, 'files', { value: [new File([csv], 'rows.csv', { type: 'text/csv' })], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  return panel
}

describe('the file the board writes', () => {
  function exportBoard(items: KanbanItem[]): HTMLElement {
    mountBoard(board(items))
    const panel = openPanel()
    act(() => {
      panel.querySelector<HTMLButtonElement>('[data-kanban-csv-action="export"]')!.click()
    })
    return panel
  }

  it('goes to the browser named after the board, as CSV', () => {
    exportBoard([card('a'), card('b')])
    expect(vi.mocked(downloadTextFile).mock.calls[0][0]).toBe('Q3 Roadmap.csv')
    expect(vi.mocked(downloadTextFile).mock.calls[0][2]).toBe('text/csv;charset=utf-8')
  })

  it('starts the file with the byte order mark a spreadsheet needs to read it', () => {
    exportBoard([card('a')])
    expect(exportedFile().charCodeAt(0)).toBe(0xFEFF)
  })

  it('leads with the columns of the board itself and gives every live card one row', () => {
    exportBoard([card('a'), card('b')])
    const rows = exportedText().split('\n')
    expect(rows[0]).toBe('Title,Description,Status')
    expect(rows.slice(1).map((row) => row.split(',')[0])).toEqual(['Card a', 'Card b'])
  })

  it('leaves filed-away cards out of the file', () => {
    exportBoard([card('a'), card('z', true)])
    expect(exportedText()).not.toContain('Card z')
  })

  it('says how many cards went into it', () => {
    expect(statusLines(exportBoard([card('a'), card('b')]))).toBe(t('preview.kanban_csv_exported', { count: 2 }))
  })
})

describe('the rows a chosen file brings in', () => {
  it('lands on the board as cards, in one step of undo', async () => {
    const { onUpdateData } = mountBoard(board([card('a')]))
    await pickCsv('Title,Status\nImported,In progress\nSecond,To Do\n')
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    const items = committed(onUpdateData).items
    expect(items.map((item) => item.title)).toEqual(['Card a', 'Imported', 'Second'])
    expect(items.slice(1).map((item) => item.properties.status)).toEqual(['doing', 'todo'])
    expect(items.slice(1).every((item) => !('archived' in item))).toBe(true)
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
  })

  it('keeps the schema as it was while nothing new is needed', async () => {
    const { onUpdateData } = mountBoard(board([card('a')]))
    await pickCsv('Title,Status\nImported,To Do\n')
    expect(committed(onUpdateData).columns).toBe(COLUMNS)
  })

  it('declares a group the board never had', async () => {
    const { onUpdateData } = mountBoard(board([card('a')]))
    const panel = await pickCsv('Title,Status\nWaiting card,Waiting\n')
    const status = committed(onUpdateData).columns.find((column) => column.id === 'status')!
    expect(status.options?.map((option) => option.id)).toEqual(['todo', 'doing', 'waiting'])
    expect(committed(onUpdateData).items.at(-1)!.properties.status).toBe('waiting')
    expect(statusLines(panel)).toContain(t('preview.kanban_csv_new_options', { count: 1 }))
  })

  it('writes the description column into the card body', async () => {
    const { onUpdateData } = mountBoard(board([]))
    await pickCsv('Title,Description\nDetailed,Read the fence rules\n')
    const [imported] = committed(onUpdateData).items
    expect(imported.content).toBe('Read the fence rules')
    expect(imported.properties.description).toBeUndefined()
  })

})

describe('what an import tells the reader', () => {
  it('imports the rows it can and reports the blank one it left out', async () => {
    const { onUpdateData } = mountBoard(board([]))
    const panel = await pickCsv('Title,Status\nKept,To Do\n,To Do\n')
    expect(committed(onUpdateData).items.map((item) => item.title)).toEqual(['Kept'])
    expect(statusLines(panel)).toContain(t('preview.kanban_csv_rows_skipped', { count: 1 }))
  })

  it('names a header the board has no column for', async () => {
    mountBoard(board([]))
    const panel = await pickCsv('Title,Widget\nA card,3\n')
    expect(statusLines(panel)).toContain(t('preview.kanban_csv_headers_ignored', { headers: 'Widget' }))
  })
})

describe('the chooser an import leaves behind', () => {
  it('lets the same file be chosen again', async () => {
    mountBoard(board([]))
    const input = openPanel().querySelector<HTMLInputElement>('input[type="file"]')!
    const cleared = vi.fn()
    // A chooser keeps whatever it was last given, so a second pick of the same file is only a
    // change if the control is emptied behind the reader's back.
    Object.defineProperty(input, 'value', { get: () => 'C:\\fakepath\\rows.csv', set: cleared, configurable: true })
    Object.defineProperty(input, 'files', { value: [new File(['Title\nA card\n'], 'rows.csv', { type: 'text/csv' })], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(cleared, 'the file chooser still holds the file').toHaveBeenCalled()
  })
})

describe('a file the board refuses', () => {
  it('refuses rows with no Title column and changes nothing', async () => {
    const { onUpdateData } = mountBoard(board([card('a')]))
    const panel = await pickCsv('Name,Status\nWhatever,To Do\n')
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(statusLines(panel)).toBe(t('preview.kanban_csv_import_no_title'))
  })

  it('refuses a file with nothing to read', async () => {
    const { onUpdateData } = mountBoard(board([card('a')]))
    const panel = await pickCsv('   \n')
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(statusLines(panel)).toBe(t('preview.kanban_csv_import_empty'))
  })

  it('refuses more rows than one board should swallow', async () => {
    const { onUpdateData } = mountBoard(board([card('a')]))
    const csv = ['Title', ...Array.from({ length: KANBAN_CSV_MAX_ROWS + 1 }, (_, i) => `Card ${i}`)].join('\n')
    const panel = await pickCsv(csv)
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(statusLines(panel)).toBe(t('preview.kanban_csv_import_too_many', { count: KANBAN_CSV_MAX_ROWS }))
  })

  it('refuses a small file for a board with no seat left for it', async () => {
    const full = Array.from({ length: KANBAN_MAX_ITEMS }, (_, index) => card(`f${index}`))
    const { onUpdateData } = mountBoard(board(full))
    const panel = await pickCsv('Title,Status\nOne more,To Do\n')
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(statusLines(panel)).toBe(t('preview.kanban_csv_import_no_room', { count: KANBAN_MAX_ITEMS }))
  })
})

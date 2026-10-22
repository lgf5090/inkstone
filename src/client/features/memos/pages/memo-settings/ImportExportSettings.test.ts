// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MemoImportConflictPolicy,
  MemoImportPlan,
  MemoImportReport,
  MemoImportSession,
} from '@shared/memos/types'
import { ConfirmHost } from '../../../../components/overlay'
import { ApiError } from '../../../../lib/api'
import { initI18n, t } from '../../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../../lib/test-render'
import { formatBytes } from '../../../../lib/time'
import { ImportExportSettings } from './ImportExportSettings'

const client = vi.hoisted(() => ({
  downloadExport: vi.fn<() => Promise<{ blob: Blob; filename: string }>>(),
  createImportSession: vi.fn<(input: { filename: string; totalSize: number }, signal?: AbortSignal) => Promise<MemoImportSession>>(),
  uploadImportChunk: vi.fn<(sessionId: string, offset: number, chunk: Blob, signal?: AbortSignal) => Promise<{ received: number }>>(),
  planImport: vi.fn<(sessionId: string, signal?: AbortSignal) => Promise<MemoImportPlan>>(),
  commitImport: vi.fn<(sessionId: string, policy: MemoImportConflictPolicy) => Promise<MemoImportReport>>(),
  cancelImport: vi.fn<(sessionId: string) => Promise<{ ok: true }>>(),
}))

const downloadBlob = vi.hoisted(() => vi.fn<(filename: string, blob: Blob) => void>())

vi.mock('../../transfer-client', () => ({
  memoTransferClient: client,
  MEMO_IMPORT_ARCHIVE_MAX_BYTES: 64 * 1024 * 1024,
}))

vi.mock('../../../../lib/export-note', () => ({ downloadBlob }))

const CHUNK = 2 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

let rendered: RenderedElement | null = null

function plan(overrides: Partial<MemoImportPlan> = {}): MemoImportPlan {
  return {
    exporter: 'alice',
    exportTime: 1_760_000_000,
    memoCount: 6,
    attachmentCount: 2,
    newCount: 2,
    renamedCount: 1,
    existingCount: 3,
    warnings: [],
    ...overrides,
  }
}

function report(overrides: Partial<MemoImportReport> = {}): MemoImportReport {
  return {
    created: 4,
    updated: 2,
    skipped: 1,
    failed: 0,
    failures: [],
    warnings: [],
    ...overrides,
  }
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function labeledControl<T extends HTMLElement>(text: string): T {
  const label = [...document.querySelectorAll('label')]
    .find((node) => node.textContent?.trim() === text)
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) : null
  if (!control) throw new Error(`no labeled control ${text}`)
  return control as T
}

function setValue(element: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!found) throw new Error('no dialog')
  return found
}

function countValue(host: HTMLElement, name: string): string {
  return host.querySelector(`[data-import-count="${name}"] dd`)?.textContent?.trim() ?? ''
}

async function chooseFile(host: HTMLElement, file: File): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush(10)
}

function renderSettings(): HTMLElement {
  rendered = renderElement(createElement(
    Fragment,
    null,
    createElement(ImportExportSettings),
    createElement(ConfirmHost),
  ))
  return rendered.container
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  client.downloadExport.mockResolvedValue({
    blob: new Blob(['zip'], { type: 'application/zip' }),
    filename: 'memos-export-alice.zip',
  })
  client.createImportSession.mockImplementation((input) => Promise.resolve({
    id: 'session-1',
    filename: input.filename,
    totalSize: input.totalSize,
    received: 0,
    chunkSize: CHUNK,
    expiresAt: 1_800_000_000,
  }))
  client.uploadImportChunk.mockImplementation((_sessionId, offset, chunk) =>
    Promise.resolve({ received: offset + chunk.size }))
  client.planImport.mockResolvedValue(plan())
  client.commitImport.mockResolvedValue(report())
  client.cancelImport.mockResolvedValue({ ok: true })
})

afterEach(() => {
  act(() => { rendered?.unmount() })
  rendered = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the import and export settings section', () => {
  it('downloads the export and saves it under the returned filename', async () => {
    const host = renderSettings()
    click(buttonNamed(t('memos.settings.transfer_export_button')))
    await flush()

    expect(client.downloadExport).toHaveBeenCalledTimes(1)
    expect(downloadBlob).toHaveBeenCalledWith('memos-export-alice.zip', expect.any(Blob))
    expect(host.textContent).not.toContain(t('memos.settings.transfer_export_failed'))
  })

  it('shows the export running state until the archive arrives', async () => {
    const gate: { finish: ((value: { blob: Blob; filename: string }) => void) | null } = { finish: null }
    client.downloadExport.mockImplementationOnce(() => new Promise((resolve) => {
      gate.finish = resolve
    }))
    renderSettings()
    click(buttonNamed(t('memos.settings.transfer_export_button')))
    await flush()

    const running = buttonNamed(t('memos.settings.transfer_exporting'))
    expect(running.disabled).toBe(true)
    gate.finish?.({ blob: new Blob(['zip']), filename: 'memos-export.zip' })
    await flush(3)
    expect(downloadBlob).toHaveBeenCalledWith('memos-export.zip', expect.any(Blob))
  })

  it('reports an export failure with the server reason', async () => {
    client.downloadExport.mockRejectedValueOnce(new ApiError(
      403,
      'forbidden',
      t('api.error.forbidden'),
      undefined,
      'Exports are disabled for this account',
    ))
    const host = renderSettings()
    click(buttonNamed(t('memos.settings.transfer_export_button')))
    await flush()

    expect(host.textContent).toContain(t('memos.settings.transfer_export_failed'))
    expect(host.textContent).toContain('Exports are disabled for this account')
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('uploads a ZIP in 2 MiB chunks and renders the plan with its warnings', async () => {
    client.planImport.mockResolvedValueOnce(plan({
      warnings: [{
        code: 'manifest_count_mismatch',
        path: 'manifest.json',
        message: 'The manifest counts 4 memos but the archive holds 6',
      }],
    }))
    const host = renderSettings()
    const file = new File([new Uint8Array(CHUNK * 2 + 100)], 'memos.zip')
    await chooseFile(host, file)

    expect(client.createImportSession).toHaveBeenCalledWith(
      { filename: 'memos.zip', totalSize: CHUNK * 2 + 100 },
      expect.any(AbortSignal),
    )
    expect(client.uploadImportChunk.mock.calls.map(([, offset, chunk]) => [offset, chunk.size])).toEqual([
      [0, CHUNK],
      [CHUNK, CHUNK],
      [CHUNK * 2, 100],
    ])
    expect(client.planImport).toHaveBeenCalledWith('session-1', expect.any(AbortSignal))
    expect(host.textContent).toContain(t('memos.settings.transfer_plan_title'))
    expect(host.textContent).toContain(t('memos.settings.transfer_plan_exporter', { exporter: 'alice' }))
    expect(host.textContent).toContain(t('memos.settings.transfer_plan_memos', { count: 6 }))
    expect(host.textContent).toContain(t('memos.settings.transfer_plan_attachments', { count: 2 }))
    expect(host.textContent).toContain(t('memos.settings.transfer_warnings', { count: 1 }))
    expect(host.textContent).toContain('The manifest counts 4 memos but the archive holds 6')
    expect(host.textContent).toContain('manifest.json')
    expect(countValue(host, 'new')).toBe('2')
    expect(countValue(host, 'renamed')).toBe('1')
    expect(countValue(host, 'existing')).toBe('3')
  })

  it('refuses a file that is not a ZIP or is past the size limit before contacting the server', async () => {
    const host = renderSettings()
    await chooseFile(host, new File(['zip'], 'notes.txt'))
    expect(host.textContent).toContain(t('memos.settings.transfer_invalid_type'))

    const huge = new File(['zip'], 'huge.zip')
    Object.defineProperty(huge, 'size', { configurable: true, value: MAX_ARCHIVE_BYTES + 1 })
    await chooseFile(host, huge)
    expect(client.createImportSession).not.toHaveBeenCalled()
    expect(host.textContent).toContain(t('memos.settings.transfer_too_large', {
      size: formatBytes(MAX_ARCHIVE_BYTES + 1),
      limit: formatBytes(MAX_ARCHIVE_BYTES),
    }))
  })

  it('commits with the skip policy without asking and renders the report', async () => {
    client.commitImport.mockResolvedValueOnce(report({
      failed: 1,
      failures: [{ code: 'content_too_large', path: 'memos/memo-9.json', message: 'Memo memo-9 is too large' }],
      warnings: [{ code: 'parent_missing', message: 'Parent memo was missing' }],
    }))
    const host = renderSettings()
    await chooseFile(host, new File(['zip'], 'memos.zip'))
    click(buttonNamed(t('memos.settings.transfer_commit')))
    await flush(5)

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(client.commitImport).toHaveBeenCalledWith('session-1', 'skip')
    expect(host.textContent).toContain(t('memos.settings.transfer_report_title'))
    expect(countValue(host, 'created')).toBe('4')
    expect(countValue(host, 'updated')).toBe('2')
    expect(countValue(host, 'skipped')).toBe('1')
    expect(countValue(host, 'failed')).toBe('1')
    expect(host.textContent).toContain(t('memos.settings.transfer_failures'))
    expect(host.textContent).toContain('Memo memo-9 is too large')
    expect(host.textContent).toContain('Parent memo was missing')

    click(buttonNamed(t('memos.settings.transfer_reset')))
    await flush()
    expect(buttonNamed(t('memos.settings.transfer_choose_file'))).toBeTruthy()
    expect(client.cancelImport).not.toHaveBeenCalled()
  })

  it('asks before replacing existing memos', async () => {
    const host = renderSettings()
    await chooseFile(host, new File(['zip'], 'memos.zip'))
    setValue(labeledControl<HTMLSelectElement>(t('memos.settings.transfer_conflict')), 'replace')
    click(buttonNamed(t('memos.settings.transfer_commit')))
    await flush()

    expect(dialog().textContent).toContain(t('memos.settings.transfer_confirm_replace_title', { count: 3 }))
    expect(client.commitImport).not.toHaveBeenCalled()
    click(buttonNamed(t('memos.settings.transfer_confirm_replace')))
    await flush(5)
    expect(client.commitImport).toHaveBeenCalledWith('session-1', 'replace')
  })

  it('offers all three policies and cancels the duplicate confirmation', async () => {
    const host = renderSettings()
    await chooseFile(host, new File(['zip'], 'memos.zip'))
    const select = labeledControl<HTMLSelectElement>(t('memos.settings.transfer_conflict'))
    expect([...select.options].map((option) => option.textContent)).toEqual([
      t('memos.settings.transfer_conflict_skip'),
      t('memos.settings.transfer_conflict_replace'),
      t('memos.settings.transfer_conflict_duplicate'),
    ])
    setValue(select, 'duplicate')
    click(buttonNamed(t('memos.settings.transfer_commit')))
    await flush()

    expect(dialog().textContent).toContain(t('memos.settings.transfer_confirm_duplicate_title', { count: 3 }))
    click(buttonNamed(t('memos.common.cancel')))
    await flush()
    expect(client.commitImport).not.toHaveBeenCalled()
    expect(host.textContent).toContain(t('memos.settings.transfer_plan_title'))
  })

  it('cancels an upload, aborts the request and removes the staged session', async () => {
    let uploadSignal: AbortSignal | undefined
    client.uploadImportChunk
      .mockImplementationOnce((_sessionId, offset, chunk) => Promise.resolve({ received: offset + chunk.size }))
      .mockImplementationOnce((_sessionId, _offset, _chunk, signal) => new Promise((_resolve, reject) => {
        uploadSignal = signal
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      }))
    const host = renderSettings()
    await chooseFile(host, new File([new Uint8Array(CHUNK * 2)], 'memos.zip'))

    click(buttonNamed(t('memos.settings.transfer_cancel')))
    await flush(6)

    expect(uploadSignal?.aborted).toBe(true)
    expect(client.cancelImport).toHaveBeenCalledWith('session-1')
    expect(client.planImport).not.toHaveBeenCalled()
    expect(host.textContent).toContain(t('memos.settings.transfer_choose_file'))
  })

  it('reports an upload failure and retries from a new session', async () => {
    client.createImportSession.mockRejectedValueOnce(new ApiError(
      503,
      'storage_unavailable',
      t('api.error.storage_unavailable'),
      undefined,
      'Attachment storage is not configured',
    ))
    const host = renderSettings()
    await chooseFile(host, new File(['zip'], 'memos.zip'))

    expect(host.textContent).toContain(t('memos.settings.transfer_upload_failed'))
    expect(host.textContent).toContain('Attachment storage is not configured')
    click(buttonNamed(t('memos.common.retry')))
    await flush(8)

    expect(client.createImportSession).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain(t('memos.settings.transfer_plan_title'))
  })

  it('discards the staged session before retrying a plan failure', async () => {
    client.planImport.mockRejectedValueOnce(new ApiError(
      400,
      'memo_import_invalid',
      t('api.error.bad_request'),
      undefined,
      'manifest.json is missing',
    ))
    const host = renderSettings()
    await chooseFile(host, new File(['zip'], 'memos.zip'))

    expect(host.textContent).toContain(t('memos.settings.transfer_plan_failed'))
    expect(host.textContent).toContain('manifest.json is missing')
    click(buttonNamed(t('memos.common.retry')))
    await flush(8)

    expect(client.cancelImport).toHaveBeenCalledWith('session-1')
    expect(client.createImportSession).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain(t('memos.settings.transfer_plan_title'))
  })

  it('reports a failed cancellation and keeps the failure visible', async () => {
    client.cancelImport.mockRejectedValueOnce(new ApiError(
      500,
      'internal',
      t('api.error.internal'),
      undefined,
      'The staging bucket is locked',
    ))
    client.uploadImportChunk.mockImplementationOnce((_sessionId, _offset, _chunk, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      }))
    const host = renderSettings()
    await chooseFile(host, new File(['zip'], 'memos.zip'))

    click(buttonNamed(t('memos.settings.transfer_cancel')))
    await flush(6)

    expect(host.textContent).toContain(t('memos.settings.transfer_discard_failed'))
    expect(host.textContent).toContain('The staging bucket is locked')
    expect(buttonNamed(t('memos.settings.transfer_discard'))).toBeTruthy()
  })
})

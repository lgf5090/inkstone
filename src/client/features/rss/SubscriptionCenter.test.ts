import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { parseOpmlPreview, readOpml } from './SubscriptionCenter'

beforeAll(async () => { await initI18n() })
afterEach(() => { vi.restoreAllMocks() })

describe('OPML file import', () => {
  it('reads a valid file and distinguishes an empty document from malformed XML', async () => {
    const file = new File(['<opml version="2.0"><body /></opml>'], 'empty.opml')
    await expect(readOpml(file)).resolves.toContain('<opml')
    expect(parseOpmlPreview('')).toBeNull()
    expect(parseOpmlPreview('<opml version="2.0"><body /></opml>')).toEqual({ feeds: [], skipped: 0 })
    expect(parseOpmlPreview('<rss />')?.error).toBe(t('rss.opml_invalid'))
  })

  it('refuses a file over five megabytes before reading it', async () => {
    const text = vi.fn()
    const file = { size: 5 * 1024 * 1024 + 1, text } as unknown as File
    const toast = vi.spyOn(useUi.getState(), 'toast').mockImplementation(() => '')
    await expect(readOpml(file)).resolves.toBeNull()
    expect(text).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith({ title: t('rss.opml_too_large'), tone: 'danger' })
  })

  it('reports a rejected file read', async () => {
    const file = { size: 10, text: vi.fn().mockRejectedValue(new Error('denied')) } as unknown as File
    const toast = vi.spyOn(useUi.getState(), 'toast').mockImplementation(() => '')
    await expect(readOpml(file)).resolves.toBeNull()
    expect(toast).toHaveBeenCalledWith({ title: t('rss.opml_read_failed'), tone: 'danger' })
  })
})

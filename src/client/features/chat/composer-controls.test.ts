/**
 * The composer's control row: seven chips that each own a menu, plus the attachment chips.
 *
 * What is pinned is the drive, not the markup — a click on each row has to reach the store or the
 * callback the composer wired, because every one of these controls is a setting the reader can only
 * change from here.
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantModel } from '@shared/assistant'
import type { PendingAttachment } from './assistant-store'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { ApprovalMenu, ContextMenu, ModelMenu, PlusMenu, ReasoningMenu, VoiceButton, formatContext } from './ComposerControls'
import { AttachmentStrip } from './ChatAttachments'
import { detectTrigger, filterRows, TOOL_TRIGGER_ROWS, TriggerPanel, type TriggerRow } from './ComposerTriggers'

const promptDialog = vi.fn(async (_options: { title?: string }) => undefined)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, prompt: (options: { title?: string }) => promptDialog(options) }
})

vi.mock('../../lib/api', () => ({
  api: {
    assistant: {
      chatFileUrl: (id: string) => `/api/assistant/files/${id}`,
      downloadChatFile: vi.fn(async (_id: string, onProgress?: (received: number, total: number) => void) => {
        onProgress?.(512, 1024)
        await new Promise((resolve) => setTimeout(resolve, 0))
        return new Blob(['line one\nline two\nlast line is 159'])
      }),
    },
  },
}))

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-flash', label: 'DeepSeek Flash',
    temperature: 0.7, maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, ...over,
  }
}

function pending(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return { localId: 'l1', id: '', filename: 'notes.txt', mime: 'text/plain', size: 2048, kind: 'file', progress: 0.4, status: 'uploading', ...over }
}

const buttons = () => [...document.body.querySelectorAll('button')]
const byText = (text: string) => buttons().find((node) => node.textContent?.includes(text))
const byAria = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)
const click = async (node: Element | undefined) => {
  if (!node) throw new Error('control is missing')
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  useUi.setState({ lightbox: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('model chip', () => {
  const open = async () => {
    await click(byText('DeepSeek Flash'))
  }

  it('picks a model and reports the manage entry', async () => {
    const onPick = vi.fn()
    const onManage = vi.fn()
    const onVision = vi.fn()
    await act(async () => {
      root.render(createElement(ModelMenu, { models: [model(), model({ id: 'm2', label: 'Mini' })], activeId: 'm1', onPick, onManage, onVision }))
    })
    await open()
    await click(byText('Mini'))
    expect(onPick).toHaveBeenCalledWith('m2')
    await open()
    await click(byText(t('assistant.composer.manage_models')))
    expect(onManage).toHaveBeenCalledTimes(1)
  })

  it('flips the vision capability from the checked state of the active model', async () => {
    const onVision = vi.fn()
    await act(async () => {
      root.render(createElement(ModelMenu, { models: [model({ vision: true })], activeId: 'm1', onPick: vi.fn(), onManage: vi.fn(), onVision }))
    })
    await open()
    const row = buttons().find((node) => node.getAttribute('role') === 'menuitemcheckbox')
    expect(row?.getAttribute('aria-checked')).toBe('true')
    await click(row)
    expect(onVision).toHaveBeenCalledWith(false)
  })
})

describe('thinking and context chips', () => {
  it('keeps auto and off selectable when the model thinks by itself', async () => {
    const onChange = vi.fn()
    await act(async () => { root.render(createElement(ReasoningMenu, { value: 'auto', disabled: true, onChange })) })
    await click(byAria(t('assistant.composer.thinking')))
    const levels = buttons().filter((node) => node.getAttribute('role') === 'menuitem')
    // Three of the five levels ask the model to think; a model that cannot is not offered them.
    expect(levels.filter((node) => node.hasAttribute('disabled')).map((node) => node.textContent)).toHaveLength(3)
    await click(levels.find((node) => !node.hasAttribute('disabled') && node.textContent?.includes(t('assistant.reasoning.off'))))
    expect(onChange).toHaveBeenCalledWith('off')
  })

  it('spells the budget like the reference slider and sends null for the global limit', async () => {
    expect(formatContext(32_768)).toBe('32K')
    expect(formatContext(4096)).toBe('4K')
    expect(formatContext(262_144)).toBe('256K')
    const onPick = vi.fn()
    await act(async () => { root.render(createElement(ContextMenu, { value: null, onPick })) })
    await click(buttons().at(0))
    await click(byText('128K'))
    expect(onPick).toHaveBeenCalledWith(131_072)
  })
})

describe('approval chip', () => {
  it('offers both arms and writes the chosen one', async () => {
    const onChange = vi.fn()
    await act(async () => { root.render(createElement(ApprovalMenu, { auto: false, onChange })) })
    await click(byAria(t('assistant.composer.approval')))
    await click(byText(t('assistant.approval.auto')))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('plus menu', () => {
  it('wires each entry to its own handler', async () => {
    const handlers = { onFiles: vi.fn(), onFolder: vi.fn(), onUrl: vi.fn(), onNote: vi.fn(), onPrompt: vi.fn() }
    await act(async () => {
      root.render(createElement(PlusMenu, { ...handlers, prompts: [{ id: 'q1', label: '总结一下' }] }))
    })
    await click(byAria(t('assistant.attach.menu')))
    await click(byText(t('assistant.attach.add_folder')))
    expect(handlers.onFolder).toHaveBeenCalledTimes(1)
    await click(byAria(t('assistant.attach.menu')))
    await click(byText(t('assistant.attach.reference_note')))
    expect(handlers.onNote).toHaveBeenCalledTimes(1)
  })
})

describe('voice chip', () => {
  it('says it cannot listen instead of looking broken', async () => {
    await act(async () => { root.render(createElement(VoiceButton, { onText: vi.fn() })) })
    await click(byAria(t('assistant.composer.voice')))
    // The chip is not a dead button: with no engine the reader is told, and it never enters listening.
    expect(promptDialog).toHaveBeenCalledWith({ title: t('assistant.composer.voice_unsupported') })
    expect(byAria(t('assistant.composer.voice_stop'))).toBeUndefined()
  })
})

describe('anchored menus', () => {
  // jsdom has no layout, so the panel's position cannot be measured here. What can be measured is the
  // mistake behind the corner-of-the-screen menu: a trigger that opens a menu without handing over its
  // own element. The shared Menu warns when that happens, so the warning is the assertion.
  it('every composer control hands its element to the menu it opens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cases: [string, () => ReactElement][] = [
      ['plus', () => createElement(PlusMenu, { onFiles: vi.fn(), onFolder: vi.fn(), onUrl: vi.fn(), onNote: vi.fn(), onPrompt: vi.fn(), prompts: [] })],
      ['model', () => createElement(ModelMenu, { models: [model()], activeId: 'm1', onPick: vi.fn(), onManage: vi.fn(), onVision: vi.fn() })],
      ['thinking', () => createElement(ReasoningMenu, { value: 'auto', disabled: false, onChange: vi.fn() })],
      ['context', () => createElement(ContextMenu, { value: null, onPick: vi.fn() })],
      ['approval', () => createElement(ApprovalMenu, { auto: false, onChange: vi.fn() })],
    ]
    for (const [name, element] of cases) {
      await act(async () => { root.render(element()) })
      await click(buttons().at(0))
      const unanchored = warn.mock.calls.filter((call) => String(call[0]).includes('without an attached anchor'))
      expect(unanchored, `${name} opened a menu with no anchor`).toEqual([])
      await act(async () => { root.unmount() })
      root = createRoot(container)
      warn.mockClear()
    }
    warn.mockRestore()
  })
})

describe('attachment chips', () => {
  const renderStrip = async (items: PendingAttachment[], onRemove = vi.fn()) => {
    await act(async () => { root.render(createElement(AttachmentStrip, { items, onRemove })) })
    return onRemove
  }

  it('counts the bytes it has handed over while a file is still uploading', async () => {
    await renderStrip([
      pending({ progress: 0.4, status: 'uploading' }),
      pending({ localId: 'l2', filename: 'shot.png', mime: 'image/png', kind: 'image', progress: 0.2, status: 'uploading' }),
    ])
    const bars = [...container.querySelectorAll('[role="progressbar"]')]
    expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['40', '20'])
    // A chip that is not ready must not open: there are no bytes behind it yet, and an image would put
    // an empty thumbnail into the lightbox.
    await click(byAria(t('assistant.attach.view', { name: 'shot.png' })))
    expect(useUi.getState().lightbox).toBeNull()
  })

  it('sends a ready picture to the lightbox and a ready file to the viewer', async () => {
    await renderStrip([pending({ id: 'a1', status: 'ready', progress: 1, kind: 'image', filename: 'shot.png', mime: 'image/png' })])
    await click(buttons().at(0))
    expect(useUi.getState().lightbox).toEqual({ src: '/api/assistant/files/a1', alt: 'shot.png' })
  })

  it('shows the download counter before the body arrives', async () => {
    let release: (() => void) | null = null
    let pump: ((received: number, total: number) => void) | null = null
    vi.mocked(api.assistant.downloadChatFile).mockImplementationOnce((async (_id: string, onProgress?: (received: number, total: number) => void) => {
      pump = onProgress ?? null
      await new Promise<void>((resolve) => { release = resolve })
      return new Blob(['ZEBRA-4471'])
    }) as never)
    await renderStrip([pending({ id: 'a2', status: 'ready', progress: 1, filename: 'log.txt' })])
    await click(buttons().at(0))
    await act(async () => { pump?.(256, 1024) })
    const widths = [...document.body.querySelectorAll('div[style]')].map((node) => node.getAttribute('style') ?? '')
    expect(widths.join(' ')).toContain('25%')
    await act(async () => { release?.() })
    expect(document.body.querySelector('pre')?.textContent).toContain('ZEBRA-4471')
  })

  it('removes the chip through the callback, not by hiding it', async () => {
    const onRemove = await renderStrip([pending({ id: 'a3', status: 'ready', progress: 1 })])
    const remove = buttons().find((node) => node.querySelector('svg')?.classList.contains('lucide-x'))
    await click(remove)
    expect(onRemove).toHaveBeenCalledWith('l1')
  })
})



describe('inline triggers', () => {
  it('reads a trigger only where a token begins', () => {
    expect(detectTrigger('@会', 2)).toEqual({ sigil: '@', query: '会', start: 0 })
    // The caret decides: a token with no sigil under it is not a trigger, and text after it is not part of the query.
    expect(detectTrigger('总结一下 @meeting notes', 19)).toBeNull()
    expect(detectTrigger('总结一下 @meeting notes', 13)).toEqual({ sigil: '@', query: 'meeting', start: 5 })
    expect(detectTrigger('/search', 7)).toEqual({ sigil: '/', query: 'search', start: 0 })
    expect(detectTrigger('#', 1)).toEqual({ sigil: '#', query: '', start: 0 })
    // An email fragment and a path are not requests for a picker.
    expect(detectTrigger('mail me@now.example', 15)).toBeNull()
    expect(detectTrigger('//path', 6)).toBeNull()
    expect(detectTrigger('@tag more', 4)).toEqual({ sigil: '@', query: 'tag', start: 0 })
  })

  it('filters rows by words or by id and keeps the list scannable', () => {
    const rows: TriggerRow[] = [
      { id: 'search_notes', label: '搜索笔记' },
      { id: 'read_note', label: '读一篇笔记' },
      { id: 'create_task', label: '建任务' },
    ]
    expect(filterRows(rows, '笔记').map((row) => row.id)).toEqual(['search_notes', 'read_note'])
    expect(filterRows(rows, 'create').map((row) => row.id)).toEqual(['create_task'])
    expect(filterRows(Array.from({ length: 30 }, (_, index) => ({ id: String(index), label: `row ${index}` })), '').length).toBe(8)
    // The tool catalog the `/` panel offers is the one the assistant can actually call.
    expect(TOOL_TRIGGER_ROWS.length).toBeGreaterThanOrEqual(22)
    expect(TOOL_TRIGGER_ROWS.filter((row) => row.danger).length).toBeGreaterThan(0)
  })

  it('marks the active row and hands a click back to the composer', async () => {
    const rows: TriggerRow[] = [{ id: 'search_notes', label: '搜索笔记', hint: '只读' }, { id: 'read_note', label: '读一篇笔记' }]
    const onPick = vi.fn()
    const onHover = vi.fn()
    await act(async () => {
      root.render(createElement(TriggerPanel, { sigil: '/', rows, activeIndex: 1, busy: false, onPick, onHover }))
    })
    const options = [...document.body.querySelectorAll('[role="option"]')]
    expect(options.map((node) => node.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    await click(options[0])
    expect(onPick).toHaveBeenCalledWith(rows[0])
    await act(async () => { options[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(onHover).toHaveBeenCalledWith(1)
  })
})

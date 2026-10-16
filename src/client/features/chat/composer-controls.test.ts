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
import type { AssistantModel, AssistantSkill } from '@shared/assistant'
import type { PendingAttachment } from './assistant-store'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { ApprovalMenu, ControlChip, ContextMenu, ModelMenu, PlusMenu, ReasoningMenu, VoiceButton, WebSearchMenu, formatContext } from './ComposerControls'
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
    temperature: 0.7, maxOutputTokens: 8192, enabled: true, reasoning: 'auto', contextTokens: null, vision: true,
    purpose: 'chat', kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [], protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', ...over,
  }
}

function pending(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return { localId: 'l1', id: '', filename: 'notes.txt', mime: 'text/plain', size: 2048, kind: 'file', progress: 0.4, status: 'uploading', ...over }
}

const buttons = () => [...document.body.querySelectorAll('button')]
const byText = (text: string) => buttons().find((node) => node.textContent?.includes(text))
// A chip's accessible name carries its value, so the label is a prefix of the name rather than all of it.
const byAria = (name: string) => buttons().find((node) => {
  const label = node.getAttribute('aria-label') ?? ''
  return label === name || label.startsWith(`${name}: `)
})
const click = async (node: Element | undefined) => {
  if (!node) throw new Error('control is missing')
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
/**
 * What a pointer is told when it arrives on a control.
 *
 * jsdom lays nothing out, so the anchor's box has to be stated before `Tooltip` will place anything at
 * all — that measurement is the component's own guard against a hidden trigger. `mouseover` is the event
 * React reads as an entry (it synthesises `onMouseEnter` from the delegated pointer events), and the
 * panel is behind the tooltip's own delay, which fake timers step over.
 */
const hover = (node: HTMLElement | undefined, name: string) => {
  expect(node, `${name} is not rendered`).toBeTruthy()
  node!.getBoundingClientRect = () => ({
    top: 10, left: 10, right: 38, bottom: 38, x: 10, y: 10, width: 28, height: 28,
    toJSON: () => ({}),
  }) as DOMRect
  vi.useFakeTimers()
  act(() => { node!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  act(() => { vi.advanceTimersByTime(600) })
  const told = document.body.querySelector('[role="tooltip"]')?.textContent ?? null
  vi.useRealTimers()
  return told
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
    await click(byAria(t('assistant.composer.model')))
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
    // The rungs a model's own service offers; DeepSeek's four plus the two values every service shares.
    await act(async () => { root.render(createElement(ReasoningMenu, { value: 'auto', rungs: ['auto', 'off', 'low', 'medium', 'high'], disabled: true, onChange })) })
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
  it('offers all three arms and writes the chosen one', async () => {
    const onChange = vi.fn()
    await act(async () => { root.render(createElement(ApprovalMenu, { mode: 'ask', onChange })) })
    await click(byAria(t('assistant.composer.approval')))
    await click(byText(t('assistant.approval.auto')))
    expect(onChange).toHaveBeenCalledWith('auto')
    await click(byAria(t('assistant.composer.approval')))
    await click(byText(t('assistant.approval.off')))
    expect(onChange).toHaveBeenCalledWith('off')
  })
})

describe('plus menu', () => {
  it('wires each entry to its own handler', async () => {
    const handlers = { onFiles: vi.fn(), onFolder: vi.fn(), onUrl: vi.fn(), onNote: vi.fn(), onSkill: vi.fn() }
    await act(async () => {
      root.render(createElement(PlusMenu, { ...handlers, onManageSkills: vi.fn(), skills: [{ id: 'q1', label: '总结一下' }] }))
    })
    await click(byAria(t('assistant.attach.menu')))
    await click(byText(t('assistant.attach.add_folder')))
    expect(handlers.onFolder).toHaveBeenCalledTimes(1)
    await click(byAria(t('assistant.attach.menu')))
    await click(byText(t('assistant.attach.reference_note')))
    expect(handlers.onNote).toHaveBeenCalledTimes(1)
  })

  it('offers saved skills by their words', async () => {
    const onSkill = vi.fn()
    const onManageSkills = vi.fn()
    await act(async () => {
      root.render(createElement(PlusMenu, {
        onFiles: vi.fn(), onFolder: vi.fn(), onUrl: vi.fn(), onNote: vi.fn(), onSkill, onManageSkills,
        skills: [{ id: 'p1', label: '周报', text: '把这周做的事写成周报' }],
      }))
    })
    await click(byAria(t('assistant.attach.menu')))
    await click(byText(t('assistant.attach.quick_skills')))
    // The submenu is its own portal; its entries are plain buttons inside a group.
    const rows = [...document.body.querySelectorAll('[role="group"] button')].map((node) => node.textContent?.trim())
    expect(rows).toEqual(['周报', t('assistant.skills.manage')])
    await click([...document.body.querySelectorAll('[role="group"] button')].find((node) => node.textContent?.trim() === '周报'))
    // Picking a saved skill inserts what it says, not what it is called — and hands over the whole row,
    // because a skill that carries a tool set or a folder is more than its words.
    expect(onSkill).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', text: '把这周做的事写成周报' }))
  })

  it('hands the saved skill itself to the composer, bindings and all', async () => {
    const onSkill = vi.fn()
    const skill: AssistantSkill = {
      id: 'p2', title: '查资料', content: '先搜我的笔记。', group: '', icon: '🔎',
      tools: ['search_notes'], scopes: [{ kind: 'folder', id: 'f1', name: '工作' }], modelId: 'm1',
      createdAt: 1, updatedAt: 1,
    }
    await act(async () => {
      root.render(createElement(PlusMenu, {
        onFiles: vi.fn(), onFolder: vi.fn(), onUrl: vi.fn(), onNote: vi.fn(), onSkill, onManageSkills: vi.fn(),
        skills: [{ id: skill.id, label: skill.title, text: skill.content, skill }],
      }))
    })
    await click(byAria(t('assistant.attach.menu')))
    await click(byText(t('assistant.attach.quick_skills')))
    await click([...document.body.querySelectorAll('[role="group"] button')].find((node) => node.textContent?.trim() === '查资料'))
    expect(onSkill.mock.calls[0]![0].skill).toEqual(skill)
  })

  it('opens the skill manager from the same submenu', async () => {
    const onSkill = vi.fn()
    const onManageSkills = vi.fn()
    await act(async () => {
      root.render(createElement(PlusMenu, {
        onFiles: vi.fn(), onFolder: vi.fn(), onUrl: vi.fn(), onNote: vi.fn(), onSkill, onManageSkills,
        skills: [{ id: 'p1', label: '周报', text: '把这周做的事写成周报' }],
      }))
    })
    await click(byAria(t('assistant.attach.menu')))
    await click(byText(t('assistant.attach.quick_skills')))
    await click([...document.body.querySelectorAll('[role="group"] button')].find((node) => node.textContent?.trim() === t('assistant.skills.manage')))
    expect(onManageSkills).toHaveBeenCalledTimes(1)
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

describe('web-search chip', () => {
  it('reads as a switch, and each press asks for the other state', async () => {
    const onChange = vi.fn()
    await act(async () => { root.render(createElement(WebSearchMenu, { value: false, onChange })) })
    const chip = byAria(t('assistant.composer.search'))
    expect(chip?.getAttribute('aria-pressed')).toBe('false')
    await click(chip)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('says which way it is set, and explains itself on hover', async () => {
    const onChange = vi.fn()
    await act(async () => { root.render(createElement(WebSearchMenu, { value: true, onChange })) })
    const chip = byAria(t('assistant.composer.search'))
    // There is no visible word anywhere, so the state rides on the name and on the button.
    expect(chip?.getAttribute('aria-pressed')).toBe('true')
    expect(chip?.getAttribute('aria-label')).toBe(`${t('assistant.composer.search')}: ${t('assistant.search.on')}`)
    // The switch says what it is set to; what a search costs the model is the hint's job.
    expect(hover(chip, 'the search chip')).toBe(t('assistant.search.hint'))
    await click(chip)
    expect(onChange).toHaveBeenCalledWith(false)
  })
})

describe('anchored menus', () => {
  // jsdom has no layout, so the panel's position cannot be measured here. What can be measured is the
  // mistake behind the corner-of-the-screen menu: a trigger that opens a menu without handing over its
  // own element. The shared Menu warns when that happens, so the warning is the assertion.
  it('every composer control hands its element to the menu it opens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cases: [string, () => ReactElement][] = [
      ['plus', () => createElement(PlusMenu, { onFiles: vi.fn(), onFolder: vi.fn(), onUrl: vi.fn(), onNote: vi.fn(), onSkill: vi.fn(), skills: [], onManageSkills: vi.fn() })],
      ['model', () => createElement(ModelMenu, { models: [model()], activeId: 'm1', onPick: vi.fn(), onManage: vi.fn(), onVision: vi.fn() })],
      ['thinking', () => createElement(ReasoningMenu, { value: 'auto', rungs: ['auto', 'off', 'low', 'medium', 'high'], disabled: false, onChange: vi.fn() })],
      ['context', () => createElement(ContextMenu, { value: null, onPick: vi.fn() })],
      ['approval', () => createElement(ApprovalMenu, { mode: 'ask', onChange: vi.fn() })],
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

describe('a control chip’s own face', () => {
  const renderChip = (props: Partial<React.ComponentProps<typeof ControlChip>>) => {
    const ref = { current: null as HTMLButtonElement | null }
    act(() => {
      root.render(createElement(ControlChip, {
        label: '审批模式',
        value: '写入确认',
        icon: createElement('i'),
        onClick: () => undefined,
        refObject: ref,
        ...props,
      }))
    })
    return buttons()[0]
  }
  it('prints no word, and keeps the value it dropped in the name', () => {
    const chip = renderChip({})
    // The row is icons only, so the value the chip used to draw is now the whole of what it says.
    expect(chip?.textContent).toBe('')
    expect(chip?.getAttribute('aria-label')).toBe('审批模式: 写入确认')
  })
  it('names the control alone when it holds no value', () => {
    const chip = renderChip({ value: undefined })
    expect(hover(chip, 'the approval chip')).toBe('审批模式')
    expect(chip?.getAttribute('aria-label')).toBe('审批模式')
  })
  it('answers a pointer with the app’s own tooltip rather than the browser’s title', () => {
    const chip = renderChip({})
    expect(chip?.getAttribute('title')).toBe(null)
    expect(hover(chip, 'the approval chip')).toBe('审批模式: 写入确认')
  })
  it('lets a stated hint stand in for the sentence a pointer would read', () => {
    const chip = renderChip({ hint: '审批模式' })
    expect(hover(chip, 'the approval chip')).toBe('审批模式')
    expect(chip?.getAttribute('aria-label')).toBe('审批模式: 写入确认')
  })
})

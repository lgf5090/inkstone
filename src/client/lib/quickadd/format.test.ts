import { beforeAll, describe, expect, it, vi } from 'vitest'
import { collectRequirements, formatQuickAddText, inertFormat, type FormatRuntime, type PromptRequest } from './format'
import { getLocale, initI18n, setLocaleAsync } from '../../lib/i18n'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'

beforeAll(async () => {
  await initI18n()
})

interface Harness {
  runtime: FormatRuntime
  asked: PromptRequest[]
}

function harness(overrides: Partial<FormatRuntime> = {}): Harness {
  const asked: PromptRequest[] = []
  const runtime: FormatRuntime = {
    variables: new Map(),
    globalVars: new Map(),
    locale: 'en-US',
    clock: { now: new Date(2026, 9, 8, 13, 5, 9), date: new Date(2026, 9, 8, 13, 5, 9) },
    defaults: { dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' },
    title: null,
    folderPath: null,
    activeTitle: null,
    activeFolderPath: null,
    selection: '',
    clipboard: async () => '',
    linkToActive: (subpath) => (subpath === null ? '[[Inbox]]' : `[[Inbox${subpath}]]`),
    cursorHeadingPath: () => null,
    prompt: async (request) => {
      asked.push(request)
      return request.defaultValue
    },
    templateBody: async () => '',
    runMacroByName: async () => '',
    fieldValues: async () => [],
    pickFile: async () => null,
    periodicPath: (period, offset) => `${period}${offset ? `+${offset}` : ''}/note`,
    warn: () => {},
    ...overrides,
  }
  return { runtime, asked }
}

const run = (text: string, overrides: Partial<FormatRuntime> = {}) =>
  formatQuickAddText(text, harness(overrides).runtime)

const render = async (text: string, overrides: Partial<FormatRuntime> = {}) =>
  (await run(text, overrides)).text

describe('the date half of a format', () => {
  it('renders today, an offset and a snap', async () => {
    expect(await render('{{DATE}}')).toBe('2026-10-08')
    expect(await render('{{DATE:YYYY/MM/DD}}')).toBe('2026/10/08')
    expect(await render('{{DATE+7:YYYY-MM-DD}}')).toBe('2026-10-15')
    expect(await render('{{DATE:YYYY-MM-DD+7}}')).toBe('2026-10-15')
    expect(await render('{{DATE+-3}}')).toBe('2026-10-05')
    expect(await render('{{DATE|startof:week}}', { locale: 'de-DE' })).toBe('2026-10-05')
    expect(await render('{{DATE|endof:month}}')).toBe('2026-10-31')
    expect(await render('{{DATE|startof:quarter}}')).toBe('2026-10-01')
    expect(await render('{{DATE|startof:quarter}}', {
      clock: { now: new Date(2026, 10, 15), date: new Date(2026, 10, 15) },
    })).toBe('2026-10-01')
    expect(await render('{{DATE|startof:year|case:upper}}')).toBe('2026-01-01')
  })

  it('shifts the calendar day the run is about, not the clock', async () => {
    const daily = await render('{{DATE:YYYY-MM-DD}} {{TIME:HH:mm}}', {
      clock: { now: new Date(2026, 9, 8, 22, 30), date: new Date(2024, 0, 1, 9, 0) },
    })
    expect(daily).toBe('2024-01-01 22:30')
  })

  it('keeps a token it cannot read exactly as written', async () => {
    expect(await render('{{DATE:YYYY-MM-DD}} and {{DATE-3}}')).toBe('2026-10-08 and {{DATE-3}}')
    expect(await render('{{TIME}}')).toBe('13:05')
    expect(await render('{{TIME|case:upper}}')).toBe('13:05')
    expect(await render('{{DATE|startof:wik}}')).toBe('2026-10-08')
  })

  it('names the periodic note the run is aimed at', async () => {
    expect(await render('Inside {{DAILY}}')).toBe('Inside daily/note')
    expect(await render('{{WEEKLY+1}}')).toBe('weekly+1/note')
  })
})

describe('the prompt half of a format', () => {
  it('asks once and reuses the answer, without rescanning it', async () => {
    const { runtime, asked } = harness({ prompt: async (request) => { asked.push(request); return 'Tom{{VALUE:x}}' } })
    const { text } = await formatQuickAddText('{{VALUE:who}} and {{VALUE:who}}', runtime)
    expect(text).toBe('Tom{{VALUE:x}} and Tom{{VALUE:x}}')
    expect(asked.length).toBe(1)
    expect(asked[0].key).toBe('who')
  })

  it('does not ask again for an answer the run already has', async () => {
    const { runtime, asked } = harness()
    runtime.variables.set('who', 'pre-seeded')
    expect((await formatQuickAddText('{{VALUE:who}}', runtime)).text).toBe('pre-seeded')
    expect(asked).toEqual([])
  })

  it('falls back to the default when the answer is empty and optional', async () => {
    const asked: PromptRequest[] = []
    const { runtime } = harness({ prompt: async (request) => { asked.push(request); return '' } })
    expect((await formatQuickAddText('{{VALUE:note|default:later}}', runtime)).text).toBe('')
    expect(asked[0].defaultValue).toBe('later')
  })

  it('reads the label, the list and the type out of the token', async () => {
    const asked: PromptRequest[] = []
    const { runtime } = harness({ prompt: async (request) => { asked.push(request); return request.options[0] ?? request.defaultValue } })
    expect((await formatQuickAddText('{{VALUE:Urgent,Normal|label:How bad?}}', runtime)).text).toBe('Urgent')
    expect(asked[0]).toMatchObject({ kind: 'suggester', label: 'How bad?', options: ['Urgent', 'Normal'] })
    expect((await formatQuickAddText('{{VALUE:Count|type:number|default:3}}', runtime)).text).toBe('3')
    expect(asked[1].kind).toBe('number')
  })

  it('joins a multi-select the way |format says', async () => {
    const { runtime } = harness({ prompt: async () => ['a', 'b'] })
    expect((await formatQuickAddText('{{VALUE:a,b,c|multi|format:yaml}}', runtime)).text).toBe('[a, b]')
    expect((await formatQuickAddText('{{VALUE:a,b,c|multi|format:spaced}}', runtime)).text).toBe('a b')
    expect((await formatQuickAddText('{{VALUE:a,b,c|multi|format:markdown}}', runtime)).text).toBe('[[a]], [[b]]')
  })

  it('applies |case and |trim to the answer', async () => {
    const { runtime } = harness({ prompt: async () => '  Hello world  ' })
    expect((await formatQuickAddText('{{VALUE:x|trim|case:title}}', runtime)).text).toBe('Hello World')
    expect((await formatQuickAddText('{{VALUE:x|case:kebab}}', runtime)).text).toBe('hello-world')
  })

  it('asks for one date and renders it through each use’s own format', async () => {
    const asked: PromptRequest[] = []
    const { runtime } = harness({
      prompt: async (request) => {
        asked.push(request)
        return '2026-01-05'
      },
    })
    expect((await formatQuickAddText('{{VDATE:due}} / {{VDATE:due, DD.MM.YYYY}}', runtime)).text).toBe('2026-01-05 / 05.01.2026')
    expect(asked.length).toBe(1)
    expect(asked[0].kind).toBe('date')
  })

  it('copies a date answer it cannot parse, so a script-set text still survives', async () => {
    const { runtime } = harness({ prompt: async () => 'sometime next week' })
    expect((await formatQuickAddText('{{VDATE:due, YYYY}}', runtime)).text).toBe('sometime next week')
  })

  it('evaluates MVALUE once and refuses a hostile expression', async () => {
    const asked: PromptRequest[] = []
    const warns: string[] = []
    const { runtime } = harness({
      prompt: async (request) => { asked.push(request); return 'fetch("evil")' },
      warn: (message) => warns.push(message),
    })
    expect((await formatQuickAddText('{{MVALUE}}', runtime)).text).toBe('')
    expect(warns[0]).toContain('unexpected')

    const ok = harness({ prompt: async () => '2*(3+4)' })
    expect((await formatQuickAddText('{{MVALUE}}', ok.runtime)).text).toBe('14')
  })

  it('fills SELECTED and CLIPBOARD from the surface, not from a prompt', async () => {
    expect(await render('[[{{SELECTED}}]]', { selection: 'picked words' })).toBe('[[picked words]]')
    expect(await render('{{CLIPBOARD}}', { clipboard: async () => 'from the clipboard' })).toBe('from the clipboard')
  })

  it('keeps a selection that looks like a token out of the token language', async () => {
    const { runtime } = harness({ selection: '{{DATE}}', prompt: async () => '{{DATE}}' })
    expect((await formatQuickAddText('{{SELECTED}} {{VALUE:x}}', runtime)).text).toBe('{{DATE}} {{DATE}}')
  })

  it('gives RANDOM a length and refuses anything else', async () => {
    const text = await render('{{RANDOM:12}}')
    expect(text).toMatch(/^[A-Za-z0-9]{12}$/)
    expect(await render('{{RANDOM:900}}')).toBe('')
  })
})

describe('code, includes and globals', () => {
  it('runs a macro and refuses to run what its own text returned', async () => {
    const calls: string[] = []
    const { runtime } = harness({
      runMacroByName: async (name) => {
        calls.push(name)
        return name === 'outer' ? '{{MACRO:outer}}!' : 'never'
      },
    })
    expect((await formatQuickAddText('{{MACRO:outer}}', runtime)).text).toBe('{{MACRO:outer}}!')
    expect(calls).toEqual(['outer'])
  })

  it('splices an included template and formats its tokens', async () => {
    const { runtime } = harness({ templateBody: async (name) => (name === 'Daily' ? 'On {{DATE}}:' : '') })
    expect((await formatQuickAddText('{{TEMPLATE:Daily}} done', runtime)).text).toBe('On 2026-10-08: done')
  })

  it('refuses a template that includes itself', async () => {
    const warns: string[] = []
    const { runtime } = harness({
      templateBody: async () => 'a {{TEMPLATE:Self}} b',
      warn: (message) => warns.push(message),
    })
    const text = (await formatQuickAddText('{{TEMPLATE:Self}}', runtime)).text
    expect(text).toContain('[skipped: Self]')
    expect(warns.join(' ')).toContain('itself')
  })

  it('expands a global snippet, including its own tokens', async () => {
    const { runtime } = harness({ globalVars: new Map([['stamp', 'signed {{DATE}}'], ['loop', '{{GLOBAL_VAR:loop}}']]) })
    expect((await formatQuickAddText('{{GLOBAL_VAR:stamp}}', runtime)).text).toBe('signed 2026-10-08')
    expect((await formatQuickAddText('{{GLOBAL_VAR:loop}}', runtime)).text).toContain('{{GLOBAL_VAR:loop}}')
  })

  it('expands a global inside an included template', async () => {
    const { runtime } = harness({
      globalVars: new Map([['who', 'the author']]),
      templateBody: async () => 'by {{GLOBAL_VAR:who}}',
    })
    expect((await formatQuickAddText('{{TEMPLATE:Credit}}', runtime)).text).toBe('by the author')
  })

  it('leaves a date token with two snaps exactly as written', async () => {
    expect(await render('{{DATE:YYYY|startof:month|endof:quarter}}')).toBe('{{DATE:YYYY|startof:month|endof:quarter}}')
    expect(await render('{{DATE:YYYY-MM-DD|startof:month}}')).toBe('2026-10-01')
  })

  it('expands \\n outside tokens but not inside them', async () => {
    expect(await render('a\\nb')).toBe('a\nb')
    expect(await render('a\\\\b')).toBe('a\\b')
    expect(await render('{{VALUE:x\\ny|default:k}}', { prompt: async (request) => request.label })).toBe('x\\ny')
  })
})

describe('the notes the run reaches for', () => {
  it('suggests a value the account already uses and stores the pick', async () => {
    const asked: PromptRequest[] = []
    const { runtime } = harness({
      fieldValues: async (token) => (token.fieldName === 'status' ? ['Done', 'Todo'] : []),
      prompt: async (request) => {
        asked.push(request)
        return 'Done'
      },
    })
    expect((await formatQuickAddText('{{FIELD:status}}', runtime)).text).toBe('Done')
    expect(asked[0]).toMatchObject({ kind: 'suggester', key: 'FIELD:status', options: ['Done', 'Todo'] })
  })

  it('renders a picked note as name, path or link', async () => {
    const { runtime } = harness({ pickFile: async () => 'Journal/2026-10-08' })
    expect((await formatQuickAddText('{{FILE:Journal}}', runtime)).text).toBe('2026-10-08')
    expect((await formatQuickAddText('{{FILE:Journal|path}}', runtime)).text).toBe('Journal/2026-10-08')
    expect((await formatQuickAddText('{{FILE:Journal|link}}', runtime)).text).toBe('[[2026-10-08]]')
  })

  it('resolves the current-file tokens once, from the run’s own context', async () => {
    expect(await render('{{TITLE}} {{LINKCURRENT}} {{FILENAMECURRENT}} {{FOLDER}} {{FOLDERCURRENT}} {{LINKSECTION}}', {
      title: 'Created note',
      folderPath: 'Journal',
      activeTitle: 'Inbox',
      activeFolderPath: 'In',
      cursorHeadingPath: () => '#Today',
    })).toBe('Created note [[Inbox]] Inbox Journal In [[Inbox#Today]]')
  })

  it('writes the property value a property capture is editing', async () => {
    const { runtime } = harness({ variables: new Map([['propertyValue', 'Draft']]) })
    expect((await formatQuickAddText('now {{PROPERTY}}', runtime, { propertyValue: 'Draft' })).text).toBe('now Draft')
  })

  it('reports where the caret marker sat and removes it', async () => {
    const withCursor = await run('title: {{VALUE:x}}\n{{cursor}}rest', { prompt: async () => 'T' })
    expect(withCursor.text).toBe('title: T\nrest')
    expect(withCursor.cursor).toBe(9)
    const kept = await formatQuickAddText('a{{cursor}}b', harness().runtime, { preserveCursor: true })
    expect(kept.text).toBe('a{{cursor}}b')
    expect(kept.cursor).toBeNull()
  })
})

describe('the settings preview', () => {
  it('never asks anything', async () => {
    const prompt = vi.fn()
    const { runtime } = harness({ prompt, fieldValues: async () => ['Done'], title: 'Note' })
    const text = inertFormat(
      '{{DATE:YYYY}} {{VALUE:who|default:me}} {{VALUE:a,b}} {{FIELD:status}} {{MACRO:M}} {{TEMPLATE:T}} {{MVALUE}} {{RANDOM:4}} {{TITLE}} {{SELECTED}}',
      runtime,
    )
    expect(text).toBe('2026 {who: me} {a | b} {status} {macro: M} {template: T} {math} aaaa Note ')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('shows an answered input as the answer', () => {
    const { runtime } = harness({ variables: new Map([['who', 'Tom']]) })
    expect(inertFormat('{{VALUE:who}}', runtime)).toBe('Tom')
  })
})

describe('one-page discovery', () => {
  it('lists each input once, in the order it appears', () => {
    const { runtime } = harness()
    const requests = collectRequirements('{{VALUE:a}} {{DATE}} {{VALUE:b}} {{VALUE:a}} {{VDATE:d}} {{MVALUE}}', runtime)
    expect(requests.map((request) => request.key)).toEqual(['a', 'b', 'd', 'mvalue'])
  })

  it('skips what the run has already answered', () => {
    const { runtime } = harness({ variables: new Map([['a', 'set']]) })
    expect(collectRequirements('{{VALUE:a}} {{VALUE:b}}', runtime).map((request) => request.key)).toEqual(['b'])
  })

  it('asks exactly the inputs discovery promised', async () => {
    const asked: string[] = []
    const { runtime } = harness({
      prompt: async (request) => {
        asked.push(request.key)
        return request.options[0] ?? 'x'
      },
      fieldValues: async () => ['Done'],
    })
    const text = 'Name {{VALUE:who}} {{VALUE:who}} {{FIELD:status}} {{VDATE:due}}'
    const promised = collectRequirements(text, runtime).map((request) => request.key)
    await formatQuickAddText(text, runtime)
    expect(asked).toEqual(promised)
  })

  it('sees through a global snippet to the inputs inside it', () => {
    const { runtime } = harness({ globalVars: new Map([['stamp', '{{VALUE:extra}}']]) })
    expect(collectRequirements('{{GLOBAL_VAR:stamp}}', runtime).map((request) => request.key)).toEqual(['extra'])
  })
})

describe('pathological formats', () => {
  it('does not fall apart on a flood of unterminated openers', async () => {
    const text = '{{'.repeat(20_000)
    const started = performance.now()
    const rendered = await render(text)
    expect(rendered).toBe(text)
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('does not fall apart on a run of pipes inside a token', async () => {
    const text = `{{VALUE:${'|'.repeat(20_000)}}}`
    const started = performance.now()
    await render(text)
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('the prompt a bare token raises', () => {
  it('names itself in the language the reader is using', async () => {
    const starting = getLocale()
    await setLocaleAsync('zh-CN', false)
    try {
      const [value] = collectRequirements('{{VALUE}}', harness().runtime)
      const [named] = collectRequirements('{{NAME}}', harness().runtime)
      expect(value.label, 'the hint is copy, so it cannot be an English literal').toBe(ZH_CN_MESSAGES['quickadd.var_value'])
      expect(named.label).toBe(ZH_CN_MESSAGES['quickadd.field_name'])
      const asking = harness()
      await formatQuickAddText('{{VALUE}}', asking.runtime)
      expect(asking.asked[0]?.label, 'the run path asks in the same words the preview promises').toBe(value.label)
    } finally {
      await setLocaleAsync(starting, false)
    }
  })
})

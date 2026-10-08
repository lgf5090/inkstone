import { describe, expect, it } from 'vitest'
import {
  applyCaseStyle,
  bodyOf,
  isKnownCaseStyle,
  parseDateToken,
  parseFieldToken,
  parseFileToken,
  parsePeriodicToken,
  parseVDateToken,
  parseValueToken,
  randomLengthOf,
  randomString,
  scanTokens,
  splitOptionList,
  splitPipes,
} from './token-grammar'

function first(text: string) {
  const spans = scanTokens(text)
  expect(spans.length).toBe(1)
  return spans[0]
}

describe('scanTokens', () => {
  it('finds every span and names it', () => {
    const spans = scanTokens('On {{DATE:YYYY-MM-DD}} I will {{VALUE:do what}}')
    expect(spans.map((span) => [span.keyword, span.name])).toEqual([
      ['DATE', 'date'],
      ['VALUE', 'value'],
    ])
    expect(spans[0].rest).toBe(':YYYY-MM-DD')
    expect(bodyOf(spans[1])).toBe('do what')
  })

  it('is case-insensitive about the keyword and tolerant of spaces', () => {
    expect(first('{{date}}').name).toBe('date')
    expect(first('{{ Value : Title }}').name).toBe('value')
    expect(bodyOf(first('{{ Value : Title }}')).trim()).toBe('Title')
    expect(first('{{VALUE:x}}').keyword).toBe('VALUE')
  })

  it('leaves a span it cannot name alone', () => {
    expect(first('{{TODO:later}}').name).toBe('unknown')
    expect(scanTokens('{{}}').length).toBe(0)
    expect(scanTokens('{{  }}').length).toBe(0)
  })

  it('refuses to treat an unclosed or nested opener as a token', () => {
    expect(scanTokens('a {{VALUE:x').length).toBe(0)
    expect(scanTokens('{{VALUE:a{{DATE}}').map((span) => span.keyword)).toEqual(['DATE'])
    expect(scanTokens('{{DATE\nYYYY}}').length).toBe(0)
  })

  it('does not rescan a span that a replacement produced', () => {
    const span = first('{{VALUE:x}}')
    expect(scanTokens('x').length).toBe(0)
    expect(span.end).toBe('{{VALUE:x}}'.length)
  })

  it('refuses a token whose literal bracket run never closes', () => {
    // The reference reads `{{DATE:YYYY[Q}}` as a format with a stray bracket. Dropping the token is
    // the plainer promise: an author with an unclosed `[` gets their text back unchanged.
    expect(scanTokens('{{DATE:YYYY[Q}}').length).toBe(0)
    expect(scanTokens('{{DATE:YYYY[Q]}}')[0].rest).toBe(':YYYY[Q]')
  })

  it('keeps a literal bracket run from closing a date token early', () => {
    const span = first('{{DATE:YYYY[}]Q}}')
    expect(span.name).toBe('date')
    expect(bodyOf(span)).toBe('YYYY[}]Q')
  })
})

describe('parseDateToken', () => {
  it('separates the format from a day offset written with a plus', () => {
    expect(parseDateToken('')).toEqual({ format: null, offset: 0, snap: null, caseStyle: null, badUnit: null, bad: false })
    expect(parseDateToken(':YYYY-MM-DD')).toMatchObject({ format: 'YYYY-MM-DD', offset: 0 })
    expect(parseDateToken('+7')).toMatchObject({ format: null, offset: 7, bad: false })
    expect(parseDateToken('+-3:YYYY')).toMatchObject({ format: 'YYYY', offset: -3 })
    expect(parseDateToken(':YYYY+7')).toMatchObject({ format: 'YYYY', offset: 7 })
    expect(parseDateToken(':YYYY-07-01')).toMatchObject({ format: 'YYYY-07-01', offset: 0 })
  })

  it('keeps a body that is not in this grammar exactly as written', () => {
    expect(parseDateToken('-3').bad).toBe(true)
    expect(parseDateToken('nonsense').bad).toBe(true)
    expect(parseDateToken(':')).toMatchObject({ format: null, bad: false })
  })

  it('reads only terminal modifiers, so a pipe can stay a literal', () => {
    expect(parseDateToken(':YYYY|MM')).toMatchObject({ format: 'YYYY|MM', caseStyle: null })
    expect(parseDateToken(':YYYY|case:upper')).toMatchObject({ format: 'YYYY', caseStyle: 'upper' })
    expect(parseDateToken(':YYYY|MM|case:title')).toMatchObject({ format: 'YYYY|MM', caseStyle: 'title' })
    expect(parseDateToken('|case:upper')).toMatchObject({ format: null, caseStyle: 'upper' })
  })

  it('takes only the last modifier of a kind, so an earlier one stays literal', () => {
    const parsed = parseDateToken(':YYYY|case:upper|case:lower')
    expect(parsed).toMatchObject({ format: 'YYYY|case:upper', caseStyle: 'lower' })
    expect(parseDateToken(':YYYY|startof:month|endof:quarter').bad).toBe(true)
    expect(parseDateToken(':YYYY|case:upper|startof:week|case:lower')).toMatchObject({
      format: 'YYYY|case:upper',
      snap: { boundary: 'start', unit: 'week' },
      caseStyle: 'lower',
      bad: false,
    })
    expect(parseDateToken(':YYYY|startof:week|case:lower')).toMatchObject({
      format: 'YYYY',
      snap: { boundary: 'start', unit: 'week' },
      caseStyle: 'lower',
    })
  })

  it('takes a snap and reports a misspelled unit instead of throwing', () => {
    expect(parseDateToken(':YYYY|startof:week')).toMatchObject({ snap: { boundary: 'start', unit: 'week' } })
    expect(parseDateToken(':YYYY|endof:q')).toMatchObject({ snap: { boundary: 'end', unit: 'quarter' } })
    expect(parseDateToken(':YYYY|startof:wik').badUnit).toBe('wik')
    expect(parseDateToken(':YYYY|startof:week|case:lower')).toMatchObject({
      snap: { boundary: 'start', unit: 'week' },
      caseStyle: 'lower',
    })
  })

  it('keeps a bracketed literal out of the offset scan', () => {
    expect(parseDateToken('DD[+7]')).toMatchObject({ format: null, offset: 0 })
    expect(parseDateToken(':DD[+7]')).toMatchObject({ format: 'DD[+7]', offset: 0 })
    expect(parseDateToken(':DD+7')).toMatchObject({ format: 'DD', offset: 7 })
  })
})

describe('parseValueToken', () => {
  it('treats a lone word as a label and a comma list as options', () => {
    expect(parseValueToken('Status')).toMatchObject({ variableName: 'Status', hasOptions: false, options: [] })
    expect(parseValueToken('a,b,c')).toMatchObject({ hasOptions: true, options: ['a', 'b', 'c'] })
    expect(parseValueToken('')).toMatchObject({ variableName: '', variableKey: 'value' })
  })

  it('keeps the old grammar where the tail was the default text', () => {
    expect(parseValueToken('Title|My note')).toMatchObject({ defaultValue: 'My note' })
    expect(parseValueToken('Title|default:My note')).toMatchObject({ defaultValue: 'My note' })
  })

  it('reads the option set a modern format uses', () => {
    const token = parseValueToken('a,b|custom|label:Pick|default:b|multi|format:yaml|optional|trim')
    expect(token).toMatchObject({
      hasOptions: true,
      allowCustomInput: true,
      label: 'Pick',
      defaultValue: 'b',
      multiSelect: true,
      multiFormat: 'yaml',
      optional: true,
      trim: true,
    })
    expect(token.variableKey).toBe('a,b\u001FPick')
  })

  it('maps the input types and their bounds', () => {
    expect(parseValueToken('Count|type:number|min:1|max:5|step:2')).toMatchObject({
      inputType: 'number',
      numeric: { min: 1, max: 5, step: 2 },
    })
    expect(parseValueToken('Body|type:multiline')).toMatchObject({ inputType: 'multiline' })
    expect(parseValueToken('Yes|type:boolean')).toMatchObject({ inputType: 'checkbox' })
    expect(parseValueToken('When|type:date')).toMatchObject({ inputType: 'date' })
    expect(parseValueToken('a,b|type:text').inputType).toBeNull()
  })

  it('ignores a type or multi that the grammar cannot honour', () => {
    expect(parseValueToken('Single|multi').multiSelect).toBe(false)
    expect(parseValueToken('a,b|type:number').inputType).toBeNull()
  })

  it('pairs display text with values only when the counts match', () => {
    expect(parseValueToken('a,b|text:Alpha,Beta').displayOptions).toEqual(['Alpha', 'Beta'])
    expect(parseValueToken('a,b|text:Alpha').displayOptions).toBeNull()
  })

  it('renames the variable a |name: sets, and scopes a labelled list', () => {
    expect(parseValueToken('a,b|name:status').variableKey).toBe('status')
    expect(parseValueToken('Status|name:status').variableKey).toBe('status')
  })

  it('splits quoted option lists and pipes', () => {
    expect(splitOptionList('"a, b",c')).toEqual(['a, b', 'c'])
    // The separators a Chinese keyboard produces: full width comma and ideographic comma.
    expect(splitOptionList('a\uFF0Cb\u3001c')).toEqual(['a', 'b', 'c'])
    expect(splitPipes('DATE:YYYY[|MM]|case:upper')).toEqual(['DATE:YYYY[|MM]', 'case:upper'])
  })
})

describe('parseVDateToken', () => {
  it('splits name, format and options', () => {
    expect(parseVDateToken('due, YYYY-MM-DD')).toMatchObject({ name: 'due', format: 'YYYY-MM-DD' })
    expect(parseVDateToken('due')).toMatchObject({ name: 'due', format: null })
    expect(parseVDateToken('due, YYYY-MM-DD HH:mm|time|optional|default:2026-01-01|case:upper'))
      .toMatchObject({ name: 'due', withTime: true, optional: true, defaultValue: '2026-01-01', caseStyle: 'upper' })
    expect(parseVDateToken('due, YYYY|startof:month').snap).toEqual({ boundary: 'start', unit: 'month' })
  })
})

describe('the FIELD, FILE and periodic grammars', () => {
  it('collects a FIELD filter set', () => {
    expect(parseFieldToken('status|folder:Work|tag:active|exclude-tag:done|multi|format:spaced|label:State'))
      .toMatchObject({
        fieldName: 'status',
        folder: 'Work',
        tag: 'active',
        excludeTag: 'done',
        multiSelect: true,
        multiFormat: 'spaced',
        label: 'State',
      })
  })

  it('reads a FILE scope and its output mode', () => {
    expect(parseFileToken('Journal|path|type:md,canvas|custom|multi')).toMatchObject({
      folder: 'Journal',
      mode: 'path',
      types: ['md', 'canvas'],
      allowCustomInput: true,
      multiSelect: true,
    })
    expect(parseFileToken('') .folder).toBe('')
    expect(parseFileToken('Journal|name|label:Note').label).toBe('Note')
  })

  it('parses a periodic token’s link flag and day offset', () => {
    expect(parsePeriodicToken('', 'DAILY')).toEqual({ period: 'DAILY', link: false, offset: 0 })
    expect(parsePeriodicToken('|link', 'WEEKLY')).toEqual({ period: 'WEEKLY', link: true, offset: 0 })
    expect(parsePeriodicToken('+1|link', 'MONTHLY')).toEqual({ period: 'MONTHLY', link: true, offset: 1 })
  })
})

describe('random and case', () => {
  it('bounds the random length the way the reference does', () => {
    expect(randomLengthOf('8')).toBe(8)
    expect(randomLengthOf('0')).toBeNull()
    expect(randomLengthOf('101')).toBeNull()
    expect(randomLengthOf('1.5')).toBeNull()
    expect(randomString(10, () => 0)).toBe('AAAAAAAAAA')
    expect(randomString(4, () => 0.999999)).toBe('9999')
  })

  it('applies every documented case style', () => {
    expect(applyCaseStyle('Hello World', 'kebab')).toBe('hello-world')
    expect(applyCaseStyle('Hello World', 'snake')).toBe('hello_world')
    expect(applyCaseStyle('hello world', 'camel')).toBe('helloWorld')
    expect(applyCaseStyle('hello world', 'pascal')).toBe('HelloWorld')
    expect(applyCaseStyle('hello world', 'title')).toBe('Hello World')
    expect(applyCaseStyle('Hello World', 'upper')).toBe('HELLO WORLD')
    expect(applyCaseStyle('Hello World', 'lower')).toBe('hello world')
    expect(applyCaseStyle('Hello World 2', 'kebab')).toBe('hello-world-2')
    expect(applyCaseStyle('XMLHttp request', 'title')).toBe('XML Http Request')
    expect(applyCaseStyle('iOS17 note', 'pascal')).toBe('iOS17Note')
    // The brand split puts a space between the letters and the digits, as the reference's tokenizer does.
    expect(applyCaseStyle('iOS17 note', 'title')).toBe('iOS 17 Note')
    expect(applyCaseStyle('   ', 'title')).toBe('')
  })

  it('leaves the text alone for a style it does not know', () => {
    expect(applyCaseStyle('Hello', 'keb')).toBe('Hello')
    expect(applyCaseStyle('Hello', null)).toBe('Hello')
    expect(isKnownCaseStyle('keb')).toBe(false)
    expect(isKnownCaseStyle('Title')).toBe(true)
  })
})

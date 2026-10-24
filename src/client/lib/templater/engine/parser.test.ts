import { describe, expect, it } from 'vitest'
import type { CommandToken, TemplaterParseResult } from './parser'
import type { ParserSegment } from '../protocol'
import { TemplaterError } from '../errors'
import { parseTemplate, parseTemplateOrThrow } from './parser'

function parsed(template: string): TemplaterParseResult {
  const result = parseTemplate(template)
  if (!result.ok) throw new Error(`expected a parse, got ${result.failure.code} at ${result.failure.line}:${result.failure.column}`)
  return result.output
}

function segments(template: string): ParserSegment[] {
  return parsed(template).segments
}

function texts(template: string): string[] {
  return segments(template)
    .filter((segment) => segment.kind === 'text')
    .map((segment) => (segment.kind === 'text' ? segment.text : ''))
}

function commands(template: string): CommandToken[] {
  return parsed(template).commands
}

describe('templater lexer: command kinds', () => {
  it('keeps a template with no command as one text segment', () => {
    expect(segments('just prose')).toEqual([{ kind: 'text', text: 'just prose' }])
    expect(commands('just prose')).toEqual([])
    expect(segments('')).toEqual([])
  })

  it('treats a bare opening tag as an interpolation', () => {
    const [command] = commands('<% tp.date.now() %>')
    expect(command.kind).toBe('interpolate')
    expect(command.body).toBe(' tp.date.now() ')
  })

  it('treats only the star as an execution command', () => {
    const [command] = commands('<%* tR += "x" %>')
    expect(command.kind).toBe('execute')
    expect(command.body).toBe(' tR += "x" ')
  })

  it('leaves a marker-looking character to the expression when a space follows the tag', () => {
    // `<% *x* %>` is a multiplication in Templater's own grammar: the Rust parser reads the character
    // directly after `<%`, and this app does the same rather than skipping spaces to hunt for a marker.
    const [command] = commands('<% *x* %>')
    expect(command.kind).toBe('interpolate')
    expect(command.body).toBe(' *x* ')
  })

  it('accepts the whitespace marker on either side of the type marker', () => {
    expect(commands('<%_* tR %>')[0]).toMatchObject({ kind: 'execute', whitespaceBefore: 'all' })
    expect(commands('<%*_ tR %>')[0]).toMatchObject({ kind: 'execute', whitespaceBefore: 'all' })
    expect(commands('<%*- tR %>')[0]).toMatchObject({ kind: 'execute', whitespaceBefore: 'newline' })
    expect(commands('<%*- tR -%>')[0]).toMatchObject({ kind: 'execute', whitespaceBefore: 'newline', whitespaceAfter: 'newline' })
  })

  it('reads the dash on both sides of a tag as two independent trims', () => {
    expect(texts('a\n<%- x -%>\nb')).toEqual(['a', 'b'])
  })

  it('reports a tilde marker as an invalid command instead of an execution one', () => {
    // Upstream's `ParserConfig` registers `*` and nothing else; the `[*~]` at `utils/Utils.ts:33` sits in a
    // regex the runtime never calls, so `~` means nothing here either. It is refused out loud rather than
    // compiled into a bitwise NOT nobody wrote.
    expect(parseTemplate('<%~ tp.file.title %>')).toEqual({
      ok: false,
      failure: { code: 'parse-invalid', line: 1, column: 1, detail: "'~'" },
    })
  })

  it('names each segment with the shape the frozen contract asks for', () => {
    expect(segments('a<% x %>b<%* y %>c')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'interpolate', expression: ' x ', origin: 1, line: 1 },
      { kind: 'text', text: 'b' },
      { kind: 'execute', body: ' y ', origin: 9, line: 1 },
      { kind: 'text', text: 'c' },
    ])
  })
})

describe('templater lexer: positions', () => {
  it('counts a command on a later line from the tag, 1-based', () => {
    const [command] = commands('one\ntwo\n<% tp.x %>\n')
    expect(command).toMatchObject({ line: 3, column: 1, origin: 8 })
  })

  it('counts the column of a tag that opens mid-line', () => {
    const [command] = commands('prose <% tp.x %>')
    expect(command).toMatchObject({ line: 1, column: 7 })
  })

  it('counts a second command on the same line by its own column', () => {
    const [, second] = commands('<% a %><% b %>')
    expect(second).toMatchObject({ line: 1, column: 8, origin: 7 })
  })

  it('keeps the line of a command whose body spans several lines', () => {
    const [command] = commands('x\n<%*\nlet a = 1\nlet b = 2\n%>')
    expect(command.line).toBe(2)
    expect(command.body).toBe('\nlet a = 1\nlet b = 2\n')
  })

  it('reports the opening line of an unclosed command', () => {
    expect(parseTemplate('one\ntwo\n<%* if (x) {\nmore text')).toEqual({
      ok: false,
      failure: { code: 'parse-unclosed', line: 3, column: 1, detail: '3:1' },
    })
  })

  it('reports an unclosed command that never even reaches its closing tag', () => {
    expect(parseTemplate('<%')).toEqual({
      ok: false,
      failure: { code: 'parse-unclosed', line: 1, column: 1, detail: '1:1' },
    })
  })

  it('reports an unclosed command whose string was never closed either', () => {
    // The scan runs to the end while still inside the quote, so the reader is told the tag is open, which
    // is the fact they can act on, rather than being handed a program that fails to compile later.
    const result = parseTemplate('a\n<%* tR += "oops')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.code).toBe('parse-unclosed')
  })

  it('reports the command that is open, not the first one in the template', () => {
    const result = parseTemplate('<% a %>\ntext\n<% b')
    expect(result.ok === false && result.failure).toEqual({
      code: 'parse-unclosed',
      line: 3,
      column: 1,
      detail: '3:1',
    })
  })
})

describe('templater lexer: whitespace control', () => {
  // The four rules of the upstream whitespace-control page, taken one at a time because each throws away a
  // different amount of text.
  it('throws away every whitespace before a command with an underscore at the start', () => {
    expect(texts('title   \t  \n  <%_ x %>tail')).toEqual(['title', 'tail'])
  })

  it('throws away every whitespace after a command with an underscore at the end', () => {
    expect(texts('head <% x _%>   \n\n  tail')).toEqual(['head ', 'tail'])
  })

  it('throws away one newline before a command with a dash at the start', () => {
    expect(texts('head\n<%- x %>tail')).toEqual(['head', 'tail'])
  })

  it('throws away one newline after a command with a dash at the end', () => {
    expect(texts('head <% x -%>\ntail')).toEqual(['head ', 'tail'])
  })

  it('throws away one newline and not the blank line beside it', () => {
    expect(texts('<% x -%>\n\ntail')).toEqual(['\ntail'])
    expect(texts('head\n\n<%- x %>')).toEqual(['head\n'])
  })

  it('leaves a newline that is not touching the tag alone', () => {
    // The literal reading of "trim one newline": a newline separated from the tag by spaces is not the
    // character the marker is attached to, and a third trimming rule would be an invention.
    expect(texts('head\n   <% x -%>   \ntail')).toEqual(['head\n   ', '   \ntail'])
  })

  it('trims both sides of one command at once', () => {
    expect(texts('head\n   <%_ x _%>\ntail')).toEqual(['head', 'tail'])
  })

  it('produces the document example exactly as the whitespace-control page says it reads', () => {
    const template = [
      '<%* if (tp.file.title == "MyFile" ) { -%>',
      'This is my file!',
      '<%* } else { -%>',
      "This isn't my file!",
      '<%* } -%>',
      'Some content ...',
    ].join('\n')
    const parts = segments(template)
    expect(parts.map((segment) => segment.kind)).toEqual(['execute', 'text', 'execute', 'text', 'execute', 'text'])
    expect(parts.filter((segment) => segment.kind === 'text').map((segment) => (segment.kind === 'text' ? segment.text : '')))
      .toEqual(['This is my file!\n', "This isn't my file!\n", 'Some content ...'])
    const executions = parts.filter((segment) => segment.kind === 'execute')
    expect(executions.map((segment) => (segment.kind === 'execute' ? segment.body : '')))
      .toEqual([' if (tp.file.title == "MyFile" ) { ', ' } else { ', ' } '])
    expect(executions.map((segment) => segment.line)).toEqual([1, 3, 5])
  })

  it('counts a CRLF as the one newline a dash trims', () => {
    expect(texts('head\r\n<%- x %>tail')).toEqual(['head', 'tail'])
    expect(texts('head <% x -%>\r\ntail')).toEqual(['head ', 'tail'])
  })

  it('keeps other line endings exactly as the template wrote them', () => {
    expect(texts('a\r\nb<% x %>c\r\nd')).toEqual(['a\r\nb', 'c\r\nd'])
  })

  it('drops a text segment the trimming emptied', () => {
    expect(segments('<% x %>\n<%_ y %>')).toEqual([
      { kind: 'interpolate', expression: ' x ', origin: 0, line: 1 },
      { kind: 'interpolate', expression: ' y ', origin: 8, line: 2 },
    ])
  })
})

describe('templater lexer: closing tags and what looks like one', () => {
  it('takes a lone closing tag in prose as prose', () => {
    expect(segments('a %> b')).toEqual([{ kind: 'text', text: 'a %> b' }])
  })

  it('does not close a command at a delimiter inside a string', () => {
    const [command] = commands('<%* tR += "a%>b" %>')
    expect(command.body).toBe(' tR += "a%>b" ')
    expect(command.kind).toBe('execute')
  })

  it('does not close a command at a delimiter inside a comment', () => {
    const [command] = commands('<%* // says %> here\ntR += "x" %>')
    expect(command.body).toBe(' // says %> here\ntR += "x" ')
  })

  it('does not close a command at a delimiter inside a block comment', () => {
    const [command] = commands('<%* /* says %> here */ tR += 1 %>')
    expect(command.body).toBe(' /* says %> here */ tR += 1 ')
  })

  it('does not close a command at a delimiter inside a template literal, even in a substitution', () => {
    const [command] = commands('<%* tR += `x${ "a%>b" }y` %>')
    expect(command.body).toBe(' tR += `x${ "a%>b" }y` ')
  })

  it('does not treat an escaped quote as the end of a string', () => {
    const [command] = commands('<%* tR += "say \\"%>\\"" %>')
    expect(command.body).toBe(' tR += "say \\"%>\\"" ')
  })

  it('does not treat an opening tag inside a string as a new command', () => {
    expect(segments('<%* tR += "<%" %>_after')).toEqual([
      { kind: 'execute', body: ' tR += "<%" ', origin: 0, line: 1 },
      { kind: 'text', text: '_after' },
    ])
  })

  it('ends a command at a delimiter inside a regex literal, which is a known limit', () => {
    // Resolving a `/` into a regex or a division needs the JavaScript parser this engine deliberately does
    // not have, so the tag closes early and the program compiled from it fails in the VM, naming the line.
    // Asserted so the limit is a fact on the record rather than a rumour.
    const [command] = commands('<%* tR += "a".replace(/x%>/, "b") %>')
    expect(command.body).toBe(' tR += "a".replace(/x')
  })
})

describe('templater lexer: dynamic commands', () => {
  it('hands a plus command back rather than compiling it', () => {
    const output = parsed('<%+ tp.file.last_modified_date() %>')
    expect(output.commands.map((command) => command.kind)).toEqual(['dynamic'])
    expect(output.dynamicCommands).toEqual([
      { body: ' tp.file.last_modified_date() ', execution: false, raw: '<%+ tp.file.last_modified_date() %>', origin: 0, line: 1, column: 1 },
    ])
    expect(output.segments.filter((segment) => segment.kind !== 'text')).toEqual([])
  })

  it('leaves the command in the text as the author wrote it, markers included', () => {
    expect(segments('before <%+ tp.x %> after')).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'text', text: '<%+ tp.x %>' },
      { kind: 'text', text: ' after' },
    ])
  })

  it('still applies whitespace control around a dynamic command', () => {
    expect(texts('a\n<%-+ tp.x -%>\nb')).toEqual(['a', '<%-+ tp.x -%>', 'b'])
  })

  it('reads a plus after the star as a dynamic execution command', () => {
    expect(parsed('<%*+ tp.user.script() %>').dynamicCommands).toMatchObject([{ execution: true, body: ' tp.user.script() ' }])
  })

  it('reports an unclosed dynamic command as unclosed, not as text', () => {
    const result = parseTemplate('a\n<%+ tp.x')
    expect(result.ok === false && result.failure).toEqual({
      code: 'parse-unclosed',
      line: 2,
      column: 1,
      detail: '2:1',
    })
  })
})

describe('templater lexer: empty commands', () => {
  it('keeps an empty interpolation as a command that produces nothing', () => {
    expect(segments('<% %>')).toEqual([{ kind: 'interpolate', expression: ' ', origin: 0, line: 1 }])
    expect(segments('<%%>')).toEqual([{ kind: 'interpolate', expression: '', origin: 0, line: 1 }])
  })

  it('keeps an empty execution command', () => {
    expect(segments('<%*%>')).toEqual([{ kind: 'execute', body: '', origin: 0, line: 1 }])
  })
})

describe('templater lexer: the throwing form', () => {
  it('throws a coded error carrying the position a reader can navigate to', () => {
    expect(() => parseTemplateOrThrow('a\n<%* if (x) {')).toThrowError(TemplaterError)
    expect(() => parseTemplateOrThrow('a\n<%* if (x) {')).toThrow('parse-unclosed: 2:1')
    expect(() => parseTemplateOrThrow('<%~ x %>')).toThrow('parse-invalid: 1:1')
  })

  it('returns the parse when there is nothing to complain about', () => {
    expect(parseTemplateOrThrow('a <% x %> b').line).toBe(1)
  })

  it('points the default position at the first command, which is where a reader should land', () => {
    expect(parsed('a\nb\n<% x %><% y %>').origin).toBe(4)
    expect(parsed('a\nb\n<% x %><% y %>').line).toBe(3)
    expect(parsed('no commands at all').origin).toBe(0)
    expect(parsed('no commands at all').line).toBe(1)
  })
})

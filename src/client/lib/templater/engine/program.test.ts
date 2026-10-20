import { describe, expect, it } from 'vitest'
import type { CompiledProgram } from './program'
import { compileTemplate, templatePositionFor } from './program'

function compile(template: string): CompiledProgram {
  const result = compileTemplate(template)
  if (!result.ok) throw new Error(`expected a program, got ${result.failure.code} at ${result.failure.line}:${result.failure.column}`)
  return result.program
}

function lines(source: string): string[] {
  return source.split('\n')
}

/** The generated line a piece of text sits on, 1-based, which is the form a VM reports it in. */
function generatedLineOf(program: CompiledProgram, needle: string): number {
  const index = lines(program.source).findIndex((line) => line.includes(needle))
  if (index === -1) throw new Error(`${needle} is not in the generated program:\n${program.source}`)
  return index + 1
}

/** The single output statement of a program, as the text the note would get. */
function renderedOf(statement: string | undefined): string {
  const prefix = '  tR += '
  if (!statement || !statement.startsWith(prefix) || !statement.endsWith(';')) {
    throw new Error(`not one output statement: ${statement}`)
  }
  // Reading it back with the same parser the interpreter uses is the proof: this only answers with the
  // template's own text if the text stayed a string literal instead of becoming program source.
  return JSON.parse(statement.slice(prefix.length, -1)) as string
}

function onlyStatement(program: CompiledProgram): string | undefined {
  return lines(program.source).find((line) => line.startsWith('  tR += '))
}

describe('templater program: the single async body', () => {
  it('wraps a whole template in exactly one async function', () => {
    const program = compile('<%* let a = 1 %>\n<%* log(a) %>')
    expect(program.source.match(/\(async \(\) => \{/g)).toHaveLength(1)
    // One `async` means one function boundary: a wrapper per command is the design this file exists to
    // avoid, and it is the reason Templater's scope rule cannot be honoured command by command.
    expect(program.source.match(/async/g)).toHaveLength(1)
    expect(lines(program.source)[0]).toBe('(async () => {')
    expect(lines(program.source)[1]).toBe('  let tR = "";')
    expect(lines(program.source).at(-2)).toBe('})()')
  })

  it('names the source so a stack trace says where the code came from', () => {
    expect(lines(compile('text').source).at(-1)).toBe('//# sourceURL=templater-template.js')
  })

  it('keeps a later command able to see what an earlier one declared', () => {
    // One body is the whole point: `function log` and its call are separate commands, and a program per
    // command would lose the declaration between them.
    const program = compile('<%* function log(m) { tR += m } %><%* log("hi") %>')
    expect(program.source).toContain('function log(m) { tR += m }')
    expect(program.source).toContain('log("hi")')
    expect(program.source.indexOf('function log')).toBeLessThan(program.source.indexOf('   log("hi")'))
  })

  it('leaves every command inside the one function scope, and none of them outside it', () => {
    const body = lines(compile('<%* function log(m) { tR += m } %>said<%* log("hi") %>').source)
    const opens = body.indexOf('(async () => {')
    const closes = body.indexOf('  return tR;')
    const declaration = body.findIndex((line) => line.includes('function log'))
    const call = body.findIndex((line) => line.includes('log("hi")'))
    expect(opens).toBe(0)
    expect(declaration).toBeGreaterThan(opens)
    expect(call).toBeGreaterThan(declaration)
    expect(closes).toBeGreaterThan(call)
  })

  it('lets a block opened in one command close in the next', () => {
    const body = lines(compile('<%* if (tp.file.title == "a") { %>yes<%* } %>').source)
    const open = body.findIndex((line) => line.includes('if ('))
    const write = body.findIndex((line) => line.includes('tR += "yes"'))
    const close = body.findIndex((line) => line.trim() === '}')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(write).toBeGreaterThan(open)
    expect(close).toBeGreaterThan(write)
  })

  it('emits text as an append and an execution command verbatim', () => {
    const program = compile('prose<%* tR += "code" %>tail')
    expect(program.source).toContain('  tR += "prose";')
    expect(program.source).toContain('  tR += "code" ')
    expect(program.source).toContain('  tR += "tail";')
  })

  it('awaits an interpolated expression the author did not mark', () => {
    expect(compile('<% tp.file.exists("x") %>').source).toContain('  tR += String(await ( tp.file.exists("x") ));')
  })

  it('keeps tR readable, writable and resettable', () => {
    const program = compile('<%* tR = "" %>')
    expect(program.source).toContain('  let tR = "";')
    expect(program.source).toContain('  tR = "" ')
  })

  it('returns the accumulator as the value of the program', () => {
    expect(lines(compile('a').source)).toContain('  return tR;')
  })

  it('carries the template it was built from', () => {
    expect(compile('a <% x %> b').template).toBe('a <% x %> b')
  })

  it('counts the commands it compiled', () => {
    expect(compile('a<% x %><%* y %><%+ z %>').commandCount).toBe(2)
    expect(compile('no commands').commandCount).toBe(0)
  })
})

describe('templater program: text can only ever be data', () => {
  // Each case is read back through the same JSON the interpreter reads, which only answers with the
  // template's own text if that text stayed one string literal rather than becoming program source.
  const cases: { name: string, prose: string }[] = [
    { name: 'quotes and a statement break', prose: '"; alert(1); //' },
    { name: 'a backtick and a substitution', prose: 'outside `inside ${evil}` done' },
    { name: 'a closing script tag', prose: 'note </script><script>alert(1)</script>' },
    { name: 'a backslash and a raw eval call', prose: 'C:\\path\\ eval("alert(1)") end' },
    { name: 'a lone closing tag', prose: 'a %> b' },
    { name: 'a newline and a tab', prose: 'first\n\tsecond' },
  ]

  for (const testCase of cases) {
    it(`keeps ${testCase.name} inside one string literal`, () => {
      const program = compile(testCase.prose)
      const statements = lines(program.source).filter((line) => line.startsWith('  tR += '))
      expect(statements).toHaveLength(1)
      expect(renderedOf(statements[0])).toBe(testCase.prose)
      // Nothing of the payload reached the program outside the literal: a statement break would have put
      // `alert(1)` on a line of its own, and a script tag would have survived unescaped.
      expect(lines(program.source).some((line) => line.trim() === 'alert(1);')).toBe(false)
      expect(program.source).not.toContain('</script>')
      expect(program.commandCount).toBe(0)
    })
  }

  it('keeps a JavaScript line separator from becoming a line of the program', () => {
    // The interpreter counts U+2028 and U+2029 as line breaks, so one left raw in prose would shift every
    // position the program reports after it by a line the compiler never emitted.
    const separator = String.fromCharCode(0x2028)
    const program = compile(`first${separator}second\n<%* let a = 1 %>`)
    expect(program.source).not.toContain(separator)
    expect(renderedOf(onlyStatement(program))).toBe(`first${separator}second\n`)
    expect(templatePositionFor(program, generatedLineOf(program, 'let a = 1'))?.line).toBe(2)
  })

  it('writes no raw angle bracket into the program at all', () => {
    expect(compile('note </script> here').source).not.toContain('</script>')
  })

  it('escapes a quote inside prose without changing what the note gets', () => {
    const program = compile('say "hi"')
    expect(onlyStatement(program)).toBe('  tR += "say \\"hi\\"";')
    expect(renderedOf(onlyStatement(program))).toBe('say "hi"')
  })

  it('keeps a CRLF in prose as the two characters it was', () => {
    expect(renderedOf(onlyStatement(compile('a\r\nb')))).toBe('a\r\nb')
  })

  it('emits one statement per text segment, and none for one the trimming emptied', () => {
    const program = compile('a<%_ x _%>b')
    expect(lines(program.source).filter((line) => line.startsWith('  tR += "'))).toHaveLength(2)
  })
})

describe('templater program: empty commands', () => {
  it('compiles a blank interpolation to an empty append', () => {
    expect(compile('<% %>').source).toContain('  tR += "";')
  })

  it('compiles a blank execution command to an empty statement', () => {
    expect(compile('<%*%>').source).toContain('  ;')
  })
})

describe('templater program: dynamic commands', () => {
  it('leaves a dynamic command in the output as text rather than running it', () => {
    const program = compile('<%+ tp.file.last_modified_date() %>')
    expect(program.commandCount).toBe(0)
    expect(program.lineMap).toEqual([])
    expect(program.source).not.toContain('String(await (')
    expect(renderedOf(onlyStatement(program))).toBe('<%+ tp.file.last_modified_date() %>')
  })

  it('keeps a dynamic execution command out of the program too', () => {
    const program = compile('<%*+ tp.user.script() %>')
    expect(program.lineMap).toEqual([])
    expect(program.source).not.toContain('String(await (')
    expect(renderedOf(onlyStatement(program))).toBe('<%*+ tp.user.script() %>')
  })
})

describe('templater program: line mapping', () => {
  const template = [
    'line one',
    '<%* let a = 1 %>',
    'line three',
    '<% tp.file.title %>',
    'line five',
    '<%*',
    '  const broken = (',
    '%>',
  ].join('\n')

  it('names the template line of every command it compiled', () => {
    expect(compile(template).lineMap).toEqual([
      { command: 0, line: 2, column: 1 },
      { command: 1, line: 4, column: 1 },
      { command: 2, line: 6, column: 1 },
    ])
  })

  it('turns a failure inside the third command back into its template line', () => {
    const program = compile(template)
    expect(templatePositionFor(program, generatedLineOf(program, 'const broken'))).toEqual({ command: 2, line: 7, column: 1 })
  })

  it('maps an interpolation that failed on the line its tag opened', () => {
    const program = compile(template)
    expect(templatePositionFor(program, generatedLineOf(program, 'String(await'))).toEqual({ command: 1, line: 4, column: 1 })
  })

  it('maps the first line of a multi-line execution command', () => {
    const program = compile(template)
    expect(templatePositionFor(program, generatedLineOf(program, 'let a = 1'))).toEqual({ command: 0, line: 2, column: 1 })
  })

  it('refuses to invent a template line for the wrapper', () => {
    const program = compile(template)
    const total = lines(program.source).length
    expect(templatePositionFor(program, 1)).toBeNull()
    expect(templatePositionFor(program, 2)).toBeNull()
    expect(templatePositionFor(program, total)).toBeNull()
    expect(templatePositionFor(program, total - 1)).toBeNull()
    expect(templatePositionFor(program, total - 2)).toBeNull()
  })

  it('maps a command that opens mid-line to the column of its tag', () => {
    const program = compile('a\nprose <%* let x = 1 %> more\nb')
    expect(program.lineMap).toEqual([{ command: 0, line: 2, column: 7 }])
    expect(templatePositionFor(program, generatedLineOf(program, 'let x = 1'))).toEqual({ command: 0, line: 2, column: 7 })
  })

  it('keeps a span for every command it compiled, covering its own lines', () => {
    const program = compile(template)
    expect(program.spans).toHaveLength(3)
    for (const span of program.spans) {
      expect(span.endLine).toBeGreaterThanOrEqual(span.startLine)
      expect(program.lineMap[span.command]).toBeTruthy()
      expect(templatePositionFor(program, span.startLine)?.command).toBe(span.command)
    }
  })

  it('counts the generated lines of a multi-line command so a later line still maps inside it', () => {
    const program = compile(template)
    const span = program.spans[2]
    expect(span.endLine - span.startLine).toBe(2)
    expect(templatePositionFor(program, span.endLine)?.line).toBe(8)
  })
})

describe('templater program: a template that does not parse', () => {
  it('returns the parse failure instead of a program', () => {
    expect(compileTemplate('one\ntwo\n<%* if (x) {')).toEqual({
      ok: false,
      failure: { code: 'parse-unclosed', line: 3, column: 1, detail: '3:1' },
    })
  })

  it('refuses the tilde marker before any code is generated', () => {
    expect(compileTemplate('<%~ x %>')).toMatchObject({ ok: false, failure: { code: 'parse-invalid' } })
  })
})

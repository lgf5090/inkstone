import { describe, expect, it } from 'vitest'
import { detectEngine, findCommandStart, templateRisk } from './detection'

describe('engine detection', () => {
  it('keeps the app’s own tokens on the legacy renderer', () => {
    expect(detectEngine('Hello {{title}}, today is {{date}}')).toBe('legacy')
    expect(detectEngine('')).toBe('legacy')
    expect(detectEngine('Plain prose with no tokens at all.')).toBe('legacy')
  })

  it('sends every command form to Templater', () => {
    for (const opener of ['<% ', '<%* ', '<%-', '<%_', '<%+', '<%~']) {
      expect(detectEngine(`${opener}tp.file.title %>`), opener).toBe('templater')
    }
  })

  it('reports where the command begins, so a caller can show the reader the line', () => {
    expect(findCommandStart('a\nb<% tp.file.title %>\n')).toBe(3)
    expect(findCommandStart('nothing here')).toBe(-1)
  })

  it('treats an unbalanced opener as Templater rather than falling back silently', () => {
    // Choosing the other engine here would expand `{{…}}` and hide the parse error the reader needs.
    expect(detectEngine('start <% tp.date.now()')).toBe('templater')
  })

  it('reads a mention of the delimiter in prose as a command, and says so through the badge', () => {
    // The documented cost of deriving the engine instead of storing a flag.
    expect(detectEngine('Write `<% tp.file.title %>` to insert the title.')).toBe('templater')
  })
})

describe('risk detection', () => {
  it('flags only interpolation as non-executable', () => {
    expect(templateRisk('<% tp.file.title %>')).toEqual({
      engine: 'templater',
      executable: false,
      userScripts: false,
      network: false,
    })
  })

  it('flags an execution command', () => {
    expect(templateRisk('<%* tR += "x" %>').executable).toBe(true)
  })

  it('flags user scripts and the network separately, because the warnings differ', () => {
    const scripts = templateRisk('<% tp.user.build(tR) %>')
    expect(scripts.userScripts).toBe(true)
    expect(scripts.network).toBe(false)

    const web = templateRisk('<% await tp.web.request("https://example.test") %>')
    expect(web.network).toBe(true)
    expect(web.userScripts).toBe(false)
  })

  it('leaves a legacy template with no risk signal', () => {
    expect(templateRisk('{{title}}')).toEqual({
      engine: 'legacy',
      executable: false,
      userScripts: false,
      network: false,
    })
  })

  it('does not read a token boundary as a word break', () => {
    // `myapp.user.name` must not light the user-scripts badge.
    expect(templateRisk('<% tp.frontmatter.owner %>').userScripts).toBe(false)
    expect(templateRisk('see app.userdetails here').userScripts).toBe(false)
    expect(templateRisk('<% tp.userx() %>').userScripts).toBe(false)
  })
})

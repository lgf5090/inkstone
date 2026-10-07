import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownBlocks } from '../lib/markdown/renderer'
import {
  clearInlineFormatting,
  convertCase,
  convertWidth,
  lineTool,
  normalizeHexColor,
  numberLines,
  setFontColor,
  setHighlightColor,
  toggleSubscript,
  toggleSuperscript,
  toggleUnderline,
  wrapLines,
  type LineTool,
} from './text-format'

function apply(doc: string, command: StateCommandLike, selection?: { anchor: number, head: number }): { handled: boolean, doc: string } {
  let state = EditorState.create({ doc, selection: selection ? EditorSelection.range(selection.anchor, selection.head) : undefined })
  const handled = command({ state, dispatch: (update: unknown) => { state = (update as { state: EditorState }).state } })
  return { handled, doc: state.doc.toString() }
}

type StateCommandLike = (target: { state: EditorState, dispatch: (update: unknown) => void }) => boolean

/** Every case below reads as "select the whole note, press the button". */
function press(doc: string, command: StateCommandLike): string {
  return apply(doc, command, { anchor: 0, head: doc.length }).doc
}

function caret(doc: string, at: number, command: StateCommandLike): string {
  return apply(doc, command, { anchor: at, head: at }).doc
}

describe('normalizeHexColor', () => {
  it('expands shorthand and rejects anything that is not a plain hex colour', () => {
    expect(normalizeHexColor('#abc')).toBe('#aabbcc')
    expect(normalizeHexColor('ABC')).toBe('#aabbcc')
    expect(normalizeHexColor('#12345678')).toBe('#123456')
    expect(normalizeHexColor('#12345')).toBeNull()
    expect(normalizeHexColor('red')).toBeNull()
    expect(normalizeHexColor('#fff; background:url(//x)')).toBeNull()
  })
})

describe('the tag wrappers', () => {
  it('wrap a selection and unwrap it again', () => {
    expect(press('cd', toggleUnderline)).toBe('<u>cd</u>')
    expect(press('<u>cd</u>', toggleUnderline)).toBe('cd')
    expect(press('x', toggleSuperscript)).toBe('<sup>x</sup>')
    expect(press('<sup>x</sup>', toggleSuperscript)).toBe('x')
    expect(press('x', toggleSubscript)).toBe('<sub>x</sub>')
  })

  it('take the word under a collapsed caret', () => {
    expect(caret('ab water c', 4, toggleUnderline)).toBe('ab <u>water</u> c')
  })
})

describe('setFontColor', () => {
  it('writes the one form a note stores', () => {
    expect(press('note', setFontColor('#E11D48'))).toBe('<font color="#e11d48">note</font>')
  })

  it('recolours an already coloured run instead of nesting a second tag', () => {
    const once = press('note', setFontColor('#e11d48'))
    expect(press(once, setFontColor('#2563eb'))).toBe('<font color="#2563eb">note</font>')
  })

  it('removes the tag when the same colour is asked for twice', () => {
    expect(press(press('note', setFontColor('#e11d48')), setFontColor('#e11d48'))).toBe('note')
  })

  it('colours every line of a multi-line selection on its own', () => {
    expect(press('first\n\nsecond', setFontColor('#059669')))
      .toBe('<font color="#059669">first</font>\n\n<font color="#059669">second</font>')
  })

  it('keeps a block marker outside the tag so the line stays what it was', () => {
    expect(press('- buy milk', setFontColor('#059669'))).toBe('- <font color="#059669">buy milk</font>')
    expect(press('# Heading', setFontColor('#059669'))).toBe('# <font color="#059669">Heading</font>')
    expect(press('> quoted', setFontColor('#059669'))).toBe('> <font color="#059669">quoted</font>')
    expect(press('1. item', setFontColor('#059669'))).toBe('1. <font color="#059669">item</font>')
  })

  it('clears colour without touching any other wrapper', () => {
    expect(press('**<font color="#059669">kept</font>**', setFontColor(null))).toBe('**kept**')
  })

  it('refuses a colour it cannot write', () => {
    expect(apply('note', setFontColor('not-a-colour'), { anchor: 0, head: 4 })).toEqual({ handled: false, doc: 'note' })
  })
})

describe('setHighlightColor', () => {
  it('writes a wash whose background reaches the page', () => {
    expect(press('note', setHighlightColor('#f79646'))).toBe('<mark style="background:#f7964659">note</mark>')
    expect(press('<mark style="background:#f7964659">note</mark>', setHighlightColor('#adefef'))).toBe('<mark style="background:#adefef59">note</mark>')
    expect(press('<mark style="background:#adefef59">note</mark>', setHighlightColor('#adefef'))).toBe('note')
    expect(press('<mark style="background:#adefef59">note</mark>', setHighlightColor(null))).toBe('note')
  })

  it('replaces a solid highlight the author wrote by hand with the wash', () => {
    expect(press('<mark style="background:#f79646">note</mark>', setHighlightColor('#f79646'))).toBe('<mark style="background:#f7964659">note</mark>')
  })

  it('leaves a plain ==highlight== alone until a colour is chosen', () => {
    expect(press('==lit==', setHighlightColor('#f79646'))).toBe('<mark style="background:#f7964659">==lit==</mark>')
  })
})

describe('clearInlineFormatting', () => {
  it('drops every inline decoration and keeps the words', () => {
    const doc = '**bold** and *em* and ~~gone~~ and ==lit== and <u>line</u> and <font color="#059669">hue</font> and <mark style="background:#fff">back</mark> and <sup>up</sup>'
    expect(press(doc, clearInlineFormatting))
      .toBe('bold and em and gone and lit and line and hue and back and up')
  })

  it('unwraps nested decoration in one press', () => {
    expect(press('**<u>*x_*</u>**', clearInlineFormatting)).toBe('x_')
  })

  it('leaves code spans, maths and comments exactly as written', () => {
    const doc = 'run `a**b` now $x*y$ and %%**hidden**%%'
    expect(press(doc, clearInlineFormatting)).toBe(doc)
  })

  it('keeps a link target intact while clearing the label around it', () => {
    expect(press('**[site](https://ex.com/a_b)**', clearInlineFormatting)).toBe('[site](https://ex.com/a_b)')
  })

  it('clears a stray closing tag left by a half-finished run', () => {
    expect(press('<u>open</u>', clearInlineFormatting)).toBe('open')
    expect(press('dangling</u>', clearInlineFormatting)).toBe('dangling')
  })
})

describe('convertCase', () => {
  it('answers each mode', () => {
    const doc = 'hello wide World'
    expect(press(doc, convertCase('upper'))).toBe('HELLO WIDE WORLD')
    expect(press(doc, convertCase('lower'))).toBe('hello wide world')
    expect(press(doc, convertCase('title'))).toBe('Hello Wide World')
    expect(press(doc, convertCase('inverse'))).toBe('HELLO WIDE wORLD')
    expect(press('who are you. i am here.', convertCase('sentence'))).toBe('Who are you. I am here.')
  })

  it('never rewrites a code span or a URL', () => {
    const doc = 'call `getUserName` at https://ex.com/GetUser'
    expect(press(doc, convertCase('upper'))).toBe('CALL `getUserName` AT https://ex.com/GetUser')
  })

  it('takes the word under a collapsed caret', () => {
    expect(caret('abc def', 1, convertCase('upper'))).toBe('ABC def')
  })

  it('never re-cases the markup of a tag the toolbar itself wrote', () => {
    expect(press('<font color="#059669">note</font> and <u>line</u>', convertCase('upper')))
      .toBe('<font color="#059669">NOTE</font> AND <u>LINE</u>')
  })
})

describe('convertWidth', () => {
  it('turns half-width punctuation full-width without touching the line structure', () => {
    expect(press('1. buy(a,b)', convertWidth('full'))).toBe('1. buy（a，b）')
    expect(press('你好，世界.', convertWidth('full'))).toBe('你好，世界。')
  })

  it('turns full-width forms back to half-width, including digits and the ideographic space', () => {
    expect(press('Ａ１（ｘ）　Ｑ', convertWidth('half'))).toBe('A1(x) Q')
    expect(press('第三。、章', convertWidth('half'))).toBe('第三.,章')
  })

  it('protects code, maths, comments, links and URLs from both directions', () => {
    expect(press('`，。` $，$ %%，%% [[，]] [，](https://ex.com/，) ，', convertWidth('half')))
      .toBe('`，。` $，$ %%，%% [[，]] [，](https://ex.com/，) ,')
  })
})

describe('line tools', () => {
  const doc = 'alpha  beta  \n  gamma\n\n  gamma  \nalpha'

  function tool(name: LineTool, source = doc): string {
    return press(source, lineTool(name))
  }

  it('trims trailing whitespace and both ends', () => {
    expect(tool('trim-end')).toBe('alpha  beta\n  gamma\n\n  gamma\nalpha')
    expect(tool('trim-lines')).toBe('alpha  beta\ngamma\n\ngamma\nalpha')
  })

  it('collapses runs of spaces behind the indentation and past the line break', () => {
    expect(tool('compress-spaces')).toBe('alpha beta  \n  gamma\n\n  gamma  \nalpha')
  })

  it('joins the touched lines into one', () => {
    expect(tool('join-lines', 'one\ntwo\nthree')).toBe('one two three')
    expect(tool('join-lines', 'one\n\ntwo')).toBe('one two')
  })

  it('removes blank lines but never the only line', () => {
    expect(tool('remove-blank-lines')).toBe('alpha  beta  \n  gamma\n  gamma  \nalpha')
    expect(tool('remove-blank-lines', '\n')).toBe('\n')
  })

  it('puts one blank line between neighbours and keeps the ones already there', () => {
    expect(tool('blank-lines-between', 'one\ntwo\n\nthree')).toBe('one\n\ntwo\n\nthree')
  })

  it('keeps the first of a repeated line, comparing past indentation', () => {
    expect(tool('dedupe-lines')).toBe('alpha  beta  \n  gamma\n\nalpha')
  })

  it('does nothing to a single line it was handed', () => {
    expect(tool('join-lines', 'only')).toBe('only')
  })
})

describe('numberLines and wrapLines', () => {
  it('numbers each line through the {n} token or a plain prefix', () => {
    expect(press('a\nb', numberLines('{n}. '))).toBe('1. a\n2. b')
    expect(press('a\nb', numberLines('· '))).toBe('· 1a\n· 2b')
    expect(press('- a\n- b', numberLines('{n}) '))).toBe('- 1) a\n- 2) b')
  })

  it('starts a fresh count for each press and skips a blank line', () => {
    expect(press('a\n\nb', numberLines('{n}. '))).toBe('1. a\n\n2. b')
    expect(press('a\nb', numberLines('{n}. ', 5))).toBe('5. a\n6. b')
    expect(press(press('a\nb', numberLines('{n}. ')), numberLines('{n}. '))).toBe('1. 1. a\n2. 2. b')
  })

  it('wraps the content of every line on both sides', () => {
    expect(press('a\nb', wrapLines('>', '<'))).toBe('>a<\n>b<')
    expect(press('- a', wrapLines('(', ')'))).toBe('- (a)')
  })
})

describe('rendered markup', () => {
  it('keeps the colour a toolbar press wrote all the way to the page', () => {
    const html = renderMarkdown('<font color="#e11d48">red</font> and <mark style="background:#f79646">lit</mark> and <u>line</u> and <sup>up</sup> and <sub>down</sub>').html
    expect(html).toContain('<font color="#e11d48">red</font>')
    expect(html).toContain('<mark style="background:#f79646">lit</mark>')
    expect(html).toContain('<u>line</u>')
    expect(html).toContain('<sup>up</sup>')
    expect(html).toContain('<sub>down</sub>')
  })

  it('still strips a style that is not one plain colour', () => {
    const html = renderMarkdown('<mark style="background:url(https://ex.com/x)">lit</mark><span style="color:red;position:fixed">x</span><mark style="background:#fff">ok</mark>').html
    expect(html).not.toContain('url(')
    expect(html).not.toContain('position')
    expect(html).not.toContain('color:red')
    expect(html).toContain('<mark style="background:#fff">ok</mark>')
  })

  it('keeps the colour in the live-preview block path too', () => {
    const source = '<font color="#e11d48">red</font> and <mark style="background:#f79646">lit</mark>'
    const blocks = renderMarkdownBlocks(`${source}\n\nsecond paragraph\n`).blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.html).toContain('<font color="#e11d48">red</font>')
    expect(blocks[0]!.html).toContain('<mark style="background:#f79646">lit</mark>')
  })

  it('accepts a colour another editor wrote with a space after the colon', () => {
    expect(renderMarkdown('<mark style="background: #F79646">lit</mark>').html).toContain('background: #F79646')
  })

  it('does not let the exemption through to the outline label', () => {
    const html = renderMarkdown('# <mark style="background:#f79646">title</mark>').headings
    expect(html).toHaveLength(1)
  })
})

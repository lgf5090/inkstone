import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { findSlideIndexByOffset, splitIntoSlides, splitIntoSlidesWithNotes, takeLayoutDirective } from './slides'

describe('splitIntoSlides — separators and code fences', () => {
  it('returns the whole note as a single slide when there is no separator', () => {
    expect(splitIntoSlides('# Title\n\nbody')).toEqual(['# Title\n\nbody'])
  })

  it('splits on blank-line-surrounded --- separators and drops the separator line', () => {
    expect(splitIntoSlides('# First\n\n---\n\n# Second')).toEqual(['# First', '# Second'])
  })

  it('keeps a --- glued to the line above as a setext heading inside one slide', () => {
    const source = 'Title\n---\n\nbody'
    expect(splitIntoSlides(source)).toEqual([source])
  })

  it('does not split on --- inside fenced code blocks', () => {
    const slide = '```yaml\nkey: value\n---\nstill: code\n```'
    expect(splitIntoSlides(`${slide}\n\n---\n\n# Next`)).toEqual([slide, '# Next'])
  })

  it('does not split on --- inside tilde fenced code blocks', () => {
    const slide = '~~~\n---\n~~~'
    expect(splitIntoSlides(`${slide}\n\n---\n\n# Next`)).toEqual([slide, '# Next'])
  })

  it('does not split on a 4-space indented ---- code block line', () => {
    const source = 'text\n\n    ----\n\nmore'
    expect(splitIntoSlides(source)).toEqual([source])
  })

  it('splits on --- with trailing spaces or extra hyphens', () => {
    expect(splitIntoSlides('# A\n\n----  \n\n# B')).toEqual(['# A', '# B'])
  })
})

// The deck divides where the projector draws a rule, and nowhere else. The answer is asked of the
// app's own Markdown pipeline rather than written down here, because a hand-copied expectation is
// exactly what drifted: the pager used to know only `---` while the renderer also draws `***`,
// `___` and `- - -`, and folds a `---` glued to prose into a setext heading instead.
const SPELLINGS = ['---', '-----', '***', '___', '- - -', '-  -\t-', ' ---', '  ---', '   ---', '    ---', '----- ', '--', '- -', '*', '= = =', '_ _', ' * * *', '\t---', '  ___  ', '----\t', '=', '===']
const CONTEXTS: [string, string][] = [
  ['a blank line', ''],
  ['a paragraph', 'Some prose'],
  ['a multi-line paragraph', 'Some prose\nmore prose'],
  ['an ATX heading', '## Section'],
  ['a list item', '- item one'],
  ['an ordered item', '1. item one'],
  ['a nested list item', '  - nested item'],
  ['a quote line', '> quoted line'],
  ['a table row', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
  ['a closed fence', '```js\nconst a = 1\n```'],
  ['an image', '![alt](https://example.com/a.png)'],
  ['an HTML block', '<div>x</div>'],
  ['a bare opening tag', '<div>'],
  ['a lone inline tag', '<span>'],
  ['a line of inline markup', '<b>bold</b>'],
  ['an unclosed comment', '<!-- prose'],
]

/** A note holding one separator spelling under one kind of block. The `intro` line above keeps a
 * rule written at the very top of the document out of the front matter machinery, which is a
 * different question from whether that rule divides the deck. */
function parityNote(head: string, spelling: string): string {
  return `intro\n\n${head ? `${head}\n${spelling}\ntail` : `${spelling}\ntail`}`
}

describe('splitIntoSlides — every separator spelling against the renderer that draws it', () => {
  for (const [name, head] of CONTEXTS) {
    for (const spelling of SPELLINGS) {
      const source = parityNote(head, spelling)
      const pages = /<hr/.test(renderMarkdown(source).html) ? 2 : 1
      it(`divides on ${JSON.stringify(spelling)} below ${name} only where the renderer draws a rule`, () => {
        expect(splitIntoSlides(source).length).toBe(pages)
      })
    }
  }

  it('reads a setext underline as the heading the renderer reads, so a declared level divides there', () => {
    const prose = 'intro\n\nSome prose\n---\ntail'
    expect(renderMarkdown(prose).html).toMatch(/<h2[^>]*>[\s\S]*?Some prose<\/h2>/)
    expect(splitIntoSlides('---\nslide-level: 2\n---\n\n' + prose)).toEqual(['intro', 'Some prose\n---\ntail'])
  })

  it('reads a setext equals run as a top-level heading', () => {
    const prose = 'intro\n\nSome prose\n===\ntail'
    expect(renderMarkdown(prose).html).toMatch(/<h1[^>]*>[\s\S]*?Some prose<\/h1>/)
    expect(splitIntoSlides('---\nslide-level: 2\n---\n\n' + prose)).toEqual(['intro', 'Some prose\n===\ntail'])
  })

  it('reads a run indented past its paragraph as more prose, so it folds no heading', () => {
    const source = 'intro\n\nSome prose\n    ---\nmore'
    expect(renderMarkdown(source).html).not.toMatch(/<\/?h2/)
    expect(splitIntoSlides('---\nslide-level: 2\n---\n\n' + source)).toEqual([source])
  })

  it('closes an HTML block at the blank line, so a rule written after it divides again', () => {
    const source = 'intro\n\n<div>x</div>\n\n***\n\ntail'
    expect(renderMarkdown(source).html).toContain('<hr')
    expect(splitIntoSlides(source)).toEqual(['intro\n\n<div>x</div>', 'tail'])
  })
})

describe('splitIntoSlides — front matter and deck edges', () => {
  it('strips leading front matter so properties never become a slide', () => {
    expect(splitIntoSlides('---\ntitle: Deck\n---\n\n# Cover\n\n---\n\n# Page 2')).toEqual(['# Cover', '# Page 2'])
  })

  it('keeps a malformed front matter block as regular content without a blank first slide', () => {
    expect(splitIntoSlides('---\ntitle: never closed\n\n# Body')).toEqual(['title: never closed\n\n# Body'])
  })

  it('supports CRLF line endings', () => {
    expect(splitIntoSlides('# A\r\n\r\n---\r\n\r\n# B')).toEqual(['# A', '# B'])
  })

  it('keeps a blank slide between two consecutive separators but drops blank edge slides', () => {
    expect(splitIntoSlides('# A\n\n---\n\n---\n\n# B')).toEqual(['# A', '', '# B'])
  })

  it('splits on a separator that follows another separator with no blank line between', () => {
    expect(splitIntoSlides('# A\n\n---\n---\n\n# B')).toEqual(['# A', '', '# B'])
  })

  it('produces one empty slide for an empty note instead of zero slides', () => {
    expect(splitIntoSlides('')).toEqual([''])
  })
})

describe('splitIntoSlides — smart heading split', () => {
  it('splits a heading-only note at each top-level heading', () => {
    expect(splitIntoSlides('# Why\n\nbecause\n\n# How\n\nlike this')).toEqual(['# Why\n\nbecause', '# How\n\nlike this'])
  })

  it('drops down to the section level when a lone title heading cannot divide the note', () => {
    const source = '# Weekly\n\n## Done\n\nshipped\n\n## Next\n\nplanned'
    expect(splitIntoSlides(source)).toEqual(['# Weekly', '## Done\n\nshipped', '## Next\n\nplanned'])
  })

  it('leaves a note with one heading and no sections as a single slide', () => {
    expect(splitIntoSlides('# Title\n\nbody')).toEqual(['# Title\n\nbody'])
  })

  it('starts the deck with the prose above the first heading instead of a blank slide', () => {
    expect(splitIntoSlides('cold open\n\n# Act I\n\nscene\n\n# Act II\n\nscene')).toEqual(['cold open', '# Act I\n\nscene', '# Act II\n\nscene'])
  })

  it('divides no further when headings sit above the level or on a slide a separator opened', () => {
    const source = '# A\n\n---\n\n# B\n\n## C\n\n## D'
    expect(splitIntoSlides(source)).toEqual(['# A', '# B\n\n## C\n\n## D'])
  })

  it('does not split on a heading inside a fenced code block', () => {
    const source = '## Real\n\n```\n# fake\n## fake\n```\n\n## Another'
    expect(splitIntoSlides(source)).toEqual(['## Real\n\n```\n# fake\n## fake\n```', '## Another'])
  })

  it('splits CRLF notes the same way', () => {
    expect(splitIntoSlides('# A\r\n\r\nbody\r\n\r\n# B\r\n\r\nbody')).toEqual(['# A\n\nbody', '# B\n\nbody'])
  })

  it('ignores an indented hash run, which markdown reads as a code block not a heading', () => {
    const source = '# A\n\ntext\n\n    # indented\n\n# B'
    expect(splitIntoSlides(source)).toEqual(['# A\n\ntext\n\n    # indented', '# B'])
  })
})

// An authored rule and a heading section are two ways of saying where a slide starts, and a note can
// carry both: the rule marks the beats the author planned, the headings mark the sections they wrote.
// Reading one as a switch that turns the other off left the mixed note with the separators only, so a
// heading in the middle of a long slide stayed buried however tall that slide got.
describe('splitIntoSlides — separators and headings divide together', () => {
  it('divides on both when a note mixes separators with heading sections', () => {
    const source = ['intro', '', '# A', 'a', '', '---', '', '# B', 'b', '', '# C', 'c', '', '---', '', '# D', 'd'].join('\n')
    expect(splitIntoSlides(source)).toEqual(['intro', '# A\na', '# B\nb', '# C\nc', '# D\nd'])
  })

  it('cuts no blank page where a heading falls on the slide a separator already opened', () => {
    expect(splitIntoSlides('intro\n\n---\n\n# Two\n\nbody\n\n# Three\n\nbody')).toEqual(['intro', '# Two\n\nbody', '# Three\n\nbody'])
  })

  it('keeps a separator inside a heading section dividing as its own page does', () => {
    expect(splitIntoSlides('# A\n\n# B\n---\n\n# C\n\nbody')).toEqual(['# A', '# B', '# C\n\nbody'])
  })

  it('leaves a layout switch above a heading on the slide that switch belongs to', () => {
    const source = '# Cover\n\nbody\n\n---\n\n<!-- layout: split -->\n\n## Two columns\n\nleft\n\n## More columns\n\nright'
    expect(splitIntoSlides(source)).toEqual(['# Cover\n\nbody', '<!-- layout: split -->\n\n## Two columns\n\nleft', '## More columns\n\nright'])
  })

  it('leaves a layout switch at the head of the deck on the slide it opens', () => {
    const source = '---\ntitle: Deck\n---\n\n<!-- layout: cover -->\n\n# Cover\n\nline\n\n---\n\n# Two\n\nline'
    expect(splitIntoSlides(source)).toEqual(['<!-- layout: cover -->\n\n# Cover\n\nline', '# Two\n\nline'])
  })

  it('still lets an authored separator keep its blank page above a heading', () => {
    expect(splitIntoSlides('# A\n\n---\n\n---\n\n# B')).toEqual(['# A', '', '# B'])
  })
})

describe('splitIntoSlides — the declared slide-level property', () => {
  it('honours a declared slide-level property over the detected one', () => {
    const source = '---\nslide-level: 1\n---\n\n# A\n\n## B\n\n# C\n\n## D'
    expect(splitIntoSlides(source)).toEqual(['# A\n\n## B', '# C\n\n## D'])
  })

  it('splits at the declared deeper level, headings above it included', () => {
    const source = '---\nslide-level: 2\n---\n\n# A\n\n## B\n\n# C\n\n## D'
    expect(splitIntoSlides(source)).toEqual(['# A', '## B', '# C', '## D'])
  })

  it('accepts the declared level quoted, and falls back to detection when it is unusable', () => {
    const quoted = '---\nslide-level: "2"\n---\n\n# A\n\n## B\n\n## C'
    expect(splitIntoSlides(quoted)).toEqual(['# A', '## B', '## C'])
    const unusable = '---\nslide-level: sometimes\n---\n\n# A\n\n## B\n\n## C'
    expect(splitIntoSlides(unusable)).toEqual(['# A', '## B', '## C'])
  })

  it('reads the level from front matter only, never from a `slide-level` line in the body', () => {
    const source = 'slide-level: 2\n\n# A\n\nbody'
    expect(splitIntoSlides(source)).toEqual([source])
  })

  it('applies a declared level to the headings a separator deck still carries', () => {
    const source = '---\nslide-level: 2\n---\n\n# A\n\ntext\n\n## B\n\ntext\n\n---\n\n# C\n\ntext'
    expect(splitIntoSlides(source)).toEqual(['# A\n\ntext', '## B\n\ntext', '# C\n\ntext'])
  })

  it('keeps headings out of the deck when the front matter turns slide-level off', () => {
    const source = '---\nslide-level: none\n---\n\n# A\n\nbody\n\n# B\n\nbody'
    expect(splitIntoSlides(source)).toEqual(['# A\n\nbody\n\n# B\n\nbody'])
    expect(splitIntoSlides('---\nslide-level: NONE\n---\n\n# A\n\nbody\n\n# B\n\nbody')).toEqual(['# A\n\nbody\n\n# B\n\nbody'])
  })

  it('still divides on separators with slide-level turned off', () => {
    const source = '---\nslide-level: none\n---\n\n# A\n\nbody\n\n---\n\n# B'
    expect(splitIntoSlides(source)).toEqual(['# A\n\nbody', '# B'])
  })
})

describe('splitIntoSlides — private speaker cues', () => {
  it('keeps a one-line cue out of every slide and returns it as that slide’s note', () => {
    const source = '# A\n\npoint\n\n<!-- note: pause here -->\n\n# B\n\npoint'
    expect(splitIntoSlides(source)).toEqual(['# A\n\npoint', '# B\n\npoint'])
    expect(splitIntoSlidesWithNotes(source).notes).toEqual(['pause here', ''])
  })

  it('joins a multi-line cue into one note and removes every line it spans', () => {
    const source = '# A\n\n<!-- note:\npause here\nemphasise the number\n-->\n\npoint'
    expect(splitIntoSlides(source)).toEqual(['# A\n\npoint'])
    expect(splitIntoSlidesWithNotes(source).notes).toEqual(['pause here\nemphasise the number'])
  })

  it('reads a `speaker:` cue the same way as a `note:` one', () => {
    expect(splitIntoSlidesWithNotes('# A\n\n<!-- speaker: bring up the chart -->\n\nx').notes).toEqual(['bring up the chart'])
  })

  it('reads a cue written tight against the comment markers, with no spaces', () => {
    expect(splitIntoSlidesWithNotes('# A\n\n<!--note:tight -->\n\n# B')).toEqual({ slides: ['# A', '# B'], notes: ['tight', ''] })
  })

  it('reads an uppercased marker the same way as a lowercased one', () => {
    expect(splitIntoSlidesWithNotes('# A\n\n<!-- NOTE: shout -->\n\n# B').notes).toEqual(['shout', ''])
  })

  it('leaves a cue line indented by four spaces alone, since markdown reads it as a code block', () => {
    const source = '# A\n\n    <!-- note: shown -->\n\n# B'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['# A\n\n    <!-- note: shown -->', '# B'], notes: ['', ''] })
  })
})

describe('splitIntoSlides — what a cue takes out of the slide', () => {
  it('keeps a fence written inside a cue private instead of opening a block', () => {
    const source = '# A\n\n<!-- note:\n```\ncue\n-->\n\npoint'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['# A\n\npoint'], notes: ['```\ncue'] })
  })

  it('keeps a blank line inside a cue, so a list written there stays a list', () => {
    const source = '# A\n\n<!-- note:\nfirst\n\nsecond\n-->\n\npoint'
    expect(splitIntoSlidesWithNotes(source).notes).toEqual(['first\n\nsecond'])
  })

  it('keeps prose written after the closing marker in the slide', () => {
    const source = '# A\n\n<!-- note: cue --> visible\n\npoint'
    expect(splitIntoSlides(source)).toEqual(['# A\n\n visible\n\npoint'])
    expect(splitIntoSlidesWithNotes(source).notes).toEqual(['cue'])
  })

  it('keeps an unclosed cue private to the end of the note, the way the reader already drops it', () => {
    const source = '# A\n\npoint\n\n<!-- note: forgot to close\n\n# B\n\nmore'
    expect(splitIntoSlidesWithNotes(source)).toEqual({
      slides: ['# A\n\npoint'],
      notes: ['forgot to close\n\n# B\n\nmore'],
    })
  })
})

describe('splitIntoSlides — what is never a cue', () => {
  it('leaves a cue inside a fenced block in the slide, since the block demos the syntax', () => {
    const source = '# A\n\n```md\n<!-- note: not a cue -->\n```\n\npoint'
    expect(splitIntoSlides(source)).toEqual(['# A\n\n```md\n<!-- note: not a cue -->\n```\n\npoint'])
    expect(splitIntoSlidesWithNotes(source).notes).toEqual([''])
  })

  it('reads front matter as metadata, never as a cue', () => {
    const source = '---\n<!-- note: hidden -->\ntitle: Deck\n---\nSome prose\n\nmore prose'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['Some prose\n\nmore prose'], notes: [''] })
  })

  it('does not let front matter open a fenced block and hide the body', () => {
    const source = '---\ndescription: |\n  ```\n---\n\n# A\n\n<!-- note: cue -->'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['# A'], notes: ['cue'] })
  })
})

describe('splitIntoSlides — which slide carries a cue', () => {
  it('collects several cues of one slide in the order they are written', () => {
    const source = '# A\n\n<!-- note: first -->\n\npoint\n\n<!-- note: second -->'
    expect(splitIntoSlides(source)).toEqual(['# A\n\npoint'])
    expect(splitIntoSlidesWithNotes(source).notes).toEqual(['first\n\nsecond'])
  })

  it('stops a rule written inside a cue from splitting the deck', () => {
    const source = '# A\n\n<!-- note:\n---\n-->\n\n# B'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['# A', '# B'], notes: ['---', ''] })
  })

  it('keeps a cue-only slide as a blank page that still carries its note', () => {
    const source = '# A\n\n---\n\n<!-- note: breathe -->\n\n---\n\n# B'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['# A', '', '# B'], notes: ['', 'breathe', ''] })
  })

  it('keeps the cue of a note whose whole body is one cue', () => {
    expect(splitIntoSlidesWithNotes('<!-- note: breathe -->')).toEqual({ slides: [''], notes: ['breathe'] })
  })

  it('keeps a cue that starts the body and never closes, so it swallows the deck', () => {
    const source = '---\ntitle: Deck\n---\n\n<!-- note: forgot to close\n\n# A'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: [''], notes: ['forgot to close\n\n# A'] })
  })

  it('counts a cue typed on the same line as a separator toward the slide above', () => {
    const source = '# A\n\n<!-- note: cue --> ---\n\n# B'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['# A', '# B'], notes: ['cue', ''] })
  })

  it('keeps a cue that swallows the tail of a divided deck', () => {
    const source = '# A\n\n---\n\n<!-- note: after the divider\n# B'
    expect(splitIntoSlidesWithNotes(source)).toEqual({ slides: ['# A'], notes: ['after the divider\n# B'] })
  })
})

describe('findSlideIndexByOffset', () => {
  it('maps a caret past a cue onto the slide the cue belongs to', () => {
    const source = '# A\n\npoint\n\n<!-- note: pause here -->\n\n# B\n\npoint'
    expect(findSlideIndexByOffset(source, source.indexOf('pause here'))).toBe(0)
    expect(findSlideIndexByOffset(source, source.indexOf('# B'))).toBe(1)
  })

  it('returns 0 for negative or zero offset or single-slide note', () => {
    expect(findSlideIndexByOffset('# Single\n\nSlide', 0)).toBe(0)
    expect(findSlideIndexByOffset('# Single\n\nSlide', -5)).toBe(0)
    expect(findSlideIndexByOffset('# Single\n\nSlide', 10)).toBe(0)
  })

  it('locates current slide based on character offset', () => {
    const doc = '# First\n\n---\n\n# Second\n\n---\n\n# Third'
    expect(findSlideIndexByOffset(doc, 4)).toBe(0)
    expect(findSlideIndexByOffset(doc, 10)).toBe(1)
    expect(findSlideIndexByOffset(doc, 18)).toBe(1)
    expect(findSlideIndexByOffset(doc, 30)).toBe(2)
    expect(findSlideIndexByOffset(doc, 999)).toBe(2)
  })

  it('skips front matter and handles code fences properly', () => {
    const doc = '---\ntitle: test\n---\n\n# Slide 1\n\n```yaml\n---\n```\n\n---\n\n# Slide 2'
    const slide1Pos = doc.indexOf('# Slide 1')
    const yamlSepPos = doc.indexOf('---\n```')
    const slide2Pos = doc.indexOf('# Slide 2')

    expect(findSlideIndexByOffset(doc, 5)).toBe(0)
    expect(findSlideIndexByOffset(doc, slide1Pos)).toBe(0)
    expect(findSlideIndexByOffset(doc, yamlSepPos)).toBe(0)
    expect(findSlideIndexByOffset(doc, slide2Pos)).toBe(1)
  })

  it('keeps a caret before a separator on the slide above it', () => {
    const doc = '# A\n\n---\n\n# B'
    const rule = doc.indexOf('---')
    expect(findSlideIndexByOffset(doc, rule)).toBe(0)
    expect(findSlideIndexByOffset(doc, rule + 1)).toBe(1)
  })
})

describe('findSlideIndexByOffset — heading decks', () => {
  it('maps a caret on a heading onto the slide that heading opens', () => {
    const doc = '# Weekly\n\ntopline\n\n## Done\n\ndone\n\n## Next\n\nnext'
    expect(findSlideIndexByOffset(doc, doc.indexOf('## Done'))).toBe(1)
    expect(findSlideIndexByOffset(doc, doc.indexOf('done'))).toBe(1)
    expect(findSlideIndexByOffset(doc, doc.indexOf('## Next'))).toBe(2)
    expect(findSlideIndexByOffset(doc, doc.indexOf('next'))).toBe(2)
  })

  it('agrees with the deck it indexes, slide for slide', () => {
    const docs = ['# A\n\nx\n\n# B\n\ny', 'cold open\n\n## A\n\nx\n\n## B\n\ny', '---\nslide-level: 2\n---\n\n# A\n\n## B\n\n## C']
    for (const doc of docs) {
      const slides = splitIntoSlides(doc)
      expect(slides.length).toBeGreaterThan(1)
      slides.forEach((slide, index) => {
        expect(findSlideIndexByOffset(doc, doc.indexOf(slide))).toBe(index)
      })
    }
  })
})

describe('takeLayoutDirective', () => {
  it('reads `<!-- layout: cover -->` as the slide’s switch and takes it out of the body', () => {
    expect(takeLayoutDirective('<!-- layout: cover -->\n\n# Title')).toEqual({ body: '# Title', layout: 'cover' })
  })

  it('reads `split` as the switch the two-column layout is', () => {
    expect(takeLayoutDirective('<!-- layout: split -->\n\n# A').layout).toBe('split')
  })

  it('reads `two-columns` as the same switch as `split`', () => {
    expect(takeLayoutDirective('<!-- layout: two-columns -->\n\n# A').layout).toBe('split')
  })

  it('reads the switch whatever case the value is written in', () => {
    expect(takeLayoutDirective('<!-- layout: COVER -->\n\n# A').layout).toBe('cover')
  })

  it('reads a switch written tight against the comment markers, with no spaces', () => {
    expect(takeLayoutDirective('<!--layout:cover-->\n\n# A')).toEqual({ body: '# A', layout: 'cover' })
  })

  it('leaves a switch indented by four spaces in the body, since markdown reads it as code', () => {
    expect(takeLayoutDirective('# A\n\n    <!-- layout: cover -->')).toEqual({ body: '# A\n\n    <!-- layout: cover -->', layout: undefined })
  })

  it('leaves a switch inside a code fence in the body, so the syntax can be demonstrated', () => {
    const source = '# A\n\n```md\n<!-- layout: cover -->\n```\n\n# B'
    expect(takeLayoutDirective(source)).toEqual({ body: source, layout: undefined })
  })

  it('consumes only the first switch, so a second one stays where it was written', () => {
    expect(takeLayoutDirective('<!-- layout: cover -->\n\n# A\n\n<!-- layout: split -->')).toEqual({ body: '# A\n\n<!-- layout: split -->', layout: 'cover' })
  })

  it('takes the blank line above a switch with it, so the body keeps no hole', () => {
    expect(takeLayoutDirective('# A\n\npoint\n\n<!-- layout: cover -->\n\nmore').body).toBe('# A\n\npoint\n\nmore')
  })

  it('leaves a layout value the projector does not know as the prose it is', () => {
    const source = '# A\n\n<!-- layout: gallery -->'
    expect(takeLayoutDirective(source)).toEqual({ body: source, layout: undefined })
  })

  it('leaves a line that carries prose after the closing marker as prose', () => {
    const source = '# A\n\n<!-- layout: cover --> and the rest of the line'
    expect(takeLayoutDirective(source)).toEqual({ body: source, layout: undefined })
  })

  it('does not read a front matter `layout:` key as a switch', () => {
    const source = '---\nlayout: cover\n---\n\n# A'
    expect(takeLayoutDirective(source)).toEqual({ body: source, layout: undefined })
  })

  it('leaves a slide that carries no switch alone', () => {
    expect(takeLayoutDirective('# A\n\npoint')).toEqual({ body: '# A\n\npoint', layout: undefined })
  })
})

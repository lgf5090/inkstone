// @vitest-environment jsdom
/**
 * The rule a public share page applies to a reference it cannot open, taken on its own.
 *
 * The page test pins what a stranger finally sees; this pins the two halves separately, because they read
 * different inputs: a user turn is plain text drawn verbatim, so the mention is still in the syntax the
 * composer wrote it in, and an assistant turn is rendered markup, where the id has already been base64'd
 * into an attribute. What matters here is the boundary as much as the redaction — a share page that eats
 * an ordinary link, or rewrites the `[[` a code sample is quoting, has traded one bug for a worse one.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { decodeDataValue, encodeDataValue } from '../../lib/markdown/data-attr'
import { neutralizeShareEmbeds, prepareShareMarkup, prepareShareSource, redactShareMentionMarkup } from './share-markdown'

const NOTE_ID = '01jqz0000000000000000000zz'
/** An attachment address, which shares the note id's alphabet and is the one handle a share page keeps. */
const FILE_ID = '01jqz1111111111111111111aa'
const SENTENCE = 'share.private_note_reference_is_not_included_in_public_shares'
const EMBED_SENTENCE = 'share.embedded_private_notes_are_not_included_in_public_shares'

beforeEach(async () => {
  await initI18n()
})

/** Whether a note id survived a pass that was supposed to take it out. */
function containsId(value: string): boolean {
  return value.includes(NOTE_ID)
}

/**
 * Every handle-shaped run a document hands out, read out of its words *and* out of every attribute.
 *
 * A shape rather than a known string, because the promise is about the kind of thing that must not go
 * out, not about one id: `b64.` values are decoded first, since that is how the renderer writes a wiki
 * target and a handle inside base64 is still the handle. The one exception is the attachment address
 * `SharePage` rewrites with the share's own slug — same alphabet, same length, and the picture the
 * author shared is what it stands for.
 */
const ATTACHMENT_ADDRESS = /^\/api\/files\/[0-9a-hjkmnp-tv-z]{26}(\?.*)?$/i

function handlesIn(html: string): string[] {
  const template = document.createElement('template')
  template.innerHTML = html
  const found: string[] = []
  /** Maximal runs of the id alphabet, so `01jq…#Heading` and `the roadmap` are both read correctly. */
  const shapes = (value: string) => value
    .split(/[^0-9a-hjkmnp-tv-z]+/i)
    .filter((part) => /^[0-9a-hjkmnp-tv-z]{26}$/i.test(part))
  // Every word on the page, and then every attribute of every element that page is made of.
  found.push(...shapes(template.content.textContent ?? ''))
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (ATTACHMENT_ADDRESS.test(attribute.value)) continue
      found.push(...shapes(decodeDataValue(attribute.value)), ...shapes(attribute.value))
    }
  }
  return [...new Set(found)]
}

describe('a mention in text handed on to be drawn somewhere else', () => {
  it('keeps the alias and drops the handle', () => {
    expect(prepareShareSource(`What about [[${NOTE_ID}|Private Roadmap]]?`)).toBe('What about Private Roadmap?')
    expect(prepareShareSource(`See ![[${NOTE_ID}|the plan]].`)).toBe('See the plan.')
  })

  it('answers a mention that has no name but its id', () => {
    expect(prepareShareSource(`Read [[${NOTE_ID}]] first.`)).toBe(`Read ${t(SENTENCE)} first.`)
    expect(prepareShareSource(`Read [[${NOTE_ID}#Heading]] first.`)).toBe(`Read ${t(SENTENCE)} first.`)
    expect(containsId(prepareShareSource(`[[${NOTE_ID}|${NOTE_ID}]]`))).toBe(false)
  })

  it('leaves a reference named by a word, and everything that is not a mention', () => {
    // The author's own words are what a reader was given; an id-shaped target is the only thing taken out.
    expect(prepareShareSource('What about [[Private Roadmap]]?')).toBe('What about [[Private Roadmap]]?')
    expect(prepareShareSource('A bracket [note] and a stray [[ and ]] stay.')).toBe('A bracket [note] and a stray [[ and ]] stay.')
    expect(prepareShareSource('[the roadmap](https://example.com/roadmap)')).toBe('[the roadmap](https://example.com/roadmap)')
    expect(prepareShareSource('Two: [[Private Roadmap]] and [[Some Other Note]].')).toBe('Two: [[Private Roadmap]] and [[Some Other Note]].')
  })

  /**
   * The notebook's own deep link is the same handle wearing an address, and a page that hands the words
   * to another renderer — a chat turn shown as text, a note sent to the deck — cannot run the markup sweep
   * over them. So the address comes out here, and a 26-character run that is not part of one is left
   * alone: an id-shaped tracking code in a shared note is the author's own text.
   */
  it('takes an address into the notebook out of a document that is not markup yet', () => {
    expect(prepareShareSource(`See [the note](/n/${NOTE_ID}) for it.`)).toBe('See [the note](#) for it.')
    expect(prepareShareSource(`Pasted: https://vault.example.com/n/${NOTE_ID}?x=1`)).toBe('Pasted: https://vault.example.com#')
    expect(prepareShareSource('Tracking code 01jqz0000000000000000000aa stays.')).toBe('Tracking code 01jqz0000000000000000000aa stays.')
    expect(prepareShareSource('A shorter run 01jqz000000000000000000aa stays.')).toBe('A shorter run 01jqz000000000000000000aa stays.')
  })

  /**
   * The notebook's “copy link” writes `/n/<id>`, so an author who pastes one into a question, or into a
   * note they then share, hands a stranger the same handle by a road that has no brackets on it. The
   * address goes and the words around it stay — and an address that names no note is left alone, because
   * shared prose is the author's to read.
   */
  it('takes the notebook’s own deep link out of the source', () => {
    expect(prepareShareSource(`See [the note](/n/${NOTE_ID}) now.`)).toBe('See [the note](#) now.')
    expect(prepareShareSource(`Address: https://vault.example.com/n/${NOTE_ID}?x=1 end`)).toBe('Address: https://vault.example.com# end')
    expect(prepareShareSource('A 26-character tracking code: 01jqz000000000000000000000 stays.')).toBe('A 26-character tracking code: 01jqz000000000000000000000 stays.')
    expect(prepareShareSource('A path that is not a note: /notes/01jqz0000000000000000000zz stays.')).toContain('/notes/')
  })
})

describe('a mention in rendered markup', () => {
  it('takes the id out of the attribute and the visible words together', () => {
    const html = renderMarkdown(
      `As [[${NOTE_ID}|the roadmap]] says, and [[${NOTE_ID}]] too.`,
    ).html
    expect(html).toContain('data-wikilink')
    const redacted = redactShareMentionMarkup(html)
    expect(containsId(redacted), 'an id survived in an attribute or a label').toBe(false)
    expect(redacted).toContain('the roadmap')
    expect(redacted).toContain(t(SENTENCE))
    // Nothing is left for a click to resolve once the handle is gone.
    expect(redacted).not.toContain('data-wikilink')
  })

  it('leaves a title-named wikilink exactly as the renderer wrote it', () => {
    const html = renderMarkdown('See [[Private Roadmap]] and [the web](https://example.com).').html
    expect(redactShareMentionMarkup(html)).toBe(html)
    expect(html).toContain('data-wikilink')
  })

  it('does not touch a code block that quotes the syntax', () => {
    const html = renderMarkdown(['A literal `[[Private Roadmap]]` stays.', '', '```ts', 'const link = "[[Private Roadmap]]"', '```'].join('\n')).html
    const redacted = redactShareMentionMarkup(html)
    expect(redacted).toContain('<code>[[Private Roadmap]]</code>')
    expect(redacted).toContain('const link = "[[Private Roadmap]]"')
    expect(redacted).toBe(html)
  })

  it('rewrites an embed that named its note by id and answers it once', () => {
    const html = renderMarkdown(`And the plan: ![[${NOTE_ID}]].`).html
    expect(html).toContain('data-embed-target')
    const prepared = prepareShareMarkup(html)
    expect(containsId(prepared), 'an id survived an embed box').toBe(false)
    expect(prepared).toContain(t(SENTENCE))
    expect(prepared).toContain(t(EMBED_SENTENCE))
    expect(prepared).not.toContain('data-embed-target')
    expect(prepared).not.toContain('aria-busy')
  })

  it('keeps running the embed rule for a reference named by title', () => {
    const prepared = prepareShareMarkup(renderMarkdown('![[Private Roadmap]]').html)
    expect(prepared).toContain(t(EMBED_SENTENCE))
    // A title the author typed is shared content, so the head keeps naming the note the reader is being
    // told about; it is only an id-shaped target that earns the sentence in its place.
    expect(prepared).toContain('<span class="note-embed-head">Private Roadmap</span>')
  })

  it('is a rule that composes with the embed pass in either order of the two ids', () => {
    const mixed = renderMarkdown(`![[${NOTE_ID}|the plan]] and [[${NOTE_ID}|the roadmap]]`).html
    const prepared = prepareShareMarkup(mixed)
    expect(containsId(prepared)).toBe(false)
    expect(prepared).toContain('the plan')
    expect(prepared).toContain('the roadmap')
    expect(neutralizeShareEmbeds(prepared)).toBe(prepared)
  })

  it('writes the target as the renderer does, so the attribute is what is compared', () => {
    // Guards the assumption above: the attribute is base64, so a plain string search would miss it.
    expect(containsId(`data-wikilink="${encodeDataValue(NOTE_ID)}"`)).toBe(false)
    expect(containsId(redactShareMentionMarkup(
      `<a class="wikilink" data-wikilink="${encodeDataValue(NOTE_ID)}">${NOTE_ID}</a>`,
    ))).toBe(false)
  })
})

describe('every place a note handle can be left on a shared page', () => {
  /**
   * The positions are not invented: the first two are what `md.renderer.rules.wikilink` and
   * `note_embed` write for a mention aimed by id, the next three are what the embed resolver stamps on a
   * head it has filled in, and the last is the address the notebook's own deep link uses. A rule that
   * only answered the attribute it knew about would leave the words, the `title` or the link behind.
   */
  const planted = () => {
    const sized = encodeDataValue(`${NOTE_ID}|600x400`)
    return [
      `<a class="wikilink" data-wikilink="${encodeDataValue(NOTE_ID)}" href="#">${NOTE_ID}</a>`,
      `<a class="wikilink" data-wikilink="${encodeDataValue(`${NOTE_ID}#Heading`)}" href="#">${NOTE_ID}#Heading</a>`,
      `<a class="wikilink" href="#" title="${NOTE_ID}" data-note-id="${NOTE_ID}">the roadmap</a>`,
      `<div class="note-embed loading" data-embed-target="${sized}">`,
      `<span class="note-embed-head" data-wikilink="${NOTE_ID}">${NOTE_ID}#Heading</span>`,
      `<div class="note-embed-body" aria-busy="true">Loading</div></div>`,
      `<img alt="${NOTE_ID}" src="/api/files/${FILE_ID}">`,
      `<img alt="A shared picture" src="https://example.com/p.png">`,
      `<p><a href="/n/${NOTE_ID}">a link into the notebook</a>`,
      `<a href="https://vault.example.com/n/${NOTE_ID}">the same link from outside</a></p>`,
      `<p>A quoted mention in prose: [[${NOTE_ID}|the roadmap]] and ![[${NOTE_ID}]].</p>`,
      '<pre><code>const link = "[[' + NOTE_ID + ']]"</code></pre>',
    ].join('\n')
  }

  it('answers each of them without leaving the handle behind', () => {
    const prepared = prepareShareMarkup(planted())
    expect(handlesIn(prepared), `a note handle survived the share rule: ${handlesIn(prepared).join(', ')}`)
      .toEqual([])
    // And nothing left standing can be handed back to a resolver.
    expect(prepared).not.toContain('data-wikilink')
    expect(prepared).not.toContain('data-embed-target')
    expect(prepared).not.toContain('data-note-id')
    expect(prepared).not.toContain('aria-busy')
  })

  it('keeps the words a reader was already given while the handles go', () => {
    const prepared = prepareShareMarkup(planted())
    expect(prepared).toContain('the roadmap')
    expect(prepared).toContain('a link into the notebook')
    expect(prepared).toContain('const link = ')
    expect(prepared).toContain(t(SENTENCE))
    expect(prepared).toContain(t(EMBED_SENTENCE))
  })

  /**
   * The one handle a share page is allowed to hand out is its own attachment address: `SharePage`
   * rewrites it with the slug so a visitor can read the picture the author shared. A rule that erased
   * every 26-character run would erase that too, and the page would lose its images.
   */
  it('leaves the shared attachment address standing', () => {
    const prepared = prepareShareMarkup(planted())
    const template = document.createElement('template')
    template.innerHTML = prepared
    const attached = [...template.content.querySelectorAll<HTMLImageElement>('img')]
    const shared = attached.find((image) => image.getAttribute('src')?.startsWith('/api/files/'))
    expect(shared?.getAttribute('src'), 'the share rule ate the attachment the author meant to share')
      .toBe(`/api/files/${FILE_ID}`)
    expect(shared?.getAttribute('alt'), 'a handle in an attribute took the whole attribute with it')
      .toBeNull()
    // A picture from outside the notebook, and the words describing it, are nobody's secret.
    const external = attached.find((image) => image.getAttribute('src')?.startsWith('https://'))
    expect(external?.getAttribute('src')).toBe('https://example.com/p.png')
    expect(external?.getAttribute('alt')).toBe('A shared picture')
  })
})

/**
 * The one answer a public share page may give to a reference it cannot open.
 *
 * `![[note]]` is drawn as a box that says "Loading", and only the embed pass fills it in or says it
 * cannot — and that pass reads the *viewer's* vault, resolving a title through the note store and then
 * `api.notes.get`. A stranger's page has no vault to read and must not start looking for one: the payload
 * behind a share link carries four fields per turn and deliberately nothing about the notes behind them,
 * and a published transcript has already leaked private note titles and ids once, out of a source card.
 * So the placeholder is answered in the markup, before anything draws it, with the only sentence that is
 * true here: what it pointed at is not part of this share. Left alone, the box spins for the life of the
 * page and reads as a document still arriving.
 *
 * The target attribute goes with it. It is the whole thing the author typed, base64'd — for a mention the
 * composer wrote, that is a note id — and it exists only to be handed back to the resolver, which is
 * precisely the call this page may not make. The head is left as the renderer wrote it: it repeats a name
 * the shared text already contains, and that name is what tells a reader *which* reference is missing.
 *
 * A mention leaks by a road the embed pass never walks. The composer writes an `@` pick as
 * `[[<id>|Title]]` because a title alone cannot tell two notes that share it apart, so the id travels in
 * the link: a user turn, shown verbatim, puts it in front of the reader as plain text, and an assistant
 * turn puts it in `data-wikilink` — invisible and unclickable, but published all the same. An id is not a
 * word anybody reads; it is a handle, and handing one out says both that the note exists and how to aim
 * at it from somewhere else. So the handle comes out of the text and out of the attributes, the alias the
 * author already wrote stays — it is what told the reader which note was meant — and a mention whose only
 * name is its id gets the same kind of honest sentence as an embed.
 *
 * A reference is written in more than one place, though, and the two passes above only know the two
 * shapes the renderer happens to use today. The handle also rides along in words the Markdown pass never
 * turned into a link — quoted in a code span, left as brackets because the target was too long for the
 * renderer's cap — and an attribute can be stamped with it by any later pass that resolves one embed into
 * another. So one rule covers all of them: after the two structural passes, a last sweep reads every
 * remaining word and every attribute of the document and takes out whatever still addresses a note by its
 * handle. Only a reference is touched — the `[[…]]` shape in text, an attribute that *is* a handle or
 * parses to one, the notebook's own `/n/<id>` address — because shared prose is the author's and a
 * 26-character run inside it is a git hash, a tracking code or a typo until something says otherwise.
 * The one address kept is `/api/files/<id>`, which names the attachment the author did choose to share.
 *
 * A reference the author named with a word is their own shared text and stays exactly as it was, in a
 * code span as much as in a paragraph.
 *
 * Both public pages run through these rules, because they are the same promise: a shared note and a
 * shared conversation must not drift into answering one reference two different ways.
 */
import { t } from '../../lib/i18n'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { parseWikiTarget } from '../../lib/markdown/renderer'

/** The 26-character id every note in this app is addressed by, and the thing a stranger must not be given. */
const NOTE_ID = /^[0-9a-hjkmnp-tv-z]{26}$/i

/**
 * The two shapes a reference is written in, capped where the renderer caps them (`WIKI_RE`/`EMBED_RE`),
 * so this pass redacts exactly what the Markdown pass would have drawn as a link.
 */
const MENTION_RE = /!?\[\[([^[\]\n]{1,400})\]\]/g

/** The notebook's own deep link, relative or absolute — a handle wearing the shape of an address. */
const NOTE_ADDRESS_RE = /(?:^|[/(])n\/[0-9a-hjkmnp-tv-z]{26}(?:[/?#)]|$)/i

/** The one handle a public page is allowed to hand out: the attachment this very share was opened for. */
const ATTACHMENT_ADDRESS_RE = /\/api\/files\/[0-9a-hjkmnp-tv-z]{26}(?:[?#/]|$)/i

/** The only sentence a reference with no human-readable name may be answered with. */
const PRIVATE_REFERENCE_KEY = 'share.private_note_reference_is_not_included_in_public_shares'

/** Whether a reference names a note by its id rather than by a word the reader could use. */
function namesNoteById(target: string): boolean {
  return NOTE_ID.test(parseWikiTarget(target).noteTitle)
}

/**
 * What to show for a redacted mention: the alias it carries, or the sentence.
 *
 * In text the alias is still inside the brackets, so it is read back out of the target; an alias that is
 * itself an id — which an author can paste — earns the sentence rather than a second handle.
 */
function mentionLabel(target: string): string {
  const alias = parseWikiTarget(target).alias?.trim()
  if (alias && !NOTE_ID.test(alias)) return alias
  return t(PRIVATE_REFERENCE_KEY)
}

/** Rewrites the ids out of mentions in text that is drawn without Markdown, in place. */
export function redactShareMentions(text: string): string {
  return text.replace(MENTION_RE, (whole, target: string) => namesNoteById(target) ? mentionLabel(target) : whole)
}

/**
 * Whether one attribute value is a handle rather than something a reader can use.
 *
 * Read through `decodeDataValue` first, because the renderer base64s a wiki target and a handle inside
 * base64 is the same handle; and through `parseWikiTarget` too, so `01jq…#Heading` answers as the handle
 * it is addressed by rather than as a sentence nobody wrote.
 */
function isNoteHandleAttribute(value: string): boolean {
  const decoded = decodeDataValue(value)
  return NOTE_ID.test(decoded) || namesNoteById(decoded)
}

/** Takes a handle out of one attribute value, or answers `null` when the attribute has to go entirely. */
function redactShareAttributeValue(value: string): string | null {
  if (isNoteHandleAttribute(value)) return null
  const quoted = redactShareMentions(value)
  if (quoted !== value) return quoted
  const addressable = NOTE_ADDRESS_RE.test(value) && !ATTACHMENT_ADDRESS_RE.test(value)
  return addressable ? null : value
}

/**
 * The last sweep: every word and every attribute the two structural passes could not have reached.
 *
 * It runs after them on purpose. A handle still sitting in `data-embed-target` at this point is an embed
 * that has not been answered yet, and erasing the attribute here would leave the box spinning forever
 * instead of saying the sentence — which is the other half of the promise this module makes.
 */
export function scrubShareHandles(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  // `firstChild`, not `currentNode`: the walker starts at its own root, and a fragment's `textContent`
  // is every word below it — writing back to that would replace the whole document with one text node.
  for (let node = walker.firstChild(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    const redacted = redactShareMentions(text)
    if (redacted !== text) node.textContent = redacted
  }
  for (const element of [...template.content.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const value = redactShareAttributeValue(attribute.value)
      if (value === null) element.removeAttribute(attribute.name)
      else if (value !== attribute.value) element.setAttribute(attribute.name, value)
    }
  }
  return template.innerHTML
}

/**
 * Whether words on screen were built out of a handle.
 *
 * Read as maximal runs of the id alphabet rather than as one string, because the renderer glues a heading
 * or a block fragment straight onto the target it shows: `01jq…#Heading` is still the handle, and a label
 * of `600x400` — an embed size, which is the alias — is not.
 */
function showsHandle(text: string): boolean {
  return text.split(/[^0-9a-hjkmnp-tv-z]+/i).some((part) => NOTE_ID.test(part))
}

/**
 * Rewrites the ids out of the references a rendered document carries, in place.
 *
 * The attribute is the source of truth for *what* a link points at — the renderer keeps the alias in the
 * visible words and the bare target in the attribute, base64'd, and drops the alias on its way out — so
 * the attribute decides whether a reference is private and the words already on screen decide what to
 * leave. Both come off together: a link that named a note by id keeps its words, loses its handle, and is
 * left with nothing to resolve.
 */
export function redactShareMentionMarkup(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  /** Leaves the words the author wrote for a human to read; answers the ones built out of the handle. */
  const redact = (element: HTMLElement | null): void => {
    if (!element) return
    const shown = element.textContent?.trim() ?? ''
    if (shown && !showsHandle(shown)) return
    element.textContent = t(PRIVATE_REFERENCE_KEY)
  }
  for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>('a.wikilink[data-wikilink]')) {
    if (!namesNoteById(decodeDataValue(anchor.getAttribute('data-wikilink') ?? ''))) continue
    anchor.removeAttribute('data-wikilink')
    redact(anchor)
  }
  for (const embed of template.content.querySelectorAll<HTMLElement>('.note-embed[data-embed-target]')) {
    if (!namesNoteById(decodeDataValue(embed.getAttribute('data-embed-target') ?? ''))) continue
    // `![[<id>]]` shows the id as its own heading, so the heading is the part that has to change here.
    redact(embed.querySelector<HTMLElement>('.note-embed-head'))
  }
  return template.innerHTML
}

/** The one markup pass every public share page runs its rendered body through. */
export function prepareShareMarkup(html: string): string {
  return scrubShareHandles(neutralizeShareEmbeds(redactShareMentionMarkup(html)))
}

/** Rewrites every embed placeholder of a rendered document into that sentence, in place. */
export function neutralizeShareEmbeds(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const embed of template.content.querySelectorAll<HTMLElement>('.note-embed[data-embed-target]')) {
    embed.removeAttribute('data-embed-target')
    embed.classList.remove('loading')
    embed.classList.add('error')
    const body = embed.querySelector<HTMLElement>('.note-embed-body')
    if (body) {
      body.removeAttribute('aria-busy')
      body.textContent = t('share.embedded_private_notes_are_not_included_in_public_shares')
    }
  }
  return template.innerHTML
}

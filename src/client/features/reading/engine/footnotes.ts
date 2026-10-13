/**
 * Footnotes: the reference and the note it points at.
 *
 * An EPUB says what a link is in three different dialects — `epub:type="noteref"`, a class of
 * `footnote-ref`, or nothing but a `<sup>` around an anchor into an `<aside role="doc-endnote">` — and a
 * reader's hover has to work on all three without mistaking a table-of-contents link for a note. So the
 * anchor and its target are both consulted, and a link only gets a preview when one of them says
 * plainly that it is a note.
 *
 * The text of a note is what the publisher wrote, minus the back-link they put at the end of it for a
 * paper reader to find their way back.
 */
export interface FootnotePointer {
  /** The anchor's own words, which is usually a number in a circle. */
  label: string
  /** Package path of the chapter holding the note; empty when the note is in this one. */
  href: string
  fragment: string
}

const NOTE_TYPE = /(?:foot|end|an)?note/i
const NOTE_CLASS = /(?:^|[\s_-])(?:footnote|endnote|noteRef|note-ref|noteref|annotation|memo)(?:$|[\s_-])/i
/** A reference set in superscript, which is how a note is marked when the publisher adds no class. */
const SUP_TAG = /^SUP$/

function tokens(value: string | null | undefined): string[] {
  return (value ?? '').trim().split(/\s+/).filter(Boolean)
}

/** Whether a set of `epub:type`/`class` words names a note or a reference to one. */
export function looksLikeNote(type: string | null | undefined, className: string | null | undefined): boolean {
  return tokens(type).some((one) => NOTE_TYPE.test(one)) || NOTE_CLASS.test(className ?? '')
}

interface AttrReader {
  getAttribute(name: string): string | null
  textContent?: string | null
  tagName?: string
  closest?(selector: string): unknown
}

/**
 * What a pressed or hovered element has to be for the reader to get a note.
 *
 * `target` is the element the fragment names, when the caller already has it: a `<sup>` around an anchor
 * with no class at all is a footnote as surely as `epub:type="noteref"` is, but only the target can say
 * so without also catching every other superscript in the book.
 */
export function footnotePointerOf(anchor: AttrReader | null, target: AttrReader | null): FootnotePointer | null {
  if (!anchor) return null
  const href = anchor.getAttribute('data-reader-href') ?? ''
  const fragment = anchor.getAttribute('data-reader-fragment') ?? ''
  if (!fragment) return null
  const epubType = anchor.getAttribute('epub:type') ?? anchor.getAttribute('data-epub-type')
  const rel = anchor.getAttribute('rel') ?? ''
  const byAnchor = looksLikeNote(epubType, anchor.getAttribute('class')) || /note/i.test(rel)
    || (anchor.tagName ? SUP_TAG.test(anchor.tagName) : false) || Boolean(anchor.closest?.('sup'))
  const byTarget = target !== null && (
    looksLikeNote(
      target.getAttribute('epub:type') ?? target.getAttribute('data-epub-type'),
      target.getAttribute('class') ?? target.getAttribute('role'),
    ) || looksLikeNote(target.getAttribute('role'), null)
  )
  if (!byAnchor && !byTarget) return null
  return { label: (anchor.textContent ?? '').trim().slice(0, 24), href, fragment }
}

/**
 * The note's own words.
 *
 * Trailing back-links (`↩`, `[Back]`) are part of the container, not the note, and leaving them in makes
 * every preview end in a glyph that does nothing here.
 */
export function noteTextOf(element: Element, maxChars = 1200): string {
  const clone = element.cloneNode(true) as Element
  clone.querySelectorAll('a[href], .backlink, [epub\\:type*="backlink"], [role="doc-backlink"]').forEach((one) => one.remove())
  const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text
}

/** The element a fragment names, from a chapter's own HTML. Null when the chapter has no such id. */
export function noteTargetFromHtml(html: string, fragment: string): Element | null {
  if (!fragment) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(fragment) : fragment.replace(/["\\]/g, '\\$&')
  try {
    return doc.getElementById(fragment) ?? doc.querySelector(`[id="${escaped}"]`)
  } catch {
    return null
  }
}

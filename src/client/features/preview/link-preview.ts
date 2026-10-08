import { decodeDataValue } from '../../lib/markdown/data-attr';
import type { LinkPreview, LinkPreviewKind } from '../../types/hover-card';

/** Where a destination stops being worth printing in full: a `data:` URI can hold megabytes. */
export const LINK_HREF_DISPLAY_LIMIT = 320;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const AUDIO_VIDEO_EXT_RE = /\.(?:mp3|wav|ogg|m4a|mp4|webm|mov)$/i;
const OPENABLE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
/** Spans the note card and the tag card already own; a link card on top of them would duplicate. */
const NOT_A_LINK = ['wikilink', 'inline-tag', 'block-reference', 'figure-reference', 'media-embed'];

export interface OwnNote {
  title: string;
  id: string;
}

function schemeOf(value: string): string {
  return /^([a-z][a-z\d+\-.]*):/i.exec(value.trim())?.[1]?.toLowerCase() ?? '';
}

function withoutFragment(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value;
}

export function isImageHref(href: string): boolean {
  const bare = withoutFragment(href).trim();
  return IMAGE_EXT_RE.test(bare);
}

/** The host a browser would contact, with the `www.` prefix dropped; null when the address has none. */
export function displayHost(href: string): string | null {
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (!host) return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  }
  catch {
    return null;
  }
}

function kindOf(href: string): LinkPreviewKind {
  const scheme = schemeOf(href);
  const bare = withoutFragment(href).trim();
  if (isImageHref(href)) return 'image';
  if (scheme === 'mailto') return 'mail';
  if (scheme === 'tel' || scheme === 'sms') return 'phone';
  if (scheme === 'http' || scheme === 'https' || scheme === 'ftp' || scheme === 'ftps') return 'web';
  if (AUDIO_VIDEO_EXT_RE.test(bare)) return 'file';
  if (!scheme || bare.startsWith('/') || bare.startsWith('./') || bare.startsWith('../')) return 'file';
  return 'other';
}

/**
 * The card's one-line summary of a destination: what the reader clicked, what it points at, and whether
 * the card may offer to open it. `javascript:` and `data:` are never openable, which is the whole reason
 * the scheme is checked here rather than trusted from the renderer.
 */
export function describeLink(href: string, text: string, own?: OwnNote | null): LinkPreview {
  const trimmed = href.trim();
  const truncated = trimmed.length > LINK_HREF_DISPLAY_LIMIT;
  const scheme = schemeOf(trimmed);
  return {
    href: truncated ? `${trimmed.slice(0, LINK_HREF_DISPLAY_LIMIT)}…` : trimmed,
    text: text.trim(),
    kind: kindOf(trimmed),
    host: displayHost(trimmed),
    openable: OPENABLE_SCHEMES.has(scheme),
    truncated,
    noteTitle: own?.title,
    noteId: own?.id ?? null,
  };
}

/** The words a source-editor span shows, with whichever markdown shape it was written in taken off. */
function plainLabel(value: string): string {
  const match = /^!?\[([^\]]*)\]\((?:<[^>]*>|[^)\s]*)\)$/.exec(value.trim());
  return match ? match[1]!.trim() : value.trim();
}

function attribute(el: HTMLElement, name: string): string | null {
  const value = el.getAttribute(name);
  return value === null || value.trim() === '' ? null : value;
}

/**
 * The link a hovered span carries, or null when the span is not a link. The editor's marks announce
 * themselves with `data-mdlink` because their text is the markdown source; the rendered preview needs
 * no such hint since it holds a real anchor or image.
 */
export function linkPreviewFromElement(
  el: HTMLElement,
  ownNoteFor?: (href: string) => OwnNote | null,
): LinkPreview | null {
  if (NOT_A_LINK.some((name) => el.classList.contains(name))) return null;
  if (el.dataset.wikilink !== undefined || el.dataset.tag !== undefined || el.dataset.blockRef !== undefined) return null;
  const tag = el.tagName.toUpperCase();
  if (el.dataset.mdlink !== undefined) {
    const href = decodeDataValue(el.dataset.mdlink);
    if (!href) return null;
    return describeLink(href, plainLabel(el.textContent ?? ''), ownNoteFor?.(href));
  }
  if (tag === 'A') {
    const href = attribute(el, 'href');
    if (!href || href.startsWith('#')) return null;
    const text = (el.textContent ?? '').trim();
    if (text === href.trim()) return describeLink(href, '', ownNoteFor?.(href));
    return describeLink(href, text, ownNoteFor?.(href));
  }
  if (tag === 'IMG') {
    const src = attribute(el, 'src');
    if (!src) return null;
    return describeLink(src, (attribute(el, 'alt') ?? '').trim(), ownNoteFor?.(src));
  }
  return null;
}

/** The card header: the words the reader sees, falling back to the host, then to the address. */
export function linkCardTitle(preview: LinkPreview): string {
  return preview.text || preview.host || preview.href;
}

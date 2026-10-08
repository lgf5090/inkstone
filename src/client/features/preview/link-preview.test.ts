import { describe, expect, it } from 'vitest';
import { encodeDataValue } from '../../lib/markdown/data-attr';
import { describeLink, displayHost, isImageHref, linkCardTitle, linkPreviewFromElement } from './link-preview';
import { resolveHoverCandidate } from './link-hover-host';
import { useNotes } from '../../store/notes';

const WORDS = '\u9009\u4e2d\u6587\u5b57';
const PIC = '\u7167\u7247';

function element(tag: string, init: { href?: string, src?: string, text?: string, alt?: string, mdlink?: string, classes?: string[], dataset?: Record<string, string> } = {}): HTMLElement {
  const el = document.createElement(tag);
  if (init.href !== undefined) el.setAttribute('href', init.href);
  if (init.src !== undefined) el.setAttribute('src', init.src);
  if (init.alt !== undefined) el.setAttribute('alt', init.alt);
  if (init.text !== undefined) el.textContent = init.text;
  for (const name of init.classes ?? []) el.classList.add(name);
  for (const [key, value] of Object.entries(init.dataset ?? {})) el.dataset[key] = value;
  if (init.mdlink !== undefined) el.dataset.mdlink = encodeDataValue(init.mdlink);
  return el;
}

describe('describeLink', () => {
  it('names the kind of destination a reader is about to follow', () => {
    expect(describeLink('https://example.com/a', WORDS).kind).toBe('web');
    expect(describeLink('https://cdn.io/shot.png', PIC).kind).toBe('image');
    expect(describeLink('mailto:reader@example.com', '\u6765\u4fe1').kind).toBe('mail');
    expect(describeLink('tel:+15551234567', '\u7535\u8bdd').kind).toBe('phone');
    expect(describeLink('notes/todo.md', '\u5f85\u529e').kind).toBe('file');
    expect(describeLink('/deep/path', '\u8def\u5f84').kind).toBe('file');
    expect(describeLink('javascript:alert(1)', WORDS).kind).toBe('other');
  });

  it('only offers to open the schemes a browser can follow', () => {
    expect(describeLink('https://example.com/a', '').openable).toBe(true);
    expect(describeLink('mailto:reader@example.com', '').openable).toBe(true);
    expect(describeLink('tel:+15551234567', '').openable).toBe(true);
    for (const href of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'blob:https://x/y', '/notes/a.md', '#section'])
      expect(describeLink(href, '').openable, href).toBe(false);
  });

  it('prints the host a request would go to', () => {
    expect(describeLink('https://www.example.com/a', '').host).toBe('example.com');
    expect(describeLink('https://cdn.io:8443/shot.png', '').host).toBe('cdn.io');
    expect(describeLink('notes/todo.md', '').host).toBeNull();
    expect(describeLink('mailto:reader@example.com', '').host).toBeNull();
  });

  it('shortens a destination too long to read, and says so', () => {
    const huge = `data:text/html;base64,${'A'.repeat(2000)}`;
    const preview = describeLink(huge, WORDS);
    expect(preview.truncated).toBe(true);
    expect(preview.href.endsWith('…')).toBe(true);
    expect(preview.href.length).toBeLessThan(400);
    const short = describeLink('https://example.com/a', WORDS);
    expect(short.truncated).toBe(false);
    expect(short.href).toBe('https://example.com/a');
  });

  it('keeps the note a copied direct link points at', () => {
    const preview = describeLink('https://app.inkstone.dev/n/abc123', '\u5f15\u7528', { title: '\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0', id: 'abc123' });
    expect(preview.noteTitle).toBe('\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0');
    expect(preview.noteId).toBe('abc123');
    expect(describeLink('https://elsewhere.dev/n/abc123', '').noteId).toBeNull();
  });
});

describe('displayHost and isImageHref', () => {
  it('reads a host out of an absolute address only', () => {
    expect(displayHost('https://example.com')).toBe('example.com');
    expect(displayHost('/relative')).toBeNull();
    expect(displayHost('')).toBeNull();
  });

  it('looks past a query or a fragment for the extension', () => {
    expect(isImageHref('https://cdn.io/a.png?v=2')).toBe(true);
    expect(isImageHref('https://cdn.io/a.webp#x')).toBe(true);
    expect(isImageHref('https://cdn.io/page')).toBe(false);
    expect(isImageHref('https://cdn.io/a.pngx')).toBe(false);
  });
});

describe('linkPreviewFromElement', () => {
  it('reads a rendered anchor', () => {
    const preview = linkPreviewFromElement(element('a', { href: 'https://example.com/a', text: WORDS }));
    expect(preview?.href).toBe('https://example.com/a');
    expect(preview?.text).toBe(WORDS);
    expect(preview?.kind).toBe('web');
  });

  it('leaves the words empty when the anchor shows its own address', () => {
    const preview = linkPreviewFromElement(element('a', { href: 'https://example.com/a', text: 'https://example.com/a' }));
    expect(preview?.text).toBe('');
    expect(linkCardTitle(preview!)).toBe('example.com');
  });

  it('stays away from in-page jumps and from the spans other cards own', () => {
    expect(linkPreviewFromElement(element('a', { href: '#section', text: '\u5c0f\u8282' }))).toBeNull();
    expect(linkPreviewFromElement(element('a', { href: '', text: '\u7a7a' }))).toBeNull();
    expect(linkPreviewFromElement(element('a', { href: '#', text: WORDS, classes: ['wikilink'], dataset: { wikilink: encodeDataValue(WORDS) } }))).toBeNull();
    expect(linkPreviewFromElement(element('a', { href: '#%5Eabc', text: '((abc))', classes: ['block-reference'], dataset: { blockRef: encodeDataValue('abc') } }))).toBeNull();
    expect(linkPreviewFromElement(element('span', { text: '#\u5de5\u4f5c', dataset: { tag: encodeDataValue('\u5de5\u4f5c') } }))).toBeNull();
    expect(linkPreviewFromElement(element('a', { href: 'https://example.com/a', text: WORDS, classes: ['figure-reference'] }))).toBeNull();
    expect(linkPreviewFromElement(element('span', { text: '\u666e\u901a\u6587\u5b57' }))).toBeNull();
  });

  it('reads a picture as the link it is', () => {
    const preview = linkPreviewFromElement(element('img', { src: 'https://cdn.io/shot.png', alt: PIC }));
    expect(preview?.kind).toBe('image');
    expect(preview?.text).toBe(PIC);
    expect(preview?.openable).toBe(true);
  });

  it('takes the destination off a source-editor mark and the words out of its markdown', () => {
    const preview = linkPreviewFromElement(element('span', { text: `[${WORDS}](https://example.com/a)`, mdlink: 'https://example.com/a' }));
    expect(preview?.href).toBe('https://example.com/a');
    expect(preview?.text).toBe(WORDS);
    const image = linkPreviewFromElement(element('span', { text: `![${PIC}](https://cdn.io/a.png)`, mdlink: 'https://cdn.io/a.png' }));
    expect(image?.kind).toBe('image');
    expect(image?.text).toBe(PIC);
    const bare = linkPreviewFromElement(element('span', { text: 'https://example.com/a', mdlink: 'https://example.com/a' }));
    expect(bare?.text).toBe('https://example.com/a');
  });

  it('never claims a source mark whose destination is empty', () => {
    expect(linkPreviewFromElement(element('span', { text: '[\u6587\u5b57]()', mdlink: '' }))).toBeNull();
  });

  it('asks for the own note by the destination it found', () => {
    const asked: string[] = [];
    const preview = linkPreviewFromElement(
      element('a', { href: 'https://app.inkstone.dev/n/abc123', text: '\u5f15\u7528' }),
      (href) => {
        asked.push(href);
        return { title: '\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0', id: 'abc123' };
      },
    );
    expect(asked).toEqual(['https://app.inkstone.dev/n/abc123']);
    expect(preview?.noteTitle).toBe('\u6df1\u5ea6\u7814\u7a76\u7b14\u8bb0');
    expect(linkCardTitle(preview!)).toBe('\u5f15\u7528');
  });
});

describe('linkCardTitle', () => {
  it('prefers the words, then the host, then the address', () => {
    expect(linkCardTitle(describeLink('https://example.com/a', WORDS))).toBe(WORDS);
    expect(linkCardTitle(describeLink('https://example.com/a', ''))).toBe('example.com');
    expect(linkCardTitle(describeLink('notes/todo.md', ''))).toBe('notes/todo.md');
  });
});

describe('resolveHoverCandidate with links', () => {
  function anchorFor(href: string, text: string): HTMLElement {
    const el = document.createElement('a');
    el.setAttribute('href', href);
    el.textContent = text;
    document.body.appendChild(el);
    return el;
  }

  it('answers a link card for a plain anchor', () => {
    const card = resolveHoverCandidate(anchorFor('https://example.com/h1', 'link words'), null);
    expect(card?.link?.href).toBe('https://example.com/h1');
    expect(card?.link?.kind).toBe('web');
    expect(card?.noteId).toBeNull();
    expect(card?.missing).toBe(false);
    expect(card?.title).toBe('link words');
  });

  it('stays away from an anchor when the link card is switched off', () => {
    expect(resolveHoverCandidate(anchorFor('https://example.com/h2', 'link words'), null, false)).toBeNull();
  });

  it('names the note a direct link of this deployment points at', () => {
    useNotes.setState({ notes: { 'n-9': { id: 'n-9', title: 'Deep Notes', deletedAt: null } as never } });
    const card = resolveHoverCandidate(anchorFor(`${window.location.origin}/n/n-9`, 'ref'), null);
    expect(card?.link?.noteTitle).toBe('Deep Notes');
    expect(card?.link?.noteId).toBe('n-9');
  });

  it('leaves a deleted note as a plain web address', () => {
    useNotes.setState({ notes: { 'n-8': { id: 'n-8', title: 'Gone', deletedAt: 5 } as never } });
    const card = resolveHoverCandidate(anchorFor(`${window.location.origin}/n/n-8`, 'ref'), null);
    expect(card?.link?.noteId).toBeNull();
    expect(card?.link?.kind).toBe('web');
  });

  it('leaves a foreign deployment link alone', () => {
    useNotes.setState({ notes: { 'n-9': { id: 'n-9', title: 'Deep Notes', deletedAt: null } as never } });
    const card = resolveHoverCandidate(anchorFor('https://elsewhere.example/n/n-9', 'ref'), null);
    expect(card?.link?.noteId).toBeNull();
  });

  it('never answers with a copy of the note the anchor merely sits in', () => {
    useNotes.setState({ notes: { 'n-7': { id: 'n-7', title: 'Host Note', deletedAt: null } as never } });
    expect(resolveHoverCandidate(anchorFor('https://example.com/h3', 'words'), 'n-7', false)).toBeNull();
    expect(resolveHoverCandidate(element('span', { text: 'ordinary words' }), 'n-7', false)).toBeNull();
  });

  it('still previews a heading of the note the reader is in', () => {
    useNotes.setState({ notes: { 'n-7': { id: 'n-7', title: 'Host Note', deletedAt: null } as never } });
    const heading = element('a', { href: '#heading', text: 'a heading', dataset: { wikilink: encodeDataValue('#Heading') } });
    const card = resolveHoverCandidate(heading, 'n-7', false);
    expect(card?.noteId).toBe('n-7');
    expect(card?.headline).toBe('Heading');
  });
});

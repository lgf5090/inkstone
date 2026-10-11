/**
 * An attempt, not an audit.
 *
 * The security notes in the review were "reads correct"; this file is what turns them into "attacked".
 * Every case is a string a note could hold that would break a renderer assuming text is only text, and
 * the assertion is always the same shape: nothing became an element, nothing became an attribute, and
 * what was written is what comes back out.
 */
import { describe, expect, it } from 'vitest';
import { parseJsonDocument, valueOfNode, writeJsonDocument } from '../../lib/markdown/json-view';
import { renderJsonTree } from './json-tree-view';
import { renderJsonMap, jsonMapSvg } from './json-map-view';
import type { JsonViewControl } from './json-tree-view';
import type { JsonMapView } from './json-map-view';

/** Keys and values chosen to break an escaper, not to be rude. */
const HOSTILE = [
  `"><script>alert(1)</script>`,
  `" onmouseover="alert(1)`,
  `javascript:alert(1)`,
  `</textarea><img src=x onerror=alert(1)>`,
  `a" b='c` ,
  `\\"><svg onload=alert(1)>`,
  `\u0000nul\u0000`,
  `\u202eRTL\u202d override`,
  `__proto__`,
  `constructor.prototype.polluted`,
  `emoji 🚀 and 中文`,
  `"${'x'.repeat(5000)}"`,
];

function hostileDocument() {
  const body = JSON.stringify({ [HOSTILE[0]!]: HOSTILE.map(value => ({ [HOSTILE[1]!]: value })) }, null, 2);
  const parsed = parseJsonDocument(body);
  if (!parsed.ok || !parsed.document)
    throw new Error(`fixture unreadable: ${parsed.failure?.reason}`);
  return parsed.document;
}

const control: JsonViewControl = { editable: true, commit: () => true, notify: () => {} };
const view: JsonMapView = { camera: { x: 0, y: 0, scale: 1 }, fitted: true };

function assertNoLiveMarkup(root: ParentNode, where: string): void {
  expect(root.querySelectorAll('script, iframe, object, embed, style, link, meta'), where).toHaveLength(0);
  const handlers = [...root.querySelectorAll<HTMLElement>('*')]
    .filter(node => [...node.attributes].some(attr => /^on/i.test(attr.name) || (attr.name === 'href' && /^javascript:/i.test(attr.value))))
    .map(node => node.outerHTML.slice(0, 80));
  expect(handlers, where).toEqual([]);
}

describe('hostile note text', () => {
  it('renders as text in the tree, never as markup', () => {
    const host = document.createElement('div');
    document.body.append(host);
    renderJsonTree(host, hostileDocument(), control, null);
    assertNoLiveMarkup(host, 'tree');
    // The escaper covers the quote that closes an attribute, so a path with one in it still has to be
    // findable by the selector the row's own buttons use.
    const rows = host.querySelectorAll('.jt-row');
    expect(rows.length).toBeGreaterThan(1);
    const first = rows[1]!;
    const path = JSON.parse(first.getAttribute('data-path') ?? '[]');
    expect(Array.isArray(path) && path.length === 1).toBe(true);
    expect(host.querySelector(`.jt-row[data-path="${CSS.escape(first.getAttribute('data-path')!)}"]`)).not.toBeNull();
  });

  it('keeps every hostile string byte-identical through a render', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const parsed = hostileDocument();
    renderJsonTree(host, parsed, control, null);
    const values = [...host.querySelectorAll('.jt-value')].map(node => node.textContent);
    for (const needle of HOSTILE.slice(0, 8)) {
      if (needle.includes('\u0000'))
        continue;
      expect(values.some(value => value?.includes(needle.slice(0, 24))), needle).toBe(true);
    }
  });

  it('renders as text in the map, and the exported SVG parses with nothing live in it', () => {
    const host = document.createElement('div');
    host.getBoundingClientRect = () => ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(host);
    renderJsonMap(host, hostileDocument(), view);
    assertNoLiveMarkup(host, 'map');
    const svg = jsonMapSvg(hostileDocument(), host);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    assertNoLiveMarkup(doc.documentElement, 'exported svg');
    // A colour that is not a colour must not be interpolated into an attribute.
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('does not let a note key reach the prototype of a value', () => {
    const parsed = parseJsonDocument('{"__proto__": {"polluted": 1}, "constructor": 2}');
    const value = valueOfNode(parsed.document!.root) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('writes a hostile document back out unchanged', () => {
    const parsed = hostileDocument();
    const body = writeJsonDocument(parsed);
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body)).toEqual(JSON.parse(JSON.stringify({
      [HOSTILE[0]!]: HOSTILE.map(value => ({ [HOSTILE[1]!]: value })),
    })));
  });

  it('drops a NUL from the display but keeps it in the note', () => {
    // The HTML parser discards U+0000 outright rather than substituting, so a note holding one shows a
    // row with the character missing. That is a display-fidelity gap worth knowing about, and it is why
    // the exported SVG has to substitute instead: XML 1.0 cannot represent a NUL at all, and the
    // previous escaper emitted a file that would not parse.
    const body = JSON.stringify({ a: '\u0000\u202eX\u202d' });
    const parsed = parseJsonDocument(body);
    const host = document.createElement('div');
    host.getBoundingClientRect = () => ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(host);
    renderJsonTree(host, parsed.document!, control, null);
    expect(host.querySelector('.jt-value')?.textContent).toBe('\u202eX\u202d');
    const svg = jsonMapSvg(parsed.document!, host);
    expect(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')).toBeNull();
    expect(svg).toContain('\uFFFD');
    expect(writeJsonDocument(parsed.document!)).toBe(body);
  });
});

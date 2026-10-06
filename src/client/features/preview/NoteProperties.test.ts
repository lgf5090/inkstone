import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFrontMatter } from '@shared/markdown-utils';
import { t } from '../../lib/i18n';

const editContent = vi.fn();
const openView = vi.fn();
interface Store {
  editContent: typeof editContent;
  openView: typeof openView;
  contents: Record<string, string>;
  tags: Array<{ id: string; name: string; color: string | null; count: number; createdAt: number }>;
}
let store: Store;

vi.mock('../../store/notes', () => ({
  useNotes: (selector: (state: typeof store) => unknown) => selector(store),
}));
vi.mock('../../store/ui', () => ({
  useUi: (selector: (state: typeof store) => unknown) => selector(store),
}));

const { NoteProperties } = await import('./NoteProperties');

const SOURCE = [
  '---',
  'title: Example',
  'flag: true',
  'count: 3',
  'aliases: [Guide]',
  'tags: [demo, ai]',
  '---',
  '',
  'body mentions #demo once',
  '',
  'tail.',
].join('\n');

let host: HTMLDivElement;
let root: Root;

function render(content: string, noteId: string | null = 'n1'): void {
  store.contents = noteId ? { [noteId]: content } : {};
  act(() => root.render(createElement(NoteProperties, { noteId })));
}

function pillButton(name: string): HTMLElement | undefined {
  return [...host.querySelectorAll('button')].find((node) => node.textContent === `#${name}`);
}

function keyButton(key: string): HTMLElement | undefined {
  return [...host.querySelectorAll('button')].find((node) => node.textContent === key);
}

function removeButtonFor(name: string): HTMLElement | undefined {
  const label = t('properties.remove_tag_value0', { value0: name });
  return [...host.querySelectorAll<HTMLElement>('[aria-label]')]
    .filter((node) => node.getAttribute('aria-label') === label)
    .find((node) => node.parentElement?.textContent?.includes(name));
}

function byLabel(label: string): HTMLElement | null {
  return [...host.querySelectorAll<HTMLElement>('[aria-label]')]
    .find((node) => node.getAttribute('aria-label') === label) ?? null;
}

function click(node: Element | null | undefined): void {
  expect(node, 'expected element to be present').toBeTruthy();
  act(() => {
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function commitText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

function written(): { raw: string; data: Record<string, unknown> } {
  expect(editContent).toHaveBeenCalledTimes(1);
  const [id, raw] = editContent.mock.calls[0]!;
  expect(id).toBe('n1');
  const parsed = parseFrontMatter(raw as string);
  expect(parsed.errors).toEqual([]);
  return { raw: raw as string, data: parsed.data };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  editContent.mockReset();
  openView.mockReset();
  store = {
    editContent,
    openView,
    contents: {},
    tags: [{ id: 't-demo', name: 'demo', color: null, count: 2, createdAt: 1 }],
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('NoteProperties', () => {
  it('lists every front matter key as its own row', () => {
    render(SOURCE);
    for (const key of ['title', 'flag', 'count', 'aliases', 'tags'])
      expect(host.textContent).toContain(key);
    expect(host.textContent).toContain('Example');
    expect(host.textContent).toContain('Guide');
  });

  it('writes a boolean back into the same content the editor holds', () => {
    render(SOURCE);
    const toggle = host.querySelector('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    click(toggle);
    const { raw, data } = written();
    expect(data.flag).toBe(false);
    expect(data.tags).toEqual(['demo', 'ai']);
    expect(raw).toContain('body mentions #demo once');
    expect(raw).toContain('tail.');
  });

  it('removes a tag from the front matter and the body in one write', () => {
    render(SOURCE);
    click(removeButtonFor('demo'));
    const { raw, data } = written();
    expect(data.tags).toEqual(['ai']);
    expect(data.title).toBe('Example');
    expect(raw).not.toContain('#demo');
    expect(raw).toContain('body mentions');
    expect(raw).toContain('tail.');
  });

  it('opens the tag view from a tag pill, and a plain list item stays inert', () => {
    render(SOURCE);
    click(pillButton('demo'));
    expect(openView).toHaveBeenCalledWith('tag', { tag: 'demo' });
    openView.mockReset();
    expect([...host.querySelectorAll('button')].some((node) => node.textContent?.includes('Guide'))).toBe(false);
    expect(host.textContent).toContain('Guide');
    expect(openView).not.toHaveBeenCalled();
  });

  it('edits a text value and leaves the other keys alone', () => {
    render(SOURCE);
    click([...host.querySelectorAll('button')].find((node) => node.textContent === 'Example'));
    commitText(host.querySelector<HTMLInputElement>('input[aria-label="title"]')!, 'Renamed');
    const { data } = written();
    expect(data.title).toBe('Renamed');
    expect(data.flag).toBe(true);
    expect(data.count).toBe(3);
    expect(data.tags).toEqual(['demo', 'ai']);
  });

  it('renames a key and carries its value across', () => {
    render(SOURCE);
    click(keyButton('title'));
    commitText(host.querySelector<HTMLInputElement>('input[aria-label="properties.rename"]')!, 'heading');
    const { data } = written();
    expect(data.heading).toBe('Example');
    expect(data.title).toBeUndefined();
  });

  it('adds and deletes a property', () => {
    render(SOURCE);
    click(byLabel(t('properties.delete')));
    expect(written().data.title).toBeUndefined();
    editContent.mockReset();
    click(byLabel(t('properties.add')));
    const [keyField, valueField] = [...host.querySelectorAll<HTMLInputElement>('input')];
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(keyField!, 'status');
      keyField!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    commitText(valueField!, 'draft');
    const { raw: addedRaw, data: added } = written();
    expect(added.status).toBe('draft');
    expect(added.tags).toEqual(['demo', 'ai']);
    expect(addedRaw).toContain('body mentions #demo once');
  });

  it('reflects a value the editor changed underneath it', () => {
    render(SOURCE);
    expect(host.textContent).toContain('Example');
    render(SOURCE.replace('title: Example', 'title: ChangedOutside'));
    expect(host.textContent).toContain('ChangedOutside');
    expect(host.textContent).not.toContain('Example');
  });

  it('writes from the newest content it was given, not the one the row was opened with', () => {
    render(SOURCE);
    render(SOURCE.replace('body mentions #demo once', 'body mentions #demo once, then typed'));
    click(removeButtonFor('ai'));
    const { raw, data } = written();
    expect(data.tags).toEqual(['demo']);
    expect(raw).toContain('then typed');
  })

  it('refuses to edit while the front matter is broken', () => {
    render(['---', 'title: [unclosed', '---', 'body'].join('\n'));
    expect(host.textContent).toContain(t('properties.invalid'));
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(byLabel(t('properties.add'))).toBeNull();
    expect(byLabel(t('properties.delete'))).toBeNull();
  });

  it('offers no writes without an open note', () => {
    store.contents = { n1: SOURCE };
    act(() => root.render(createElement(NoteProperties, { noteId: null })));
    expect(byLabel(t('properties.add'))).toBeNull();
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(editContent).not.toHaveBeenCalled();
  });
});

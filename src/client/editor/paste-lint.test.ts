/**
 * The paste-time rules, as the editor sees them.
 *
 * The claim here is narrow: a paste the linter was asked to handle is rewritten before it lands, and
 * a paste it was not asked about is left for the editor's own handlers. The third case matters most —
 * an address is the one thing the linter must not touch, because the link features are waiting for it.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants';
import type { LinterSettings } from '@shared/linter';
import { useSession } from '../store/session';
import { pasteEventHandlers } from './paste';

const ELLIPSIS: LinterSettings['ruleConfigs'] = { 'proper-ellipsis-on-paste': { enabled: true } };

async function withPaste(doc: string, clip: string, from = 0, to = from) {
  const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: from, head: to } }) });
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [], types: ['text/plain'], getData: (kind: string) => (kind === 'text/plain' ? clip : '') },
  });
  const handled = pasteEventHandlers({ uploadFile: async () => null }).paste!.call(view, event, view);
  const claimed = handled === true;
  const prevented = event.defaultPrevented;
  // the paste rules are behind a dynamic import, so the text lands a beat after the keystroke
  if (claimed) {
    await vi.waitFor(() => expect(view.state.doc.toString()).not.toBe(doc), { timeout: 5_000, interval: 10 });
  }
  const text = view.state.doc.toString();
  view.destroy();

  return { text, claimed, prevented };
}

function setLinter(patch: Partial<LinterSettings>): void {
  useSession.setState({
    settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, lintOnPaste: true, ruleConfigs: ELLIPSIS, ...patch } }),
  });
}

beforeAll(async () => {
  // `paste.ts` reaches the rules through `await import('../lib/linter')`, and that module reaches the
  // runner and the registry through two more dynamic imports of its own. Cold, those wait on the
  // bundler's transform queue, and a full-suite run is contended enough for the wait to outlast any
  // timeout this file could reasonably carry — the paste then lands after the case has given up.
  // Loading all three here puts them in the module graph, so the handler's own imports resolve on a
  // tick. Warming only the index is what left this file failing in the full run: `lintPaste` never
  // touches `./runner` until it is called.
  await Promise.all([import('../lib/linter'), import('../lib/linter/runner'), import('../lib/linter/registry')]);
});

beforeEach(() => {
  localStorage.clear();
  setLinter({});
});

describe('pasting while the paste rules are on', () => {
  it('rewrites what lands in the note', async () => {
    const pasted = await withPaste('', 'wait (. . .) here');

    expect(pasted.claimed).toBe(true);
    expect(pasted.prevented).toBe(true);
    expect(pasted.text).toBe('wait (…) here');
  });

  it('replaces the selection it was pasted over', async () => {
    const pasted = await withPaste('lorem ipsum', 'wait (. . .)', 0, 5);

    expect(pasted.text).toBe('wait (…) ipsum');
  });

  it('says nothing to a clipboard that holds only an address', async () => {
    const pasted = await withPaste('', 'https://example.com/a');

    expect(pasted.claimed).toBe(false);
    expect(pasted.prevented).toBe(false);
    expect(pasted.text).toBe('');
  });

  it('leaves the editor to paste on its own when the reader switched the drive off', async () => {
    setLinter({ lintOnPaste: false });
    const pasted = await withPaste('', 'wait (. . .) here');

    expect(pasted.claimed).toBe(false);
    expect(pasted.prevented).toBe(false);
    expect(pasted.text).toBe('');
  });

  it('leaves it alone when the linter itself is off', async () => {
    setLinter({ enabled: false });
    const pasted = await withPaste('', 'wait (. . .) here');

    expect(pasted.claimed).toBe(false);
    expect(pasted.text).toBe('');
  });

  it('leaves the paste to the editor when the drive is on but no paste rule is', async () => {
    setLinter({ ruleConfigs: { 'trailing-spaces': { enabled: true } } });
    const pasted = await withPaste('', 'wait (. . .) here');

    expect(pasted.claimed).toBe(false);
    expect(pasted.prevented).toBe(false);
    expect(pasted.text).toBe('');
  });

  it('does not claim a clipboard with nothing on it', async () => {
    const pasted = await withPaste('keep', '');

    expect(pasted.claimed).toBe(false);
    expect(pasted.text).toBe('keep');
  });
});

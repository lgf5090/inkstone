/**
 * The two automatic runs, on a clock.
 *
 * What a reader expects from `Lint on save` in an app that saves on its own is: the note gets
 * formatted once the typing has stopped, and not while a word is still being composed. These
 * assertions are about that schedule — one run per pause, none when the switches are off, none for a
 * note that was only opened — and they stub the drive itself, because the engine's own behaviour is
 * the subject of `drive.test.ts`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants';
import type { LinterSettings } from '@shared/linter';
import { useSession } from '../../store/session';
import { useLinterDrives } from './idle-drive';

const calls: Array<[string, boolean, EditorView | null]> = [];
vi.mock('./drive', () => ({
  lintAndReport: (noteId: string, quiet: boolean, view: EditorView | null) => {
    calls.push([noteId, quiet, view]);
    return Promise.resolve();
  },
}));

let root: Root;
let container: HTMLDivElement;
let armed: (() => void) | null;

function Harness({ noteId, view }: { noteId: string | null, view: EditorView | null }) {
  armed = useLinterDrives(noteId, view);
  return null;
}

function mount(noteId: string | null, view: EditorView | null = null): void {
  act(() => {
    root.render(createElement(Harness, { noteId, view }));
  });
}

function setLinter(patch: Partial<LinterSettings>, autoSaveDelay = 800): void {
  useSession.setState({
    settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, ...patch }, editor: { ...DEFAULT_SETTINGS.editor, autoSaveDelay } }),
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
  armed = null;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  setLinter({ enabled: true, lintOnSave: true });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('lint on save', () => {
  it('runs once the typing has stopped for the auto-save delay', async () => {
    mount('n1');
    act(() => {
      armed?.();
    });

    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map(([noteId, quiet]) => [noteId, quiet])).toEqual([['n1', true]]);
  });

  it('runs once for a pause, not once per keystroke', async () => {
    mount('n1');
    for (let key = 0; key < 6; key++) {
      act(() => {
        armed?.();
      });
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(900);

    expect(calls).toHaveLength(1);
  });

  it('does not run when the reader asked for nothing', async () => {
    setLinter({ lintOnSave: false, lintOnIdle: 0 });
    mount('n1');
    act(() => {
      armed?.();
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
  });

  it('does not run while the linter itself is switched off', async () => {
    setLinter({ enabled: false });
    mount('n1');
    act(() => {
      armed?.();
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
  });

  it('takes the shorter of the two delays when both are on', async () => {
    setLinter({ lintOnSave: false, lintOnIdle: 5_000 });
    mount('n1');
    act(() => {
      armed?.();
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
  });

  it('does not wait for a save the reader switched off', async () => {
    setLinter({ lintOnSave: true, lintOnIdle: 5_000 }, 60_000);
    mount('n1');
    act(() => {
      armed?.();
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });

  it('waits for an input method to finish the word it is composing', async () => {
    const fakeView = { composing: true };
    mount('n1', fakeView as unknown as EditorView);
    act(() => {
      armed?.();
    });

    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toEqual([]);

    // the reader commits the word; the same scheduled run then finds nothing holding it back
    fakeView.composing = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
  });

  it('gives up on a composition that never ends rather than writing over it forever', async () => {
    mount('n1', { composing: true } as unknown as EditorView);
    act(() => {
      armed?.();
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual([]);
  });

  it('stops waiting when the reader switches to another note', async () => {
    mount('n1');
    act(() => {
      armed?.();
    });
    await vi.advanceTimersByTimeAsync(400);

    mount('n2');
    await vi.advanceTimersByTimeAsync(5_000);

    // the note that was left behind is not formatted by a run that was armed for it, and switching
    // notes is not an edit, so the note that arrived is not formatted either
    expect(calls).toEqual([]);
  });
});

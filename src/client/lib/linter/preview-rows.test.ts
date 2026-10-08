/**
 * The rows the preview dialog draws.
 *
 * A reader decides from this whether to let the run through, so the two things that matter are that
 * it shows the lines that actually change and that it says how much it left out. The counts are the
 * ones the dialog prints in its header, so they are asserted here rather than recomputed there.
 */
import { describe, expect, it } from 'vitest';
import { buildPreviewDiff } from './preview-rows';

describe('buildPreviewDiff', () => {
  it('answers nothing at all when the two texts are the same', () => {
    const diff = buildPreviewDiff('a\nb\n', 'a\nb\n');

    expect(diff.rows).toEqual([]);
    expect(diff).toMatchObject({ hidden: 0, truncated: false, linesAdded: 0, linesRemoved: 0, charsAdded: 0, charsRemoved: 0 });
  });

  it('shows the changed line on both sides, with its neighbours', () => {
    const before = 'one\ntwo  \nthree\n';
    const after = 'one\ntwo\nthree\n';
    const diff = buildPreviewDiff(before, after);
    const kinds = diff.rows.map((row) => `${row.kind}:${row.line}`);

    // the trailing empty line the note ends with is context like any other line
    expect(kinds).toEqual(['context:1', 'removed:2', 'added:2', 'context:3', 'context:4']);
    expect(diff).toMatchObject({ linesAdded: 1, linesRemoved: 1, charsRemoved: 2 });
    // a reader deciding from this has to see that the line stays and only its spaces go: one row
    // alone would read as "this line is being deleted"
    expect(diff.rows[1].text).toBe('two  ');
    expect(diff.rows[2].text).toBe('two');
  });

  it('does not invent a line that only moved up when its neighbour was deleted', () => {
    const diff = buildPreviewDiff('one\ntwo\nthree\n', 'one\nthree\n');
    const kinds = diff.rows.map((row) => `${row.kind}:${row.line}`);

    expect(kinds).toEqual(['context:1', 'removed:2', 'context:3', 'context:4']);
    expect(diff).toMatchObject({ linesAdded: 0, linesRemoved: 1 });
  });

  it('does not invent a line that only moved down when a neighbour was added', () => {
    const diff = buildPreviewDiff('one\nthree\n', 'one\ntwo\nthree\n');

    expect(diff.rows.filter((row) => row.kind === 'added').map((row) => row.text)).toEqual(['two']);
    expect(diff).toMatchObject({ linesAdded: 1, linesRemoved: 0 });
  });

  it('shows a line the run added, not just the ones it removed', () => {
    const diff = buildPreviewDiff('---\n---\n\nbody\n', '---\ntitle: x\n---\n\nbody\n');

    expect(diff.linesAdded).toBe(1);
    expect(diff.linesRemoved).toBeLessThan(diff.linesAdded);
    expect(diff.rows.filter((row) => row.kind === 'added').map((row) => row.text)).toContain('title: x');
  });

  it('says nothing about a note that only lost its final newline', () => {
    const diff = buildPreviewDiff('body\n', 'body');

    // every line still reads the same, so the diff has no row to show — and a change that trimmed
    // away must not be drawn as a block, or its context lines come out twice
    expect(diff.rows).toEqual([]);
    expect(diff).toMatchObject({ linesAdded: 0, linesRemoved: 0, charsRemoved: 1, hidden: 0 });
  });

  it('marks the characters the two sides disagree about', () => {
    const diff = buildPreviewDiff('one\ntwo  \nthree\n', 'one\ntwo\nthree\n');
    const removed = diff.rows.find((row) => row.kind === 'removed');
    const added = diff.rows.find((row) => row.kind === 'added');

    // the dialog paints this span darker: two rows of spaces are otherwise the same picture, and the
    // line that reads `two` has nothing of its own to mark
    expect(removed?.changed).toEqual({ start: 3, end: 5 });
    expect(added?.changed).toBeUndefined();
  });

  it('marks the whole of two lines that share nothing', () => {
    const diff = buildPreviewDiff('before the change\n', 'after it\n');
    const removed = diff.rows.find((row) => row.kind === 'removed');
    const added = diff.rows.find((row) => row.kind === 'added');

    expect(removed?.changed).toEqual({ start: 0, end: 17 });
    expect(added?.changed).toEqual({ start: 0, end: 8 });
  });

  it('marks only what moved when a word was put into the middle of a line', () => {
    const diff = buildPreviewDiff('the cat sat\n', 'the cat now sat\n');
    const added = diff.rows.find((row) => row.kind === 'added');
    const removed = diff.rows.find((row) => row.kind === 'removed');

    expect(added?.changed).toEqual({ start: 8, end: 12 });
    expect(removed).not.toHaveProperty('changed');
  });

  it('collapses the unchanged middle of a note with a change at each end', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index}`);
    const before = `${lines.join('\n')}\n`;
    const changed = [...lines];
    changed[0] = 'changed first';
    changed[changed.length - 1] = 'changed last';
    const diff = buildPreviewDiff(before, `${changed.join('\n')}\n`);

    expect(diff.hidden).toBeGreaterThan(300);
    expect(diff.rows.filter((row) => row.kind === 'context').length).toBeLessThanOrEqual(12);
    expect(diff.truncated).toBe(false);
  });

  it('caps what it draws and tells the reader the rest exists', () => {
    const dirty: string[] = [];
    const clean: string[] = [];
    for (let index = 0; index < 400; index++) {
      dirty.push(`${index}   `, 'untouched');
      clean.push(`${index}`, 'untouched');
    }
    const before = dirty.join('\n');
    const after = clean.join('\n');
    const capped = buildPreviewDiff(before, after);
    const whole = buildPreviewDiff(before, after, true);

    expect(capped.truncated).toBe(true);
    expect(capped.rows.length).toBeLessThanOrEqual(240);
    // the cap cuts what is drawn, never what is counted: the header still says how big the change is
    expect(capped.hidden).toBeGreaterThan(0);
    expect(capped.linesRemoved).toBe(whole.linesRemoved);
    expect(capped.linesAdded).toBe(whole.linesAdded);
    expect(whole.rows.length).toBeGreaterThan(capped.rows.length);
    expect(whole.truncated).toBe(false);
    // every dirty line is reported on both sides, and no clean one is
    expect(whole.linesRemoved).toBeGreaterThanOrEqual(400);
    expect(whole.linesAdded).toBeGreaterThanOrEqual(400);
    expect(whole.rows.filter((row) => row.kind === 'removed').length).toBe(whole.linesRemoved);
    expect(whole.rows.filter((row) => row.kind === 'added').length).toBe(whole.linesAdded);
  });
});

import { describe, expect, it } from 'vitest';

import MoveFootnotesToTheBottom from '../rules/move-footnotes-to-the-bottom';
import ReIndexFootnotes from '../rules/re-index-footnotes';
import { t } from '../../i18n';

const documents = [
  '[^a]\n[^a]:\n```\n```',
  '[^a]\n[^a]: text\n```\ncode\n```',
  '[^a]\n[^a]: `code`\n\nAfter',
  '`[^a]`\n\n[^a]: text',
  '```\n[^a]\n```\n\n[^a]: text',
  '$$\n[^a]\n$$\n\n[^a]: text',
  '[^a] [^a]\n\n[^a]: first\n[^a]: second',
  '[^a] [^b]\n\n[^a]: [^b]\n[^b]: text',
  '[^2] [^1]\n\n[^2]: same\n[^1]: same',
  '[^a]\n\n[^a]: text\n    ```\n    code\n    ```\n\nAfter',
];

// asked for inside the test, so the locale the reader picked is the one that answers
const missingReference = () => 'THREW: ' + t('linter.logs.missing_footnote_error_message').replace('{FOOTNOTE}', '[^a]: text');
const MISSING_REFERENCE = '@@missing-reference@@'
const expectedResults = [
  ['[^a]\n```\n```\n\n[^a]:', '[^1]\n[^1]:\n```\n```'],
  // Masking's placeholder made the fence a continuation of the definition; the real parse keeps them separate.
  ['[^a]\n```\ncode\n```\n\n[^a]: text', '[^1]\n[^1]: text\n```\ncode\n```'],
  ['[^a]\nAfter\n\n[^a]: `code`', '[^1]\n[^1]: `code`\n\nAfter'],
  [MISSING_REFERENCE, '`[^a]`\n\n[^1]: text'],
  [MISSING_REFERENCE, '```\n[^a]\n```\n\n[^1]: text'],
  [MISSING_REFERENCE, '$$\n[^a]\n$$\n\n[^1]: text'],
  ['[^a] [^a]\n\n[^a]: first\n[^a]: second', '[^2] [^2]\n\n[^2]: first\n[^2]: second'],
  // The old output renamed the inner reference but not the definition's key, leaving a dangling reference.
  ['[^a] [^b]\n\n[^a]: [^b]\n[^b]: text', '[^1] [^2]\n\n[^1]: [^2]\n[^2]: text'],
  // Sequential string replacements collided and renumbered the wrong definition when bodies were identical.
  ['[^2] [^1]\n\n[^2]: same\n[^1]: same', '[^1] [^2]\n\n[^1]: same\n[^2]: same'],
  ['[^a]\n\nAfter\n\n[^a]: text\n    ```\n    code\n    ```', '[^1]\n\n[^1]: text\n    ```\n    code\n    ```\n\nAfter'],
];

describe.each([
  {name: 'move', rule: MoveFootnotesToTheBottom.getRule(), index: 0},
  {name: 're-index', rule: ReIndexFootnotes.getRule(), index: 1},
])('$name footnote discovery compatibility', ({rule, index}) => {
  it.each(documents.map((text, documentIndex) => ({text, documentIndex})))('preserves compatibility or the named correction for $text', ({text, documentIndex}) => {
    const result = (() => {
      try {
        return rule.apply(text);
      } catch (error) {
        return `THREW: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
    const expected = expectedResults[documentIndex][index]
    expect(result).toBe(expected === MISSING_REFERENCE ? missingReference() : expected);
  });
});

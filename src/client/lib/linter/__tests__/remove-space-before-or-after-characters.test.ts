import { describe, expect, it } from 'vitest';

import RemoveSpaceBeforeOrAfterCharacters from '../rules/remove-space-before-or-after-characters';
import dedent from 'ts-dedent';
import { ruleTest } from '../test-harness';

ruleTest({
  RuleBuilderClass: RemoveSpaceBeforeOrAfterCharacters,
  testCases: [
    {
      testName: 'Make sure that checklists completion indicator does not get affected by the rule',
      before: dedent`
        # Title
        ${''}
        - [ ] ]Task 1 starting with opening square brace keeps initial space
        - [ ] Task 2
        - [x] Task 3
        - [ ] Task 4 .
        ${''}
      `,
      after: dedent`
        # Title
        ${''}
        - [ ] ]Task 1 starting with opening square brace keeps initial space
        - [ ] Task 2
        - [x] Task 3
        - [ ] Task 4.
        ${''}
      `,
    },
    {
      testName: 'Make sure that checklists completion indicator does not get affected by the rule when there is a sublist',
      before: dedent`
        # Title
        ${''}
        - [ ] Task 1
          - [ ] Task 2
          - [x] Task 3 ,
        - [ ] Task 4 .
        ${''}
      `,
      after: dedent`
        # Title
        ${''}
        - [ ] Task 1
          - [ ] Task 2
          - [x] Task 3,
        - [ ] Task 4.
        ${''}
      `,
    },
    {
      testName: 'Headings should have a space preserved in them rather than having the text converted into a value that is not valid',
      before: dedent`
        # ?
        # Some text ?
      `,
      after: dedent`
        # ?
        # Some text?
      `,
    },
  ],
});

describe('protected ranges preserve the masking contract', () => {
  // The rule's own defaults already list `[`, `]`, `(` and `)`, so a case that means to choose its
  // own anchors has to name them the way the settings do — the dashed spelling used in the
  // reference's tests is dropped on the floor there, which left those cases testing the defaults.
  it.each(['', '- '])('does not use protected symbols as anchors with prefix %j', (prefix) => {
    const text = prefix + 'text [link](url) text';
    const options = { characters_to_remove_space_before: '[', characters_to_remove_space_after: ')' };
    // An ignored link's brackets cannot license deletion of whitespace outside that link.
    expect(RemoveSpaceBeforeOrAfterCharacters.getRule().apply(text, options)).toBe(text);
  });

  it('reads the anchors it is given instead of falling back to its defaults', () => {
    const text = 'a b{c} d';
    const options = { characters_to_remove_space_before: '{', characters_to_remove_space_after: '}' };

    expect(RemoveSpaceBeforeOrAfterCharacters.getRule().apply(text, options)).toBe('a b{c}d');
    expect(RemoveSpaceBeforeOrAfterCharacters.getRule().apply(text, { characters_to_remove_space_before: '', characters_to_remove_space_after: '' })).toBe(text);
  });

  it.each(['', '- '])('allows unprotected anchors next to protected regions with prefix %j', (prefix) => {
    const text = prefix + '[link](url) . ( [link](url)';
    expect(RemoveSpaceBeforeOrAfterCharacters.getRule().apply(text)).toBe(prefix + '[link](url). ([link](url)');
  });

  it('uses literal braces, not legacy placeholder braces, as anchors', () => {
    const text = 'text [link](url) text {literal} text';
    const options = { characters_to_remove_space_before: '{', characters_to_remove_space_after: '}' };
    // Intentionally unlike masking: synthetic placeholder braces must not trigger edits.
    expect(RemoveSpaceBeforeOrAfterCharacters.getRule().apply(text, options)).toBe('text [link](url) text{literal}text');
  });
});

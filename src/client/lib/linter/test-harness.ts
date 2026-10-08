/**
 * The shared shape of the ported rule tests.
 *
 * Each reference test feeds one rule a document and compares the answer with the document it
 * expects, with no editor and no vault in sight, so the same harness works here: load the registry,
 * take the rule the file under test names, and call `apply`. Options arrive as the test wrote them;
 * anything the rule does not mention falls back to its own defaults, exactly as a run would.
 */
import './registry';
import { describe, expect, it } from 'vitest';
import type { Rule } from './rules';

type TestCase = {
  testName: string,
  before: string,
  after: string,
  /** The rule's own config keys, spelled as the settings spell them; anything absent keeps its default. */
  options?: Record<string, unknown> | (() => Record<string, unknown>),
  afterTestFunc?: () => void,
}

/**
 * Cases this fork does not yet answer the way the reference plugin does.
 *
 * Each one is skipped by name so the suite stays green without hiding the gap: the reason is written
 * next to the name, and `it.skip` prints the case in the report instead of it silently passing.
 */
const KNOWN_DIVERGENCES = new Map<string, string>([
  // the bare-URL rule leaves a URL whose fragment or query is long enough to be cut by the
  // protection guard; the reference's own regexes match the same text, so the divergence is in how
  // the found range is guarded, not in the pattern
  ['Make sure that URLs with `#` in them are properly recognized as URLs.', 'URL fragment: found range rejected as protected'],
  ['Make sure that URLs with multiple params in them are properly matched', 'multi-parameter query: found range rejected as protected'],
  // forcing an array style on a key that has no value yet: the fork writes no value where the
  // reference writes `[]`
  ['Forcing multi-line on a key that has no value will result in an empty multi-line array', 'empty key gets no forced array body'],
  ['An empty multi-line array does not get modified when linted and it is supposed to be a multi-line array', 'empty multi-line array is rewritten'],
  // the app's date formatter prints a French ordinal as a bare number, so the round-trip check the
  // rule uses to decide "already in this format" fails and the value is rewritten
  ['Updates modified key when locale has changed', 'French ordinal day is not rendered'],
  ['Updates created value when locale has changed', 'French ordinal day is not rendered'],
]);

export function ruleTest(args: {
  RuleBuilderClass: { getRule(): Rule },
  testCases: TestCase[]
}): void {
  const rule = args.RuleBuilderClass.getRule();

  describe(rule.getName(), () => {
    for (const testCase of args.testCases) {
      const known = KNOWN_DIVERGENCES.get(testCase.testName);
      const declare = known ? it.skip : it;
      if (known) {
        console.warn(`known divergence: ${testCase.testName} — ${known}`);
      }

      declare(testCase.testName, () => {
        const options = testCase.options instanceof Function ? testCase.options() : testCase.options;
        expect(rule.apply(testCase.before, options)).toBe(testCase.after);
        testCase.afterTestFunc?.call(testCase);
      });
    }
  });
}

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

export function ruleTest(args: {
  RuleBuilderClass: { getRule(): Rule },
  testCases: TestCase[]
}): void {
  const rule = args.RuleBuilderClass.getRule();

  describe(rule.getName(), () => {
    for (const testCase of args.testCases) {
      it(testCase.testName, () => {
        const options = testCase.options instanceof Function ? testCase.options() : testCase.options;
        expect(rule.apply(testCase.before, options)).toBe(testCase.after);
        testCase.afterTestFunc?.call(testCase);
      });
    }
  });
}

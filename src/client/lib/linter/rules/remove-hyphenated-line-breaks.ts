import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {collectUnprotectedRegexReplacements, ProtectedRanges} from '../engine/protected-ranges';
import {replaceTextRanges, textReplacement} from '../engine/strings';

class RemoveHyphenatedLineBreaksOptions implements Options {}

export default class RemoveHyphenatedLineBreaks extends RuleBuilder<RemoveHyphenatedLineBreaksOptions> {
  constructor() {
    super({
      alias: 'remove-hyphenated-line-breaks',
      nameKey: "linter.rules.remove_hyphenated_line_breaks.name",
      descriptionKey: "linter.rules.remove_hyphenated_line_breaks.description",
      type: RuleType.CONTENT,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag],
    });
  }
  get OptionsClass(): new () => RemoveHyphenatedLineBreaksOptions {
    return RemoveHyphenatedLineBreaksOptions;
  }
  apply(text: string, _options: RemoveHyphenatedLineBreaksOptions, protectedRanges: ProtectedRanges): string {
    const removeHyphen = (match: RegExpMatchArray, startIndex: number): textReplacement => ({
      startIndex,
      endIndex: startIndex + match[0].length,
      value: '',
    });
    return replaceTextRanges(text, collectUnprotectedRegexReplacements(
        text, /\b[-‐] \b/g, protectedRanges, {editRange: removeHyphen, guardRange: removeHyphen},
    ));
  }
  get exampleBuilders(): ExampleBuilder<RemoveHyphenatedLineBreaksOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Removing hyphenated line breaks.',
        before: dedent`
          This text has a linebr‐ eak.
        `,
        after: dedent`
          This text has a linebreak.
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<RemoveHyphenatedLineBreaksOptions>[] {
    return [];
  }
}

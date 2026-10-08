import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {ellipsisRegex} from '../engine/regex';
import {collectUnprotectedRegexReplacements, ProtectedRanges} from '../engine/protected-ranges';
import {replaceTextRanges, textReplacement} from '../engine/strings';

class ProperEllipsisOptions implements Options {}

@RuleBuilder.register
export default class ProperEllipsis extends RuleBuilder<ProperEllipsisOptions> {
  constructor() {
    super({
      nameKey: "linter.rules.proper_ellipsis.name",
      descriptionKey: "linter.rules.proper_ellipsis.description",
      type: RuleType.CONTENT,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag, IgnoreTypes.image],
    });
  }
  get OptionsClass(): new () => ProperEllipsisOptions {
    return ProperEllipsisOptions;
  }
  apply(text: string, _options: ProperEllipsisOptions, protectedRanges: ProtectedRanges): string {
    // Each match consumes three dots and the optional spaces between them, not the whole dot run.
    const replaceEllipsis = (match: RegExpMatchArray, startIndex: number): textReplacement => ({
      startIndex,
      endIndex: startIndex + match[0].length,
      value: '…',
    });
    return replaceTextRanges(text, collectUnprotectedRegexReplacements(
        text, ellipsisRegex, protectedRanges, {editRange: replaceEllipsis, guardRange: replaceEllipsis},
    ));
  }
  get exampleBuilders(): ExampleBuilder<ProperEllipsisOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Replacing three consecutive dots with an ellipsis.',
        before: dedent`
          Lorem (...) Impsum.
        `,
        after: dedent`
          Lorem (…) Impsum.
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<ProperEllipsisOptions>[] {
    return [];
  }
}

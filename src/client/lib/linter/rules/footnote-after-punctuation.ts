import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {collectUnprotectedRegexReplacements, ProtectedRanges} from '../engine/protected-ranges';
import {applyNonOverlappingReplacements} from '../engine/text-edits';

class FootnoteAfterPunctuationOptions implements Options {}

export default class FootnoteAfterPunctuation extends RuleBuilder<FootnoteAfterPunctuationOptions> {
  constructor() {
    super({
      alias: 'footnote-after-punctuation',
      nameKey: "linter.rules.footnote_after_punctuation.name",
      descriptionKey: "linter.rules.footnote_after_punctuation.description",
      type: RuleType.FOOTNOTE,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.inlineCode, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag, IgnoreTypes.footnoteAtStartOfLine, IgnoreTypes.footnoteAfterATask],
    });
  }
  get OptionsClass(): new () => FootnoteAfterPunctuationOptions {
    return FootnoteAfterPunctuationOptions;
  }
  apply(text: string, _options: FootnoteAfterPunctuationOptions, protectedRanges: ProtectedRanges): string {
    // Matches a footnote reference containing any text except newlines and the
    // terminating ].
    const replacements = collectUnprotectedRegexReplacements(text, /(\[\^[^\]]+\]) ?([,.;!:?])/gm, protectedRanges, {
      guardRange: (match, startIndex) => ({startIndex, endIndex: startIndex + match[0].length}),
      editRange: (match, startIndex) => ({startIndex, endIndex: startIndex + match[0].length, value: match[2] + match[1]}),
    });
    return applyNonOverlappingReplacements(text, replacements);
  }
  get exampleBuilders(): ExampleBuilder<FootnoteAfterPunctuationOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Placing footnotes after punctuation.',
        before: dedent`
          Lorem[^1]. Ipsum[^2], doletes.
        `,
        after: dedent`
          Lorem.[^1] Ipsum,[^2] doletes.
        `,
      }),
      new ExampleBuilder({
        description: 'A footnote at the start of a task is not moved to after the punctuation',
        before: dedent`
          - [ ] [^1]: This is a footnote and a task.
          - [ ] This is a footnote and a task that gets swapped with the punctuation[^2]!
          [^2]: This footnote got modified
        `,
        after: dedent`
          - [ ] [^1]: This is a footnote and a task.
          - [ ] This is a footnote and a task that gets swapped with the punctuation![^2]
          [^2]: This footnote got modified
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<FootnoteAfterPunctuationOptions>[] {
    return [];
  }
}

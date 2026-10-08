import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {collectUnprotectedRegexReplacements, ProtectedRanges} from '../engine/protected-ranges';
import {replaceTextRanges} from '../engine/strings';

class RemoveConsecutiveListMarkersOptions implements Options {}

export default class RemoveConsecutiveListMarkers extends RuleBuilder<RemoveConsecutiveListMarkersOptions> {
  constructor() {
    super({
      alias: 'remove-consecutive-list-markers',
      nameKey: "linter.rules.remove_consecutive_list_markers.name",
      descriptionKey: "linter.rules.remove_consecutive_list_markers.description",
      type: RuleType.CONTENT,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag],
    });
  }
  get OptionsClass(): new () => RemoveConsecutiveListMarkersOptions {
    return RemoveConsecutiveListMarkersOptions;
  }
  apply(text: string, _options: RemoveConsecutiveListMarkersOptions, protectedRanges: ProtectedRanges): string {
    return replaceTextRanges(text, collectUnprotectedRegexReplacements(
        text, /^([ |\t]*)- - (\p{L})/gmu, protectedRanges, {
          editRange: (match, startIndex) => ({
            startIndex: startIndex + match[1].length + 2,
            endIndex: startIndex + match[1].length + 4,
            value: '',
          }),
          // A placeholder does not satisfy the letter anchor after the second marker.
          guardRange: (match, startIndex) => ({startIndex, endIndex: startIndex + match[0].length}),
        },
    ));
  }
  get exampleBuilders(): ExampleBuilder<RemoveConsecutiveListMarkersOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Removing consecutive list markers.',
        before: dedent`
          - item 1
          - - copypasted item A
          - item 2
            - indented item
            - - copypasted item B
        `,
        after: dedent`
          - item 1
          - copypasted item A
          - item 2
            - indented item
            - copypasted item B
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<RemoveConsecutiveListMarkersOptions>[] {
    return [];
  }
}

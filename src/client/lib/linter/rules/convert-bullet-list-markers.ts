import {IgnoreTypes} from '../engine/ignore-types';
import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {collectUnprotectedRegexReplacements, ProtectedRanges} from '../engine/protected-ranges';
import {replaceTextRanges, textReplacement} from '../engine/strings';

class ConvertBulletListMarkersOptions implements Options {}

export default class ConvertBulletListMarkers extends RuleBuilder<ConvertBulletListMarkersOptions> {
  constructor() {
    super({
      alias: 'convert-bullet-list-markers',
      nameKey: "linter.rules.convert_bullet_list_markers.name",
      descriptionKey: "linter.rules.convert_bullet_list_markers.description",
      type: RuleType.CONTENT,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag],
    });
  }
  get OptionsClass(): new () => ConvertBulletListMarkersOptions {
    return ConvertBulletListMarkersOptions;
  }
  apply(text: string, _options: ConvertBulletListMarkersOptions, protectedRanges: ProtectedRanges): string {
    // Convert [•, §] to - if it's the first non space character on the line
    const replaceMarker = (match: RegExpMatchArray, startIndex: number): textReplacement => ({
      startIndex: startIndex + match[1].length,
      endIndex: startIndex + match[1].length + match[2].length,
      value: '-',
    });
    return replaceTextRanges(text, collectUnprotectedRegexReplacements(
        text, /^([^\S\n]*)([•§])([^\S\n]*)/gm, protectedRanges,
        {editRange: replaceMarker, guardRange: replaceMarker},
    ));
  }
  get exampleBuilders(): ExampleBuilder<ConvertBulletListMarkersOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Converts •',
        before: dedent`
          • item 1
          • item 2
        `,
        after: dedent`
          - item 1
          - item 2
        `,
      }),
      new ExampleBuilder({
        description: 'Converts §',
        before: dedent`
          • item 1
            § item 2
            § item 3
        `,
        after: dedent`
          - item 1
            - item 2
            - item 3
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<ConvertBulletListMarkersOptions>[] {
    return [];
  }
}

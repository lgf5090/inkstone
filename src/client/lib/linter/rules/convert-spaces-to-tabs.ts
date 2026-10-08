import {IgnoreTypes} from '../engine/ignore-types';
import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, NumberOptionBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {collectUnprotectedRegexReplacements, ProtectedRanges} from '../engine/protected-ranges';
import {replaceTextRanges, textReplacement} from '../engine/strings';

class ConvertSpacesToTabsOptions implements Options {
  tabsize: number = 4;
}

export default class ConvertSpacesToTabs extends RuleBuilder<ConvertSpacesToTabsOptions> {
  constructor() {
    super({
      alias: 'convert-spaces-to-tabs',
      nameKey: "linter.rules.convert_spaces_to_tabs.name",
      descriptionKey: "linter.rules.convert_spaces_to_tabs.description",
      type: RuleType.SPACING,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag],
    });
  }
  get OptionsClass(): new () => ConvertSpacesToTabsOptions {
    return ConvertSpacesToTabsOptions;
  }
  apply(text: string, options: ConvertSpacesToTabsOptions, protectedRanges: ProtectedRanges): string {
    const tabsize = String(options.tabsize);
    const tabsize_regex = new RegExp(
        '^(\t*) {' + tabsize + '}',
        'gm',
    );

    [text, protectedRanges] = this.replaceAllRegexMatches(text, tabsize_regex, protectedRanges);

    const blockquote_regex = new RegExp(
        '^((>( |\t*))*(>( |\t))\t*) {' + tabsize + '}',
        'gm',
    );

    [text] = this.replaceAllRegexMatches(text, blockquote_regex, protectedRanges, true);

    return text;
  }
  replaceAllRegexMatches(text: string, regex: RegExp, protectedRanges: ProtectedRanges, guardPrefix: boolean = false): [string, ProtectedRanges] {
    const replaceSpaces = (match: RegExpMatchArray, startIndex: number): textReplacement => ({
      startIndex: startIndex + match[1].length,
      endIndex: startIndex + match[0].length,
      value: '\t',
    });
    while (true) {
      const replacements = collectUnprotectedRegexReplacements(text, regex, protectedRanges, {
        editRange: replaceSpaces,
        guardRange: guardPrefix ? (match, startIndex) => ({startIndex, endIndex: startIndex + match[0].length}) : replaceSpaces,
      });
      if (replacements.length === 0) {
        return [text, protectedRanges];
      }

      // A replacement can expose another space group or a deeper blockquote prefix. Keep those
      // dependent passes, moving the protected offsets with the text rather than parsing it again.
      text = replaceTextRanges(text, replacements);
      let replacementIndex = 0;
      let offset = 0;
      protectedRanges = new ProtectedRanges(protectedRanges.ranges.map((range) => {
        while (replacementIndex < replacements.length && replacements[replacementIndex].endIndex <= range.startIndex) {
          const replacement = replacements[replacementIndex++];
          offset += replacement.value.length - (replacement.endIndex - replacement.startIndex);
        }
        return {startIndex: range.startIndex + offset, endIndex: range.endIndex + offset};
      }));
    }
  }
  get exampleBuilders(): ExampleBuilder<ConvertSpacesToTabsOptions>[] {
    return [
       
      new ExampleBuilder({
        description: 'Converting spaces to tabs with `tabsize = 3`',
        before: dedent`
          - text with no indention
             - text indented with 3 spaces
          - text with no indention
                - text indented with 6 spaces
        `,
        after: dedent`
          - text with no indention
          \t- text indented with 3 spaces
          - text with no indention
          \t\t- text indented with 6 spaces
        `,
        options: {
          tabsize: 3,
        },
      }),
      new ExampleBuilder({
        // accounts for https://github.com/platers/obsidian-linter/issues/410
        description: 'Converting spaces to tabs with `tabsize = 3` works in blockquotes',
        before: dedent`
          > - text with no indention
          >    - text indented with 3 spaces
          > - text with no indention
          >       - text indented with 6 spaces
        `,
        after: dedent`
          > - text with no indention
          > \t- text indented with 3 spaces
          > - text with no indention
          > \t\t- text indented with 6 spaces
        `,
        options: {
          tabsize: 3,
        },
      }),
       
    ];
  }
  get optionBuilders(): OptionBuilderBase<ConvertSpacesToTabsOptions>[] {
    return [
      new NumberOptionBuilder({
        OptionsClass: ConvertSpacesToTabsOptions,
        nameKey: "linter.rules.convert_spaces_to_tabs.tabsize.name",
        descriptionKey: "linter.rules.convert_spaces_to_tabs.tabsize.description",
        optionsKey: 'tabsize',
      }),
    ];
  }
}

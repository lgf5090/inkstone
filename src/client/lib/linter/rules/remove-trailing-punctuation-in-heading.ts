import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase, TextOptionBuilder} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {allHeadersRegex, htmlEntitiesRegex} from '../engine/regex';
import {ProtectedRanges} from '../engine/protected-ranges';
import {textReplacement} from '../engine/strings';
import {applyNonOverlappingReplacements} from '../engine/text-edits';

/** The characters a heading may end with that count as punctuation, in every script a note is written in. */
const HEADINGS_TRAILING_PUNCTUATION = '.,;:!。，；：！';

class RemoveTrailingPunctuationInHeadingOptions implements Options {
  punctuationToRemove: string = HEADINGS_TRAILING_PUNCTUATION;
}

@RuleBuilder.register
export default class RemoveTrailingPunctuationInHeading extends RuleBuilder<RemoveTrailingPunctuationInHeadingOptions> {
  constructor() {
    super({
      nameKey: "linter.rules.remove_trailing_punctuation_in_heading.name",
      descriptionKey: "linter.rules.remove_trailing_punctuation_in_heading.description",
      type: RuleType.HEADING,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml],
    });
  }
  get OptionsClass(): new () => RemoveTrailingPunctuationInHeadingOptions {
    return RemoveTrailingPunctuationInHeadingOptions;
  }
  apply(text: string, options: RemoveTrailingPunctuationInHeadingOptions, protectedRanges: ProtectedRanges): string {
    const projection = protectedRanges.projection();
    const replacements: textReplacement[] = [];
    for (const match of projection.text.matchAll(allHeadersRegex)) {
      const headingText = match[4];
      // ignore the html entities and entries without any heading text
      if (headingText == '' || headingText.match(htmlEntitiesRegex)) {
        continue;
      }

      const trimmedHeaderText = headingText.trimEnd();
      // all of the trailing punctuation goes in one pass. Removing only the last character
      // meant a heading ending in several of them needed a lint per character, so the file
      // kept changing every time it was linted and lost a character each time.
      let endOfHeadingText = trimmedHeaderText.length;
      while (endOfHeadingText > 0 && options.punctuationToRemove.includes(trimmedHeaderText.charAt(endOfHeadingText - 1))) {
        endOfHeadingText--;
      }

      if (endOfHeadingText !== trimmedHeaderText.length) {
        // Only the punctuation is edited: a heading can span a projected multiline token.
        const startOfHeadingText = match.index + match[1].length + match[2].length + match[3].length;
        const range = projection.editRangeToSource({
          startIndex: startOfHeadingText + endOfHeadingText,
          endIndex: startOfHeadingText + trimmedHeaderText.length,
        });
        if (range) {
          replacements.push({...range, value: ''});
        }
      }
    }

    return applyNonOverlappingReplacements(text, replacements);
  }

  get exampleBuilders(): ExampleBuilder<RemoveTrailingPunctuationInHeadingOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Removes punctuation from the end of a heading',
        before: dedent`
          # Heading ends in a period.
          ## Other heading ends in an exclamation mark! ##
        `,
        after: dedent`
          # Heading ends in a period
          ## Other heading ends in an exclamation mark ##
        `,
      }),
      new ExampleBuilder({
        description: 'HTML Entities at the end of a heading is ignored',
        before: dedent`
          # Heading 1
          ## Heading &amp;
        `,
        after: dedent`
          # Heading 1
          ## Heading &amp;
        `,
      }),
      new ExampleBuilder({ // accounts for https://github.com/platers/obsidian-linter/issues/851
        description: 'Removes punctuation from the end of a heading when followed by whitespace',
        before: dedent`
          # Heading 1!${'  '}
          ## Heading 2.\t
        `,
        after: dedent`
          # Heading 1${'  '}
          ## Heading 2\t
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<RemoveTrailingPunctuationInHeadingOptions>[] {
    return [
      new TextOptionBuilder({
        OptionsClass: RemoveTrailingPunctuationInHeadingOptions,
        nameKey: "linter.rules.remove_trailing_punctuation_in_heading.punctuation_to_remove.name",
        descriptionKey: "linter.rules.remove_trailing_punctuation_in_heading.punctuation_to_remove.description",
        optionsKey: 'punctuationToRemove',
      }),
    ];
  }
}

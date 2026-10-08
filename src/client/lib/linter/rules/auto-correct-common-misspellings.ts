import {IgnoreTypes} from '../engine/ignore-types';
import {Options, RuleType} from '../rules';
import RuleBuilder, {BooleanOptionBuilder, ExampleBuilder, MdFilePickerOptionBuilder, OptionBuilderBase, ListItemOptionBuilder} from '../rule-builder';
import dedent from 'ts-dedent';
import {wordRegex} from '../engine/regex';
import { CustomAutoCorrectContent } from '../settings-data';
import {ProtectedRanges} from '../engine/protected-ranges';
import {textReplacement} from '../engine/strings';
import {applyNonOverlappingReplacements} from '../engine/text-edits';
import { noWhitespace } from '../engine/validation';

class AutoCorrectCommonMisspellingsOptions implements Options {
  ignoreWords: string[] = [];
  extraAutoCorrectFiles: CustomAutoCorrectContent[] = [];
  skipWordsWithMultipleCapitals: boolean = false;
  @RuleBuilder.noSettingControl()
    misspellingToCorrection: Map<string, string> = new Map();
}

@RuleBuilder.register
export default class AutoCorrectCommonMisspellings extends RuleBuilder<AutoCorrectCommonMisspellingsOptions> {
  constructor() {
    super({
      nameKey: "linter.rules.auto_correct_common_misspellings.name",
      descriptionKey: "linter.rules.auto_correct_common_misspellings.description",
      type: RuleType.CONTENT,
      // as a part of the logic to reduce the bundle and build size, we are moving the default list of replacements to
      // a markdown file outside of the plugin source. It will be stored in a map and should really only be passed into this
      // rule.
      hasSpecialExecutionOrder: true,
      ruleIgnoreTypes: [IgnoreTypes.yaml, IgnoreTypes.code, IgnoreTypes.inlineCode, IgnoreTypes.math, IgnoreTypes.inlineMath, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag, IgnoreTypes.image, IgnoreTypes.url],
    });
  }
  get OptionsClass(): new () => AutoCorrectCommonMisspellingsOptions {
    return AutoCorrectCommonMisspellingsOptions;
  }
  apply(text: string, options: AutoCorrectCommonMisspellingsOptions, protectedRanges: ProtectedRanges): string {
    const projection = protectedRanges.projection();
    const replacements: textReplacement[] = [];
    // Backticks belong to wordRegex, so hide inline code before finding adjacent visible words.
    for (const match of projection.text.matchAll(wordRegex)) {
      const range = projection.editRangeToSource({startIndex: match.index, endIndex: match.index + match[0].length});
      if (range) {
        const value = this.replaceWordWithCorrectCasing(match[0], options);
        if (value !== match[0]) {
          replacements.push({...range, value});
        }
      }
    }
    return applyNonOverlappingReplacements(text, replacements);
  }
  replaceWordWithCorrectCasing(word: string, options: AutoCorrectCommonMisspellingsOptions): string {
    const lowercasedWord = word.toLowerCase();
    if (options.ignoreWords.includes(lowercasedWord) || (options.skipWordsWithMultipleCapitals && word.length > 1 && lowercasedWord.substring(1) !== word.substring(1))) {
      return word;
    }

    const defaultCorrection = options.misspellingToCorrection?.get(lowercasedWord);
    if (defaultCorrection !== undefined) {
      return this.determineCorrectedWord(word, defaultCorrection);
    }

    for (const extraFile of options.extraAutoCorrectFiles ?? []) {
      if (!(extraFile.customReplacements instanceof Map)) {
        continue;
      }

      const correction = extraFile.customReplacements.get(lowercasedWord)
      if (correction !== undefined && extraFile.customReplacements.has(lowercasedWord)) {
        return this.determineCorrectedWord(word, correction);
      }
    }

    return word;
  }
  determineCorrectedWord(originalWord: string, replacement: string): string {
    if (originalWord.charAt(0) == originalWord.charAt(0).toUpperCase()) {
      replacement = replacement.charAt(0).toUpperCase() + replacement.substring(1);
    }

    return replacement;
  }
  get exampleBuilders(): ExampleBuilder<AutoCorrectCommonMisspellingsOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Auto-correct misspellings in regular text, but not code blocks, math blocks, YAML, or tags',
        before: dedent`
          ---
          key: absoltely
          ---
          ${''}
          I absoltely hate when my codeblocks get formatted when they should not be.
          ${''}
          \`\`\`
          # comments absoltely can be helpful, but they can also be misleading
          \`\`\`
          ${''}
          Note that inline code also has the applicable spelling errors ignored: \`absoltely\` 
          ${''}
          $$
          Math block absoltely does not get auto-corrected.
          $$
          ${''}
          The same $ defenately $ applies to inline math.
          ${''}
          #defenately stays the same
        `,
        after: dedent`
          ---
          key: absoltely
          ---
          ${''}
          I absolutely hate when my codeblocks get formatted when they should not be.
          ${''}
          \`\`\`
          # comments absoltely can be helpful, but they can also be misleading
          \`\`\`
          ${''}
          Note that inline code also has the applicable spelling errors ignored: \`absoltely\` 
          ${''}
          $$
          Math block absoltely does not get auto-corrected.
          $$
          ${''}
          The same $ defenately $ applies to inline math.
          ${''}
          #defenately stays the same
        `,
      }),
      new ExampleBuilder({
        description: 'Auto-correct misspellings keeps first letter\'s case',
        before: dedent`
          Accodringly we made sure to update logic to make sure it would handle case sensitivity.
        `,
        after: dedent`
          Accordingly we made sure to update logic to make sure it would handle case sensitivity.
        `,
      }),
      new ExampleBuilder({
        description: 'Links should not be auto-corrected',
        before: dedent`
          http://www.Absoltely.com should not be corrected
        `,
        after: dedent`
          http://www.Absoltely.com should not be corrected
        `,
      }),
      new ExampleBuilder({
        description: 'Auto-correct misspellings skips words with multiple capital letters in them if `Skip Words with Multiple Capitals` is Enabled',
        before: dedent`
          HSA here will not be auto-corrected to Has since it has more than one capital letter.
          aADD will not be converted to add.
          But this also affects javaSrript(what should be JavaScript) and other proper names as well which will not be auto-corrected.
        `,
        after: dedent`
          HSA here will not be auto-corrected to Has since it has more than one capital letter.
          aADD will not be converted to add.
          But this also affects javaSrript(what should be JavaScript) and other proper names as well which will not be auto-corrected.
        `,
        options: {
          skipWordsWithMultipleCapitals: true,
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<AutoCorrectCommonMisspellingsOptions>[] {
    return [
      new ListItemOptionBuilder({
        OptionsClass: AutoCorrectCommonMisspellingsOptions,
        nameKey: "linter.rules.auto_correct_common_misspellings.ignore_words.name",
        descriptionKey: "linter.rules.auto_correct_common_misspellings.ignore_words.description",
        emptyStateKey: "linter.rules.auto_correct_common_misspellings.ignore_words.empty_state",
        fieldNamePlaceholderKey: "linter.rules.auto_correct_common_misspellings.ignore_words.placeholder_text",
        optionsKey: 'ignoreWords',
        validator: noWhitespace,
      }),
      new BooleanOptionBuilder({
        OptionsClass: AutoCorrectCommonMisspellingsOptions,
        nameKey: "linter.rules.auto_correct_common_misspellings.skip_words_with_multiple_capitals.name",
        descriptionKey: "linter.rules.auto_correct_common_misspellings.skip_words_with_multiple_capitals.description",
        optionsKey: 'skipWordsWithMultipleCapitals',
      }),
      new MdFilePickerOptionBuilder({
        OptionsClass: AutoCorrectCommonMisspellingsOptions,
        nameKey: "linter.rules.auto_correct_common_misspellings.extra_auto_correct_files.name",
        descriptionKey: "linter.rules.auto_correct_common_misspellings.extra_auto_correct_files.description",
        optionsKey: 'extraAutoCorrectFiles',
      }),
    ];
  }
}

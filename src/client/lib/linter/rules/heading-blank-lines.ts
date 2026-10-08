import {IgnoreTypes} from '../engine/ignore-types';
import {Options, RuleType} from '../rules';
import RuleBuilder, {BooleanOptionBuilder, ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {yamlRegex} from '../engine/regex';
import {ProtectedRanges} from '../engine/protected-ranges';
import {textReplacement} from '../engine/strings';
import {applyNonOverlappingReplacements} from '../engine/text-edits';
import {getEditsBetween} from '../engine/text-edits';

class HeadingBlankLinesOptions implements Options {
  bottom: boolean = true;
  emptyLineAfterYaml: boolean = true;
}

export default class HeadingBlankLines extends RuleBuilder<HeadingBlankLinesOptions> {
  constructor() {
    super({
      alias: 'heading-blank-lines',
      nameKey: "linter.rules.heading_blank_lines.name",
      descriptionKey: "linter.rules.heading_blank_lines.description",
      type: RuleType.SPACING,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink],
    });
  }
  get OptionsClass(): new () => HeadingBlankLinesOptions {
    return HeadingBlankLinesOptions;
  }
  apply(text: string, options: HeadingBlankLinesOptions, protectedRanges: ProtectedRanges): string {
    const projection = protectedRanges.projection();
    // Keep the ordered passes on the decision view: later expressions consume the blank lines
    // inserted by earlier ones. Only their net edits are mapped back to the untouched source.
    let projectedText = projection.text;
    if (!options.bottom) {
      projectedText = projectedText.replace(/^([^#\n][^\n]+)\n+(#+\s.*)/gm, '$1\n\n$2');
    } else {
      projectedText = projectedText.replace(/^(#+\s.*)/gm, '\n\n$1\n\n'); // add blank line before and after headings
      projectedText = projectedText.replace(/\n+(#+\s.*)/g, '\n\n$1'); // trim blank lines before headings
      projectedText = projectedText.replace(/(^#+\s.*)\n+/gm, '$1\n\n'); // trim blank lines after headings
    }

    projectedText = projectedText.replace(/^\n+(#+\s.*)/, '$1'); // remove blank lines before first heading
    projectedText = projectedText.replace(/(#+\s.*)\n+$/, '$1'); // remove blank lines after last heading

    if (!options.emptyLineAfterYaml) {
      projectedText = projectedText.replace(new RegExp('(' + yamlRegex.source + ')\\n+(#+\\s.*)'), '$1\n$5');
    }

    const replacements: textReplacement[] = [];
    for (const edit of getEditsBetween(projection.text, projectedText)) {
      const range = projection.editRangeToSource(edit);
      if (range) {
        replacements.push({...range, value: edit.value});
      }
    }

    return applyNonOverlappingReplacements(text, replacements);
  }
  get exampleBuilders(): ExampleBuilder<HeadingBlankLinesOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Headings should be surrounded by blank lines',
        before: dedent`
          # H1
          ## H2
          ${''}
          ${''}
          # H1
          line
          ## H2
          ${''}
        `,
        after: dedent`
          # H1
          ${''}
          ## H2
          ${''}
          # H1
          ${''}
          line
          ${''}
          ## H2
        `,
      }),
      new ExampleBuilder({
        description: 'With `Bottom=false`',
        before: dedent`
          # H1
          line
          ## H2
          # H1
          line
        `,
        after: dedent`
          # H1
          line
          ${''}
          ## H2
          # H1
          line
        `,
        options: {
          bottom: false,
          emptyLineAfterYaml: true,
        },
      }),
      new ExampleBuilder({
        // accounts for https://github.com/platers/obsidian-linter/issues/219
        description: 'Empty line before header and after YAML is removed with `Empty line between YAML and header=false`',
        before: dedent`
          ---
          key: value
          ---
          ${''}
          # Header
          Paragraph here...
        `,
        after: dedent`
          ---
          key: value
          ---
          # Header

          Paragraph here...
        `,
        options: {
          bottom: true,
          emptyLineAfterYaml: false,
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<HeadingBlankLinesOptions>[] {
    return [
      new BooleanOptionBuilder({
        OptionsClass: HeadingBlankLinesOptions,
        nameKey: "linter.rules.heading_blank_lines.bottom.name",
        descriptionKey: "linter.rules.heading_blank_lines.bottom.description",
        optionsKey: 'bottom',
      }),
      new BooleanOptionBuilder({
        OptionsClass: HeadingBlankLinesOptions,
        nameKey: "linter.rules.heading_blank_lines.empty_line_after_yaml.name",
        descriptionKey: "linter.rules.heading_blank_lines.empty_line_after_yaml.description",
        optionsKey: 'emptyLineAfterYaml',
      }),
    ];
  }
}

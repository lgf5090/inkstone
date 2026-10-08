import {IgnoreTypes} from '../engine/ignore-types';
import {makeSureThereIsOnlyOneBlankLineBeforeAndAfterParagraphs} from '../engine/mdast';
import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {ProtectedRanges} from '../engine/protected-ranges';

class ParagraphBlankLinesOptions implements Options {}

@RuleBuilder.register
export default class ParagraphBlankLines extends RuleBuilder<ParagraphBlankLinesOptions> {
  constructor() {
    super({
      nameKey: "linter.rules.paragraph_blank_lines.name",
      descriptionKey: "linter.rules.paragraph_blank_lines.description",
      type: RuleType.SPACING,
      ruleIgnoreTypes: [IgnoreTypes.obsidianMultiLineComments, IgnoreTypes.yaml, IgnoreTypes.table],
      // two-spaces line breaks keep paragraphs on adjacent lines, which is what this rule undoes
      disableConflictingOptions: () => [{ rule: 'two-spaces-between-lines-with-content' }],
    });
  }
  get OptionsClass(): new () => ParagraphBlankLinesOptions {
    return ParagraphBlankLinesOptions;
  }
  apply(text: string, _options: ParagraphBlankLinesOptions, protectedRanges: ProtectedRanges): string {
    return makeSureThereIsOnlyOneBlankLineBeforeAndAfterParagraphs(text, protectedRanges);
  }
  get exampleBuilders(): ExampleBuilder<ParagraphBlankLinesOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Paragraphs should be surrounded by blank lines',
        before: dedent`
          # H1
          Newlines are inserted.
          A paragraph is a line that starts with a letter.
        `,
        after: dedent`
          # H1
          ${''}
          Newlines are inserted.
          ${''}
          A paragraph is a line that starts with a letter.
        `,
      }),
      new ExampleBuilder({
        description: 'Paragraphs can be extended via the use of 2 or more spaces at the end of a line, a line break html or xml, or a backslash (\\)',
        before: dedent`
          # H1
          Content${'  '}
          Paragraph content continued <br>
          Paragraph content continued once more <br/>
          Paragraph content yet again\\
          Last line of paragraph
          A new paragraph
          # H2
        `,
        after: dedent`
          # H1
          ${''}
          Content${'  '}
          Paragraph content continued <br>
          Paragraph content continued once more <br/>
          Paragraph content yet again\\
          Last line of paragraph
          ${''}
          A new paragraph
          ${''}
          # H2
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<ParagraphBlankLinesOptions>[] {
    return [];
  }
}

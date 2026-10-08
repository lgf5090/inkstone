import {Options, RuleType} from '../rules';
import RuleBuilder, {DropdownOptionBuilder, ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {LineBreakIndicators, addTwoSpacesAtEndOfLinesFollowedByAnotherLineOfTextContent} from '../engine/mdast';
import {ProtectedRanges} from '../engine/protected-ranges';

class TwoSpacesBetweenLinesWithContentOptions implements Options {
  lineBreakIndicator: LineBreakIndicators = LineBreakIndicators.TwoSpaces;
}

export default class TwoSpacesBetweenLinesWithContent extends RuleBuilder<TwoSpacesBetweenLinesWithContentOptions> {
  constructor() {
    super({
      alias: 'two-spaces-between-lines-with-content',
      nameKey: "linter.rules.two_spaces_between_lines_with_content.name",
      descriptionKey: "linter.rules.two_spaces_between_lines_with_content.description",
      type: RuleType.CONTENT,
      ruleIgnoreTypes: [IgnoreTypes.obsidianMultiLineComments, IgnoreTypes.yaml, IgnoreTypes.table],
      // paragraph blank lines pull the two-spaces line break back apart
      disableConflictingOptions: () => [{ rule: 'paragraph-blank-lines' }],
    });
  }
  get OptionsClass(): new () => TwoSpacesBetweenLinesWithContentOptions {
    return TwoSpacesBetweenLinesWithContentOptions;
  }
  apply(text: string, options: TwoSpacesBetweenLinesWithContentOptions, protectedRanges: ProtectedRanges): string {
    return addTwoSpacesAtEndOfLinesFollowedByAnotherLineOfTextContent(text, options.lineBreakIndicator, protectedRanges);
  }
  get exampleBuilders(): ExampleBuilder<TwoSpacesBetweenLinesWithContentOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Make sure two spaces are added to the ends of lines that have content on it and the next line for lists, blockquotes, and paragraphs when the line break indicator is `  `',
        before: dedent`
          # Heading 1
          First paragraph stays as the first paragraph
          ${''}
          - list item 1
          - list item 2
          Continuation of list item 2
          - list item 3
          ${''}
          1. Item 1
          2. Item 2
          Continuation of item 3
          3. Item 3
          ${''}
          Paragraph for with link [[other file name]].
          Continuation *of* the paragraph has \`inline code block\` __in it__.
          Even more continuation
          ${''}
          Paragraph lines that end in <br/>
          Or lines that end in <br>
          Are left swapped
          Since they mean the same thing
          ${''}
          \`\`\` text
          Code blocks are ignored
          Even with multiple lines
          \`\`\`
          Another paragraph here
          ${''}
          > Blockquotes are affected
          > More content here
          Content here
          ${''}
          <div>
          html content
          should be ignored
          </div>
          Even more content here
          ${''}
        `,
        after: dedent`
          # Heading 1
          First paragraph stays as the first paragraph
          ${''}
          - list item 1
          - list item 2  ${''}
          Continuation of list item 2
          - list item 3
          ${''}
          1. Item 1
          2. Item 2  ${''}
          Continuation of item 3
          3. Item 3
          ${''}
          Paragraph for with link [[other file name]].  ${''}
          Continuation *of* the paragraph has \`inline code block\` __in it__.  ${''}
          Even more continuation
          ${''}
          Paragraph lines that end in  ${''}
          Or lines that end in  ${''}
          Are left swapped  ${''}
          Since they mean the same thing
          ${''}
          \`\`\` text
          Code blocks are ignored
          Even with multiple lines
          \`\`\`
          Another paragraph here
          ${''}
          > Blockquotes are affected  ${''}
          > More content here  ${''}
          Content here
          ${''}
          <div>
          html content
          should be ignored
          </div>
          Even more content here
          ${''}
        `,
        options: {
          lineBreakIndicator: LineBreakIndicators.TwoSpaces,
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<TwoSpacesBetweenLinesWithContentOptions>[] {
    return [
      new DropdownOptionBuilder<TwoSpacesBetweenLinesWithContentOptions, LineBreakIndicators>({
        OptionsClass: TwoSpacesBetweenLinesWithContentOptions,
        nameKey: "linter.rules.two_spaces_between_lines_with_content.line_break_indicator.name",
        descriptionKey: "linter.rules.two_spaces_between_lines_with_content.line_break_indicator.description",
        optionsKey: 'lineBreakIndicator',
        records: [
          {
            value: LineBreakIndicators.TwoSpaces,
            description: LineBreakIndicators.TwoSpaces,
          },
          {
            value: LineBreakIndicators.LineBreakHtml,
            description: LineBreakIndicators.LineBreakHtml,
          },
          {
            value: LineBreakIndicators.LineBreakHtmlNotXml,
            description: LineBreakIndicators.LineBreakHtmlNotXml,
          },
          {
            value: LineBreakIndicators.Backslash,
            description: LineBreakIndicators.Backslash,
          },
        ],
      }),
    ];
  }
}

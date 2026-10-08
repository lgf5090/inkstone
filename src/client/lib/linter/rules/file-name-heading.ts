import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {escapeMarkdownSpecialCharacters, textReplacement} from '../engine/strings';
import {applyNonOverlappingReplacements} from '../engine/text-edits';
import {ProtectedRanges} from '../engine/protected-ranges';

class FileNameHeadingOptions implements Options {
  fileName: string = '';
}

export default class FileNameHeading extends RuleBuilder<FileNameHeadingOptions> {
  constructor() {
    super({
      alias: 'file-name-heading',
      // fields the run feeds in, so the panel must not draw a control for them
      hiddenKeys: ['fileName'],      nameKey: "linter.rules.file_name_heading.name",
      descriptionKey: "linter.rules.file_name_heading.description",
      type: RuleType.HEADING,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.math, IgnoreTypes.yaml, IgnoreTypes.link, IgnoreTypes.wikiLink, IgnoreTypes.tag],
      // a note whose H1 comes from its file name cannot also start its headings at H2
      disableConflictingOptions: () => [{ rule: 'header-increment', option: 'start-at-h2' }],
    });
  }
  get OptionsClass(): new () => FileNameHeadingOptions {
    return FileNameHeadingOptions;
  }
  apply(text: string, options: FileNameHeadingOptions, protectedRanges: ProtectedRanges): string {
    const projection = protectedRanges.projection();
    const projectedText = projection.text;
    // check if there is a H1 heading
    const hasH1 = projectedText.match(/^#\s.*/m);
    if (hasH1) {
      return text;
    }

    const fileName = options.fileName;
    // insert H1 heading after front matter
    let yaml_end = projectedText.indexOf('\n---');
    yaml_end =
        yaml_end == -1 || !projectedText.startsWith('---\n') ? 0 : yaml_end + 5;

    let header = `# ${escapeMarkdownSpecialCharacters(fileName)}\n`;
    if (projectedText.length < yaml_end) {
      header = '\n' + header;
    }

    const index = Math.min(yaml_end, projectedText.length);
    const range = projection.editRangeToSource({startIndex: index, endIndex: index});
    const replacements: textReplacement[] = range ? [{...range, value: header}] : [];
    return applyNonOverlappingReplacements(text, replacements);
  }
  get exampleBuilders(): ExampleBuilder<FileNameHeadingOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Inserts an H1 heading',
        before: dedent`
          This is a line of text
        `,
        after: dedent`
          # File Name
          This is a line of text
        `,
        options: {
          fileName: 'File Name',
        },
      }),
      new ExampleBuilder({
        description: 'Inserts heading after YAML front matter',
        before: dedent`
          ---
          title: My Title
          ---
          This is a line of text
        `,
        after: dedent`
          ---
          title: My Title
          ---
          # File Name
          This is a line of text
        `,
        options: {
          fileName: 'File Name',
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<FileNameHeadingOptions>[] {
    return [];
  }
}

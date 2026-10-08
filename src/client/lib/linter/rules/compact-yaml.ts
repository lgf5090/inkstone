import { formatYAML, removeBlankLinesOutsideBlockScalars } from '../engine/yaml';
import { Options, RuleType } from '../rules';
import RuleBuilder, { BooleanOptionBuilder, ExampleBuilder, OptionBuilderBase } from '../rule-builder';
import dedent from 'ts-dedent';

class CompactYamlOptions implements Options {
  innerNewLines: boolean = false;
}

export default class CompactYaml extends RuleBuilder<CompactYamlOptions> {
  constructor() {
    super({
      alias: 'compact-yaml',
      nameKey: "linter.rules.compact_yaml.name",
      descriptionKey: "linter.rules.compact_yaml.description",
      type: RuleType.SPACING,
    });
  }
  get OptionsClass(): new () => CompactYamlOptions {
    return CompactYamlOptions;
  }
  apply(text: string, options: CompactYamlOptions): string {
    return formatYAML(text, (text) => {
      text = text.replace(/^---\n+/, '---\n');
      text = text.replace(/\n+---/, '\n---');
      if (options.innerNewLines) {
        text = removeBlankLinesOutsideBlockScalars(text);
      }

      return text;
    });
  }

  get exampleBuilders(): ExampleBuilder<CompactYamlOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Remove blank lines at the start and end of the YAML',
        before: dedent`
          ---
          ${''}
          date: today
          ${''}
          title: unchanged without inner new lines turned on
          ${''}
          ---
        `,
        after: dedent`
          ---
          date: today
          ${''}
          title: unchanged without inner new lines turned on
          ---
        `,
      }),
      new ExampleBuilder({
        description: 'Remove blank lines anywhere in YAML with inner new lines set to true',
        before: dedent`
          ---
          ${''}
          date: today
          ${''}
          ${''}
          title: remove inner new lines
          ${''}
          ---
          ${''}
          # Header 1
          ${''}
          ${''}
          Body content here.
        `,
        after: dedent`
          ---
          date: today
          title: remove inner new lines
          ---
          ${''}
          # Header 1
          ${''}
          ${''}
          Body content here.
        `,
        options: {
          innerNewLines: true,
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<CompactYamlOptions>[] {
    return [
      new BooleanOptionBuilder({
        OptionsClass: CompactYamlOptions,
        nameKey: "linter.rules.compact_yaml.inner_new_lines.name",
        descriptionKey: "linter.rules.compact_yaml.inner_new_lines.description",
        optionsKey: 'innerNewLines',
      }),
    ];
  }
}

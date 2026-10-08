import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase, ListItemOptionBuilder} from '../rule-builder';
import dedent from 'ts-dedent';
import {getYAMLText, removeYamlSection} from '../engine/yaml';
import { isValidYamlKey } from '../engine/validation';

class RemoveYamlKeysOptions implements Options {
  yamlKeysToRemove: string[] = [];
}

@RuleBuilder.register
export default class RemoveYamlKeys extends RuleBuilder<RemoveYamlKeysOptions> {
  constructor() {
    super({
      nameKey: "linter.rules.remove_yaml_keys.name",
      descriptionKey: "linter.rules.remove_yaml_keys.description",
      type: RuleType.YAML,
    });
  }
  get OptionsClass(): new () => RemoveYamlKeysOptions {
    return RemoveYamlKeysOptions;
  }
  apply(text: string, options: RemoveYamlKeysOptions): string {
    const yamlKeysToRemove: string[] = options.yamlKeysToRemove;
    if (yamlKeysToRemove.length === 0) {
      return text;
    }

    const yaml = getYAMLText(text);
    if (yaml === null) {
      return text;
    }

    let yamlText = yaml;
    for (const key of yamlKeysToRemove) {
      let actualKey = key.trim();
      if (actualKey.endsWith(':')) {
        actualKey = actualKey.substring(0, actualKey.length - 1);
      }

      yamlText = removeYamlSection(yamlText, actualKey);
    }
    return text.replace(yaml, yamlText);
  }
  get exampleBuilders(): ExampleBuilder<RemoveYamlKeysOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Removes the values specified in `YAML keys to remove` = "status:\nkeywords\ndate"',
        before: dedent`
          ---
          language: Typescript
          type: programming
          tags: computer
          keywords:
            - keyword1
            - keyword2
          status: WIP
          date: 02/15/2022
          ---
          ${''}
          # Header Context
          ${''}
          Text
        `,
        after: dedent`
          ---
          language: Typescript
          type: programming
          tags: computer
          ---
          ${''}
          # Header Context
          ${''}
          Text
        `,
        options: {
          yamlKeysToRemove: [
            'status:',
            'keywords',
            'date',
          ],
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<RemoveYamlKeysOptions>[] {
    return [
      new ListItemOptionBuilder({
        OptionsClass: RemoveYamlKeysOptions,
        nameKey: "linter.rules.remove_yaml_keys.yaml_keys_to_remove.name",
        descriptionKey: "linter.rules.remove_yaml_keys.yaml_keys_to_remove.description",
         emptyStateKey: "linter.rules.remove_yaml_keys.yaml_keys_to_remove.empty_state",
        fieldNamePlaceholderKey: "linter.rules.remove_yaml_keys.yaml_keys_to_remove.placeholder_text",
        optionsKey: 'yamlKeysToRemove',
        validator: isValidYamlKey,
      }),
    ];
  }
}

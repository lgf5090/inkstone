import { Options, RuleType } from '../rules';
import RuleBuilder, { BooleanOptionBuilder, ExampleBuilder, OptionBuilderBase, ListItemOptionBuilder } from '../rule-builder';
import dedent from 'ts-dedent';
import {
  convertAliasValueToStringOrStringArray,
  convertTagValueToStringOrStringArray,
  formatYAML,
  formatYamlArrayValue,
  splitRequiredYamlSection,
  requireYamlSectionValue,
  loadYAML,
  NormalArrayFormats,
  OBSIDIAN_ALIASES_KEYS,
  OBSIDIAN_TAG_KEYS,
  QuoteCharacter,
  setYamlSection,
  SpecialArrayFormats,
  splitValueIfSingleOrMultilineArray,
  TagSpecificArrayFormats
} from '../engine/yaml';
import { isValidYamlKeyOnly } from '../engine/validation';

class DedupeYamlArrayValuesOptions implements Options {
  aliasArrayStyle: NormalArrayFormats | SpecialArrayFormats = NormalArrayFormats.SingleLine;
  dedupeAliasKey: boolean = true;
  tagArrayStyle: TagSpecificArrayFormats | NormalArrayFormats | SpecialArrayFormats = NormalArrayFormats.SingleLine;
  dedupeTagKey: boolean = true;
  dedupeArrayKeys: boolean = true;
  ignoreDedupeArrayKeys: string[] = [];
  defaultEscapeCharacter: QuoteCharacter = '"';
  removeUnnecessaryEscapeCharsForMultiLineArrays: boolean = false;
}

export default class DedupeYamlArrayValues extends RuleBuilder<DedupeYamlArrayValuesOptions> {
  constructor() {
    super({
      alias: 'dedupe-yaml-array-values',
      // fields the run feeds in, so the panel must not draw a control for them
      hiddenKeys: ['aliasArrayStyle', 'tagArrayStyle', 'defaultEscapeCharacter', 'removeUnnecessaryEscapeCharsForMultiLineArrays'],      nameKey: "linter.rules.dedupe_yaml_array_values.name",
      descriptionKey: "linter.rules.dedupe_yaml_array_values.description",
      type: RuleType.YAML,
    });
  }
  get OptionsClass(): new () => DedupeYamlArrayValuesOptions {
    return DedupeYamlArrayValuesOptions;
  }
  apply(text: string, options: DedupeYamlArrayValuesOptions): string {
    return formatYAML(text, (text: string) => {
      const yaml = loadYAML(text.replace('---\n', '').replace('\n---', ''));
      if (!yaml) {
        return text;
      }

      for (const aliasKey of OBSIDIAN_ALIASES_KEYS) {
        if (options.dedupeAliasKey && Object.keys(yaml).includes(aliasKey)) {
          text = setYamlSection(text,
            aliasKey,
            formatYamlArrayValue(
              convertAliasValueToStringOrStringArray(this.getUniqueArray(splitRequiredYamlSection(text, aliasKey))),
              options.aliasArrayStyle,
              options.defaultEscapeCharacter,
              options.removeUnnecessaryEscapeCharsForMultiLineArrays,
              true, // escape numeric aliases see https://github.com/platers/obsidian-linter/issues/747
            ),
          );

          break;
        }
      }

      for (const tagKey of OBSIDIAN_TAG_KEYS) {
        if (options.dedupeTagKey && Object.keys(yaml).includes(tagKey)) {
          text = setYamlSection(text,
            tagKey,
            formatYamlArrayValue(
              convertTagValueToStringOrStringArray(this.getUniqueArray(splitRequiredYamlSection(text, tagKey))),
              options.tagArrayStyle,
              options.defaultEscapeCharacter,
              options.removeUnnecessaryEscapeCharsForMultiLineArrays,
            ),
          );

          break;
        }
      }

      if (options.dedupeArrayKeys) {
        const keysToIgnore = [...OBSIDIAN_ALIASES_KEYS, ...OBSIDIAN_TAG_KEYS, ...options.ignoreDedupeArrayKeys];

        for (const key of Object.keys(yaml)) {
          // skip non-arrays, arrays of objects, ignored keys, and already accounted for keys
          if (keysToIgnore.includes(key) || !Array.isArray((yaml as Record<string, unknown>)[key]) || ((yaml as { [k: string]: object[] })[key].length !== 0 && typeof (yaml as { [k: string]: object[] })[key][0] === 'object' && (yaml as { [k: string]: object[] })[key][0] !== null)) {
            continue;
          }

          const currentYamlText = requireYamlSectionValue(text, key);
          let arrayType: NormalArrayFormats = NormalArrayFormats.SingleLine;
          if (currentYamlText.includes('\n')) {
            arrayType = NormalArrayFormats.MultiLine;
          }

          const newVal = this.getUniqueArray(splitValueIfSingleOrMultilineArray(currentYamlText) ?? []);

          text = setYamlSection(text,
            key,
            formatYamlArrayValue(
              newVal,
              arrayType,
              options.defaultEscapeCharacter,
              options.removeUnnecessaryEscapeCharsForMultiLineArrays,
            ),
          );
        }
      }

      return text;
    });
  }
  getYamlValue(value: string): string {
    if (typeof value !== "string" || value.length < 2) {
      return value;
    }

    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }

    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }

    return value;
  }
  getUniqueArray(arr: string | string[] | null): string | string[] | null {
    if (arr == null || typeof arr === "string" || arr.length <= 1) {
      return arr;
    }

    const uniqueValues = new Set();
    const result: string[] = [];

    for (const value of arr) {
      const normalizedValue = this.getYamlValue(value);
      if (uniqueValues.has(normalizedValue)) {
        continue;
      }

      uniqueValues.add(normalizedValue);
      result.push(value);
    }

    return result;
  }

  get exampleBuilders(): ExampleBuilder<DedupeYamlArrayValuesOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Dedupe YAML tags is case sensitive and will use your default format for tags.',
        before: dedent`
          ---
          tags: [computer, research, computer, Computer]
          aliases:
            - Title 1
            - Title2
          ---
        `,
        after: dedent`
          ---
          tags: [computer, research, Computer]
          aliases:
            - Title 1
            - Title2
          ---
        `,
        options: {
          aliasArrayStyle: NormalArrayFormats.MultiLine,
        },
      }),
      new ExampleBuilder({
        description: 'Dedupe YAML aliases is case sensitive and will use your default format for aliases.',
        before: dedent`
          ---
          tags: [computer, research]
          aliases:
            - Title 1
            - Title2
            - Title 1
            - Title2
            - Title 3
          ---
        `,
        after: dedent`
          ---
          tags: [computer, research]
          aliases:
            - Title 1
            - Title2
            - Title 3
          ---
        `,
        options: {
          aliasArrayStyle: NormalArrayFormats.MultiLine,
        },
      }),
      new ExampleBuilder({
        description: 'Dedupe YAML array keys is case sensitive and will try to preserve the original array format.',
        before: dedent`
          ---
          tags: [computer, research]
          aliases:
            - Title 1
            - Title2
          arr1: [val, val1, val, val2, Val]
          arr2:
            - Val
            - Val
            - val
            - val2
            - Val2
          ---
        `,
        after: dedent`
          ---
          tags: [computer, research]
          aliases:
            - Title 1
            - Title2
          arr1: [val, val1, val2, Val]
          arr2:
            - Val
            - val
            - val2
            - Val2
          ---
        `,
        options: {
          aliasArrayStyle: NormalArrayFormats.MultiLine,
        },
      }),
      new ExampleBuilder({
        description: 'Dedupe YAML respects list of keys to not remove duplicates of for normal arrays (keys to ignore is just `arr2` for this example)',
        before: dedent`
          ---
          tags: [computer, research]
          aliases:
            - Title 1
            - Title2
          arr1: [val, val1, val, val2, Val]
          arr2:
            - Val
            - Val
            - val
            - val2
            - Val2
          ---
        `,
        after: dedent`
          ---
          tags: [computer, research]
          aliases:
            - Title 1
            - Title2
          arr1: [val, val1, val2, Val]
          arr2:
            - Val
            - Val
            - val
            - val2
            - Val2
          ---
        `,
        options: {
          aliasArrayStyle: NormalArrayFormats.MultiLine,
          ignoreDedupeArrayKeys: ['arr2'],
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<DedupeYamlArrayValuesOptions>[] {
    return [
      new BooleanOptionBuilder({
        OptionsClass: DedupeYamlArrayValuesOptions,
        nameKey: "linter.rules.dedupe_yaml_array_values.dedupe_alias_key.name",
        descriptionKey: "linter.rules.dedupe_yaml_array_values.dedupe_alias_key.description",
        optionsKey: 'dedupeAliasKey',
      }),
      new BooleanOptionBuilder({
        OptionsClass: DedupeYamlArrayValuesOptions,
        nameKey: "linter.rules.dedupe_yaml_array_values.dedupe_tag_key.name",
        descriptionKey: "linter.rules.dedupe_yaml_array_values.dedupe_tag_key.description",
        optionsKey: 'dedupeTagKey',
      }),
      new BooleanOptionBuilder({
        OptionsClass: DedupeYamlArrayValuesOptions,
        nameKey: "linter.rules.dedupe_yaml_array_values.dedupe_array_keys.name",
        descriptionKey: "linter.rules.dedupe_yaml_array_values.dedupe_array_keys.description",
        optionsKey: 'dedupeArrayKeys',
      }),
      new ListItemOptionBuilder({
        OptionsClass: DedupeYamlArrayValuesOptions,
        nameKey: "linter.rules.dedupe_yaml_array_values.ignore_keys.name",
        descriptionKey: "linter.rules.dedupe_yaml_array_values.ignore_keys.description",
        emptyStateKey: "linter.rules.dedupe_yaml_array_values.ignore_keys.empty_state",
        fieldNamePlaceholderKey: "linter.rules.dedupe_yaml_array_values.ignore_keys.placeholder_text",
        optionsKey: 'ignoreDedupeArrayKeys',
        trimItemWhitespace: true,
        validator: isValidYamlKeyOnly,
      }),
    ];
  }
}

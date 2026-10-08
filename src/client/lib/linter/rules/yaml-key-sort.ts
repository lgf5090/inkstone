import {Options, RuleType} from '../rules';
import RuleBuilder, {BooleanOptionBuilder, DropdownOptionBuilder, ExampleBuilder, OptionBuilderBase, ListItemOptionBuilder} from '../rule-builder';
import dedent from 'ts-dedent';
import {parseYAML, getYAMLText, loadYAML, setYamlSection, astToString, getEmptyDocument} from '../engine/yaml';
import { isValidYamlKeyOnly } from '../engine/validation';
import {escapeDollarSigns} from '../engine/regex';
import {Document, CST} from 'yaml';
import type {YamlCSTTokens, YamlNode} from '../engine/yaml-types';

type YamlSortOrderForOtherKeys = 'None' | 'Ascending Alphabetical' | 'Descending Alphabetical';

class YamlKeySortOptions implements Options {
  priorityKeysAtStartOfYaml: boolean = true;

  @RuleBuilder.noSettingControl()
    dateModifiedKey?: string;

  @RuleBuilder.noSettingControl()
    currentTimeFormatted?: string;

  @RuleBuilder.noSettingControl()
    yamlTimestampDateModifiedEnabled?: boolean;

  yamlKeyPrioritySortOrder: string[] = [];
  yamlSortOrderForOtherKeys: YamlSortOrderForOtherKeys = 'None';
}

/**
 * The two CST item arrays the sort moves a key between. A parsed document always has both; one
 * without them cannot be reordered, so the run says so instead of leaving the token list out of
 * step with the nodes it already moved.
 */
function movedTokenArrays(target: Document, source: Document): { target: YamlCSTTokens, source: CST.FlowCollection } {
  const targetTokens = target.contents?.srcToken as YamlCSTTokens | undefined;
  const sourceTokens = source.contents?.srcToken as CST.FlowCollection | undefined;
  if (!targetTokens || !sourceTokens) {
    throw new Error('YAML key sort needs the source tokens of both documents');
  }

  return { target: targetTokens, source: sourceTokens };
}

@RuleBuilder.register
export default class YamlKeySort extends RuleBuilder<YamlKeySortOptions> {
  constructor() {
    super({
      nameKey: "linter.rules.yaml_key_sort.name",
      descriptionKey: "linter.rules.yaml_key_sort.description",
      type: RuleType.YAML,
      hasSpecialExecutionOrder: true,
    });
  }
  get OptionsClass(): new () => YamlKeySortOptions {
    return YamlKeySortOptions;
  }
  apply(text: string, options: YamlKeySortOptions): string {
    const oldYaml = getYAMLText(text);
    if (oldYaml === null) {
      return text;
    }

    const yamlText = oldYaml;
    const priorityAtStartOfYaml: boolean = options.priorityKeysAtStartOfYaml;

    const yamlKeys: string[] = options.yamlKeyPrioritySortOrder;
    let index = 0;
    for (let key of yamlKeys) {
      key = key.trimEnd();
      if (key.endsWith(':')) {
        yamlKeys[index] = key.substring(0, key.length - 1);
      } else if (key != yamlKeys[index]) {
        yamlKeys[index] = key;
      }

      index++;
    }

    const yamlObject = loadYAML(yamlText);
    const doc = parseYAML(yamlText);
    if (doc == null || doc.contents == null) {
      return text;
    }

    const startingPriorityKeys = getEmptyDocument(doc);

    let remainingKeys = this.getYAMLKeysSorted(yamlKeys, doc, startingPriorityKeys);

    const sortOrder = options.yamlSortOrderForOtherKeys;
    if (yamlObject == null) {
      return this.getTextWithNewYamlFrontmatter(text, oldYaml, astToString(startingPriorityKeys), astToString(doc), priorityAtStartOfYaml, options.dateModifiedKey ?? 'date modified', options.currentTimeFormatted ?? '', !!options.yamlTimestampDateModifiedEnabled);
    }

    let sortMethod: (previousKey: string, currentKey: string) => number;
    if (sortOrder === 'Ascending Alphabetical') {
      sortMethod = this.sortAlphabeticallyAsc;
    } else if (sortOrder === 'Descending Alphabetical') {
      sortMethod = this.sortAlphabeticallyDesc;
    } else {
      return this.getTextWithNewYamlFrontmatter(text, oldYaml, astToString(startingPriorityKeys), astToString(doc), priorityAtStartOfYaml, options.dateModifiedKey ?? 'date modified', options.currentTimeFormatted ?? '', !!options.yamlTimestampDateModifiedEnabled);
    }

    const remainingDocKeys = getEmptyDocument(doc);
    remainingKeys = remainingKeys.sort(sortMethod);
    this.getYAMLKeysSorted(remainingKeys, doc, remainingDocKeys);

    return this.getTextWithNewYamlFrontmatter(text, oldYaml, astToString(startingPriorityKeys), astToString(remainingDocKeys), priorityAtStartOfYaml, options.dateModifiedKey ?? 'date modified', options.currentTimeFormatted ?? '', !!options.yamlTimestampDateModifiedEnabled);
  }
  getYAMLKeysSorted(keys: string[], yamlObject: Document, newDocument: Document): string[] {
    const contents = yamlObject.contents as YamlNode | null | undefined
    if (!contents) {
      return [];
    }

    const initialKeys: YamlNode[] = contents.items ?? [];
    const remainingKeys: string[] = [];

    for (const key of keys) {
      for (let i = 0; i < initialKeys.length; i++) {
        const node = initialKeys[i];
        if (node.key?.value === key) {
          newDocument.add(node);
          initialKeys.splice(i, 1);
          const movedTokens = movedTokenArrays(newDocument, yamlObject);
          movedTokens.target.items.push(movedTokens.source.items[i]);
          movedTokens.source.items.splice(i, 1);

          break;
        }
      }
    }

    for (const node of initialKeys) {
      if (node.key?.value !== undefined) {
        remainingKeys.push(node.key.value)
      }
    }

    return remainingKeys;
  }
  updateDateModifiedIfYamlChanged(oldYaml: string, newYaml: string, dateModifiedKey: string, currentTimeFormatted: string): string {
    if (oldYaml == newYaml) {
      return newYaml;
    }

    return setYamlSection(newYaml, dateModifiedKey, ' ' + currentTimeFormatted);
  }
  getTextWithNewYamlFrontmatter(text: string, oldYaml: string, priorityKeysSorted: string, remainingKeys: string, priorityAtStart: boolean, dateModifiedKey: string, currentTimeFormatted: string, yamlTimestampDateModifiedEnabled: boolean): string {
    let newYaml = `${remainingKeys}${priorityKeysSorted}`;
    if (priorityAtStart) {
      newYaml = `${priorityKeysSorted}${remainingKeys}`;
    }

    if (yamlTimestampDateModifiedEnabled) {
      newYaml = this.updateDateModifiedIfYamlChanged(oldYaml, newYaml, dateModifiedKey, currentTimeFormatted);
    }

    // `newYaml` is used as the replacement string, so any `$` in a YAML value
    // (e.g. `$$$$`) would be interpreted as a replacement pattern and collapsed.
    // Escape it the same way formatYAML() already does. See #1532.
    return text.replace(oldYaml, escapeDollarSigns(newYaml));
  }
  sortAlphabeticallyAsc(this:void, previousKey: string, currentKey: string): number {
    previousKey = previousKey.toLowerCase();
    currentKey = currentKey.toLowerCase();

    return previousKey < currentKey ? -1 : currentKey < previousKey ? 1 : 0;
  }
  sortAlphabeticallyDesc(this:void, previousKey: string, currentKey: string): number {
    previousKey = previousKey.toLowerCase();
    currentKey = currentKey.toLowerCase();

    return previousKey > currentKey ? -1 : currentKey > previousKey ? 1 : 0;
  }
  get exampleBuilders(): ExampleBuilder<YamlKeySortOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Sorts YAML keys in order specified by `YAML key priority sort order` has a sort order of `date type language`',
        before: dedent`
          ---
          language: Typescript
          type: programming
          tags: computer
          keywords: []
          status: WIP
          date: 02/15/2022
          ---
        `,
        after: dedent`
          ---
          date: 02/15/2022
          type: programming
          language: Typescript
          tags: computer
          keywords: []
          status: WIP
          ---
        `,
        options: {
          yamlKeyPrioritySortOrder: [
            'date',
            'type',
            'language',
          ],
          yamlSortOrderForOtherKeys: 'None',
          priorityKeysAtStartOfYaml: true,
        },
      }),
      new ExampleBuilder({
        description: 'Sorts YAML keys in order specified by `YAML key priority sort order` has a sort order of `date type language` with `\'YAML sort order for other keys\' = Ascending Alphabetical`',
        before: dedent`
          ---
          language: Typescript
          type: programming
          tags: computer
          keywords: []
          status: WIP
          date: 02/15/2022
          ---
        `,
        after: dedent`
          ---
          date: 02/15/2022
          type: programming
          language: Typescript
          keywords: []
          status: WIP
          tags: computer
          ---
        `,
        options: {
          yamlKeyPrioritySortOrder: [
            'date',
            'type',
            'language',
          ],
          yamlSortOrderForOtherKeys: 'Ascending Alphabetical',
        },
      }),
      new ExampleBuilder({
        description: 'Sorts YAML keys in order specified by `YAML key priority sort order` has a sort order of `date type language` with `\'YAML sort order for other keys\' = Descending Alphabetical`',
        before: dedent`
          ---
          language: Typescript
          type: programming
          tags: computer
          keywords: []
          status: WIP
          date: 02/15/2022
          ---
        `,
        after: dedent`
          ---
          date: 02/15/2022
          type: programming
          language: Typescript
          tags: computer
          status: WIP
          keywords: []
          ---
        `,
        options: {
          yamlKeyPrioritySortOrder: [
            'date',
            'type',
            'language',
          ],
          yamlSortOrderForOtherKeys: 'Descending Alphabetical',
          priorityKeysAtStartOfYaml: true,
        },
      }),
      new ExampleBuilder({
        description: 'Sorts YAML keys in order specified by `YAML key priority sort order` has a sort order of `date type language` with `\'YAML sort order for other keys\' = Descending Alphabetical` and `\'Priority keys at start of YAML\' = false`',
        before: dedent`
          ---
          language: Typescript
          type: programming
          tags: computer
          keywords: []
          ${''}
          status: WIP
          date: 02/15/2022
          ---
          Any blank line is attached to the line that follows it
        `,
        after: dedent`
          ---
          tags: computer
          ${''}
          status: WIP
          keywords: []
          date: 02/15/2022
          type: programming
          language: Typescript
          ---
          Any blank line is attached to the line that follows it
        `,
        options: {
          yamlKeyPrioritySortOrder: [
            'date',
            'type',
            'language',
          ],
          yamlSortOrderForOtherKeys: 'Descending Alphabetical',
          priorityKeysAtStartOfYaml: false,
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<YamlKeySortOptions>[] {
    return [
      new ListItemOptionBuilder({
        OptionsClass: YamlKeySortOptions,
        nameKey: "linter.rules.yaml_key_sort.yaml_key_priority_sort_order.name",
        descriptionKey: "linter.rules.yaml_key_sort.yaml_key_priority_sort_order.description",
         emptyStateKey: "linter.rules.yaml_key_sort.yaml_key_priority_sort_order.empty_state",
        fieldNamePlaceholderKey: "linter.rules.yaml_key_sort.yaml_key_priority_sort_order.placeholder_text",
        optionsKey: 'yamlKeyPrioritySortOrder',
        allowReorder: true,
        validator: isValidYamlKeyOnly,
      }),
      new BooleanOptionBuilder({
        OptionsClass: YamlKeySortOptions,
        nameKey: "linter.rules.yaml_key_sort.priority_keys_at_start_of_yaml.name",
        descriptionKey: "linter.rules.yaml_key_sort.priority_keys_at_start_of_yaml.description",
        optionsKey: 'priorityKeysAtStartOfYaml',
      }),
      new DropdownOptionBuilder<YamlKeySortOptions, YamlSortOrderForOtherKeys>({
        OptionsClass: YamlKeySortOptions,
        nameKey: "linter.rules.yaml_key_sort.yaml_sort_order_for_other_keys.name",
        descriptionKey: "linter.rules.yaml_key_sort.yaml_sort_order_for_other_keys.description",
        optionsKey: 'yamlSortOrderForOtherKeys',
        records: [
          {
            value: 'None',
            description: 'No sorting other than what is in the YAML Key Priority Sort Order text area',
          },
          {
            value: 'Ascending Alphabetical',
            description: 'Sorts the keys based on key value from a to z',
          },
          {
            value: 'Descending Alphabetical',
            description: 'Sorts the keys based on key value from z to a',
          },
        ],
      }),
    ];
  }
}

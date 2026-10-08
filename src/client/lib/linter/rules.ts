/**
 * The rule model: what a rule is, how it declares its options, and how a run keeps it away from
 * the parts of a note it promised not to change.
 *
 * A rule is a text-to-text function plus the description of its settings, so the settings panel,
 * the palette, the search index, and the run loop all read the same record. `apply` is handed the
 * document itself together with the regions the rule declared it leaves alone; nothing is masked
 * away and handed back, which is what lets every rule in a run share one parse.
 */
import { t } from '../i18n'
import { getExactDisabledRuleValue, getYAMLText } from './engine/yaml';
import { LintContext } from './engine/protected-ranges';
import { LinterError } from './linter-error';
import { BooleanOption, Option, type RuleConflict } from './option';
import type { MessageKey } from '../i18n'
import type { IgnoreType } from './engine/ignore-types';
import type { ProtectedRanges } from './engine/protected-ranges';
import type { LinterSettings } from './settings-data';
import type { YAMLParseError } from 'yaml';

export type Options = object;

type ApplyFunction = (text: string, options?: Partial<Options>, protectedRanges?: ProtectedRanges) => string;

export enum RuleType {
  YAML = 'YAML',
  HEADING = 'Heading',
  FOOTNOTE = 'Footnote',
  CONTENT = 'Content',
  SPACING = 'Spacing',
  PASTE = 'Paste',
}

export type { RuleConflict } from './option';

/** Class representing a rule */
export class Rule {
  private ruleHeading: string;

  /** Filled in by the builder: which other settings switching this rule on should turn off. */
  public conflictsWhenEnabled: (value: boolean) => RuleConflict[] = () => [];

  /** Option keys the settings panel must not draw a control for; set by the builder. */
  public hiddenConfigKeys: string[] = [];

  constructor(
      private nameKey: MessageKey,
      private descriptionKey: MessageKey,
      public settingsKey: string,
      public alias: string,
      public type: RuleType,
      public applyAfterIgnore: ApplyFunction,
      public examples: Array<Example>,
      public options: Array<Option> = [],
      public readonly hasSpecialExecutionOrder: boolean = false,
      public readonly ignoreTypes: IgnoreType[] = [],
  ) {
    this.ruleHeading = this.getName().toLowerCase().replaceAll(' ', '-');

    options.unshift(new BooleanOption('enabled', this.nameKey, this.descriptionKey, false, alias));
    for (const option of options) {
      option.ruleAlias = alias;
    }
  }

  getDefaultOptions(): Options {
    const options: Record<string, unknown> = {};
    for (const option of this.options) {
      options[option.configKey] = option.defaultValue;
    }

    return options;
  }

  getOptions(settings: LinterSettings): Options {
    return settings.ruleConfigs[this.settingsKey] as Options;
  }

  getName(): string {
    return t(this.nameKey);
  }

  getDescription(): string {
    return t(this.descriptionKey);
  }

  /** The heading the reference documentation uses for this rule, kept for the run log. */
  getHeading(): string {
    return this.ruleHeading;
  }

  enabledOptionName(): string {
    return this.options[0].configKey;
  }

  /**
   * Run the rule, keeping it away from the parts of the document it declared it ignores.
   *
   * Every rule is given the document itself and told which regions of it not to change.
   */
  apply(text: string, options?: Partial<Options>, context?: LintContext): string {
    // a context belongs to the text it was built from, so one for a different document is not
    // reused rather than trusted
    const contextForText = context && context.text === text ? context : LintContext.for(text);

    return this.applyAfterIgnore(text, options, contextForText.protectedRangesFor(this.ignoreTypes));
  }
}

/** Class representing an example of a rule */
export class Example {
  public description: string;
  public options: Partial<Options>;

  public before: string;
  public after: string;

  constructor(description: string, before: string, after: string, options: Partial<Options> = {}) {
    this.description = description;
    this.options = options;
    this.before = before;
    this.after = after;
  }
}

export const RuleTypeOrder: RuleType[] = Object.values(RuleType);

/**
 * The rules a note's front matter switches off, and whether the whole note is skipped.
 * @param {string} text The text to parse
 * @return {[string[], boolean]} The disabled rule aliases and whether to skip the file entirely
 */
export function getDisabledRules(text: string): [string[], boolean] {
  const yamlText = getYAMLText(text);
  if (yamlText === null) {
    return [[], false];
  }

  const disabledRules = getExactDisabledRuleValue(yamlText);

  if (disabledRules.includes('all')) {
    return [rules.map((rule) => rule.alias), true];
  }

  return [disabledRules, false];
}

export const rules: Rule[] = [];

export const rulesDict = new Map<string, Rule>();
export const ruleTypeToRules = new Map<RuleType, Rule[]>();

export function registerRule(rule: Rule): void {
  rules.push(rule);
  rulesDict.set(rule.alias, rule);

  const existing = ruleTypeToRules.get(rule.type);
  if (existing) {
    existing.push(rule);
  } else {
    ruleTypeToRules.set(rule.type, [rule]);
  }
}

export function sortRules(): void {
  rules.sort((a, b) => (RuleTypeOrder.indexOf(a.type) - RuleTypeOrder.indexOf(b.type)) || a.settingsKey.localeCompare(b.settingsKey));
}

export function wrapLintError(error: Error, ruleName: string): never {
  let errorMessage: string;
  if (isYamlParseError(error)) {
    errorMessage = error.toString();
    errorMessage = t('linter.logs.wrapper_yaml_error').replace('{ERROR_MESSAGE}', errorMessage.substring(errorMessage.indexOf(':') + 1));
  } else {
    errorMessage = t('linter.logs.wrapper_unknown_error').replace('{ERROR_MESSAGE}', error.message);
  }

  throw new LinterError(t('linter.logs.error_message_format').replace('{RULE_NAME}', ruleName).replace('{ERROR_MESSAGE}', errorMessage), error);
}

function isYamlParseError(error: Error): error is YAMLParseError {
  return error && typeof error === 'object' && 'name' in error && (error as { name: string }).name === 'YAMLParseError';
}

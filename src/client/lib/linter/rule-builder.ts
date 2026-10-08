/**
 * The rule authoring layer.
 *
 * A rule is written as a class deriving from `RuleBuilder`, and `@RuleBuilder.register` turns an
 * instance of it into the `Rule` the run loop and the settings panel use. Builders exist so a rule's
 * option objects, its examples, and its config keys are declared once next to the code that reads
 * them; the `Rule` they produce is plain data, so nothing else has to know about this layer.
 */
import { Example, Options, Rule, registerRule, RuleType, wrapLintError } from './rules';
import {
  BooleanOption,
  DropdownOption,
  DropdownRecord,
  ListItemOption,
  MomentFormatOption,
  NotePickerOption,
  NumberOption,
  type RuleOption,
  TextOption,
  type EntryValidator,
  type RuleConflict,
} from './option';
import type { CustomAutoCorrectContent } from '@shared/linter'
import { logDebug, timingBegin, timingEnd } from './engine/logger';
import { t } from '../i18n';
import { IgnoreTypes } from './engine/ignore-types';
import { LintContext, ProtectedRanges } from './engine/protected-ranges';
import type { MessageKey } from '../i18n';
import type { IgnoreType } from './engine/ignore-types';
import type { LinterSettings } from './settings-data';

export type { RuleConflict };

// limit the amount of text that can be written to the logs to try to prevent memory issues
const maxFileSizeLength = 10000;

export class RuleBuilderBase {
  static #ruleMap = new Map<string, Rule>();

  static getRule<TOptions extends Options>(this: (new () => RuleBuilder<TOptions>)): Rule {
    // Keyed on the rule's alias rather than the name of the class it was built from: three rules
    // were left named `RuleTemplate` after being copied from the template, so they shared an entry
    // and two of them silently became the third.
    const builder = new this();
    const existing = RuleBuilderBase.#ruleMap.get(builder.alias);
    if (existing) {
      return existing;
    }

    const rule = new Rule(builder.nameKey, builder.descriptionKey, builder.settingsKey, builder.alias, builder.type, builder.safeApply.bind(builder), builder.exampleBuilders.map((builder) => builder.example), builder.optionBuilders.map((builder) => builder.option), builder.hasSpecialExecutionOrder, builder.ignoreTypes);
    rule.conflictsWhenEnabled = builder.conflictsWhenEnabled;
    rule.hiddenConfigKeys = builder.hiddenKeys
      .map((field) => rule.options.find((option) => option.configKey === toConfigKey(field))?.configKey)
      .filter((configKey): configKey is string => configKey !== undefined);
    RuleBuilderBase.#ruleMap.set(builder.alias, rule);

    return rule;
  }

  static applyIfEnabledBase(rule: Rule, text: string, settings: LinterSettings, extraOptions: Partial<Options>, context?: LintContext): [result: string, isEnabled: boolean] {
    const optionsFromSettings = rule.getOptions(settings);
    if ((optionsFromSettings as Record<string, unknown>)?.[rule.enabledOptionName()]) {
      timingBegin(rule.alias);
      const options = Object.assign({}, optionsFromSettings, extraOptions);
      logDebug(`${t('linter.logs.run_rule_text')} ${rule.getName()}`);

      try {
        const newText = rule.apply(text, options, context);
        timingEnd(rule.alias);

        if (newText.length > maxFileSizeLength) {
          logDebug(newText.slice(0, maxFileSizeLength - 1) + '...');
        } else {
          logDebug(newText);
        }

        return [newText, true];
      } catch (error) {
        timingEnd(rule.alias);
        wrapLintError(error instanceof Error ? error : new Error(String(error)), rule.getName());
      }
    }

    return [text, false];
  }

}

type RuleBuilderConstructorArgs = {
  /** Defaults to the locale key’s rule segment; a rule that keeps the reference’s dashed alias names it here. */
  alias?: string,
  nameKey: MessageKey,
  descriptionKey: MessageKey,
  type: RuleType,
  hasSpecialExecutionOrder?: boolean,
  // ignore types to use on the entirety of the rule and not just a part
  // Note: this value should not contain custom ignore as that is added to all rules except Paste
  // rules, which do not use this property
  ruleIgnoreTypes?: IgnoreType[],
  /** Option fields the run feeds in; the panel draws no control for them. */
  hiddenKeys?: string[],
  /** Switching this rule on means these other settings should be turned off, with the reader's say. */
  disableConflictingOptions?: (value: boolean) => RuleConflict[],
};

export default abstract class RuleBuilder<TOptions extends Options> extends RuleBuilderBase {
  public settingsKey: string;
  public alias: string;
  public nameKey: MessageKey;
  public descriptionKey: MessageKey;
  public type: RuleType;
  public hasSpecialExecutionOrder: boolean;
  public ignoreTypes: IgnoreType[];
  public conflictsWhenEnabled: (value: boolean) => RuleConflict[];
  public hiddenKeys: string[];

  constructor(args: RuleBuilderConstructorArgs) {
    super();

    // cut "linter.rules." from the start and ".name" from the end, unless the rule carries the
    // reference's own alias: that spelling is what a note's disabled-rules front matter uses
    this.alias = args.alias ?? args.nameKey.substring('linter.rules.'.length, args.nameKey.length - '.name'.length);
    this.settingsKey = this.alias;
    this.nameKey = args.nameKey;
    this.descriptionKey = args.descriptionKey;
    this.type = args.type;
    this.hasSpecialExecutionOrder = args.hasSpecialExecutionOrder ?? false;
    this.conflictsWhenEnabled = args.disableConflictingOptions ?? (() => []);
    this.hiddenKeys = args.hiddenKeys ?? [];

    if (args.ruleIgnoreTypes) {
      this.ignoreTypes = [IgnoreTypes.customIgnore, ...args.ruleIgnoreTypes];
    } else {
      this.ignoreTypes = [IgnoreTypes.customIgnore];
    }
  }

  abstract get OptionsClass(): new () => TOptions;

  static register<TOptions extends Options, T extends typeof RuleBuilderBase & (new () => RuleBuilder<TOptions>)>(this: void, ruleBuilderClass: T, _context: ClassDecoratorContext): void {
    registerRule(ruleBuilderClass.getRule());
  }

  safeApply(text: string, options?: Partial<Options>, protectedRanges?: ProtectedRanges): string {
    return this.apply(text, this.buildRuleOptions(options), protectedRanges);
  }

  buildRuleOptions(options?: Partial<Options>): TOptions {
    const ruleOptions = Object.assign(new this.OptionsClass(), options ?? {});
    for (const optionBuilder of this.optionBuilders) {
      optionBuilder.setRuleOption(ruleOptions, options ?? {});
    }

    return ruleOptions;
  }

  abstract apply(text: string, options: TOptions, protectedRanges?: ProtectedRanges): string;
  abstract get exampleBuilders(): ExampleBuilder<TOptions>[];
  abstract get optionBuilders(): OptionBuilderBase<TOptions>[];

  static applyIfEnabled<TOptions extends Options>(this: typeof RuleBuilderBase & (new () => RuleBuilder<TOptions>), text: string, settings: LinterSettings, disabledRules: string[], extraOptions?: Partial<Options>, context?: LintContext): [result: string, isEnabled: boolean] {
    const rule = this.getRule();
    if (disabledRules.includes(rule.alias)) {
      logDebug(`${rule.alias} ${t('linter.logs.disabled_text')}`);
      return [text, false];
    }

    return RuleBuilderBase.applyIfEnabledBase(rule, text, settings, extraOptions ?? {}, context);
  }

  static getRuleOptions<TOptions extends Options>(this: (new () => RuleBuilder<TOptions>), settings: LinterSettings): TOptions {
    const rule = RuleBuilderBase.getRule.bind(this)();
    const builder = new this();
    return builder.buildRuleOptions(rule.getOptions(settings));
  }
}

export class ExampleBuilder<TOptions extends Options> {
  readonly example: Example;

  constructor(args: { description: string, before: string, after: string, options?: Partial<TOptions> }) {
    this.example = new Example(args.description, args.before, args.after, args.options);
  }
}

// NonNullable, because an options field the rule leaves unset is still a value of the declared
// kind: `preserveStart?: boolean` names a boolean option, not a boolean-or-undefined one.
type KeysOfObjectMatchingPropertyValueType<TObject, TValue> = { [TKey in keyof TObject]-?: NonNullable<TObject[TKey]> extends TValue ? (TValue extends NonNullable<TObject[TKey]> ? TKey : never) : never }[keyof TObject & string];

type OptionBuilderConstructorArgs<TOptions extends Options, TValue> = {
  OptionsClass: new () => TOptions,
  nameKey: MessageKey,
  descriptionKey: MessageKey,
  optionsKey: KeysOfObjectMatchingPropertyValueType<TOptions, TValue>;
};

export abstract class OptionBuilderBase<TOptions extends Options> {
  abstract setRuleOption(ruleOptions: TOptions, options: Partial<Options>): void;
  abstract get option(): RuleOption;
  abstract get optionsKey(): string;
}

export abstract class OptionBuilder<TOptions extends Options, TValue> extends OptionBuilderBase<TOptions> {
  readonly OptionsClass: new () => TOptions;
  readonly configKey: string;
  readonly nameKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly optionsKey: KeysOfObjectMatchingPropertyValueType<TOptions, TValue>;
  #option: RuleOption | undefined;

  constructor(args: OptionBuilderConstructorArgs<TOptions, TValue>) {
    super();
    this.OptionsClass = args.OptionsClass;

    const keyParts = args.nameKey.split('.');
    this.configKey = keyParts.length === 1 ? keyParts[0] : keyParts[keyParts.length - 2];

    this.nameKey = args.nameKey;
    this.descriptionKey = args.descriptionKey;
    this.optionsKey = args.optionsKey;
  }

  protected get defaultValue(): TValue {
    return (new this.OptionsClass()[this.optionsKey] as unknown) as TValue;
  }

  get option(): RuleOption {
    if (!this.#option) {
      this.#option = this.buildOption();
    }

    return this.#option;
  }

  setRuleOption(ruleOptions: TOptions, options: Partial<Options>): void {
    const optionValue = (options as Record<string, unknown>)?.[this.configKey] as TOptions[KeysOfObjectMatchingPropertyValueType<TOptions, TValue>] | undefined;
    if (optionValue !== undefined) {
      (ruleOptions as Record<string, unknown>)[this.optionsKey] = optionValue;
    }
  }

  protected abstract buildOption(): RuleOption;
}

export class BooleanOptionBuilder<TOptions extends Options> extends OptionBuilder<TOptions, boolean> {
  private readonly conflictsWith: RuleConflict[]

  constructor(args: OptionBuilderConstructorArgs<TOptions, boolean> & { conflictsWith?: RuleConflict[] }) {
    super(args);
    this.conflictsWith = args.conflictsWith ?? [];
  }

  protected buildOption(): RuleOption {
    return new BooleanOption(this.configKey, this.nameKey, this.descriptionKey, this.defaultValue, null, this.conflictsWith.length ? this.conflictsWith : undefined);
  }
}

export class NumberOptionBuilder<TOptions extends Options> extends OptionBuilder<TOptions, number> {
  protected buildOption(): RuleOption {
    return new NumberOption(this.configKey, this.nameKey, this.descriptionKey, this.defaultValue);
  }
}

export class DropdownOptionBuilder<TOptions extends Options, TValue extends string> extends OptionBuilder<TOptions, TValue> {
  readonly records: DropdownRecord[];

  constructor(args: OptionBuilderConstructorArgs<TOptions, TValue> & {
    records: { value: TValue, description: string }[]
  }) {
    super(args);
    // A record whose value is a word has a translated label; one whose value is a symbol (`*`, `""`)
    // is its own label, which is why the lookup is optional.
    this.records = args.records.map((record) => new DropdownRecord(record.value, enumLabelKeyFor(record.value), record.description));
  }

  protected buildOption(): RuleOption {
    return new DropdownOption(this.configKey, this.nameKey, this.descriptionKey, this.defaultValue, this.records);
  }
}

export class ListItemOptionBuilder<TOptions extends Options> extends OptionBuilder<TOptions, string[]> {
  private readonly validator?: EntryValidator;
  private readonly emptyStateKey: MessageKey;
  private readonly fieldNamePlaceholderKey: MessageKey;
  private readonly allowReorder: boolean;
  private readonly trimItemWhitespace: boolean;

  constructor(args: OptionBuilderConstructorArgs<TOptions, string[]> & { validator?: EntryValidator, emptyStateKey: MessageKey, fieldNamePlaceholderKey: MessageKey, allowReorder?: boolean, trimItemWhitespace?: boolean }) {
    super(args);

    this.validator = args.validator;
    this.emptyStateKey = args.emptyStateKey;
    this.fieldNamePlaceholderKey = args.fieldNamePlaceholderKey;
    this.allowReorder = args.allowReorder ?? false;
    this.trimItemWhitespace = args.trimItemWhitespace ?? false;
  }

  protected buildOption(): RuleOption {
    return new ListItemOption(this.configKey, this.nameKey, this.descriptionKey, this.defaultValue ?? [], null, this.validator, this.emptyStateKey, this.fieldNamePlaceholderKey, this.allowReorder, this.trimItemWhitespace);
  }

  setRuleOption(ruleOptions: TOptions, options: Partial<Options>): void {
    const stored = (options as Record<string, unknown>)?.[this.configKey]
    if (Array.isArray(stored)) {
      // an empty entry is not a value the rule can act on
      (ruleOptions as Record<string, unknown>)[this.optionsKey] = stored.filter((element: string) => element !== '');
    }
  }
}

export class TextOptionBuilder<TOptions extends Options> extends OptionBuilder<TOptions, string> {
  protected buildOption(): RuleOption {
    return new TextOption(this.configKey, this.nameKey, this.descriptionKey, this.defaultValue);
  }
}

export class MomentFormatOptionBuilder<TOptions extends Options> extends OptionBuilder<TOptions, string> {
  protected buildOption(): RuleOption {
    return new MomentFormatOption(this.configKey, this.nameKey, this.descriptionKey, this.defaultValue);
  }
}

export class MdFilePickerOptionBuilder<TOptions extends Options> extends OptionBuilder<TOptions, CustomAutoCorrectContent[]> {
  protected buildOption(): RuleOption {
    return new NotePickerOption(this.configKey, this.nameKey, this.descriptionKey);
  }
}

/**
 * The label key for a dropdown value, or null when the value is a symbol or a markup tag and so
 * displays as itself.
 *
 * This is the same decision the locale catalog was built with: worded values got one
 * `linter.enums.<value>` entry each, and every other value was left out of it on purpose, so
 * asking for their key would hand the reader the raw key instead of the value.
 */
function enumLabelKeyFor(value: string): MessageKey | null {
  if (!/[\p{L}\p{N}]/u.test(value) || /^<[\s\S]*>$/.test(value)) {
    return null;
  }

  return `linter.enums.${value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}` as MessageKey;
}

/** An options field name as the settings and the catalog spell it. */
function toConfigKey(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export { enumLabelKeyFor, toConfigKey };

/**
 * The settings a rule exposes, described rather than rendered.
 *
 * Each option knows its own config key, its two locale keys, its default, and the control kind the
 * settings panel should draw. The panel switches on `kind`, so a rule can add an option without
 * touching any UI code, and a stored value that is not one of these kinds never reaches a rule.
 */
import { t } from '../i18n'
import type { MessageKey } from '../i18n'

/** Another rule's setting that switching this one on ought to turn off. */
export type RuleConflict = { rule: string, option?: string }

export type OptionKind = 'toggle' | 'text' | 'number' | 'dropdown' | 'date-format' | 'list' | 'note-picker'

/** A stored value's own check, answered as `[valid, message]`. */
export type EntryValidator = (value: string) => [boolean, string]

/** Every control kind a rule can ask the panel to draw. */
export type RuleOption =
  | BooleanOption
  | TextOption
  | NumberOption
  | DropdownOption
  | MomentFormatOption
  | ListItemOption
  | NotePickerOption

export abstract class Option {
  public ruleAlias: string = ''

  abstract readonly kind: OptionKind

  constructor(public configKey: string, public nameKey: MessageKey, public descriptionKey: MessageKey, public defaultValue: unknown, ruleAlias?: string | null) {
    if (ruleAlias) {
      this.ruleAlias = ruleAlias;
    }
  }

  getName(): string {
    return t(this.nameKey) ?? '';
  }

  getDescription(): string {
    return t(this.descriptionKey) ?? '';
  }
}

export class BooleanOption extends Option {
  readonly kind = 'toggle' as const

  declare public defaultValue: boolean

  constructor(configKey: string, nameKey: MessageKey, descriptionKey: MessageKey, defaultValue: boolean, ruleAlias?: string | null,
      public conflictsWith?: RuleConflict[]) {
    super(configKey, nameKey, descriptionKey, defaultValue, ruleAlias);
  }
}

export class TextOption extends Option {
  readonly kind = 'text' as const

  declare public defaultValue: string
}

/** A numeric setting: the same control as text, but the panel keeps the reader on a number field. */
export class NumberOption extends Option {
  readonly kind = 'number' as const

  declare public defaultValue: number

  constructor(configKey: string, nameKey: MessageKey, descriptionKey: MessageKey, defaultValue: number, ruleAlias?: string | null, public min?: number, public max?: number) {
    super(configKey, nameKey, descriptionKey, defaultValue, ruleAlias);
  }
}

export class DropdownRecord {
  constructor(public value: string, public labelKey: MessageKey | null, public description: string) {}

  getDisplayValue(): string {
    return this.labelKey ? t(this.labelKey) : this.value;
  }
}

export class DropdownOption extends Option {
  readonly kind = 'dropdown' as const

  declare public defaultValue: string
  public options: DropdownRecord[]

  constructor(configKey: string, nameKey: MessageKey, descriptionKey: MessageKey, defaultValue: string, options: DropdownRecord[], ruleAlias?: string | null) {
    super(configKey, nameKey, descriptionKey, defaultValue, ruleAlias);
    this.options = options;
  }
}

/** A date or date-time pattern, previewed with the reader's own locale and clock. */
export class MomentFormatOption extends Option {
  readonly kind = 'date-format' as const

  declare public defaultValue: string
}

/** A list of entries the reader adds, edits, and reorders — YAML keys, words to ignore, and so on. */
export class ListItemOption extends Option {
  readonly kind = 'list' as const

  declare public defaultValue: string[]

  constructor(configKey: string, nameKey: MessageKey, descriptionKey: MessageKey, defaultValue: string[] | null, ruleAlias?: string | null,
      public validator?: EntryValidator, public emptyStateKey?: MessageKey, public placeholderKey?: MessageKey,
      public allowReorder: boolean = false, public trimItemWhitespace: boolean = false) {
    super(configKey, nameKey, descriptionKey, defaultValue ?? [], ruleAlias);
  }
}

/**
 * Notes whose tables hold extra spelling corrections, in place of the vault file picker the
 * reference plugin uses.
 */
export class NotePickerOption extends Option {
  readonly kind = 'note-picker' as const

  declare public defaultValue: string[]

  constructor(configKey: string, nameKey: MessageKey, descriptionKey: MessageKey, ruleAlias?: string | null) {
    super(configKey, nameKey, descriptionKey, [], ruleAlias);
  }
}

// based on https://github.com/chrisgrieser/obsidian-smarter-paste/blob/master/clipboardModification.ts#L13
import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';

class RemoveHyphensOnPasteOptions implements Options {}

@RuleBuilder.register
export default class RemoveHyphensOnPaste extends RuleBuilder<RemoveHyphensOnPasteOptions> {
  constructor() {
    super({
      nameKey: "linter.rules.remove_hyphens_on_paste.name",
      descriptionKey: "linter.rules.remove_hyphens_on_paste.description",
      type: RuleType.PASTE,
    });
  }
  get OptionsClass(): new () => RemoveHyphensOnPasteOptions {
    return RemoveHyphensOnPasteOptions;
  }
  apply(text: string, _options: RemoveHyphensOnPasteOptions): string {
    return text.replace(/([^\s-])[-‐]\s+\n?(?=\w)/g, '$1');
  }
  get exampleBuilders(): ExampleBuilder<RemoveHyphensOnPasteOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Remove hyphen in content to paste',
        before: dedent`
          Text that was cool but hyper-
          tension made it uncool.
        `,
        after: dedent`
          Text that was cool but hypertension made it uncool.
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<RemoveHyphensOnPasteOptions>[] {
    return [];
  }
}

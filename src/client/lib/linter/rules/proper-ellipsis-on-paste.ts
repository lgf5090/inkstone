// based on https://github.com/chrisgrieser/obsidian-smarter-paste/blob/master/clipboardModification.ts#L16
import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {ellipsisRegex} from '../engine/regex';

class ProperEllipsisOnPasteOptions implements Options {}

export default class ProperEllipsisOnPaste extends RuleBuilder<ProperEllipsisOnPasteOptions> {
  constructor() {
    super({
      alias: 'proper-ellipsis-on-paste',
      nameKey: "linter.rules.proper_ellipsis_on_paste.name",
      descriptionKey: "linter.rules.proper_ellipsis_on_paste.description",
      type: RuleType.PASTE,
    });
  }
  get OptionsClass(): new () => ProperEllipsisOnPasteOptions {
    return ProperEllipsisOnPasteOptions;
  }
  apply(text: string, _options: ProperEllipsisOnPasteOptions): string {
    return text.replaceAll(ellipsisRegex, '…');
  }
  get exampleBuilders(): ExampleBuilder<ProperEllipsisOnPasteOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Replacing three consecutive dots with an ellipsis even if spaces are present',
        before: dedent`
          Lorem (...) Impsum.
          Lorem (. ..) Impsum.
          Lorem (. . .) Impsum.
        `,
        after: dedent`
          Lorem (…) Impsum.
          Lorem (…) Impsum.
          Lorem (…) Impsum.
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<ProperEllipsisOnPasteOptions>[] {
    return [];
  }
}

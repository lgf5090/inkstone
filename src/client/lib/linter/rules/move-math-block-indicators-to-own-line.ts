import {Options, RuleType} from '../rules';
import RuleBuilder, {ExampleBuilder, OptionBuilderBase} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {makeSureMathBlockIndicatorsAreOnTheirOwnLines} from '../engine/mdast';
import {ProtectedRanges} from '../engine/protected-ranges';

class MoveMathBlockIndicatorsToOwnLineOptions implements Options {
  minimumNumberOfDollarSignsToBeAMathBlock: number = 2;
}

export default class MoveMathBlockIndicatorsToOwnLine extends RuleBuilder<MoveMathBlockIndicatorsToOwnLineOptions> {
  constructor() {
    super({
      alias: 'move-math-block-indicators-to-their-own-line',
      // fields the run feeds in, so the panel must not draw a control for them
      hiddenKeys: ['minimumNumberOfDollarSignsToBeAMathBlock'],      nameKey: "linter.rules.move_math_block_indicators_to_their_own_line.name",
      descriptionKey: "linter.rules.move_math_block_indicators_to_their_own_line.description",
      type: RuleType.SPACING,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.inlineCode],
      hasSpecialExecutionOrder: true,
    });
  }
  get OptionsClass(): new () => MoveMathBlockIndicatorsToOwnLineOptions {
    return MoveMathBlockIndicatorsToOwnLineOptions;
  }
  apply(text: string, options: MoveMathBlockIndicatorsToOwnLineOptions, protectedRanges: ProtectedRanges): string {
    return makeSureMathBlockIndicatorsAreOnTheirOwnLines(text, options.minimumNumberOfDollarSignsToBeAMathBlock, protectedRanges);
  }
  get exampleBuilders(): ExampleBuilder<MoveMathBlockIndicatorsToOwnLineOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Moving math block indicator to its own line when `Number of dollar signs to indicate a math block` = 2',
        before: dedent`
          This is left alone:
          $$
          \\boldsymbol{a}=\\begin{bmatrix}a_x \\\\ a_y\\end{bmatrix}
          $$
          The following is updated:
          $$L = \\frac{1}{2} \\rho v^2 S C_L$$
        `,
        after: dedent`
          This is left alone:
          $$
          \\boldsymbol{a}=\\begin{bmatrix}a_x \\\\ a_y\\end{bmatrix}
          $$
          The following is updated:
          $$
          L = \\frac{1}{2} \\rho v^2 S C_L
          $$
        `,
      }),
      new ExampleBuilder({
        description: 'Moving math block indicator to its own line when `Number of dollar signs to indicate a math block` = 3 and opening indicator is on the same line as the start of the content',
        before: dedent`
          $$$\\boldsymbol{a}=\\begin{bmatrix}a_x \\\\ a_y\\end{bmatrix}
          $$$
        `,
        after: dedent`
          $$$
          \\boldsymbol{a}=\\begin{bmatrix}a_x \\\\ a_y\\end{bmatrix}
          $$$
        `,
      }),
      new ExampleBuilder({
        description: 'Moving math block indicator to its own line when `Number of dollar signs to indicate a math block` = 2 and ending indicator is on the same line as the ending line of the content',
        before: dedent`
          $$
          \\boldsymbol{a}=\\begin{bmatrix}a_x \\\\ a_y\\end{bmatrix}$$
        `,
        after: dedent`
          $$
          \\boldsymbol{a}=\\begin{bmatrix}a_x \\\\ a_y\\end{bmatrix}
          $$
        `,
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<MoveMathBlockIndicatorsToOwnLineOptions>[] {
    return [];
  }
}

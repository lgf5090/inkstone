/**
 * The lint run: which rules run, in what order, and how their changes share one document.
 *
 * Rules used to be handed the text the rule before them produced. A run now gives every rule the
 * same snapshot, works out what each changed by comparing its answer with what it was given, and
 * applies the changes together, so one parse and one set of protected regions serve the whole batch.
 * A rule whose changes land near another's, or one that has to see earlier work, ends the batch and
 * starts the next.
 */
import { getDisabledRules, Rule, rules, RuleType, type Options } from './rules';
import { patternSafety } from '@shared/regex-safety';
import { IgnoreTypes } from './engine/ignore-types';
import { LintContext, replaceUnprotectedRegexMatches } from './engine/protected-ranges';
import { addEditsIfTheyDoNotClash, getEditsBetween } from './engine/text-edits';
import { convertStringVersionOfEscapeCharactersToEscapeCharacters, replaceTextRanges, type textReplacement } from './engine/strings';
import { yamlRegex } from './engine/regex';
import { LinterError } from './linter-error';
import { formatDatePattern } from '../quickadd/date-pattern';
import type { CustomAutoCorrectContent, CustomReplace, LinterSettings } from './settings-data';

import AddBlankLineAfterYAML from './rules/add-blank-line-after-yaml';
import AutoCorrectCommonMisspellings from './rules/auto-correct-common-misspellings';
import BlockquoteStyle from './rules/blockquote-style';
import BlockquotifyOnPaste from './rules/blockquotify-on-paste';
import CapitalizeHeadings from './rules/capitalize-headings';
import ConsecutiveBlankLines from './rules/consecutive-blank-lines';
import EscapeYamlSpecialCharacters from './rules/escape-yaml-special-characters';
import ForceYamlEscape from './rules/force-yaml-escape';
import FormatTagsInYaml from './rules/format-tags-in-yaml';
import MoveInlineFieldsToYaml from './rules/move-inline-fields-to-yaml';
import MoveMathBlockIndicatorsToOwnLine from './rules/move-math-block-indicators-to-own-line';
import PreventDoubleChecklistIndicatorOnPaste from './rules/prevent-double-checklist-indicator-on-paste';
import PreventDoubleListItemIndicatorOnPaste from './rules/prevent-double-list-item-indicator-on-paste';
import ProperEllipsisOnPaste from './rules/proper-ellipsis-on-paste';
import RemoveHyphensOnPaste from './rules/remove-hyphens-on-paste';
import RemoveLeadingOrTrailingWhitespaceOnPaste from './rules/remove-leading-or-trailing-whitespace-on-paste';
import RemoveLeftoverFootnotesFromQuoteOnPaste from './rules/remove-leftover-footnotes-from-quote-on-paste';
import RemoveMultipleBlankLinesOnPaste from './rules/remove-multiple-blank-lines-on-paste';
import TrailingSpaces from './rules/trailing-spaces';
import YamlKeySort from './rules/yaml-key-sort';
import YamlTimestamp from './rules/yaml-timestamp';
import YamlTitle from './rules/yaml-title';
import YamlTitleAlias from './rules/yaml-title-alias';

export type LintFileInfo = {
  /** The note's title, which is what the YAML title rules write into the front matter. */
  name: string,
  createdAtFormatted: string,
  modifiedAtFormatted: string,
  path: string,
}

export type RunLintOptions = {
  oldText: string,
  fileInfo: LintFileInfo,
  settings: LinterSettings,
  locale: string,
  getCurrentTime: () => Date,
  defaultMisspellings: Map<string, string>,
}

/** What a run did: the new text, the rules that asked for changes, and why it may have stopped. */
export type LintOutcome = {
  text: string,
  changedRules: string[],
  /** The note's front matter asked for no linting at all. */
  skipped: boolean,
  error: string | null,
}

/**
 * Rules that must see the work of the rules before them: the ones that move content about, or that
 * decide what to do from where everything already is.
 */
const rulesThatMustSeeEarlierWork = [
  'move-footnotes-to-the-bottom',
  're-index-footnotes',
  'line-break-at-document-end',
  'file-name-heading',
  'header-increment',
];

export class RulesRunner {
  private disabledRules: string[] = [];
  private changed = new Set<string>();
  skipFile = false;

  lintText(runOptions: RunLintOptions): LintOutcome {
    this.skipFile = false;
    this.changed = new Set();
    const originalText = runOptions.oldText;
    [this.disabledRules, this.skipFile] = getDisabledRules(originalText);
    if (this.skipFile) {
      return { text: originalText, changedRules: [], skipped: true, error: null };
    }

    try {
      const settings = runOptions.settings;
      const extraOptions: Options = {
        fileCreatedTime: runOptions.fileInfo.createdAtFormatted,
        fileModifiedTime: runOptions.fileInfo.modifiedAtFormatted,
        fileName: runOptions.fileInfo.name,
        locale: runOptions.locale,
        minimumNumberOfDollarSignsToBeAMathBlock: settings.commonStyles.minimumNumberOfDollarSignsToBeAMathBlock,
        aliasArrayStyle: settings.commonStyles.aliasArrayStyle,
        tagArrayStyle: settings.commonStyles.tagArrayStyle,
        defaultArrayStyle: settings.commonStyles.defaultArrayStyle,
        defaultEscapeCharacter: settings.commonStyles.escapeCharacter,
        removeUnnecessaryEscapeCharsForMultiLineArrays: settings.commonStyles.removeUnnecessaryEscapeCharsForMultiLineArrays,
      };

      let text = this.runBeforeRegularRules(runOptions);
      text = this.runRegularRules(text, settings, extraOptions, runOptions);
      text = this.runCustomRegexReplacement(settings.customRegexes, text);
      text = this.runAfterRegularRules(originalText, { ...runOptions, oldText: text });

      return { text, changedRules: [...this.changed], skipped: false, error: null };
    } catch (error) {
      return {
        text: originalText,
        changedRules: [...this.changed],
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private runBeforeRegularRules(runOptions: RunLintOptions): string {
    const styles = runOptions.settings.commonStyles;
    let text = runOptions.oldText;
    // remove hashtags from tags before parsing yaml
    text = this.apply(FormatTagsInYaml.getRule(), text, runOptions.settings, {});
    // escape YAML where possible before parsing yaml
    text = this.apply(EscapeYamlSpecialCharacters.getRule(), text, runOptions.settings, { defaultEscapeCharacter: styles.escapeCharacter });
    text = this.apply(MoveMathBlockIndicatorsToOwnLine.getRule(), text, runOptions.settings, { minimumNumberOfDollarSignsToBeAMathBlock: styles.minimumNumberOfDollarSignsToBeAMathBlock });
    text = this.apply(AutoCorrectCommonMisspellings.getRule(), text, runOptions.settings, { misspellingToCorrection: runOptions.defaultMisspellings });
    // inline fields move last so the YAML rules that run after them see the keys they add
    text = this.apply(MoveInlineFieldsToYaml.getRule(), text, runOptions.settings, {
      defaultEscapeCharacter: styles.escapeCharacter,
      tagArrayStyle: styles.tagArrayStyle,
      aliasArrayStyle: styles.aliasArrayStyle,
      defaultArrayStyle: styles.defaultArrayStyle,
      removeUnnecessaryEscapeCharsForMultiLineArrays: styles.removeUnnecessaryEscapeCharsForMultiLineArrays,
    });

    return text;
  }

  /** The regular rules, in batches that share one snapshot of the document. */
  private runRegularRules(text: string, settings: LinterSettings, extraOptions: Options, runOptions: RunLintOptions): string {
    const rulesToRun: Rule[] = [];
    for (const rule of rules) {
      if (this.isDisabled(rule)) {
        continue;
      } else if (rule.hasSpecialExecutionOrder || rule.type === RuleType.PASTE) {
        continue;
      } else if (rule.alias === 'auto-correct-common-misspellings' && holdsOwnCorrectionFile(runOptions)) {
        continue;
      }

      rulesToRun.push(rule);
    }

    return this.runBatches(rulesToRun, text, settings, extraOptions, (rule) => rule.type === RuleType.YAML || rulesThatMustSeeEarlierWork.includes(rule.alias));
  }

  private runBatches(rulesToRun: Rule[], text: string, settings: LinterSettings, extraOptions: Options, mustRunOnItsOwn: (rule: Rule) => boolean): string {
    let index = 0;
    while (index < rulesToRun.length) {
      const snapshot = text;
      const context = LintContext.for(snapshot);
      const batchedEdits: textReplacement[] = [];

      while (index < rulesToRun.length) {
        const rule = rulesToRun[index];

        // a disabled rule never reads the snapshot, so it does not need a batch boundary
        if (!rule.isEnabled(settings)) {
          index++;
          continue;
        }

        const runsOnItsOwn = mustRunOnItsOwn(rule);
        if (runsOnItsOwn && batchedEdits.length > 0) {
          break;
        }

        const ruleOutput = runRuleOnSnapshot(rule, snapshot, settings, extraOptions, context);
        if (ruleOutput === snapshot) {
          index++;
          continue;
        }

        if (!addEditsIfTheyDoNotClash(batchedEdits, getEditsBetween(snapshot, ruleOutput), snapshot)) {
          break;
        }

        this.changed.add(rule.alias);
        index++;

        if (runsOnItsOwn) {
          break;
        }
      }

      // a rule that clashed has not been counted as run, so it leads the next batch and gets to see
      // what the rules before it settled on
      text = replaceTextRanges(snapshot, batchedEdits);
    }

    return text;
  }

  private runAfterRegularRules(originalText: string, runOptions: RunLintOptions): string {
    const settings = runOptions.settings;
    const escapeCharacter = settings.commonStyles.escapeCharacter;
    let text = runOptions.oldText;

    text = this.apply(CapitalizeHeadings.getRule(), text, settings, {});
    text = this.apply(YamlTitle.getRule(), text, settings, {
      fileName: runOptions.fileInfo.name,
      defaultEscapeCharacter: escapeCharacter,
    });
    text = this.apply(YamlTitleAlias.getRule(), text, settings, {
      fileName: runOptions.fileInfo.name,
      aliasArrayStyle: settings.commonStyles.aliasArrayStyle,
      defaultEscapeCharacter: escapeCharacter,
      removeUnnecessaryEscapeCharsForMultiLineArrays: settings.commonStyles.removeUnnecessaryEscapeCharsForMultiLineArrays,
    });

    const cleanupRules = [BlockquoteStyle.getRule(), ForceYamlEscape.getRule(), TrailingSpaces.getRule(), ConsecutiveBlankLines.getRule()]
      .filter((rule) => !this.isDisabled(rule));
    // these adjacent cleanup rules can share a snapshot, including the front-matter-only escape
    // rule; clashes still start a fresh batch
    text = this.runBatches(cleanupRules, text, settings, { defaultEscapeCharacter: escapeCharacter }, () => false);

    const hasYaml = text.match(yamlRegex) != null;
    if (hasYaml) {
      text = this.apply(AddBlankLineAfterYAML.getRule(), text, settings, {});
    }

    const currentTime = runOptions.getCurrentTime();
    // the timestamp runs last so it can see whether anything else changed
    const [afterTimestamp, timestampRan] = this.applyWithFlag(YamlTimestamp.getRule(), text, settings, {
      fileCreatedTime: runOptions.fileInfo.createdAtFormatted,
      fileModifiedTime: runOptions.fileInfo.modifiedAtFormatted,
      currentTime,
      alreadyModified: originalText !== text,
      locale: runOptions.locale,
    });
    text = afterTimestamp;

    if (!hasYaml) {
      text = this.apply(AddBlankLineAfterYAML.getRule(), text, settings, {});
    }

    const timestampOptions = YamlTimestamp.getRule().getOptions(settings) as Record<string, unknown>;
    const sortedTime = formatForTimestamp(currentTime, String(timestampOptions.format ?? ''), runOptions.locale, timestampOptions.convertToUTC === true);

    text = this.apply(YamlKeySort.getRule(), text, settings, {
      currentTimeFormatted: sortedTime,
      yamlTimestampDateModifiedEnabled: timestampRan && timestampOptions.dateModified === true,
      dateModifiedKey: timestampOptions.dateModifiedKey,
    });

    return text;
  }

  /** The reader's own find/replace rules, last of the regular work and never inside ignored regions. */
  runCustomRegexReplacement(customRegexes: CustomReplace[], text: string): string {
    let newText = text;
    for (const each of customRegexes) {
      if (!each.enabled || each.find === '') {
        continue;
      }

      // The panel refuses these at the keystroke; a pattern that came in through a restored backup
      // never passed a panel, so it is refused here too, before anything gets a chance to hang.
      if (patternSafety(each.find)) {
        continue;
      }

      let regex: RegExp;
      try {
        regex = new RegExp(each.find, each.flags);
      } catch {
        // a broken saved pattern is skipped rather than guessed at; the panel says why
        continue;
      }

      const protectedRanges = LintContext.for(newText).protectedRangesFor([IgnoreTypes.customIgnore]);
      newText = replaceUnprotectedRegexMatches(newText, regex, convertStringVersionOfEscapeCharactersToEscapeCharacters(each.replace), protectedRanges);
    }

    return newText;
  }

  /** The paste-time rules, run over the text as it will sit in the note. */
  runPasteLint(args: { text: string, currentLine: string, selectedText: string, settings: LinterSettings }): string {
    const { settings, currentLine, selectedText } = args;
    const lineOptions = { lineContent: currentLine, selectedText };
    let text = args.text;

    text = this.apply(RemoveHyphensOnPaste.getRule(), text, settings, {});
    text = this.apply(RemoveMultipleBlankLinesOnPaste.getRule(), text, settings, {});
    text = this.apply(RemoveLeftoverFootnotesFromQuoteOnPaste.getRule(), text, settings, {});
    text = this.apply(ProperEllipsisOnPaste.getRule(), text, settings, {});
    text = this.apply(RemoveLeadingOrTrailingWhitespaceOnPaste.getRule(), text, settings, {});
    text = this.apply(PreventDoubleChecklistIndicatorOnPaste.getRule(), text, settings, lineOptions);
    text = this.apply(PreventDoubleListItemIndicatorOnPaste.getRule(), text, settings, lineOptions);
    text = this.apply(BlockquotifyOnPaste.getRule(), text, settings, { lineContent: currentLine });

    return text;
  }

  private isDisabled(rule: Rule): boolean {
    return this.disabledRules.includes(rule.alias);
  }

  private apply(rule: Rule, text: string, settings: LinterSettings, extraOptions: Options): string {
    const [result] = this.applyWithFlag(rule, text, settings, extraOptions);

    return result;
  }

  private applyWithFlag(rule: Rule, text: string, settings: LinterSettings, extraOptions: Options): [string, boolean] {
    if (this.isDisabled(rule) || !rule.isEnabled(settings)) {
      return [text, false];
    }

    const result = runRuleOnSnapshot(rule, text, settings, extraOptions, LintContext.for(text));
    if (result !== text) {
      this.changed.add(rule.alias);
    }

    return [result, true];
  }
}

/** Run one rule against the batch's snapshot and return the document it asks for. */
function runRuleOnSnapshot(rule: Rule, snapshot: string, settings: LinterSettings, extraOptions: Options, context: LintContext): string {
  const options = Object.assign({}, rule.getOptions(settings), extraOptions) as Options;

  try {
    return rule.apply(snapshot, options, context);
  } catch (error) {
    // named for the rule and keeping the original trace, because the reader is told which rule gave
    // up and a rewritten stack would hide where it happened
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new LinterError(`${rule.getName()}: ${cause.message}`, cause);
  }
}

/**
 * The timestamp rendered the way the reader's pattern wants it, so the key-sort rule can find the
 * value that was just written. UTC is applied here rather than in the pattern, the way the
 * reference plugin switched Moment into UTC before formatting.
 */
function formatForTimestamp(time: Date, pattern: string, locale: string, utc: boolean): string {
  const shown = utc ? new Date(time.getTime() + time.getTimezoneOffset() * 60_000) : time;

  return formatDatePattern(shown, pattern.trimEnd(), { locale });
}

/** A reader who keeps their own corrections in a note has that note linted without double work. */
function holdsOwnCorrectionFile(runOptions: RunLintOptions): boolean {
  const config = runOptions.settings.ruleConfigs['auto-correct-common-misspellings'] as Record<string, unknown> | undefined;
  const files = (config?.['extra_auto_correct_files'] ?? []) as CustomAutoCorrectContent[];

  return files.some((entry) => entry.filePath !== '' && entry.filePath === runOptions.fileInfo.path);
}

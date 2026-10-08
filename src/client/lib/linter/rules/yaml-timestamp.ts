import {Options, RuleType} from '../rules';
import RuleBuilder, {BooleanOptionBuilder, DropdownOptionBuilder, ExampleBuilder, MomentFormatOptionBuilder, OptionBuilderBase, TextOptionBuilder} from '../rule-builder';
import dedent from 'ts-dedent';
import {formatYAML, initYAML} from '../engine/yaml';

import {escapeDollarSigns} from '../engine/regex';
import {
  asUTC,
  detectDatePattern,
  diffSeconds,
  formatDate,
  isValidDate,
  lintDateFrom,
  withLocale,
  type LintDate,
} from '../engine/dates';
import {insert} from '../engine/strings';
import {t} from '../../i18n';
import {AfterFileChangeLintTimes} from '../settings-data';


/**
 * Read a timestamp the way the rule's settings would: in the wanted pattern when there is one, in
 * the reader's locale for names, and as a UTC wall clock when the reader asked for UTC. A value that
 * cannot be read comes back invalid rather than missing, which is what `isValidDate` is for.
 */
function readDate(value: string | number | Date | undefined, pattern: string | undefined, locale: string, utc: boolean | undefined): LintDate {
  const date = value === undefined ? null : lintDateFrom(value, { pattern: pattern ? pattern.trimEnd() : undefined, locale, utc: !!utc })

  return date === null ? { date: new Date(Number.NaN), utc: !!utc, locale } : withLocale(date, locale)
}

function renderDate(value: LintDate, pattern: string, utc: boolean | undefined): string {
  return formatDate(utc ? asUTC(value) : value, pattern)
}

type DateCreatedSourceOfTruth = 'file system' | 'frontmatter';
type DateModifiedSourceOfTruth = 'file system' | 'user or Linter edits';

class YamlTimestampOptions implements Options {
    alreadyModified?: boolean;

  dateCreatedKey: string = 'date created';
  dateCreated: boolean = true;
  dateCreatedSourceOfTruth: DateCreatedSourceOfTruth = 'file system';
  dateModifiedSourceOfTruth: DateModifiedSourceOfTruth = 'file system';
    fileCreatedTime?: string;

  format: string = 'dddd, MMMM Do YYYY, h:mm:ss a';
  dateModified: boolean = true;
  dateModifiedKey: string = 'date modified';

  convertToUTC: boolean = false;

  // This is not used in the rule itself. It is used for running this rule as a standalone when
  // editor content is updated.
  timestampUpdateOnFileContentUpdated: AfterFileChangeLintTimes =AfterFileChangeLintTimes.Never;
    fileModifiedTime?: string;
  locale: string = 'en';
    currentTime?: LintDate;
    fileName?: string;
}

export default class YamlTimestamp extends RuleBuilder<YamlTimestampOptions> {
  constructor() {
    super({
      alias: 'yaml-timestamp',
      // fields the run feeds in, so the panel must not draw a control for them
      hiddenKeys: ['alreadyModified', 'fileCreatedTime', 'fileModifiedTime', 'locale', 'currentTime', 'fileName'],      nameKey: "linter.rules.yaml_timestamp.name",
      descriptionKey: "linter.rules.yaml_timestamp.description",
      type: RuleType.YAML,
      hasSpecialExecutionOrder: true,
    });
  }
  get OptionsClass(): new () => YamlTimestampOptions {
    return YamlTimestampOptions;
  }
  apply(text: string, options: YamlTimestampOptions): string {
    let textModified = options.alreadyModified ?? false;
    const newText = initYAML(text);
    textModified = textModified || newText !== text;
    options.format = options.format.trimEnd();

    return formatYAML(newText, (text) => {
      if (options.dateCreated) {
        let newTextModified: boolean;
        [text, newTextModified] = this.handleDateCreatedValue(text, options);

        textModified = textModified || newTextModified;
      }

      if (options.dateModified) {
        text = this.handleDateModifiedValue(text, textModified, options);
      }

      return text;
    });
  }
  handleDateCreatedValue(text: string, options: YamlTimestampOptions): [string, boolean] {
    let textModified = false;
    const created_match_str = `\n${options.dateCreatedKey}: [^\n]+\n`;
    const created_key_match_str = `\n${options.dateCreatedKey}:[ \t]*\n`;
    const created_key_match = new RegExp(created_key_match_str);
    const created_match = new RegExp(created_match_str);

    const created_date = readDate(options.fileCreatedTime, undefined, options.locale, options.convertToUTC);
    const formatted_date = renderDate(created_date, options.format, options.convertToUTC);
    const created_date_line = `\n${options.dateCreatedKey}: ${formatted_date}`;

    const keyWithValueFound = created_match.test(text);
    if (!keyWithValueFound && created_key_match.test(text)) {
      text = text.replace(
          created_key_match,
          escapeDollarSigns(created_date_line) + '\n',
      );

      textModified = true;
    } else if (!keyWithValueFound) {
      const yaml_end = text.indexOf('\n---');
      text = insert(
          text,
          yaml_end,
          `\n${options.dateCreatedKey}: ${formatted_date}`,
      );

      textModified = true;
    } else if (keyWithValueFound) {
      const createdDateString = this.getYAMLTimestampString(text, created_match, options.dateCreatedKey);
      const actualFormat = detectDatePattern(createdDateString);
      if (options.dateCreatedSourceOfTruth == 'frontmatter' && options.format !== actualFormat) {
        const yamlCreatedDateTime = this.parseValueToCurrentFormatIfPossible(createdDateString, options.format, options.locale, options.convertToUTC);
        if (yamlCreatedDateTime == null) {
          throw new Error(t('linter.logs.invalid_date_format_error').replace('{DATE}', createdDateString).replace('{FILE_NAME}', options.fileName ?? ''));
        }

        const formattedYamlCreatedDate = renderDate(yamlCreatedDateTime, options.format, options.convertToUTC);

        if (formattedYamlCreatedDate !== createdDateString) {
          const created_date_yaml_line = `\n${options.dateCreatedKey}: ${formattedYamlCreatedDate}`;
          text = text.replace(
              created_match,
              escapeDollarSigns(created_date_yaml_line) + '\n',
          );

          textModified = true;
        }
      } else if (options.dateCreatedSourceOfTruth != 'frontmatter') {
        // due to how moment validation works for formats, we must check if the output string is the same for the provided value since
        // parsing when it has escaped characters in it does not result in a valid value
        // see https://github.com/platers/obsidian-linter/issues/1411
        const createdDateTime = readDate(createdDateString, options.format, options.locale, options.convertToUTC);
        // to keep backwards compatibility, we will just go ahead and say that the format output must be equal if the format is not blank
        if (!isValidDate(createdDateTime) || (options.format !== '' && formatDate(createdDateTime, options.format) != createdDateString)) {
          text = text.replace(
              created_match,
              escapeDollarSigns(created_date_line) + '\n',
          );

          textModified = true;
        }
      }
    }

    return [text, textModified];
  }
  handleDateModifiedValue(text: string, textModified: boolean, options: YamlTimestampOptions): string {
    const modified_match_str = `\n${options.dateModifiedKey}: [^\n]+\n`;
    const modified_key_match_str = `\n${options.dateModifiedKey}:[ \t]*\n`;
    const modified_key_match = new RegExp(modified_key_match_str);
    const modified_match = new RegExp(modified_match_str);

    const modified_date = readDate(options.fileModifiedTime, undefined, options.locale, options.convertToUTC);
    // using the current time helps prevent issues where the previous modified time was greater
    // than 5 seconds prior to the time the linter will finish with the file (i.e. helps prevent accidental infinite loops on updating the date modified value)
    const currentTime = options.currentTime ?? readDate(new Date(), undefined, options.locale, options.convertToUTC);
    const formatted_modified_date = renderDate(currentTime, options.format, options.convertToUTC);
    const modified_date_line = `\n${options.dateModifiedKey}: ${formatted_modified_date}`;

    const keyWithValueFound = modified_match.test(text);
    if (keyWithValueFound) {
      // due to how moment validation works for formats, we must check if the output string is the same for the provided value since
      // parsing when it has escaped characters in it does not result in a valid value
      // see https://github.com/platers/obsidian-linter/issues/1411
      const originalString = this.getYAMLTimestampString(text, modified_match, options.dateModifiedKey);
      const modifiedDateTime = readDate(originalString, options.format, options.locale, options.convertToUTC);
      // conditions when update happens for date modified if the key already exists:
      // 1. the text has been modified
      // 2. the modified date in the frontmatter is not the same locale or format as the settings
      // 3. the source of truth is not when a user or the Linter makes a change to the file and
      // there is a more than 5 second difference between the date modified in the frontmatter and
      // the filesystem
      if (textModified || !isValidDate(modifiedDateTime) || formatDate(modifiedDateTime, options.format) != originalString ||
            (options.dateModifiedSourceOfTruth != 'user or Linter edits' && this.getTimeDifferenceInSeconds(modifiedDateTime, modified_date, options) > 5)
      ) {
        text = text.replace(
            modified_match,
            escapeDollarSigns(modified_date_line) + '\n',
        );
      }
    } else if (modified_key_match.test(text)) {
      text = text.replace(
          modified_key_match,
          escapeDollarSigns(modified_date_line) + '\n',
      );
    } else if (!keyWithValueFound) {
      const yaml_end = text.indexOf('\n---');
      text = insert(text, yaml_end, modified_date_line);
    }

    return text;
  }
  parseValueToCurrentFormatIfPossible(timestamp: string, format: string, locale: string, utc: boolean): LintDate | null {
    if (timestamp == undefined) {
      return null;
    }

    const desiredFormatDate = readDate(timestamp, format, locale, utc);
    if (isValidDate(desiredFormatDate)) {
      return desiredFormatDate;
    }

    const actualFormat = detectDatePattern(timestamp);
    if (actualFormat) {
      const date = readDate(timestamp, actualFormat, locale, utc);
      if (!isValidDate(date)) {
        return null;
      }

      // re-reading through the wanted format is what makes a value written another way come back as
      // the same instant the reader's format would print
      return readDate(formatDate(date, format), format, locale, utc);
    }

    return null;
  }
  getYAMLTimestampString(text: string, matchRegex: RegExp, key: string): string {
    const match = text.match(matchRegex)?.[0] ?? '';

    return match.replace(key + ':', '').trim();
  }
  getTimeDifferenceInSeconds(modifiedDateTimeMetadata: LintDate, yamlModifiedDateTime: LintDate, options: YamlTimestampOptions): number {
    // the metadata value may not be in the correct format, so we need to convert it to the correct format
    // and then do the time comparison otherwise we get erroneously large differences in seconds
    // see https://github.com/platers/obsidian-linter/issues/568
    const formattedDateModifiedDate = readDate(formatDate(yamlModifiedDateTime, options.format), options.format, options.locale, options.convertToUTC);

    return Math.abs(diffSeconds(modifiedDateTimeMetadata, formattedDateModifiedDate));
  }
  get exampleBuilders(): ExampleBuilder<YamlTimestampOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Adds a header with the date.',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          date created: Wednesday, January 1st 2020, 12:00:00 am
          date modified: Thursday, January 2nd 2020, 12:00:05 am
          ---
          # H1
        `,
        options: {
          fileCreatedTime: '2020-01-01T00:00:00-00:00',
          fileModifiedTime: '2020-01-02T00:00:00-00:00',
          currentTime: readDate('Thursday, January 2nd 2020, 12:00:05 am', 'dddd, MMMM Do YYYY, h:mm:ss a', 'en', false),
          alreadyModified: false,
        },
      }),
      new ExampleBuilder({
        description: 'dateCreated option is false',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          date modified: Thursday, January 2nd 2020, 12:00:05 am
          ---
          # H1
        `,
        options: {
          dateCreated: false,
          fileCreatedTime: '2020-01-01T00:00:00-00:00',
          fileModifiedTime: '2020-01-01T00:00:00-00:00',
          currentTime: readDate('Thursday, January 2nd 2020, 12:00:05 am', 'dddd, MMMM Do YYYY, h:mm:ss a', 'en', false),
          alreadyModified: false,
        },
      }),
      new ExampleBuilder({
        description: 'Date created key is set',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          created: Wednesday, January 1st 2020, 12:00:00 am
          ---
          # H1
        `,
        options: {
          dateCreated: true,
          dateModified: false,
          dateCreatedKey: 'created',
          fileCreatedTime: '2020-01-01T00:00:00-00:00',
          currentTime: readDate('Thursday, January 2nd 2020, 12:00:03 am', 'dddd, MMMM Do YYYY, h:mm:ss a', 'en', false),
          alreadyModified: false,
        },
      }),
      new ExampleBuilder({
        description: 'Date modified key is set',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          modified: Wednesday, January 1st 2020, 4:00:00 pm
          ---
          # H1
        `,
        options: {
          dateCreated: false,
          dateModified: true,
          dateModifiedKey: 'modified',
          fileModifiedTime: '2020-01-01T00:00:00-00:00',
          currentTime: readDate('Wednesday, January 1st 2020, 4:00:00 pm', 'dddd, MMMM Do YYYY, h:mm:ss a', 'en', false),
          alreadyModified: false,
        },
      }),
      new ExampleBuilder({
        description: 'Header is set with convert to UTC option true',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          date created: 2020-01-01T14:00:00+00:00
          date modified: 2020-01-02T02:00:05+00:00
          ---
          # H1
        `,
        options: {
          format: 'YYYY-MM-DDTHH:mm:ssZ',
          fileCreatedTime: '2020-01-01T09:00:00-05:00', // 9 AM Eastern Standard Time
          fileModifiedTime: '2020-01-01T21:00:00-05:00', // 9 PM Eastern Standard Time, same day
          currentTime: readDate('2020-01-01T21:00:05-05:00', 'YYYY-MM-DDTHH:mm:ssZ', 'en', false), // 9:00:05 PM EST, same day
          alreadyModified: false,
          convertToUTC: true,
        },
      }),
      new ExampleBuilder({
        description: 'dateCreated option is false with convert to UTC option true',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          date modified: 2020-01-02T02:00:05+00:00
          ---
          # H1
        `,
        options: {
          format: 'YYYY-MM-DDTHH:mm:ssZ',
          dateCreated: false,
          fileCreatedTime: '2020-01-01T09:00:00-05:00', // 9 AM Eastern Standard Time
          fileModifiedTime: '2020-01-01T21:00:00-05:00', // 9 PM Eastern Standard Time, same day
          currentTime: readDate('2020-01-01T21:00:05-05:00', 'YYYY-MM-DDTHH:mm:ssZ', 'en', false), // 9:00:05 PM EST, same day
          alreadyModified: false,
          convertToUTC: true,
        },
      }),
      new ExampleBuilder({
        description: 'Date created key is set with convert to UTC option true',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          created: 2020-01-01T14:00:00+00:00
          ---
          # H1
        `,
        options: {
          format: 'YYYY-MM-DDTHH:mm:ssZ',
          dateCreated: true,
          dateModified: false,
          dateCreatedKey: 'created',
          fileCreatedTime: '2020-01-01T09:00:00-05:00', // 9 AM Eastern Standard Time
          currentTime: readDate('2020-01-01T21:00:05-05:00', 'YYYY-MM-DDTHH:mm:ssZ', 'en', false), // 9:00:05 PM EST, same day
          alreadyModified: false,
          convertToUTC: true,
        },
      }),
      new ExampleBuilder({
        description: 'Date modified key is set with convert to UTC option true',
        before: dedent`
          # H1
        `,
        after: dedent`
          ---
          modified: 2020-01-02T02:00:05+00:00
          ---
          # H1
        `,
        options: {
          format: 'YYYY-MM-DDTHH:mm:ssZ',
          dateCreated: false,
          dateModified: true,
          dateModifiedKey: 'modified',
          fileModifiedTime: '2020-01-01T21:00:00-05:00', // 9 PM Eastern Standard Time, same day
          currentTime: readDate('2020-01-01T21:00:05-05:00', 'YYYY-MM-DDTHH:mm:ssZ', 'en', false), // 9:00:05 PM EST, same day
          alreadyModified: false,
          convertToUTC: true,
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<YamlTimestampOptions>[] {
    return [
      new BooleanOptionBuilder({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.date_created.name",
        descriptionKey: "linter.rules.yaml_timestamp.date_created.description",
        optionsKey: 'dateCreated',
      }),
      new TextOptionBuilder({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.date_created_key.name",
        descriptionKey: "linter.rules.yaml_timestamp.date_created_key.description",
        optionsKey: 'dateCreatedKey',
      }),
      new DropdownOptionBuilder<YamlTimestampOptions, DateCreatedSourceOfTruth>({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.date_created_source_of_truth.name",
        descriptionKey: "linter.rules.yaml_timestamp.date_created_source_of_truth.description",
        optionsKey: 'dateCreatedSourceOfTruth',
        records: [
          {
            value: 'file system',
            description: 'The file system date created value is used to set the value of date created in the frontmatter',
          },
          {
            value: 'frontmatter',
            description: 'When a value is present in the frontmatter for date created, this value is used as the value for the date created',
          },
        ],
      }),
      new BooleanOptionBuilder({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.date_modified.name",
        descriptionKey: "linter.rules.yaml_timestamp.date_modified.description",
        optionsKey: 'dateModified',
      }),
      new TextOptionBuilder({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.date_modified_key.name",
        descriptionKey: "linter.rules.yaml_timestamp.date_modified_key.description",
        optionsKey: 'dateModifiedKey',
      }),
      new DropdownOptionBuilder<YamlTimestampOptions, DateModifiedSourceOfTruth>({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.date_modified_source_of_truth.name",
        descriptionKey: "linter.rules.yaml_timestamp.date_modified_source_of_truth.description",
        optionsKey: 'dateModifiedSourceOfTruth',
        records: [
          {
            value: 'file system',
            description: 'The file system date modified value is used to set the value of date modified in the frontmatter',
          },
          {
            value: 'user or Linter edits',
            description: 'When a value is present in the frontmatter for date modified, date modified is kept as is unless the Linter makes a change to a note or the user edits a note with the setting `{NAME}` set to something other than `{NEVER}`.'.replace('{NAME}', t("linter.rules.yaml_timestamp.update_on_file_contents_updated.name")).replace('{NEVER}', t("linter.enums.never")),
          },
        ],
      }),
      new MomentFormatOptionBuilder({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.format.name",
        descriptionKey: "linter.rules.yaml_timestamp.format.description",
        optionsKey: 'format',
      }),
      new BooleanOptionBuilder({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.convert_to_utc.name",
        descriptionKey: "linter.rules.yaml_timestamp.convert_to_utc.description",
        optionsKey: 'convertToUTC',
      }),
      new DropdownOptionBuilder<YamlTimestampOptions, AfterFileChangeLintTimes>({
        OptionsClass: YamlTimestampOptions,
        nameKey: "linter.rules.yaml_timestamp.update_on_file_contents_updated.name",
        descriptionKey: "linter.rules.yaml_timestamp.update_on_file_contents_updated.description",
        optionsKey: 'timestampUpdateOnFileContentUpdated',
        records: [
          {
            value: AfterFileChangeLintTimes.Never,
            description: AfterFileChangeLintTimes.Never,
          },
          {
            value: AfterFileChangeLintTimes.After5Seconds,
            description: AfterFileChangeLintTimes.After5Seconds,
          },
          {
            value: AfterFileChangeLintTimes.After10Seconds,
            description: AfterFileChangeLintTimes.After10Seconds,
          },
          {
            value: AfterFileChangeLintTimes.After15Seconds,
            description: AfterFileChangeLintTimes.After15Seconds,
          },
          {
            value: AfterFileChangeLintTimes.After30Seconds,
            description: AfterFileChangeLintTimes.After30Seconds,
          },
          {
            value: AfterFileChangeLintTimes.After1Minute,
            description: AfterFileChangeLintTimes.After1Minute,
          },
        ],
      }),
    ];
  }
}

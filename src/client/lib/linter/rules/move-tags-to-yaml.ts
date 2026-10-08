import {Options, RuleType} from '../rules';
import RuleBuilder, {DropdownOptionBuilder, ExampleBuilder, OptionBuilderBase, ListItemOptionBuilder} from '../rule-builder';
import dedent from 'ts-dedent';
import {IgnoreTypes} from '../engine/ignore-types';
import {tagWithLeadingWhitespaceRegex} from '../engine/regex';
import {ProtectedRanges} from '../engine/protected-ranges';
import {textReplacement} from '../engine/strings';
import {applyNonOverlappingReplacements, getEditsBetween} from '../engine/text-edits';
import {
  convertTagValueToStringOrStringArray,
  getYamlSectionValue,
  setYamlSection,
  splitValueIfSingleOrMultilineArray,
  formatYamlArrayValue,
  initYAML,
  formatYAML,
  OBSIDIAN_TAG_KEYS,
  NormalArrayFormats,
  SpecialArrayFormats,
  TagSpecificArrayFormats,
  OBSIDIAN_TAG_KEY_PLURAL,
  QuoteCharacter,
} from '../engine/yaml';
import { isValidTag } from '../engine/validation';

type tagOperations = 'Nothing' | 'Remove hashtag' | 'Remove whole tag';

class MoveTagsToYamlOptions implements Options {
    tagArrayStyle : TagSpecificArrayFormats | NormalArrayFormats | SpecialArrayFormats = NormalArrayFormats.SingleLine;
  howToHandleExistingTags: tagOperations = 'Nothing';
  tagsToIgnore: string[] = [];
  defaultEscapeCharacter: QuoteCharacter = '"';
  removeUnnecessaryEscapeCharsForMultiLineArrays: boolean = false;
}

export default class MoveTagsToYaml extends RuleBuilder<MoveTagsToYamlOptions> {
  constructor() {
    super({
      alias: 'move-tags-to-yaml',
      // fields the run feeds in, so the panel must not draw a control for them
      hiddenKeys: ['tagArrayStyle', 'defaultEscapeCharacter', 'removeUnnecessaryEscapeCharsForMultiLineArrays'],      nameKey: "linter.rules.move_tags_to_yaml.name",
      descriptionKey: "linter.rules.move_tags_to_yaml.description",
      type: RuleType.YAML,
      ruleIgnoreTypes: [IgnoreTypes.code, IgnoreTypes.inlineCode, IgnoreTypes.math, IgnoreTypes.html, IgnoreTypes.wikiLink, IgnoreTypes.link],
    });
  }
  get OptionsClass(): new () => MoveTagsToYamlOptions {
    return MoveTagsToYamlOptions;
  }
  apply(text: string, options: MoveTagsToYamlOptions, protectedRanges: ProtectedRanges): string {
    const projection = protectedRanges.projection();
    const bodyProjection = protectedRanges.combinedWith([IgnoreTypes.yaml]).projection();
    // need to ignore YAML when getting regex matches to avoid improper matches with YAML contents
    // https://github.com/platers/obsidian-linter/issues/661
    const tagMatches = [...bodyProjection.text.matchAll(tagWithLeadingWhitespaceRegex)].filter((match) => {
      return bodyProjection.editRangeToSource({startIndex: match.index, endIndex: match.index + match[0].length}) !== undefined;
    });
    const tags = tagMatches.map((match) => match[2]);

    if (tags.length === 0) {
      return text;
    }

    text = initYAML(projection.text);
    text = formatYAML(text, (text: string) => {
      text = text.replace('---\n', '').replace('---', '');

      let tagValue: string[] = [];
      let existingTagKey = OBSIDIAN_TAG_KEY_PLURAL;

      for (const tagKey of OBSIDIAN_TAG_KEYS) {
        const tempTagValue = getYamlSectionValue(text, tagKey);
        if (tempTagValue != null) {
          tagValue = convertTagValueToStringOrStringArray(splitValueIfSingleOrMultilineArray(tempTagValue) ?? []);
          existingTagKey = tagKey;

          break;
        }
      }

      const existingTags = new Set<string>();
      if (typeof tagValue === 'string') {
        existingTags.add(tagValue);
        tagValue = [tagValue];
      } else if (tagValue != undefined) {
        for (const tag of tagValue) {
          existingTags.add(tag);
        }
      } else {
        tagValue = [];
      }

      for (const tag of tags) {
        const tagContent = tag.trim().substring(1);
        if (!existingTags.has(tagContent) && !options.tagsToIgnore.includes(tagContent)) {
          existingTags.add(tagContent);
          tagValue.push(tagContent);
        }
      }

      const newYaml = setYamlSection(text, existingTagKey, formatYamlArrayValue(tagValue, options.tagArrayStyle, options.defaultEscapeCharacter, options.removeUnnecessaryEscapeCharsForMultiLineArrays));

      return `---\n${newYaml}---`;
    });

    const removals: textReplacement[] = [];
    const yamlLengthChange = text.length - projection.text.length;
    if (options.howToHandleExistingTags !== 'Nothing') {
      for (const match of tagMatches) {
        if (options.tagsToIgnore.includes(match[2].substring(1))) {
          continue;
        }
        const sourceRange = bodyProjection.editRangeToSource({startIndex: match.index, endIndex: match.index + match[0].length});
        if (!sourceRange) {
          continue;
        }

        const projectedStart = projection.sourceToProjection(sourceRange.startIndex)
        const projectedEnd = projection.sourceToProjection(sourceRange.endIndex)
        if (projectedStart === undefined || projectedEnd === undefined) {
          continue;
        }

        let startIndex = projectedStart + yamlLengthChange;
        const endIndex = projectedEnd + yamlLengthChange;
        if (options.howToHandleExistingTags === 'Remove hashtag') {
          startIndex += match[1].length;
          removals.push({startIndex, endIndex: startIndex + 1, value: ''});
        } else {
          // A newly inserted frontmatter supplies the leading newline for a tag at offset zero.
          if (match.index === 0 && match[1] === '' && yamlLengthChange > 0) {
            startIndex--;
          }
          removals.push({startIndex, endIndex, value: ''});
        }
      }
    }
    text = applyNonOverlappingReplacements(text, removals);

    // Make sure that the YAML frontmatter does not have whitespace added after the end of the YAML frontmatter.
    // This accounts for https://github.com/platers/obsidian-linter/issues/573
    text = text.replace(/(\n---)( |\t)+/, '$1');

    const replacements: textReplacement[] = [];
    for (const edit of getEditsBetween(projection.text, text)) {
      const range = projection.editRangeToSource(edit);
      if (range) {
        replacements.push({...range, value: edit.value});
      }
    }
    return applyNonOverlappingReplacements(projection.source, replacements);
  }
  get exampleBuilders(): ExampleBuilder<MoveTagsToYamlOptions>[] {
    return [
      new ExampleBuilder({
        description: 'Move tags from body to YAML with `Tags to ignore = \'ignored-tag\'`',
        before: dedent`
          Text has to do with #test and #markdown
          ${''}
          #test content here
          \`\`\`
          #ignored
          Code block content is ignored
          \`\`\`
          ${''}
          This inline code \`#ignored content\`
          ${''}
          #ignored-tag is ignored since it is in the ignored list
        `,
        after: dedent`
          ---
          tags: [test, markdown]
          ---
          Text has to do with #test and #markdown
          ${''}
          #test content here
          \`\`\`
          #ignored
          Code block content is ignored
          \`\`\`
          ${''}
          This inline code \`#ignored content\`
          ${''}
          #ignored-tag is ignored since it is in the ignored list
        `,
        options: {
          tagsToIgnore: ['ignored-tag'],
        },
      }),
      new ExampleBuilder({
        description: 'Move tags from body to YAML with existing tags retains the already existing ones and only adds new ones',
        before: dedent`
          ---
          tags: [test, tag2]
          ---
          Text has to do with #test and #markdown
        `,
        after: dedent`
          ---
          tags: [test, tag2, markdown]
          ---
          Text has to do with #test and #markdown
        `,
      }),
      new ExampleBuilder({
        description: 'Move tags to YAML frontmatter and then remove hashtags in body content tags when `Body tag operation = \'Remove hashtag\'` and `Tags to ignore = \'yet-another-ignored-tag\'`.',
        before: dedent`
          ---
          tags: [test, tag2]
          ---
          Text has to do with #test and #markdown
          ${''}
          The tag at the end of this line stays as a tag since it is ignored #yet-another-ignored-tag
        `,
        after: dedent`
          ---
          tags: [test, tag2, markdown]
          ---
          Text has to do with test and markdown
          ${''}
          The tag at the end of this line stays as a tag since it is ignored #yet-another-ignored-tag
        `,
        options: {
          howToHandleExistingTags: 'Remove hashtag',
          tagsToIgnore: ['yet-another-ignored-tag'],
        },
      }),
      new ExampleBuilder({
        description: 'Move tags to YAML frontmatter and then remove body content tags when `Body tag operation = \'Remove whole tag\'`.',
        before: dedent`
          ---
          tags: [test, tag2]
          ---
          This document will have #tags removed and spacing around tags is left alone except for the space prior to the hashtag #warning
        `,
        after: dedent`
          ---
          tags: [test, tag2, tags, warning]
          ---
          This document will have removed and spacing around tags is left alone except for the space prior to the hashtag
        `,
        options: {
          howToHandleExistingTags: 'Remove whole tag',
        },
      }),
    ];
  }
  get optionBuilders(): OptionBuilderBase<MoveTagsToYamlOptions>[] {
    return [
      new DropdownOptionBuilder({
        OptionsClass: MoveTagsToYamlOptions,
        nameKey: "linter.rules.move_tags_to_yaml.how_to_handle_existing_tags.name",
        descriptionKey: "linter.rules.move_tags_to_yaml.how_to_handle_existing_tags.description",
        optionsKey: 'howToHandleExistingTags',
        records: [
          {
            value: 'Nothing',
            description: 'Leaves tags in the body of the file alone',
          },
          {
            value: 'Remove hashtag',
            description: 'Removes `#` from tags in content body after moving them to the YAML frontmatter',
          },
          {
            value: 'Remove whole tag',
            description: 'Removes the whole tag in content body after moving them to the YAML frontmatter. _Note that this removes the first space prior to the tag as well_',
          },
        ],
      }),
      new ListItemOptionBuilder({
        OptionsClass: MoveTagsToYamlOptions,
        nameKey: "linter.rules.move_tags_to_yaml.tags_to_ignore.name",
        descriptionKey: "linter.rules.move_tags_to_yaml.tags_to_ignore.description",
         emptyStateKey: "linter.rules.move_tags_to_yaml.tags_to_ignore.empty_state",
        fieldNamePlaceholderKey: "linter.rules.move_tags_to_yaml.tags_to_ignore.placeholder_text",
        optionsKey: 'tagsToIgnore',
        validator: isValidTag,
      }),
    ];
  }
}

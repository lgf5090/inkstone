/**
 * The rule list, as plain data.
 *
 * The settings panel reads the real rules through a dynamic import, but the settings search index
 * has to know every row's title before anything is loaded — so this file names each rule and the
 * options it can show, without pulling in a single rule body. It mirrors the rule aliases the
 * reference plugin uses, which are also the spellings a note's disabled-rules front matter names.
 */
import type { MessageKey } from '../i18n'

export type LinterRuleSearchEntry = {
  alias: string,
  /** The rule's family, as the engine spells it; `Paste` is the one the editor's paste handler asks about. */
  ruleType: string,
  nameKey: MessageKey,
  descriptionKey: MessageKey,
  optionNameKeys: MessageKey[],
}

export const LINTER_RULE_SEARCH_ENTRIES: LinterRuleSearchEntry[] = [
  {
    alias: 'add-blank-line-after-yaml',
    ruleType: 'YAML',
    nameKey: 'linter.rules.add_blank_line_after_yaml.name',
    descriptionKey: 'linter.rules.add_blank_line_after_yaml.description',
    optionNameKeys: [],
  },
  {
    alias: 'add-blockquote-indentation-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.add_blockquote_indentation_on_paste.name',
    descriptionKey: 'linter.rules.add_blockquote_indentation_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'align-table-columns',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.align_table_columns.name',
    descriptionKey: 'linter.rules.align_table_columns.description',
    optionNameKeys: [],
  },
  {
    alias: 'auto-correct-common-misspellings',
    ruleType: 'Content',
    nameKey: 'linter.rules.auto_correct_common_misspellings.name',
    descriptionKey: 'linter.rules.auto_correct_common_misspellings.description',
    optionNameKeys: [
      'linter.rules.auto_correct_common_misspellings.extra_auto_correct_files.name',
      'linter.rules.auto_correct_common_misspellings.ignore_words.name',
      'linter.rules.auto_correct_common_misspellings.skip_words_with_multiple_capitals.name',
    ],
  },
  {
    alias: 'blockquote-style',
    ruleType: 'Content',
    nameKey: 'linter.rules.blockquote_style.name',
    descriptionKey: 'linter.rules.blockquote_style.description',
    optionNameKeys: [
      'linter.rules.blockquote_style.style.name',
    ],
  },
  {
    alias: 'capitalize-headings',
    ruleType: 'Heading',
    nameKey: 'linter.rules.capitalize_headings.name',
    descriptionKey: 'linter.rules.capitalize_headings.description',
    optionNameKeys: [
      'linter.rules.capitalize_headings.ending_word_ignore_characters.name',
      'linter.rules.capitalize_headings.ignore_case_words.name',
      'linter.rules.capitalize_headings.ignore_words.name',
      'linter.rules.capitalize_headings.lowercase_words.name',
      'linter.rules.capitalize_headings.starting_word_ignore_characters.name',
      'linter.rules.capitalize_headings.style.name',
    ],
  },
  {
    alias: 'compact-yaml',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.compact_yaml.name',
    descriptionKey: 'linter.rules.compact_yaml.description',
    optionNameKeys: [
      'linter.rules.compact_yaml.inner_new_lines.name',
    ],
  },
  {
    alias: 'consecutive-blank-lines',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.consecutive_blank_lines.name',
    descriptionKey: 'linter.rules.consecutive_blank_lines.description',
    optionNameKeys: [],
  },
  {
    alias: 'convert-bullet-list-markers',
    ruleType: 'Content',
    nameKey: 'linter.rules.convert_bullet_list_markers.name',
    descriptionKey: 'linter.rules.convert_bullet_list_markers.description',
    optionNameKeys: [],
  },
  {
    alias: 'convert-spaces-to-tabs',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.convert_spaces_to_tabs.name',
    descriptionKey: 'linter.rules.convert_spaces_to_tabs.description',
    optionNameKeys: [
      'linter.rules.convert_spaces_to_tabs.tabsize.name',
    ],
  },
  {
    alias: 'dedupe-yaml-array-values',
    ruleType: 'YAML',
    nameKey: 'linter.rules.dedupe_yaml_array_values.name',
    descriptionKey: 'linter.rules.dedupe_yaml_array_values.description',
    optionNameKeys: [
      'linter.rules.dedupe_yaml_array_values.dedupe_alias_key.name',
      'linter.rules.dedupe_yaml_array_values.dedupe_array_keys.name',
      'linter.rules.dedupe_yaml_array_values.dedupe_tag_key.name',
      'linter.rules.dedupe_yaml_array_values.ignore_keys.name',
    ],
  },
  {
    alias: 'default-language-for-code-fences',
    ruleType: 'Content',
    nameKey: 'linter.rules.default_language_for_code_fences.name',
    descriptionKey: 'linter.rules.default_language_for_code_fences.description',
    optionNameKeys: [
      'linter.rules.default_language_for_code_fences.default_language.name',
    ],
  },
  {
    alias: 'emphasis-style',
    ruleType: 'Content',
    nameKey: 'linter.rules.emphasis_style.name',
    descriptionKey: 'linter.rules.emphasis_style.description',
    optionNameKeys: [
      'linter.rules.emphasis_style.style.name',
    ],
  },
  {
    alias: 'empty-line-around-blockquotes',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.empty_line_around_blockquotes.name',
    descriptionKey: 'linter.rules.empty_line_around_blockquotes.description',
    optionNameKeys: [],
  },
  {
    alias: 'empty-line-around-code-fences',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.empty_line_around_code_fences.name',
    descriptionKey: 'linter.rules.empty_line_around_code_fences.description',
    optionNameKeys: [],
  },
  {
    alias: 'empty-line-around-horizontal-rules',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.empty_line_around_horizontal_rules.name',
    descriptionKey: 'linter.rules.empty_line_around_horizontal_rules.description',
    optionNameKeys: [],
  },
  {
    alias: 'empty-line-around-math-blocks',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.empty_line_around_math_blocks.name',
    descriptionKey: 'linter.rules.empty_line_around_math_blocks.description',
    optionNameKeys: [],
  },
  {
    alias: 'empty-line-around-tables',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.empty_line_around_tables.name',
    descriptionKey: 'linter.rules.empty_line_around_tables.description',
    optionNameKeys: [],
  },
  {
    alias: 'escape-yaml-special-characters',
    ruleType: 'YAML',
    nameKey: 'linter.rules.escape_yaml_special_characters.name',
    descriptionKey: 'linter.rules.escape_yaml_special_characters.description',
    optionNameKeys: [
      'linter.rules.escape_yaml_special_characters.try_to_escape_single_line_arrays.name',
    ],
  },
  {
    alias: 'file-name-heading',
    ruleType: 'Heading',
    nameKey: 'linter.rules.file_name_heading.name',
    descriptionKey: 'linter.rules.file_name_heading.description',
    optionNameKeys: [],
  },
  {
    alias: 'footnote-after-punctuation',
    ruleType: 'Footnote',
    nameKey: 'linter.rules.footnote_after_punctuation.name',
    descriptionKey: 'linter.rules.footnote_after_punctuation.description',
    optionNameKeys: [],
  },
  {
    alias: 'force-yaml-escape',
    ruleType: 'YAML',
    nameKey: 'linter.rules.force_yaml_escape.name',
    descriptionKey: 'linter.rules.force_yaml_escape.description',
    optionNameKeys: [
      'linter.rules.force_yaml_escape.force_yaml_escape_keys.name',
    ],
  },
  {
    alias: 'format-tags-in-yaml',
    ruleType: 'YAML',
    nameKey: 'linter.rules.format_tags_in_yaml.name',
    descriptionKey: 'linter.rules.format_tags_in_yaml.description',
    optionNameKeys: [],
  },
  {
    alias: 'format-yaml-array',
    ruleType: 'YAML',
    nameKey: 'linter.rules.format_yaml_array.name',
    descriptionKey: 'linter.rules.format_yaml_array.description',
    optionNameKeys: [
      'linter.rules.format_yaml_array.alias_key.name',
      'linter.rules.format_yaml_array.default_array_keys.name',
      'linter.rules.format_yaml_array.force_multi_line_array_style.name',
      'linter.rules.format_yaml_array.force_single_line_array_style.name',
      'linter.rules.format_yaml_array.tag_key.name',
    ],
  },
  {
    alias: 'header-increment',
    ruleType: 'Heading',
    nameKey: 'linter.rules.header_increment.name',
    descriptionKey: 'linter.rules.header_increment.description',
    optionNameKeys: [
      'linter.rules.header_increment.start_at_h2.name',
    ],
  },
  {
    alias: 'heading-blank-lines',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.heading_blank_lines.name',
    descriptionKey: 'linter.rules.heading_blank_lines.description',
    optionNameKeys: [
      'linter.rules.heading_blank_lines.bottom.name',
      'linter.rules.heading_blank_lines.empty_line_after_yaml.name',
    ],
  },
  {
    alias: 'headings-start-line',
    ruleType: 'Heading',
    nameKey: 'linter.rules.headings_start_line.name',
    descriptionKey: 'linter.rules.headings_start_line.description',
    optionNameKeys: [],
  },
  {
    alias: 'insert-yaml-attributes',
    ruleType: 'YAML',
    nameKey: 'linter.rules.insert_yaml_attributes.name',
    descriptionKey: 'linter.rules.insert_yaml_attributes.description',
    optionNameKeys: [
      'linter.rules.insert_yaml_attributes.text_to_insert.name',
    ],
  },
  {
    alias: 'line-break-at-document-end',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.line_break_at_document_end.name',
    descriptionKey: 'linter.rules.line_break_at_document_end.description',
    optionNameKeys: [],
  },
  {
    alias: 'move-footnotes-to-the-bottom',
    ruleType: 'Footnote',
    nameKey: 'linter.rules.move_footnotes_to_the_bottom.name',
    descriptionKey: 'linter.rules.move_footnotes_to_the_bottom.description',
    optionNameKeys: [
      'linter.rules.move_footnotes_to_the_bottom.include_blank_line_between_footnotes.name',
    ],
  },
  {
    alias: 'move-inline-fields-to-yaml',
    ruleType: 'YAML',
    nameKey: 'linter.rules.move_inline_fields_to_yaml.name',
    descriptionKey: 'linter.rules.move_inline_fields_to_yaml.description',
    optionNameKeys: [
      'linter.rules.move_inline_fields_to_yaml.how_to_handle_bracketed_fields.name',
      'linter.rules.move_inline_fields_to_yaml.how_to_handle_existing_keys.name',
      'linter.rules.move_inline_fields_to_yaml.how_to_handle_full_line_fields.name',
      'linter.rules.move_inline_fields_to_yaml.inline_keys_to_ignore.name',
    ],
  },
  {
    alias: 'move-math-block-indicators-to-their-own-line',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.move_math_block_indicators_to_their_own_line.name',
    descriptionKey: 'linter.rules.move_math_block_indicators_to_their_own_line.description',
    optionNameKeys: [],
  },
  {
    alias: 'move-tags-to-yaml',
    ruleType: 'YAML',
    nameKey: 'linter.rules.move_tags_to_yaml.name',
    descriptionKey: 'linter.rules.move_tags_to_yaml.description',
    optionNameKeys: [
      'linter.rules.move_tags_to_yaml.how_to_handle_existing_tags.name',
      'linter.rules.move_tags_to_yaml.tags_to_ignore.name',
    ],
  },
  {
    alias: 'no-bare-urls',
    ruleType: 'Content',
    nameKey: 'linter.rules.no_bare_urls.name',
    descriptionKey: 'linter.rules.no_bare_urls.description',
    optionNameKeys: [
      'linter.rules.no_bare_urls.no_bare_uris.name',
    ],
  },
  {
    alias: 'ordered-list-style',
    ruleType: 'Content',
    nameKey: 'linter.rules.ordered_list_style.name',
    descriptionKey: 'linter.rules.ordered_list_style.description',
    optionNameKeys: [
      'linter.rules.ordered_list_style.list_end_style.name',
      'linter.rules.ordered_list_style.number_style.name',
      'linter.rules.ordered_list_style.preserve_start.name',
    ],
  },
  {
    alias: 'paragraph-blank-lines',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.paragraph_blank_lines.name',
    descriptionKey: 'linter.rules.paragraph_blank_lines.description',
    optionNameKeys: [],
  },
  {
    alias: 'prevent-double-checklist-indicator-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.prevent_double_checklist_indicator_on_paste.name',
    descriptionKey: 'linter.rules.prevent_double_checklist_indicator_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'prevent-double-list-item-indicator-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.prevent_double_list_item_indicator_on_paste.name',
    descriptionKey: 'linter.rules.prevent_double_list_item_indicator_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'proper-ellipsis',
    ruleType: 'Content',
    nameKey: 'linter.rules.proper_ellipsis.name',
    descriptionKey: 'linter.rules.proper_ellipsis.description',
    optionNameKeys: [],
  },
  {
    alias: 'proper-ellipsis-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.proper_ellipsis_on_paste.name',
    descriptionKey: 'linter.rules.proper_ellipsis_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'quote-style',
    ruleType: 'Content',
    nameKey: 'linter.rules.quote_style.name',
    descriptionKey: 'linter.rules.quote_style.description',
    optionNameKeys: [
      'linter.rules.quote_style.double_quote_enabled.name',
      'linter.rules.quote_style.double_quote_style.name',
      'linter.rules.quote_style.single_quote_enabled.name',
      'linter.rules.quote_style.single_quote_style.name',
    ],
  },
  {
    alias: 're-index-footnotes',
    ruleType: 'Footnote',
    nameKey: 'linter.rules.re_index_footnotes.name',
    descriptionKey: 'linter.rules.re_index_footnotes.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-consecutive-list-markers',
    ruleType: 'Content',
    nameKey: 'linter.rules.remove_consecutive_list_markers.name',
    descriptionKey: 'linter.rules.remove_consecutive_list_markers.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-empty-lines-between-list-markers-and-checklists',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.remove_empty_lines_between_list_markers_and_checklists.name',
    descriptionKey: 'linter.rules.remove_empty_lines_between_list_markers_and_checklists.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-empty-list-markers',
    ruleType: 'Content',
    nameKey: 'linter.rules.remove_empty_list_markers.name',
    descriptionKey: 'linter.rules.remove_empty_list_markers.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-hyphenated-line-breaks',
    ruleType: 'Content',
    nameKey: 'linter.rules.remove_hyphenated_line_breaks.name',
    descriptionKey: 'linter.rules.remove_hyphenated_line_breaks.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-hyphens-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.remove_hyphens_on_paste.name',
    descriptionKey: 'linter.rules.remove_hyphens_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-leading-or-trailing-whitespace-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.remove_leading_or_trailing_whitespace_on_paste.name',
    descriptionKey: 'linter.rules.remove_leading_or_trailing_whitespace_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-leftover-footnotes-from-quote-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.remove_leftover_footnotes_from_quote_on_paste.name',
    descriptionKey: 'linter.rules.remove_leftover_footnotes_from_quote_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-link-spacing',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.remove_link_spacing.name',
    descriptionKey: 'linter.rules.remove_link_spacing.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-multiple-blank-lines-on-paste',
    ruleType: 'Paste',
    nameKey: 'linter.rules.remove_multiple_blank_lines_on_paste.name',
    descriptionKey: 'linter.rules.remove_multiple_blank_lines_on_paste.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-multiple-spaces',
    ruleType: 'Content',
    nameKey: 'linter.rules.remove_multiple_spaces.name',
    descriptionKey: 'linter.rules.remove_multiple_spaces.description',
    optionNameKeys: [],
  },
  {
    alias: 'remove-space-around-characters',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.remove_space_around_characters.name',
    descriptionKey: 'linter.rules.remove_space_around_characters.description',
    optionNameKeys: [
      'linter.rules.remove_space_around_characters.include_cjk_symbols_and_punctuation.name',
      'linter.rules.remove_space_around_characters.include_dashes.name',
      'linter.rules.remove_space_around_characters.include_fullwidth_forms.name',
      'linter.rules.remove_space_around_characters.other_symbols.name',
    ],
  },
  {
    alias: 'remove-space-before-or-after-characters',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.remove_space_before_or_after_characters.name',
    descriptionKey: 'linter.rules.remove_space_before_or_after_characters.description',
    optionNameKeys: [
      'linter.rules.remove_space_before_or_after_characters.characters_to_remove_space_after.name',
      'linter.rules.remove_space_before_or_after_characters.characters_to_remove_space_before.name',
    ],
  },
  {
    alias: 'remove-trailing-punctuation-in-heading',
    ruleType: 'Heading',
    nameKey: 'linter.rules.remove_trailing_punctuation_in_heading.name',
    descriptionKey: 'linter.rules.remove_trailing_punctuation_in_heading.description',
    optionNameKeys: [
      'linter.rules.remove_trailing_punctuation_in_heading.punctuation_to_remove.name',
    ],
  },
  {
    alias: 'remove-yaml-keys',
    ruleType: 'YAML',
    nameKey: 'linter.rules.remove_yaml_keys.name',
    descriptionKey: 'linter.rules.remove_yaml_keys.description',
    optionNameKeys: [
      'linter.rules.remove_yaml_keys.yaml_keys_to_remove.name',
    ],
  },
  {
    alias: 'sort-yaml-array-values',
    ruleType: 'YAML',
    nameKey: 'linter.rules.sort_yaml_array_values.name',
    descriptionKey: 'linter.rules.sort_yaml_array_values.description',
    optionNameKeys: [
      'linter.rules.sort_yaml_array_values.ignore_keys.name',
      'linter.rules.sort_yaml_array_values.sort_alias_key.name',
      'linter.rules.sort_yaml_array_values.sort_array_keys.name',
      'linter.rules.sort_yaml_array_values.sort_order.name',
      'linter.rules.sort_yaml_array_values.sort_tag_key.name',
    ],
  },
  {
    alias: 'space-after-list-markers',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.space_after_list_markers.name',
    descriptionKey: 'linter.rules.space_after_list_markers.description',
    optionNameKeys: [],
  },
  {
    alias: 'space-between-chinese-japanese-or-korean-and-english-or-numbers',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.space_between_chinese_japanese_or_korean_and_english_or_numbers.name',
    descriptionKey: 'linter.rules.space_between_chinese_japanese_or_korean_and_english_or_numbers.description',
    optionNameKeys: [
      'linter.rules.space_between_chinese_japanese_or_korean_and_english_or_numbers.english_symbols_punctuation_after.name',
      'linter.rules.space_between_chinese_japanese_or_korean_and_english_or_numbers.english_symbols_punctuation_before.name',
    ],
  },
  {
    alias: 'strong-style',
    ruleType: 'Content',
    nameKey: 'linter.rules.strong_style.name',
    descriptionKey: 'linter.rules.strong_style.description',
    optionNameKeys: [
      'linter.rules.strong_style.style.name',
    ],
  },
  {
    alias: 'trailing-spaces',
    ruleType: 'Spacing',
    nameKey: 'linter.rules.trailing_spaces.name',
    descriptionKey: 'linter.rules.trailing_spaces.description',
    optionNameKeys: [
      'linter.rules.trailing_spaces.two_space_line_break.name',
    ],
  },
  {
    alias: 'two-spaces-between-lines-with-content',
    ruleType: 'Content',
    nameKey: 'linter.rules.two_spaces_between_lines_with_content.name',
    descriptionKey: 'linter.rules.two_spaces_between_lines_with_content.description',
    optionNameKeys: [
      'linter.rules.two_spaces_between_lines_with_content.line_break_indicator.name',
    ],
  },
  {
    alias: 'unordered-list-style',
    ruleType: 'Content',
    nameKey: 'linter.rules.unordered_list_style.name',
    descriptionKey: 'linter.rules.unordered_list_style.description',
    optionNameKeys: [
      'linter.rules.unordered_list_style.list_style.name',
    ],
  },
  {
    alias: 'yaml-key-sort',
    ruleType: 'YAML',
    nameKey: 'linter.rules.yaml_key_sort.name',
    descriptionKey: 'linter.rules.yaml_key_sort.description',
    optionNameKeys: [
      'linter.rules.yaml_key_sort.priority_keys_at_start_of_yaml.name',
      'linter.rules.yaml_key_sort.yaml_key_priority_sort_order.name',
      'linter.rules.yaml_key_sort.yaml_sort_order_for_other_keys.name',
    ],
  },
  {
    alias: 'yaml-timestamp',
    ruleType: 'YAML',
    nameKey: 'linter.rules.yaml_timestamp.name',
    descriptionKey: 'linter.rules.yaml_timestamp.description',
    optionNameKeys: [
      'linter.rules.yaml_timestamp.convert_to_utc.name',
      'linter.rules.yaml_timestamp.date_created.name',
      'linter.rules.yaml_timestamp.date_created_key.name',
      'linter.rules.yaml_timestamp.date_created_source_of_truth.name',
      'linter.rules.yaml_timestamp.date_modified.name',
      'linter.rules.yaml_timestamp.date_modified_key.name',
      'linter.rules.yaml_timestamp.date_modified_source_of_truth.name',
      'linter.rules.yaml_timestamp.format.name',
      'linter.rules.yaml_timestamp.update_on_file_contents_updated.name',
    ],
  },
  {
    alias: 'yaml-title',
    ruleType: 'YAML',
    nameKey: 'linter.rules.yaml_title.name',
    descriptionKey: 'linter.rules.yaml_title.description',
    optionNameKeys: [
      'linter.rules.yaml_title.mode.name',
      'linter.rules.yaml_title.title_key.name',
    ],
  },
  {
    alias: 'yaml-title-alias',
    ruleType: 'YAML',
    nameKey: 'linter.rules.yaml_title_alias.name',
    descriptionKey: 'linter.rules.yaml_title_alias.description',
    optionNameKeys: [
      'linter.rules.yaml_title_alias.alias_helper_key.name',
      'linter.rules.yaml_title_alias.keep_alias_that_matches_the_filename.name',
      'linter.rules.yaml_title_alias.preserve_existing_alias_section_style.name',
      'linter.rules.yaml_title_alias.remove_alias_if_empty.name',
      'linter.rules.yaml_title_alias.use_yaml_key_to_keep_track_of_old_filename_or_heading.name',
    ],
  },
]

/**
 * Whether the reader has any paste-time rule switched on. The editor's paste handler asks this
 * before it claims a paste: without a rule to run, the paste belongs to the editor.
 */
export function pasteRulesAreOn(ruleConfigs: Record<string, unknown>): boolean {
  return LINTER_RULE_SEARCH_ENTRIES.some((entry) => entry.ruleType === 'Paste' && (ruleConfigs[entry.alias] as { enabled?: unknown } | undefined)?.enabled === true)
}

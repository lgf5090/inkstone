/**
 * One jump target per lint rule.
 *
 * The rule list is drawn from the loaded rule library, so its titles are computed at run time, and a
 * static scan of this folder cannot attach a settings-search hit to one of them. This spells out every
 * label the index promises, as literal keys, so the row a reader lands on is the row they were looking
 * for. The keys come from `rule-search-index.ts`, which is what keeps the two in step.
 */
import { t } from '../../lib/i18n'

export function LinterRuleTitle({ alias, runtimeName }: { alias: string, runtimeName: string }) {
  switch (alias) {
    case "add-blank-line-after-yaml":
      return <span data-setting-title={t('linter.rules.add_blank_line_after_yaml.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.add_blank_line_after_yaml.name')}</span>
    case "add-blockquote-indentation-on-paste":
      return <span data-setting-title={t('linter.rules.add_blockquote_indentation_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.add_blockquote_indentation_on_paste.name')}</span>
    case "align-table-columns":
      return <span data-setting-title={t('linter.rules.align_table_columns.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.align_table_columns.name')}</span>
    case "auto-correct-common-misspellings":
      return <span data-setting-title={t('linter.rules.auto_correct_common_misspellings.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.auto_correct_common_misspellings.name')}</span>
    case "blockquote-style":
      return <span data-setting-title={t('linter.rules.blockquote_style.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.blockquote_style.name')}</span>
    case "capitalize-headings":
      return <span data-setting-title={t('linter.rules.capitalize_headings.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.capitalize_headings.name')}</span>
    case "compact-yaml":
      return <span data-setting-title={t('linter.rules.compact_yaml.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.compact_yaml.name')}</span>
    case "consecutive-blank-lines":
      return <span data-setting-title={t('linter.rules.consecutive_blank_lines.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.consecutive_blank_lines.name')}</span>
    case "convert-bullet-list-markers":
      return <span data-setting-title={t('linter.rules.convert_bullet_list_markers.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.convert_bullet_list_markers.name')}</span>
    case "convert-spaces-to-tabs":
      return <span data-setting-title={t('linter.rules.convert_spaces_to_tabs.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.convert_spaces_to_tabs.name')}</span>
    case "dedupe-yaml-array-values":
      return <span data-setting-title={t('linter.rules.dedupe_yaml_array_values.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.dedupe_yaml_array_values.name')}</span>
    case "default-language-for-code-fences":
      return <span data-setting-title={t('linter.rules.default_language_for_code_fences.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.default_language_for_code_fences.name')}</span>
    case "emphasis-style":
      return <span data-setting-title={t('linter.rules.emphasis_style.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.emphasis_style.name')}</span>
    case "empty-line-around-blockquotes":
      return <span data-setting-title={t('linter.rules.empty_line_around_blockquotes.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.empty_line_around_blockquotes.name')}</span>
    case "empty-line-around-code-fences":
      return <span data-setting-title={t('linter.rules.empty_line_around_code_fences.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.empty_line_around_code_fences.name')}</span>
    case "empty-line-around-horizontal-rules":
      return <span data-setting-title={t('linter.rules.empty_line_around_horizontal_rules.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.empty_line_around_horizontal_rules.name')}</span>
    case "empty-line-around-math-blocks":
      return <span data-setting-title={t('linter.rules.empty_line_around_math_blocks.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.empty_line_around_math_blocks.name')}</span>
    case "empty-line-around-tables":
      return <span data-setting-title={t('linter.rules.empty_line_around_tables.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.empty_line_around_tables.name')}</span>
    case "escape-yaml-special-characters":
      return <span data-setting-title={t('linter.rules.escape_yaml_special_characters.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.escape_yaml_special_characters.name')}</span>
    case "file-name-heading":
      return <span data-setting-title={t('linter.rules.file_name_heading.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.file_name_heading.name')}</span>
    case "footnote-after-punctuation":
      return <span data-setting-title={t('linter.rules.footnote_after_punctuation.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.footnote_after_punctuation.name')}</span>
    case "force-yaml-escape":
      return <span data-setting-title={t('linter.rules.force_yaml_escape.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.force_yaml_escape.name')}</span>
    case "format-tags-in-yaml":
      return <span data-setting-title={t('linter.rules.format_tags_in_yaml.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.format_tags_in_yaml.name')}</span>
    case "format-yaml-array":
      return <span data-setting-title={t('linter.rules.format_yaml_array.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.format_yaml_array.name')}</span>
    case "header-increment":
      return <span data-setting-title={t('linter.rules.header_increment.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.header_increment.name')}</span>
    case "heading-blank-lines":
      return <span data-setting-title={t('linter.rules.heading_blank_lines.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.heading_blank_lines.name')}</span>
    case "headings-start-line":
      return <span data-setting-title={t('linter.rules.headings_start_line.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.headings_start_line.name')}</span>
    case "insert-yaml-attributes":
      return <span data-setting-title={t('linter.rules.insert_yaml_attributes.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.insert_yaml_attributes.name')}</span>
    case "line-break-at-document-end":
      return <span data-setting-title={t('linter.rules.line_break_at_document_end.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.line_break_at_document_end.name')}</span>
    case "move-footnotes-to-the-bottom":
      return <span data-setting-title={t('linter.rules.move_footnotes_to_the_bottom.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.move_footnotes_to_the_bottom.name')}</span>
    case "move-inline-fields-to-yaml":
      return <span data-setting-title={t('linter.rules.move_inline_fields_to_yaml.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.move_inline_fields_to_yaml.name')}</span>
    case "move-math-block-indicators-to-their-own-line":
      return <span data-setting-title={t('linter.rules.move_math_block_indicators_to_their_own_line.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.move_math_block_indicators_to_their_own_line.name')}</span>
    case "move-tags-to-yaml":
      return <span data-setting-title={t('linter.rules.move_tags_to_yaml.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.move_tags_to_yaml.name')}</span>
    case "no-bare-urls":
      return <span data-setting-title={t('linter.rules.no_bare_urls.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.no_bare_urls.name')}</span>
    case "ordered-list-style":
      return <span data-setting-title={t('linter.rules.ordered_list_style.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.ordered_list_style.name')}</span>
    case "paragraph-blank-lines":
      return <span data-setting-title={t('linter.rules.paragraph_blank_lines.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.paragraph_blank_lines.name')}</span>
    case "prevent-double-checklist-indicator-on-paste":
      return <span data-setting-title={t('linter.rules.prevent_double_checklist_indicator_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.prevent_double_checklist_indicator_on_paste.name')}</span>
    case "prevent-double-list-item-indicator-on-paste":
      return <span data-setting-title={t('linter.rules.prevent_double_list_item_indicator_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.prevent_double_list_item_indicator_on_paste.name')}</span>
    case "proper-ellipsis":
      return <span data-setting-title={t('linter.rules.proper_ellipsis.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.proper_ellipsis.name')}</span>
    case "proper-ellipsis-on-paste":
      return <span data-setting-title={t('linter.rules.proper_ellipsis_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.proper_ellipsis_on_paste.name')}</span>
    case "quote-style":
      return <span data-setting-title={t('linter.rules.quote_style.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.quote_style.name')}</span>
    case "re-index-footnotes":
      return <span data-setting-title={t('linter.rules.re_index_footnotes.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.re_index_footnotes.name')}</span>
    case "remove-consecutive-list-markers":
      return <span data-setting-title={t('linter.rules.remove_consecutive_list_markers.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_consecutive_list_markers.name')}</span>
    case "remove-empty-lines-between-list-markers-and-checklists":
      return <span data-setting-title={t('linter.rules.remove_empty_lines_between_list_markers_and_checklists.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_empty_lines_between_list_markers_and_checklists.name')}</span>
    case "remove-empty-list-markers":
      return <span data-setting-title={t('linter.rules.remove_empty_list_markers.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_empty_list_markers.name')}</span>
    case "remove-hyphenated-line-breaks":
      return <span data-setting-title={t('linter.rules.remove_hyphenated_line_breaks.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_hyphenated_line_breaks.name')}</span>
    case "remove-hyphens-on-paste":
      return <span data-setting-title={t('linter.rules.remove_hyphens_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_hyphens_on_paste.name')}</span>
    case "remove-leading-or-trailing-whitespace-on-paste":
      return <span data-setting-title={t('linter.rules.remove_leading_or_trailing_whitespace_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_leading_or_trailing_whitespace_on_paste.name')}</span>
    case "remove-leftover-footnotes-from-quote-on-paste":
      return <span data-setting-title={t('linter.rules.remove_leftover_footnotes_from_quote_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_leftover_footnotes_from_quote_on_paste.name')}</span>
    case "remove-link-spacing":
      return <span data-setting-title={t('linter.rules.remove_link_spacing.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_link_spacing.name')}</span>
    case "remove-multiple-blank-lines-on-paste":
      return <span data-setting-title={t('linter.rules.remove_multiple_blank_lines_on_paste.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_multiple_blank_lines_on_paste.name')}</span>
    case "remove-multiple-spaces":
      return <span data-setting-title={t('linter.rules.remove_multiple_spaces.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_multiple_spaces.name')}</span>
    case "remove-space-around-characters":
      return <span data-setting-title={t('linter.rules.remove_space_around_characters.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_space_around_characters.name')}</span>
    case "remove-space-before-or-after-characters":
      return <span data-setting-title={t('linter.rules.remove_space_before_or_after_characters.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_space_before_or_after_characters.name')}</span>
    case "remove-trailing-punctuation-in-heading":
      return <span data-setting-title={t('linter.rules.remove_trailing_punctuation_in_heading.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_trailing_punctuation_in_heading.name')}</span>
    case "remove-yaml-keys":
      return <span data-setting-title={t('linter.rules.remove_yaml_keys.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.remove_yaml_keys.name')}</span>
    case "sort-yaml-array-values":
      return <span data-setting-title={t('linter.rules.sort_yaml_array_values.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.sort_yaml_array_values.name')}</span>
    case "space-after-list-markers":
      return <span data-setting-title={t('linter.rules.space_after_list_markers.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.space_after_list_markers.name')}</span>
    case "space-between-chinese-japanese-or-korean-and-english-or-numbers":
      return <span data-setting-title={t('linter.rules.space_between_chinese_japanese_or_korean_and_english_or_numbers.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.space_between_chinese_japanese_or_korean_and_english_or_numbers.name')}</span>
    case "strong-style":
      return <span data-setting-title={t('linter.rules.strong_style.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.strong_style.name')}</span>
    case "trailing-spaces":
      return <span data-setting-title={t('linter.rules.trailing_spaces.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.trailing_spaces.name')}</span>
    case "two-spaces-between-lines-with-content":
      return <span data-setting-title={t('linter.rules.two_spaces_between_lines_with_content.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.two_spaces_between_lines_with_content.name')}</span>
    case "unordered-list-style":
      return <span data-setting-title={t('linter.rules.unordered_list_style.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.unordered_list_style.name')}</span>
    case "yaml-key-sort":
      return <span data-setting-title={t('linter.rules.yaml_key_sort.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.yaml_key_sort.name')}</span>
    case "yaml-timestamp":
      return <span data-setting-title={t('linter.rules.yaml_timestamp.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.yaml_timestamp.name')}</span>
    case "yaml-title":
      return <span data-setting-title={t('linter.rules.yaml_title.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.yaml_title.name')}</span>
    case "yaml-title-alias":
      return <span data-setting-title={t('linter.rules.yaml_title_alias.name')} className="text-[13px] font-medium text-[var(--text-primary)]">{t('linter.rules.yaml_title_alias.name')}</span>
    default:
      return <span className="text-[13px] font-medium text-[var(--text-primary)]">{runtimeName}</span>
  }
}

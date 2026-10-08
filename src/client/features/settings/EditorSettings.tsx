import { Input, Segmented, SettingRow, Slider, Switch } from '../../components/form';
import { Button } from '../../components/primitives';
import { useSession } from '../../store/session';
import { t } from "../../lib/i18n";
import { clearRecentEmojis, RECENT_EMOJI_LIMIT, useEmojiPreferences } from '../../lib/emoji-prefs';
import { EMOJI_TONE_LABEL_KEYS, EMOJI_TONE_SLOTS, emojiToneHand } from '../../lib/emoji-unicode';
import { LINK_EDITOR_ALIAS_SEPARATOR_MAX } from '@shared/constants';
import type { CodeFormatKeywordCase, EmojiInsertFormat, LinkEditorAliasMode, LinkEditorModifier, LinkEditorTrigger, OutlineAutoExpandName, OutlineModeName, OutlineTextDirectionName, PasteLinkNothing, SkinTone } from '@shared/types';
export function EditorSettings() {
    const editor = useSession((s) => s.settings.editor);
    const preview = useSession((s) => s.settings.preview);
    const notes = useSession((s) => s.settings.notes);
    const update = useSession((s) => s.updateSettings);
    const { recentEmojis } = useEmojiPreferences();
    return (<div className="space-y-6">
      <section>
        <SettingRow title={t("settings.editor_font")}>
          <Segmented<'mono' | 'sans'> label={t("settings.editor_font")} value={editor.fontFamily} onChange={(fontFamily) => void update({ editor: { fontFamily } })} options={[
            { value: 'mono', label: t("settings.monospace") },
            { value: 'sans', label: t("common.sans_serif") },
        ]}/>
        </SettingRow>

        <SettingRow title={t("settings.editor_font_size")}>
          <Slider label={t("settings.editor_font_size")} className="w-[200px]" value={editor.fontSize} min={12} max={22} onChange={(fontSize) => void update({ editor: { fontSize } })} suffix="px"/>
        </SettingRow>

        <SettingRow title={t("settings.show_line_numbers")}>
          <Switch checked={editor.lineNumbers} onChange={(lineNumbers) => void update({ editor: { lineNumbers } })} label={t("settings.show_line_numbers")}/>
        </SettingRow>

        <SettingRow title={t("settings.show_toolbar")}>
          <Switch checked={editor.showToolbar} onChange={(showToolbar) => void update({ editor: { showToolbar } })} label={t("settings.show_toolbar")}/>
        </SettingRow>

        <SettingRow title={t("settings.spellcheck")}>
          <Switch checked={editor.spellcheck} onChange={(spellcheck) => void update({ editor: { spellcheck } })} label={t("settings.spellcheck")}/>
        </SettingRow>
      </section>

      <section>
        <SettingRow title={t("settings.todo_tag")} description={t("settings.todo_tag_hint")}>
          <Input aria-label={t("settings.todo_tag")} value={notes.todoTag} onChange={(event) => void update({ notes: { todoTag: event.target.value } })} className="w-[200px]"/>
        </SettingRow>
      </section>

      <section>
        <h3 data-setting-title={t("settings.writing_mode")} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.writing_mode")}</h3>

        <SettingRow title={t("settings.typewriter_mode")} description={t("settings.keep_the_cursor_line_centered_on_screen")}>
          <Switch checked={editor.typewriter} onChange={(typewriter) => void update({ editor: { typewriter } })} label={t("settings.typewriter_mode")}/>
        </SettingRow>

        <SettingRow title={t("settings.focus_mode")} description={t("settings.fade_content_outside_the_current_paragraph")}>
          <Switch checked={editor.focusMode} onChange={(focusMode) => void update({ editor: { focusMode } })} label={t("settings.focus_mode")}/>
        </SettingRow>
      </section>

      <section>
        <h3 data-setting-title={t("settings.link_editor_group")} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.link_editor_group")}</h3>

        <SettingRow title={t("settings.link_editor")} description={t("settings.link_editor_description")}>
          <Switch checked={editor.linkEditor} onChange={(linkEditor) => void update({ editor: { linkEditor } })} label={t("settings.link_editor")}/>
        </SettingRow>

        {editor.linkEditor && <>
            <SettingRow title={t("settings.link_editor_trigger")} description={t("settings.link_editor_trigger_description")}>
              <Segmented<LinkEditorTrigger> label={t("settings.link_editor_trigger")} value={editor.linkEditorTrigger} onChange={(linkEditorTrigger) => void update({ editor: { linkEditorTrigger } })} options={[
                { value: 'click', label: t("settings.link_editor_trigger_click") },
                { value: 'double-click', label: t("settings.link_editor_trigger_double_click") },
              ]}/>
            </SettingRow>

            <SettingRow title={t("settings.link_editor_modifier")} description={t("settings.link_editor_modifier_description")}>
              <Segmented<LinkEditorModifier> label={t("settings.link_editor_modifier")} value={editor.linkEditorModifier} onChange={(linkEditorModifier) => void update({ editor: { linkEditorModifier } })} options={[
                { value: 'none', label: t("settings.link_editor_modifier_none") },
                { value: 'ctrl', label: t("settings.link_editor_modifier_ctrl") },
                { value: 'alt', label: t("settings.link_editor_modifier_alt") },
                { value: 'shift', label: t("settings.link_editor_modifier_shift") },
              ]}/>
            </SettingRow>

            <SettingRow title={t("settings.link_editor_suggest")} description={t("settings.link_editor_suggest_description")}>
              <Switch checked={editor.linkEditorSuggest} onChange={(linkEditorSuggest) => void update({ editor: { linkEditorSuggest } })} label={t("settings.link_editor_suggest")}/>
            </SettingRow>

            {editor.linkEditorSuggest && <>
                <SettingRow title={t("settings.link_editor_sync_alias")} description={t("settings.link_editor_sync_alias_description")}>
                  <Switch checked={editor.linkEditorSyncAlias} onChange={(linkEditorSyncAlias) => void update({ editor: { linkEditorSyncAlias } })} label={t("settings.link_editor_sync_alias")}/>
                </SettingRow>

                {editor.linkEditorSyncAlias && <SettingRow title={t("settings.link_editor_alias_mode")}>
                  <Segmented<LinkEditorAliasMode> label={t("settings.link_editor_alias_mode")} value={editor.linkEditorAliasMode} onChange={(linkEditorAliasMode) => void update({ editor: { linkEditorAliasMode } })} options={[
                    { value: 'heading', label: t("settings.link_editor_alias_heading") },
                    { value: 'note-then-heading', label: t("settings.link_editor_alias_note_then_heading") },
                    { value: 'heading-then-note', label: t("settings.link_editor_alias_heading_then_note") },
                  ]}/>
                </SettingRow>}

                {editor.linkEditorSyncAlias && <SettingRow title={t("settings.link_editor_alias_separator")} description={t("settings.link_editor_alias_separator_description")}>
                  <Input aria-label={t("settings.link_editor_alias_separator")} value={editor.linkEditorAliasSeparator} onChange={(event) => void update({ editor: { linkEditorAliasSeparator: event.target.value.slice(0, LINK_EDITOR_ALIAS_SEPARATOR_MAX) } })} className="w-[120px]"/>
                </SettingRow>}

                <SettingRow title={t("settings.link_editor_quick_select")} description={t("settings.link_editor_quick_select_description")}>
                  <Switch checked={editor.linkEditorQuickSelect} onChange={(linkEditorQuickSelect) => void update({ editor: { linkEditorQuickSelect } })} label={t("settings.link_editor_quick_select")}/>
                </SettingRow>
              </>}

            <SettingRow title={t("settings.link_editor_validate")} description={t("settings.link_editor_validate_description")}>
              <Switch checked={editor.linkEditorValidate} onChange={(linkEditorValidate) => void update({ editor: { linkEditorValidate } })} label={t("settings.link_editor_validate")}/>
            </SettingRow>

            <SettingRow title={t("settings.link_editor_keeps_text")} description={t("settings.link_editor_keeps_text_description")}>
              <Switch checked={editor.linkEditorKeepsText} onChange={(linkEditorKeepsText) => void update({ editor: { linkEditorKeepsText } })} label={t("settings.link_editor_keeps_text")}/>
            </SettingRow>

            <SettingRow title={t("settings.link_editor_embed_toggle")} description={t("settings.link_editor_embed_toggle_description")}>
              <Switch checked={editor.linkEditorEmbedToggle} onChange={(linkEditorEmbedToggle) => void update({ editor: { linkEditorEmbedToggle } })} label={t("settings.link_editor_embed_toggle")}/>
            </SettingRow>

            <SettingRow title={t("settings.link_editor_pad_new")} description={t("settings.link_editor_pad_new_description")}>
              <Switch checked={editor.linkEditorPadNew} onChange={(linkEditorPadNew) => void update({ editor: { linkEditorPadNew } })} label={t("settings.link_editor_pad_new")}/>
            </SettingRow>
          </>}
      </section>

      <section>
        <h3 data-setting-title={t("settings.paste_link_group")} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.paste_link_group")}</h3>

        <SettingRow title={t("settings.paste_link")} description={t("settings.paste_link_description")}>
          <Switch checked={editor.pasteLink} onChange={(pasteLink) => void update({ editor: { pasteLink } })} label={t("settings.paste_link")}/>
        </SettingRow>

        {editor.pasteLink && <>
            <SettingRow title={t("settings.paste_link_nothing")} description={t("settings.paste_link_nothing_description")}>
              <Segmented<PasteLinkNothing> label={t("settings.paste_link_nothing")} value={editor.pasteLinkNothing} onChange={(pasteLinkNothing) => void update({ editor: { pasteLinkNothing } })} options={[
                { value: 'plain', label: t("settings.paste_link_nothing_plain") },
                { value: 'word', label: t("settings.paste_link_nothing_word") },
                { value: 'inline', label: t("settings.paste_link_nothing_inline") },
                { value: 'bare', label: t("settings.paste_link_nothing_bare") },
            ]}/>
            </SettingRow>

            <SettingRow title={t("settings.paste_link_reverse")} description={t("settings.paste_link_reverse_description")}>
              <Switch checked={editor.pasteLinkReverse} onChange={(pasteLinkReverse) => void update({ editor: { pasteLinkReverse } })} label={t("settings.paste_link_reverse")}/>
            </SettingRow>

            <SettingRow title={t("settings.paste_link_image")} description={t("settings.paste_link_image_description")}>
              <Switch checked={editor.pasteLinkImageEmbed} onChange={(pasteLinkImageEmbed) => void update({ editor: { pasteLinkImageEmbed } })} label={t("settings.paste_link_image")}/>
            </SettingRow>

            <SettingRow title={t("settings.paste_link_bare_address")} description={t("settings.paste_link_bare_address_description")}>
              <Switch checked={editor.pasteLinkBareAddress} onChange={(pasteLinkBareAddress) => void update({ editor: { pasteLinkBareAddress } })} label={t("settings.paste_link_bare_address")}/>
            </SettingRow>

            <SettingRow title={t("settings.paste_link_internal_note")} description={t("settings.paste_link_internal_note_description")}>
              <Switch checked={editor.pasteLinkInternalNote} onChange={(pasteLinkInternalNote) => void update({ editor: { pasteLinkInternalNote } })} label={t("settings.paste_link_internal_note")}/>
            </SettingRow>

            <SettingRow title={t("settings.paste_link_retarget")} description={t("settings.paste_link_retarget_description")}>
              <Switch checked={editor.pasteLinkRetarget} onChange={(pasteLinkRetarget) => void update({ editor: { pasteLinkRetarget } })} label={t("settings.paste_link_retarget")}/>
            </SettingRow>
          </>}
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("settings.emoji")}</h3>

        <SettingRow title={t("settings.emoji_button")} description={t("settings.emoji_button_description")}>
          <Switch checked={editor.emojiToolbarButton} onChange={(emojiToolbarButton) => void update({ editor: { emojiToolbarButton } })} label={t("settings.emoji_button")}/>
        </SettingRow>

        <SettingRow title={t("settings.emoji_insert_format")} description={t("settings.emoji_insert_format_description")}>
          <Segmented<EmojiInsertFormat> label={t("settings.emoji_insert_format")} value={editor.emojiInsertFormat} onChange={(emojiInsertFormat) => void update({ editor: { emojiInsertFormat } })} options={[
            { value: 'native', label: t("settings.emoji_insert_native") },
            { value: 'shortcode', label: t("settings.emoji_insert_shortcode") },
          ]}/>
        </SettingRow>

        <SettingRow title={t("settings.emoji_skin_tone")} description={t("settings.emoji_skin_tone_description")}>
          <Segmented<string> label={t("settings.emoji_skin_tone")} value={String(editor.emojiSkinTone)} onChange={(value) => void update({ editor: { emojiSkinTone: Number(value) as SkinTone } })} options={EMOJI_TONE_SLOTS.map((slot) => ({
            value: String(slot),
            title: t(EMOJI_TONE_LABEL_KEYS[slot]!),
            label: <span aria-hidden="true" className="text-[15px] leading-none">{emojiToneHand(slot)}</span>,
          }))}/>
        </SettingRow>

        <SettingRow title={t("settings.emoji_shortcodes")} description={t("settings.emoji_shortcodes_description")}>
          <Switch checked={preview.emojiShortcodes} onChange={(emojiShortcodes) => void update({ preview: { emojiShortcodes } })} label={t("settings.emoji_shortcodes")}/>
        </SettingRow>

        <SettingRow title={t("settings.emoji_recent")} description={t("settings.emoji_recent_description")}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-right text-[15px] leading-none text-[var(--text-quaternary)]" aria-label={t("settings.emoji_recent")}>
              {recentEmojis.length ? recentEmojis.slice(0, 12).join(' ') : `${recentEmojis.length}/${RECENT_EMOJI_LIMIT}`}
            </span>
            <Button variant="ghost" size="sm" disabled={!recentEmojis.length} onClick={() => clearRecentEmojis()}>
              {t("common.clear")}
            </Button>
          </div>
        </SettingRow>
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t("common.preview")}</h3>

        <SettingRow title={t("settings.scroll_sync")} description={t("settings.keep_the_editor_and_preview_scrolled_together")}>
          <Switch checked={preview.syncScroll} onChange={(syncScroll) => void update({ preview: { syncScroll } })} label={t("settings.scroll_sync")}/>
        </SettingRow>

        <SettingRow title={t("settings.math")} description={t("settings.render_and_using_katex")}>
          <Switch checked={preview.math} onChange={(math) => void update({ preview: { math } })} label={t("settings.math")}/>
        </SettingRow>

        <SettingRow title={t("settings.diagram")} description={t("settings.render_mermaid_code_blocks_into_flowcharts")}>
          <Switch checked={preview.mermaid} onChange={(mermaid) => void update({ preview: { mermaid } })} label={t("settings.diagram")}/>
        </SettingRow>

        <SettingRow title={t("settings.chart")} description={t("settings.render_chart_fences_as_charts")}>
          <Switch checked={preview.chart} onChange={(chart) => void update({ preview: { chart } })} label={t("settings.chart")}/>
        </SettingRow>

        <SettingRow title={t("settings.collapse_long_code_blocks")} description={t("settings.collapse_long_code_blocks_description")}>
          <Switch checked={preview.codeBlockCollapse} onChange={(codeBlockCollapse) => void update({ preview: { codeBlockCollapse } })} label={t("settings.collapse_long_code_blocks")}/>
        </SettingRow>

        {preview.codeBlockCollapse && <SettingRow title={t("settings.code_block_collapse_after")}>
          <Slider label={t("settings.code_block_collapse_after")} className="w-[200px]" value={preview.codeBlockCollapseLines} min={8} max={100} step={1} onChange={(codeBlockCollapseLines) => void update({ preview: { codeBlockCollapseLines } })} suffix={t("settings.lines")}/>
        </SettingRow>}

        <SettingRow title={t("settings.code_format_button")} description={t("settings.code_format_button_description")}>
          <Switch checked={preview.codeFormatButton} onChange={(codeFormatButton) => void update({ preview: { codeFormatButton } })} label={t("settings.code_format_button")}/>
        </SettingRow>

        <SettingRow title={t("settings.table_bubble_menu")} description={t("settings.table_bubble_menu_description")}>
          <Switch checked={preview.tableBubbleMenu} onChange={(tableBubbleMenu) => void update({ preview: { tableBubbleMenu } })} label={t("settings.table_bubble_menu")}/>
        </SettingRow>

        <SettingRow title={t("settings.media_toolbar")} description={t("settings.media_toolbar_description")}>
          <Switch checked={preview.mediaToolbar} onChange={(mediaToolbar) => void update({ preview: { mediaToolbar } })} label={t("settings.media_toolbar")}/>
        </SettingRow>

        <SettingRow title={t("settings.media_auto_bundle")} description={t("settings.media_auto_bundle_description")}>
          <Switch checked={preview.mediaAutoBundle} onChange={(mediaAutoBundle) => void update({ preview: { mediaAutoBundle } })} label={t("settings.media_auto_bundle")}/>
        </SettingRow>

        {preview.mediaAutoBundle && <SettingRow title={t("settings.media_default_wrap")} description={t("settings.media_default_wrap_description")}>
          <Switch checked={preview.mediaAutoBundleWrap} onChange={(mediaAutoBundleWrap) => void update({ preview: { mediaAutoBundleWrap } })} label={t("settings.media_default_wrap")}/>
        </SettingRow>}

        <SettingRow title={t("settings.show_outline_by_default")}>
          <Switch checked={preview.showToc} onChange={(showToc) => void update({ preview: { showToc } })} label={t("settings.show_outline_by_default")}/>
        </SettingRow>

        {preview.showToc && <SettingRow title={t("settings.outline_display_mode")} description={t("settings.outline_display_mode_desc")}>
          <Segmented<OutlineModeName> label={t("settings.outline_display_mode")} value={preview.outlineMode} onChange={(outlineMode) => void update({ preview: { outlineMode } })} options={[
            { value: 'sidebar', label: t("settings.outline_sidebar") },
            { value: 'floating-always', label: t("settings.outline_floating_always") },
            { value: 'floating-hover', label: t("settings.outline_floating_hover") },
            { value: 'floating-circle', label: t("settings.outline_floating_circle") },
        ]}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_default_level")} description={t("settings.outline_default_level_description")}>
          <Slider label={t("settings.outline_default_level")} className="w-[200px]" value={preview.outlineDefaultLevel} min={1} max={6} step={1} onChange={(outlineDefaultLevel) => void update({ preview: { outlineDefaultLevel } })}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_show_progress")}>
          <Switch checked={preview.outlineShowProgress} onChange={(outlineShowProgress) => void update({ preview: { outlineShowProgress } })} label={t("settings.outline_show_progress")}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_auto_expand")} description={t("settings.outline_auto_expand_description")}>
          <Segmented<OutlineAutoExpandName> label={t("settings.outline_auto_expand")} value={preview.outlineAutoExpand} onChange={(outlineAutoExpand) => void update({ preview: { outlineAutoExpand } })} options={[
            { value: 'off', label: t("settings.outline_auto_expand_off") },
            { value: 'ancestors', label: t("settings.outline_auto_expand_ancestors") },
        ]}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_tooltip_side")}>
          <Segmented<'left' | 'right'> label={t("settings.outline_tooltip_side")} value={preview.outlineTooltipSide} onChange={(outlineTooltipSide) => void update({ preview: { outlineTooltipSide } })} options={[
            { value: 'left', label: t("settings.outline_tooltip_left") },
            { value: 'right', label: t("settings.outline_tooltip_right") },
        ]}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_truncate_length")} description={t("settings.outline_truncate_length_description")}>
          <Slider label={t("settings.outline_truncate_length")} className="w-[200px]" value={preview.outlineTruncateLength} min={0} max={120} step={5} onChange={(outlineTruncateLength) => void update({ preview: { outlineTruncateLength } })}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_show_reading_time")} description={t("settings.outline_show_reading_time_description")}>
          <Switch checked={preview.outlineShowReadingTime} onChange={(outlineShowReadingTime) => void update({ preview: { outlineShowReadingTime } })} label={t("settings.outline_show_reading_time")}/>
        </SettingRow>}

        {preview.showToc && preview.outlineShowReadingTime && <SettingRow title={t("settings.outline_reading_speed")} description={t("settings.outline_reading_speed_description")}>
          <Slider label={t("settings.outline_reading_speed")} className="w-[200px]" value={preview.outlineReadingSpeed} min={50} max={1000} step={25} onChange={(outlineReadingSpeed) => void update({ preview: { outlineReadingSpeed } })}/>
        </SettingRow>}
        {preview.showToc && <SettingRow title={t("settings.outline_text_direction")} description={t("settings.outline_text_direction_description")}>
          <Segmented<OutlineTextDirectionName> label={t("settings.outline_text_direction")} value={preview.outlineTextDirection} onChange={(outlineTextDirection) => void update({ preview: { outlineTextDirection } })} options={[
            { value: 'system', label: t("settings.outline_text_direction_system") },
            { value: 'text', label: t("settings.outline_text_direction_text") },
        ]}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_hover_peek")} description={t("settings.outline_hover_peek_description")}>
          <Switch checked={preview.outlineHoverPeek} onChange={(outlineHoverPeek) => void update({ preview: { outlineHoverPeek } })} label={t("settings.outline_hover_peek")}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_markdown_labels")} description={t("settings.outline_markdown_labels_description")}>
          <Switch checked={preview.outlineMarkdownLabels} onChange={(outlineMarkdownLabels) => void update({ preview: { outlineMarkdownLabels } })} label={t("settings.outline_markdown_labels")}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_drag_edits")} description={t("settings.outline_drag_edits_description")}>
          <Switch checked={preview.outlineDragEdits} onChange={(outlineDragEdits) => void update({ preview: { outlineDragEdits } })} label={t("settings.outline_drag_edits")}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_keep_search")} description={t("settings.outline_keep_search_description")}>
          <Switch checked={preview.outlineKeepSearch} onChange={(outlineKeepSearch) => void update({ preview: { outlineKeepSearch } })} label={t("settings.outline_keep_search")}/>
        </SettingRow>}

        {preview.showToc && <SettingRow title={t("settings.outline_locate_by_cursor")} description={t("settings.outline_locate_by_cursor_description")}>
          <Switch checked={preview.outlineLocateByCursor} onChange={(outlineLocateByCursor) => void update({ preview: { outlineLocateByCursor } })} label={t("settings.outline_locate_by_cursor")}/>
        </SettingRow>}

        <SettingRow title={t("settings.context_menu")} description={t("settings.context_menu_description")}>
          <Switch checked={preview.contextMenu} onChange={(contextMenu) => void update({ preview: { contextMenu } })} label={t("settings.context_menu")}/>
        </SettingRow>

        {preview.contextMenu && <SettingRow title={t("settings.context_menu_toolbar")} description={t("settings.context_menu_toolbar_description")}>
          <Switch checked={preview.contextMenuToolbar} onChange={(contextMenuToolbar) => void update({ preview: { contextMenuToolbar } })} label={t("settings.context_menu_toolbar")}/>
        </SettingRow>}

        {preview.contextMenu && <SettingRow title={t("settings.context_menu_search")} description={t("settings.context_menu_search_description")}>
          <Switch checked={preview.contextMenuSearch} onChange={(contextMenuSearch) => void update({ preview: { contextMenuSearch } })} label={t("settings.context_menu_search")}/>
        </SettingRow>}

        <SettingRow title={t("settings.link_hover_preview")} description={t("settings.link_hover_preview_description")}>
          <Switch checked={preview.linkHover} onChange={(linkHover) => void update({ preview: { linkHover } })} label={t("settings.link_hover_preview")}/>
        </SettingRow>

        {preview.linkHover && <SettingRow title={t("settings.link_hover_delay")}>
          <Slider label={t("settings.link_hover_delay")} className="w-[200px]" value={preview.linkHoverDelayMs} min={150} max={1000} step={50} onChange={(linkHoverDelayMs) => void update({ preview: { linkHoverDelayMs } })} suffix="ms"/>
        </SettingRow>}

        {preview.linkHover && <SettingRow title={t("settings.link_preview_length")}>
          <Slider label={t("settings.link_preview_length")} className="w-[200px]" value={preview.linkPreviewLength} min={300} max={8000} step={100} onChange={(linkPreviewLength) => void update({ preview: { linkPreviewLength } })} suffix={t("settings.characters")}/>
        </SettingRow>}

        <SettingRow title={t("settings.floating_window_size")} description={t("settings.floating_window_size_description")}>
          <Segmented<'small' | 'medium' | 'large' | 'custom'> label={t("settings.floating_window_size")} value={preview.pinnedWindowSize} onChange={(pinnedWindowSize) => void update({ preview: { pinnedWindowSize } })} options={[
            { value: 'small', label: t("settings.floating_window_small") },
            { value: 'medium', label: t("settings.floating_window_medium") },
            { value: 'large', label: t("settings.floating_window_large") },
            { value: 'custom', label: t("settings.floating_window_custom") },
        ]}/>
        </SettingRow>

        {preview.pinnedWindowSize === 'custom' && <SettingRow title={t("settings.floating_window_width")}>
          <Slider label={t("settings.floating_window_width")} className="w-[200px]" value={preview.pinnedWindowWidth} min={260} max={1200} step={20} onChange={(pinnedWindowWidth) => void update({ preview: { pinnedWindowWidth } })} suffix="px"/>
        </SettingRow>}

        {preview.pinnedWindowSize === 'custom' && <SettingRow title={t("settings.floating_window_height")}>
          <Slider label={t("settings.floating_window_height")} className="w-[200px]" value={preview.pinnedWindowHeight} min={140} max={2000} step={20} onChange={(pinnedWindowHeight) => void update({ preview: { pinnedWindowHeight } })} suffix="px"/>
        </SettingRow>}
      </section>

      <section>
        <SettingRow title={t("settings.presentation_slide_list")} description={t("settings.presentation_slide_list_description")}>
          <Switch checked={preview.presentationSlideList} onChange={(presentationSlideList) => void update({ preview: { presentationSlideList } })} label={t("settings.presentation_slide_list")}/>
        </SettingRow>

        <SettingRow title={t("settings.presentation_chart_animation")} description={t("settings.presentation_chart_animation_description")}>
          <Switch checked={preview.presentationChartAnimation} onChange={(presentationChartAnimation) => void update({ preview: { presentationChartAnimation } })} label={t("settings.presentation_chart_animation")}/>
        </SettingRow>

        <SettingRow title={t("settings.presentation_auto_hide")} description={t("settings.presentation_auto_hide_description")}>
          <Switch checked={preview.presentationAutoHideChrome} onChange={(presentationAutoHideChrome) => void update({ preview: { presentationAutoHideChrome } })} label={t("settings.presentation_auto_hide")}/>
        </SettingRow>
      </section>

      <section>
        <SettingRow title={t("settings.autosave_delay")} description={t("settings.delay_before_uploading_after_you_stop_typing_shorter_makes_more_requests")}>
          <Slider label={t("settings.autosave_delay")} className="w-[200px]" value={editor.autoSaveDelay} min={200} max={3000} step={100} onChange={(autoSaveDelay) => void update({ editor: { autoSaveDelay } })} suffix="ms"/>
        </SettingRow>

        <SettingRow title={t("settings.indent_width")}>
          <Segmented<string> label={t("settings.indent_width")} value={String(editor.tabSize)} onChange={(value) => void update({ editor: { tabSize: Number(value) } })} options={[
            { value: '2', label: '2' },
            { value: '4', label: '4' },
        ]}/>
        </SettingRow>

        <SettingRow title={t("settings.code_format_keyword_case")}>
          <Segmented<CodeFormatKeywordCase> label={t("settings.code_format_keyword_case")} value={editor.codeFormatKeywordCase} onChange={(codeFormatKeywordCase) => void update({ editor: { codeFormatKeywordCase } })} options={[
            { value: 'upper', label: t("settings.code_format_upper") },
            { value: 'lower', label: t("settings.code_format_lower") },
            { value: 'keep', label: t("settings.code_format_keep") },
        ]}/>
        </SettingRow>
      </section>
    </div>);
}

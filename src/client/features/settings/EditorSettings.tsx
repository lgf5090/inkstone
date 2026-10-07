import { Input, Segmented, SettingRow, Slider, Switch } from '../../components/form';
import { useSession } from '../../store/session';
import { t } from "../../lib/i18n";
import type { CodeFormatKeywordCase, OutlineAutoExpandName, OutlineModeName, OutlineTextDirectionName } from '@shared/types';
export function EditorSettings() {
    const editor = useSession((s) => s.settings.editor);
    const preview = useSession((s) => s.settings.preview);
    const notes = useSession((s) => s.settings.notes);
    const update = useSession((s) => s.updateSettings);
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

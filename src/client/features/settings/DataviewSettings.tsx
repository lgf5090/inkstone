/**
 * The Dataview settings section, and the workbench that comes with it.
 *
 * The switches decide what a note may compute; the saved-query list is where a reader tries a query
 * without writing it into a note first. That is the same job Obsidian's "Global data view" does, and it
 * lives here rather than in its own panel because this app has no sidebar dock to put one in: the
 * section already has the query field, the list, and the index's own progress line.
 *
 * A run reads through the same index and engine a block uses, so what the workbench shows is what the
 * block would show — including the note bodies it has to fetch to answer, which is why the first run of
 * a new query can take a moment and the next one does not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { DEFAULT_SETTINGS } from '@shared/constants';
import type { SavedDataviewQuery } from '@shared/types';
import { Button, IconButton } from '../../components/primitives';
import { Input, Segmented, SettingRow, Slider, Switch } from '../../components/form';
import { confirm } from '../../components/overlay';
import { useSession } from '../../store/session';
import { t } from '../../lib/i18n';
import { randomLocalId } from '../../lib/random-id';
import { executeQuery } from '../../lib/dataview/engine';
import { Context } from '../../lib/dataview/context';
import { parseQuery } from '../../lib/dataview/expression';
import { renderNotice, renderResult } from '../../lib/dataview/render';
import { dataviewIndex, querySettings, startDataview } from '../../lib/dataview/service';

const DURATION_OPTIONS = [
  { value: 'long', labelKey: 'settings.dataview_duration_long' },
  { value: 'short', labelKey: 'settings.dataview_duration_short' },
  { value: 'tiny', labelKey: 'settings.dataview_duration_tiny' },
] as const

export function DataviewSettings() {
  const dataview = useSession((state) => state.settings.dataview);
  const update = useSession((state) => state.updateSettings);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState(dataviewIndex.getStatus());
  const [running, setRunning] = useState<string | null>(null);
  useEffect(() => {
    startDataview();
    const stop = dataviewIndex.subscribe(() => setStatus(dataviewIndex.getStatus()));
    setStatus(dataviewIndex.getStatus());
    return stop;
  }, []);
  const patch = useCallback((next: Partial<typeof dataview>) => void update({
      dataview: next,
    }), [update]);
  const rewriteSaved = useCallback((savedQueries: SavedDataviewQuery[]) => patch({ savedQueries }), [patch]);
  const runQuery = useCallback(async (entry: SavedDataviewQuery) => {
    const host = resultRef.current;
    if (!host) return;
    setRunning(entry.id);
    host.replaceChildren();
    try {
      const query = parseQuery(entry.query);
      const resolved = await dataviewIndex.resolveRails(query.source);
      const context = new Context({
          linkHandler: {
            resolve: (path) => {
              const id = dataviewIndex.noteIdForLink(path);
              return id ? dataviewIndex.serialize(id) : null;
            },
            normalize: (path) => {
              const id = dataviewIndex.noteIdForLink(path);
              return id ? dataviewIndex.pageOf(id)?.path ?? path : path;
            },
            exists: (path) => dataviewIndex.noteIdForLink(path) !== undefined,
          },
          settings: querySettings(),
        });
      const result = executeQuery(query, resolved.rails, context, null);
      if (!result.ok) {
          host.append(renderNotice('error', t('dataview.exec_failed'), result.error));
          return;
        }
      host.append(renderResult(result.value, { settings: context.settings, originPath: null }));
    } catch (error) {
      host.append(renderNotice('error', t('dataview.parse_failed'), error instanceof Error ? error.message : String(error)));
    } finally {
      setRunning(null);
    }
  }, []);
  return (<div className="space-y-6">
      <section>
        <SettingRow title={t('settings.dataview_enabled')} description={t('settings.dataview_enabled_desc')}>
          <Switch checked={dataview.enabled} onChange={(enabled) => patch({ enabled })} label={t('settings.dataview_enabled')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_inline_fields')} description={t('settings.dataview_inline_fields_desc')}>
          <Switch checked={dataview.inlineFields} onChange={(inlineFields) => patch({ inlineFields })} label={t('settings.dataview_inline_fields')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_inline_queries')} description={t('settings.dataview_inline_queries_desc')}>
          <Switch checked={dataview.inlineQueries} onChange={(inlineQueries) => patch({ inlineQueries })} label={t('settings.dataview_inline_queries')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_inline_live')} description={t('settings.dataview_inline_live_desc')}>
          <Switch checked={dataview.prettyInlineFieldsLivePreview} onChange={(prettyInlineFieldsLivePreview) => patch({ prettyInlineFieldsLivePreview })} label={t('settings.dataview_inline_live')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_inline_codeblocks')} description={t('settings.dataview_inline_codeblocks_desc')}>
          <Switch checked={dataview.inlineQueriesInCodeblocks} onChange={(inlineQueriesInCodeblocks) => patch({ inlineQueriesInCodeblocks })} label={t('settings.dataview_inline_codeblocks')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_inline_js')} description={t('settings.dataview_inline_js_desc')}>
          <Switch checked={dataview.inlineJsQueries} onChange={(inlineJsQueries) => patch({ inlineJsQueries })} label={t('settings.dataview_inline_js')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_inline_js_prefix')} description={t('settings.dataview_inline_js_prefix_desc')}>
          <Input className="w-[120px]" value={dataview.inlineJsQueryPrefix} maxLength={8} placeholder={DEFAULT_SETTINGS.dataview.inlineJsQueryPrefix} onChange={(event) => patch({ inlineJsQueryPrefix: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_js')} description={t('settings.dataview_js_desc')}>
          <Switch checked={dataview.jsBlocks} onChange={(jsBlocks) => patch({ jsBlocks })} label={t('settings.dataview_js')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_live_refresh')} description={t('settings.dataview_live_refresh_desc')}>
          <Switch checked={dataview.liveRefresh} onChange={(liveRefresh) => patch({ liveRefresh })} label={t('settings.dataview_live_refresh')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_error_details')} description={t('settings.dataview_error_details_desc')}>
          <Switch checked={dataview.showErrorDetails} onChange={(showErrorDetails) => patch({ showErrorDetails })} label={t('settings.dataview_error_details')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_archived')} description={t('settings.dataview_archived_desc')}>
          <Switch checked={dataview.includeArchived} onChange={(includeArchived) => patch({ includeArchived })} label={t('settings.dataview_archived')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_task_completion')} description={t('settings.dataview_task_completion_desc')}>
          <Switch checked={dataview.taskCompletionTracking} onChange={(taskCompletionTracking) => patch({ taskCompletionTracking })} label={t('settings.dataview_task_completion')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_task_completion_emoji')} description={t('settings.dataview_task_completion_emoji_desc')}>
          <Switch checked={dataview.taskCompletionUseEmojiShorthand} onChange={(taskCompletionUseEmojiShorthand) => patch({ taskCompletionUseEmojiShorthand })} label={t('settings.dataview_task_completion_emoji')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_task_completion_field')} description={t('settings.dataview_task_completion_field_desc')}>
          <Input className="w-[170px]" value={dataview.taskCompletionText} maxLength={40} placeholder={DEFAULT_SETTINGS.dataview.taskCompletionText} onChange={(event) => patch({ taskCompletionText: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_task_completion_format')} description={t('settings.dataview_task_completion_format_desc')}>
          <Input className="w-[170px]" value={dataview.taskCompletionDateFormat} maxLength={40} placeholder={DEFAULT_SETTINGS.dataview.taskCompletionDateFormat} onChange={(event) => patch({ taskCompletionDateFormat: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_task_recursive')} description={t('settings.dataview_task_recursive_desc')}>
          <Switch checked={dataview.recursiveSubTaskCompletion} onChange={(recursiveSubTaskCompletion) => patch({ recursiveSubTaskCompletion })} label={t('settings.dataview_task_recursive')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_result_count')} description={t('settings.dataview_result_count_desc')}>
          <Switch checked={dataview.showResultCount} onChange={(showResultCount) => patch({ showResultCount })} label={t('settings.dataview_result_count')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_empty_warning')} description={t('settings.dataview_empty_warning_desc')}>
          <Switch checked={dataview.warnOnEmptyResult} onChange={(warnOnEmptyResult) => patch({ warnOnEmptyResult })} label={t('settings.dataview_empty_warning')}/>
        </SettingRow>
      </section>

      <section>
        <SettingRow title={t('settings.dataview_table_id')} description={t('settings.dataview_table_id_desc')}>
          <Input className="w-[170px]" value={dataview.tableIdColumnName} maxLength={40} placeholder={DEFAULT_SETTINGS.dataview.tableIdColumnName} onChange={(event) => patch({ tableIdColumnName: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_table_group')} description={t('settings.dataview_table_group_desc')}>
          <Input className="w-[170px]" value={dataview.tableGroupColumnName} maxLength={40} placeholder={DEFAULT_SETTINGS.dataview.tableGroupColumnName} onChange={(event) => patch({ tableGroupColumnName: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_recursion')} description={t('settings.dataview_recursion_desc')}>
          <Slider className="w-[200px]" value={dataview.maxRecursiveRenderDepth} min={1} max={12} step={1} onChange={(maxRecursiveRenderDepth) => patch({ maxRecursiveRenderDepth })} label={t('settings.dataview_recursion')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_export_html')} description={t('settings.dataview_export_html_desc')}>
          <Switch checked={dataview.allowHtmlInExports} onChange={(allowHtmlInExports) => patch({ allowHtmlInExports })} label={t('settings.dataview_export_html')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_null')} description={t('settings.dataview_null_desc')}>
          <Input className="w-[120px]" value={dataview.renderNullAs} maxLength={24} placeholder={DEFAULT_SETTINGS.dataview.renderNullAs} onChange={(event) => patch({ renderNullAs: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_date_format')} description={t('settings.dataview_date_format_desc')}>
          <Input className="w-[170px]" value={dataview.dateFormat} maxLength={40} placeholder={DEFAULT_SETTINGS.dataview.dateFormat} onChange={(event) => patch({ dateFormat: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_datetime_format')} description={t('settings.dataview_datetime_format_desc')}>
          <Input className="w-[170px]" value={dataview.datetimeFormat} maxLength={40} placeholder={DEFAULT_SETTINGS.dataview.datetimeFormat} onChange={(event) => patch({ datetimeFormat: event.target.value })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_duration_format')}>
          <Segmented value={dataview.durationFormat} options={DURATION_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))} onChange={(durationFormat) => patch({ durationFormat })}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_max_rows')} description={t('settings.dataview_max_rows_desc')}>
          <Slider className="w-[200px]" value={dataview.maxRows} min={10} max={2000} step={10} onChange={(maxRows) => patch({ maxRows })} label={t('settings.dataview_max_rows')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_body_limit')} description={t('settings.dataview_body_limit_desc')}>
          <Slider className="w-[200px]" value={dataview.bodyLimit} min={20} max={5000} step={20} onChange={(bodyLimit) => patch({ bodyLimit })} label={t('settings.dataview_body_limit')}/>
        </SettingRow>
        <SettingRow title={t('settings.dataview_index')} description={t('settings.dataview_index_desc', {
          value0: status.parsed,
          value1: status.total,
        })}>
          <Button variant="ghost" icon={<RotateCcw size={14}/>
          } onClick={() => {
            dataviewIndex.sync();
            setStatus(dataviewIndex.getStatus());
          }}>{t('settings.dataview_index_rerun')}</Button>
        </SettingRow>
      </section>

      <section className="space-y-2">
        <SettingRow title={t('settings.dataview_saved')} description={t('settings.dataview_saved_desc')}>
          <Button variant="ghost" icon={<Plus size={14}/>
          } onClick={() => rewriteSaved([...dataview.savedQueries, {
              id: randomLocalId('dvq'),
              name: t('settings.dataview_saved_untitled'),
              query: 'LIST\nSORT file.mtime DESC\nLIMIT 10',
            }])}>{t('settings.dataview_saved_add')}</Button>
        </SettingRow>
        {dataview.savedQueries.map((entry, index) => <div key={entry.id} className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
            <div className="flex items-center gap-2">
              <Input className="min-w-0 flex-1" value={entry.name} maxLength={60} aria-label={t('settings.dataview_saved_name')} onChange={(event) => rewriteSaved(dataview.savedQueries.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}/>
              <Button variant="ghost" icon={<Play size={14}/>
              } disabled={running !== null} onClick={() => void runQuery(entry)}>{t('settings.dataview_saved_run')}</Button>
              <IconButton label={t('settings.dataview_saved_delete')}
                onClick={async () => {
                if (!await confirm({
                    title: t('settings.dataview_saved_delete'),
                    description: t('settings.dataview_saved_delete_confirm'),
                    confirmLabel: t('settings.dataview_saved_delete'),
                    tone: 'danger',
                  })) return;
                rewriteSaved(dataview.savedQueries.filter((item) => item.id !== entry.id));
              }}>
                <Trash2 size={14}/>
              </IconButton>
            </div>
            <textarea aria-label={t('settings.dataview_saved_query')} className="h-24 w-full resize-y rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 font-mono text-[12px] text-[var(--text-primary)]" value={entry.query} maxLength={4000} onChange={(event) => rewriteSaved(dataview.savedQueries.map((item, position) => position === index ? { ...item, query: event.target.value } : item))}/>
          </div>)}
        <div ref={resultRef} className="ink-prose min-h-0 overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2 text-[13px]" aria-live="polite"/>
      </section>
    </div>);
}

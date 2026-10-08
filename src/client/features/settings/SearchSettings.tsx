import { useCallback, useState } from 'react';
import { ScanSearch, Trash2 } from 'lucide-react';
import { DEFAULT_SETTINGS, SEARCH_CUSTOM_PROPERTIES_MAX, SEARCH_DISPLAY_TITLE_MAX, SEARCH_PROPERTY_WEIGHT_RANGE, SEARCH_WEIGHT_RANGE } from '@shared/constants';
import { Button, IconButton } from '../../components/primitives';
import { Input, Segmented, SettingRow, Slider, Switch } from '../../components/form';
import { confirm } from '../../components/overlay';
import { useSession } from '../../store/session';
import { t } from "../../lib/i18n";
import { formatBytes } from '../../lib/time';
import { omnisearchIndexer, useOmnisearchStatus } from '../omnisearch/indexer';
import { clearHistory } from '../omnisearch/history';
function WeightSlider({ label, value, onChange }: {
    label: string;
    value: number;
    onChange: (value: number) => void;
}) {
    return <Slider label={label} className="w-[200px]" value={value} min={SEARCH_WEIGHT_RANGE[0]} max={SEARCH_WEIGHT_RANGE[1]} step={0.5} onChange={onChange}/>;
}

export function SearchSettings() {
    const search = useSession((s) => s.settings.search);
    const update = useSession((s) => s.updateSettings);
    const status = useOmnisearchStatus();
    const [propertyDraft, setPropertyDraft] = useState('');
    const patch = useCallback((next: Partial<typeof search>) => void update({
        search: next,
    }), [update]);
    const rebuild = useCallback(() => void (async () => {
        const ok = await confirm({
            title: t('settings.search_rebuild'),
            description: t('settings.search_rebuild_confirm'),
            confirmLabel: t('settings.search_rebuild'),
        });
        if (ok) await omnisearchIndexer.rebuild();
    })(), []);
    const clearCache = useCallback(() => void (async () => {
        const ok = await confirm({
            title: t('settings.search_clear_cache'),
            description: t('settings.search_clear_cache_confirm'),
            confirmLabel: t('settings.search_clear_cache'),
            tone: 'danger',
        });
        if (!ok) return;
        await omnisearchIndexer.rebuild();
        await clearHistory();
    })(), []);
    return (<div className="space-y-6">
      <section>
        <SettingRow title={t('settings.omnisearch_enabled')} description={t('settings.omnisearch_enabled_desc')}>
          <Switch checked={search.enabled} onChange={(enabled) => patch({
                enabled,
            })} label={t('settings.omnisearch_enabled')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_ribbon_button')} description={t('settings.search_ribbon_button_desc')}>
          <Switch checked={search.ribbonButton} onChange={(ribbonButton) => patch({
                ribbonButton,
            })} label={t('settings.search_ribbon_button')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_show_previous')} description={t('settings.search_show_previous_desc')}>
          <Switch checked={search.showPreviousQueryResults} onChange={(showPreviousQueryResults) => patch({
                showPreviousQueryResults,
            })} label={t('settings.search_show_previous')}/>
        </SettingRow>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-[11.5px] text-[var(--text-tertiary)]">
          <ScanSearch size={14} className="shrink-0 text-[var(--text-quaternary)]"/>
          <span>{t('settings.search_indexed_notes', {
                value0: status.indexed,
                value1: status.available,
            })}</span>
          <span className="text-[var(--text-quaternary)]">{t('settings.search_body_cache', {
                value0: formatBytes(status.bodyBytes),
            })}</span>
          {status.deferred > 0 && (<span className="text-[var(--warning)]">
              {t('settings.search_deferred_notes', {
                    value0: status.deferred,
                })}
            </span>)}
          {status.cacheFailed && <span className="text-[var(--danger)]">{t('settings.search_cache_write_failed')}</span>}
        </div>
      </section>

      <section>
        <h3 data-setting-title={t('settings.search_index_limits')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t('settings.search_index_limits')}
        </h3>
        <SettingRow title={t('settings.search_use_cache')} description={t('settings.search_use_cache_desc')}>
          <Switch checked={search.useCache} onChange={(useCache) => patch({
                useCache,
            })} label={t('settings.search_use_cache')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_max_notes')} description={t('settings.search_max_notes_desc')}>
          <Slider label={t('settings.search_max_notes')} className="w-[200px]" value={search.maxIndexedNotes} min={200} max={20000} step={100} onChange={(maxIndexedNotes) => patch({
                maxIndexedNotes,
            })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_max_chars')} description={t('settings.search_max_chars_desc')}>
          <Slider label={t('settings.search_max_chars')} className="w-[200px]" value={search.maxContentChars} min={2000} max={200000} step={2000} onChange={(maxContentChars) => patch({
                maxContentChars,
            })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_storage')} description={t('settings.search_storage_desc')}>
          <Slider label={t('settings.search_storage')} className="w-[200px]" value={search.indexStorageMb} min={8} max={512} step={8} suffix="MB" onChange={(indexStorageMb) => patch({
                indexStorageMb,
            })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_rebuild')} description={t('settings.search_rebuild_desc')}>
          <Button size="sm" onClick={rebuild} disabled={!search.enabled}>{t('settings.search_rebuild')}</Button>
        </SettingRow>
        <SettingRow title={t('settings.search_clear_cache')} description={t('settings.search_clear_cache_desc')}>
          <Button size="sm" variant="ghost" icon={<Trash2 size={13}/>} onClick={clearCache}>{t('settings.search_clear_cache')}</Button>
        </SettingRow>
      </section>

      <section>
        <h3 data-setting-title={t('settings.search_query_behaviour')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t('settings.search_query_behaviour')}
        </h3>
        <SettingRow title={t('settings.search_fuzziness')} description={t('settings.search_fuzziness_desc')}>
          <Segmented label={t('settings.search_fuzziness')} value={search.fuzziness} onChange={(fuzziness) => patch({
                fuzziness,
            })} options={[
                { value: '0', label: t('settings.search_fuzzy_exact') },
                { value: '1', label: t('settings.search_fuzzy_medium') },
                { value: '2', label: t('settings.search_fuzzy_loose') },
            ]}/>
        </SettingRow>
        <SettingRow title={t('settings.search_simple')} description={t('settings.search_simple_desc')}>
          <Switch checked={search.simpleSearch} onChange={(simpleSearch) => patch({
                simpleSearch,
            })} label={t('settings.search_simple')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_ignore_diacritics')} description={t('settings.search_ignore_diacritics_desc')}>
          <Switch checked={search.ignoreDiacritics} onChange={(ignoreDiacritics) => patch({
                ignoreDiacritics,
            })} label={t('settings.search_ignore_diacritics')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_cjk_bigrams')} description={t('settings.search_cjk_bigrams_desc')}>
          <Switch checked={search.cjkBigrams} onChange={(cjkBigrams) => patch({
                cjkBigrams,
            })} label={t('settings.search_cjk_bigrams')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_pinyin')} description={t('settings.search_pinyin_desc')}>
          <Switch checked={search.pinyinSearch} onChange={(pinyinSearch) => patch({
                pinyinSearch,
            })} label={t('settings.search_pinyin')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_split_camel')} description={t('settings.search_split_camel_desc')}>
          <Switch checked={search.splitCamelCase} onChange={(splitCamelCase) => patch({
                splitCamelCase,
            })} label={t('settings.search_split_camel')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_hide_archived')} description={t('settings.search_hide_archived_desc')}>
          <Switch checked={search.hideArchived} onChange={(hideArchived) => patch({
                hideArchived,
            })} label={t('settings.search_hide_archived')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_downranked')} description={t('settings.search_downranked_desc')}>
          <Input className="w-[260px] max-w-full" aria-label={t('settings.search_downranked')} value={search.downrankedFolders.join(', ')} placeholder={t('settings.search_downranked_placeholder')} onChange={(event) => patch({
                downrankedFolders: event.target.value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 40),
            })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_recency')} description={t('settings.search_recency_desc')}>
          <Segmented label={t('settings.search_recency')} value={search.recencyBoost} onChange={(recencyBoost) => patch({
                recencyBoost,
            })} options={[
                { value: 'disabled', label: t('settings.search_recency_off') },
                { value: 'day', label: t('settings.search_recency_day') },
                { value: 'week', label: t('settings.search_recency_week') },
                { value: 'month', label: t('settings.search_recency_month') },
            ]}/>
        </SettingRow>
      </section>

      <section>
        <h3 data-setting-title={t('settings.search_results_presentation')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t('settings.search_results_presentation')}
        </h3>
        <SettingRow title={t('settings.search_show_excerpt')} description={t('settings.search_show_excerpt_desc')}>
          <Switch checked={search.showExcerpt} onChange={(showExcerpt) => patch({
                showExcerpt,
            })} label={t('settings.search_show_excerpt')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_plain_excerpt')} description={t('settings.search_plain_excerpt_desc')}>
          <Switch checked={search.plainExcerpt} onChange={(plainExcerpt) => patch({
                plainExcerpt,
            })} label={t('settings.search_plain_excerpt')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_line_returns')} description={t('settings.search_line_returns_desc')}>
          <Switch checked={search.renderLineReturnInExcerpts} onChange={(renderLineReturnInExcerpts) => patch({
                renderLineReturnInExcerpts,
            })} label={t('settings.search_line_returns')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_max_results')} description={t('settings.search_max_results_desc')}>
          <Slider label={t('settings.search_max_results')} className="w-[200px]" value={search.maxResults} min={10} max={100} step={5} onChange={(maxResults) => patch({
                maxResults,
            })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_max_embeds')} description={t('settings.search_max_embeds_desc')}>
          <Slider label={t('settings.search_max_embeds')} className="w-[200px]" value={search.maxEmbeds} min={0} max={10} step={1} onChange={(maxEmbeds) => patch({
                maxEmbeds,
            })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_create_button')} description={t('settings.search_create_button_desc')}>
          <Switch checked={search.showCreateButton} onChange={(showCreateButton) => patch({
                showCreateButton,
            })} label={t('settings.search_create_button')}/>
        </SettingRow>
        <SettingRow title={t('settings.search_display_title')} description={t('settings.search_display_title_desc')}>
          <Input className="w-[200px] max-w-full" aria-label={t('settings.search_display_title')} value={search.displayTitleProperty} maxLength={SEARCH_DISPLAY_TITLE_MAX} placeholder={t('settings.search_display_title_placeholder')} onChange={(event) => patch({
                displayTitleProperty: event.target.value,
            })}/>
        </SettingRow>
      </section>

      <section>
        <h3 data-setting-title={t('settings.search_weighting')} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {t('settings.search_weighting')}
        </h3>
        <SettingRow title={t('settings.search_weight_title')} description={t('settings.search_weight_default', {
                value0: DEFAULT_SETTINGS.search.weightTitle,
            })}>
          <WeightSlider label={t('settings.search_weight_title')} value={search.weightTitle} onChange={(weightTitle) => patch({
                    weightTitle,
                })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_weight_folder')} description={t('settings.search_weight_default', {
                value0: DEFAULT_SETTINGS.search.weightFolder,
            })}>
          <WeightSlider label={t('settings.search_weight_folder')} value={search.weightFolder} onChange={(weightFolder) => patch({
                    weightFolder,
                })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_weight_h1')} description={t('settings.search_weight_default', {
                value0: DEFAULT_SETTINGS.search.weightH1,
            })}>
          <WeightSlider label={t('settings.search_weight_h1')} value={search.weightH1} onChange={(weightH1) => patch({
                    weightH1,
                })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_weight_h2')} description={t('settings.search_weight_default', {
                value0: DEFAULT_SETTINGS.search.weightH2,
            })}>
          <WeightSlider label={t('settings.search_weight_h2')} value={search.weightH2} onChange={(weightH2) => patch({
                    weightH2,
                })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_weight_h3')} description={t('settings.search_weight_default', {
                value0: DEFAULT_SETTINGS.search.weightH3,
            })}>
          <WeightSlider label={t('settings.search_weight_h3')} value={search.weightH3} onChange={(weightH3) => patch({
                    weightH3,
                })}/>
        </SettingRow>
        <SettingRow title={t('settings.search_weight_tags')} description={t('settings.search_weight_default', {
                value0: DEFAULT_SETTINGS.search.weightTags,
            })}>
          <WeightSlider label={t('settings.search_weight_tags')} value={search.weightTags} onChange={(weightTags) => patch({
                    weightTags,
                })}/>
        </SettingRow>

        <SettingRow title={t('settings.search_weight_properties')} description={t('settings.search_weight_properties_desc')}>
          <div className="flex w-[300px] max-w-full flex-col gap-2">
            {search.weightCustomProperties.map((item, index) => (<div key={index} className="flex items-center gap-2">
                <Input className="min-w-0 flex-1" aria-label={t('settings.search_weight_property_name')} value={item.name} onChange={(event) => {
                    const next = [...search.weightCustomProperties];
                    next[index] = {
                        ...item,
                        name: event.target.value,
                    };
                    patch({
                        weightCustomProperties: next,
                    });
                }}/>
                <span className="shrink-0 text-[11px] tabular text-[var(--text-quaternary)]">×{item.weight.toFixed(1)}</span>
                <Slider className="w-[90px] shrink-0" label={t('settings.search_weight_property_name')} value={item.weight} min={SEARCH_PROPERTY_WEIGHT_RANGE[0]} max={SEARCH_PROPERTY_WEIGHT_RANGE[1]} step={0.1} onChange={(weight) => {
                    const next = [...search.weightCustomProperties];
                    next[index] = {
                        ...item,
                        weight,
                    };
                    patch({
                        weightCustomProperties: next,
                    });
                }}/>
                <IconButton label={t('common.delete')} size="sm" onClick={() => {
                    const next = search.weightCustomProperties.filter((_, at) => at !== index);
                    patch({
                        weightCustomProperties: next,
                    });
                }}>
                  <Trash2 size={13}/>
                </IconButton>
              </div>))}
            <div className="flex items-center gap-2">
              <Input className="min-w-0 flex-1" aria-label={t('settings.search_weight_property_name')} value={propertyDraft} placeholder={t('settings.search_weight_property_placeholder')} onChange={(event) => setPropertyDraft(event.target.value)}/>
              <Button size="sm" disabled={!propertyDraft.trim() || search.weightCustomProperties.length >= SEARCH_CUSTOM_PROPERTIES_MAX} onClick={() => {
                    patch({
                        weightCustomProperties: [...search.weightCustomProperties, {
                                name: propertyDraft.trim().slice(0, 40),
                                weight: 1,
                            }],
                    });
                    setPropertyDraft('');
                }}>{t('settings.search_weight_property_add')}</Button>
            </div>
          </div>
        </SettingRow>
      </section>
    </div>);
}

import { useCallback, useMemo, useRef, useState } from 'react'
import { DEFAULT_NEW_NOTE_TEMPLATE, NEW_NOTE_TEMPLATE_MAX_LENGTH } from '@shared/constants'
import { NEW_NOTE_PLACEHOLDERS } from '@shared/note-template-render'
import { renderNewNoteTemplate } from '@shared/note-template-render'
import { Input, SettingRow, Switch, Textarea } from '../../components/form'
import { Button } from '../../components/primitives'
import { confirm } from '../../components/overlay'
import { useSession } from '../../store/session'
import { t, useLocale } from '../../lib/i18n'
import { splitTagInput } from '../templates/gallery-persist'

export function NotesSettings() {
  const notes = useSession((s) => s.settings.notes);
  const update = useSession((s) => s.updateSettings);
  const setTemplate = useCallback((newNoteTemplate: string) => void update({ notes: { newNoteTemplate } }), [update]);
  const restoreDefault = useCallback(() => {
    void (async () => {
      const ok = await confirm({
        title: t('settings.restore_default_template'),
        description: t('settings.restore_default_template_confirm'),
        confirmLabel: t('settings.restore_default_template'),
      })
      if (ok) await update({ notes: { newNoteTemplate: DEFAULT_NEW_NOTE_TEMPLATE } })
    })()
  }, [update]);
  const setSyncTitleToFrontMatter = useCallback((syncTitleToFrontMatter: boolean) => void update({ notes: { syncTitleToFrontMatter } }), [update]);
  const setSyncFrontMatterTitle = useCallback((syncFrontMatterTitle: boolean) => void update({ notes: { syncFrontMatterTitle } }), [update]);
  const isDefault = notes.newNoteTemplate === DEFAULT_NEW_NOTE_TEMPLATE;
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const insertPlaceholder = useCallback((placeholder: string) => {
    const field = templateRef.current;
    const token = `{{${placeholder}}}`;
    const value = notes.newNoteTemplate;
    const at = field ? field.selectionStart : value.length;
    const end = field ? field.selectionEnd : value.length;
    const room = NEW_NOTE_TEMPLATE_MAX_LENGTH - value.length + (end - at);
    if (room <= 0) return;
    const text = token.slice(0, room);
    setTemplate(value.slice(0, at) + text + value.slice(end));
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      field.setSelectionRange(at + text.length, at + text.length);
    });
  }, [notes.newNoteTemplate, setTemplate]);
  return (<div className="space-y-6">
    <section>
      <SettingRow title={t("settings.new_note_template")} description={t("settings.new_note_template_description")}>
        <div className="flex w-[340px] max-w-full flex-col items-end gap-2">
          <Textarea
            ref={templateRef}
            aria-label={t("settings.new_note_template")}
            value={notes.newNoteTemplate}
            onChange={(event) => setTemplate(event.target.value)}
            maxLength={NEW_NOTE_TEMPLATE_MAX_LENGTH}
            rows={10}
            spellCheck={false}
            className="w-full font-mono text-[12.5px]"/>
          <div className="flex w-full flex-wrap justify-end gap-1">
            {NEW_NOTE_PLACEHOLDERS.map((placeholder) => (<button
              key={placeholder}
              type="button"
              onClick={() => insertPlaceholder(placeholder)}
              className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-1.5 py-px font-mono text-[10.5px] text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]">
              {`{{${placeholder}}}`}
            </button>))}
          </div>
          <p className="w-full text-right text-[10.5px] text-[var(--text-quaternary)]">{t("templates.placeholders_hint")}</p>
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-[10.5px] tabular text-[var(--text-quaternary)]">
              {t("settings.new_note_template_characters", {
                value0: notes.newNoteTemplate.length,
                value1: NEW_NOTE_TEMPLATE_MAX_LENGTH,
              })}
            </span>
            <Button size="sm" variant="ghost" onClick={restoreDefault} disabled={isDefault}>
              {t("settings.restore_default_template")}
            </Button>
          </div>
        </div>
      </SettingRow>
      <p className="pt-3 text-[11.5px] leading-relaxed text-[var(--text-quaternary)]">
        {t("settings.new_note_template_hint")}
      </p>
      <TemplatePreview template={notes.newNoteTemplate}/>
    </section>

    <section>
      <h3 data-setting-title={t("settings.title_sync")} className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {t("settings.title_sync")}
      </h3>
      <SettingRow title={t("settings.sync_title_to_frontmatter")} description={t("settings.sync_title_to_frontmatter_desc")}>
        <Switch checked={notes.syncTitleToFrontMatter} onChange={setSyncTitleToFrontMatter} label={t("settings.sync_title_to_frontmatter")}/>
      </SettingRow>
      <SettingRow title={t("settings.sync_frontmatter_title")} description={t("settings.sync_frontmatter_title_desc")}>
        <Switch checked={notes.syncFrontMatterTitle} onChange={setSyncFrontMatterTitle} label={t("settings.sync_frontmatter_title")}/>
      </SettingRow>
    </section>
  </div>);
}

function TemplatePreview({ template }: { template: string }) {
  const locale = useLocale();
  const [demoTitle, setDemoTitle] = useState('');
  const [demoFolder, setDemoFolder] = useState('');
  const [demoTag, setDemoTag] = useState('');
  const preview = useMemo(() => {
    const tags = splitTagInput(demoTag);
    return renderNewNoteTemplate(
      template,
      {
        title: demoTitle.trim() || t('common.new_note'),
        folder: demoFolder.trim(),
        tags: tags.join(', '),
      },
      tags,
    );
  }, [template, demoTitle, demoFolder, demoTag, locale]);
  const hasContextualPlaceholders = template.includes('{{folder}}') || template.includes('{{tags}}');
  return (
    <div className="mt-4">
      <h3 data-setting-title={t("settings.new_note_template_preview")} className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {t("settings.new_note_template_preview")}
      </h3>
      <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Input aria-label={t("settings.template_preview_title")} placeholder={t("settings.template_preview_title")} value={demoTitle} onChange={(event) => setDemoTitle(event.target.value)}/>
        <Input aria-label={t("settings.template_preview_folder")} placeholder={t("settings.template_preview_folder")} value={demoFolder} onChange={(event) => setDemoFolder(event.target.value)}/>
        <Input aria-label={t("settings.template_preview_tag")} placeholder={t("settings.template_preview_tag")} value={demoTag} onChange={(event) => setDemoTag(event.target.value)}/>
      </div>
      <pre className="max-h-[208px] overflow-auto whitespace-pre rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text-secondary)]">{preview.cursor === null ? preview.content : (<>
        {preview.content.slice(0, preview.cursor)}
        <span aria-hidden="true" className="mx-px inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-[var(--accent)] align-middle"/>
        {preview.content.slice(preview.cursor)}
      </>)}</pre>
      {hasContextualPlaceholders && (<p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-quaternary)]">
        {t("settings.template_preview_context")}
      </p>)}
    </div>
  );
}

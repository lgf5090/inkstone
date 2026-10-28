/** Inknote's own settings, kept out of the account-wide settings panel. */
import { useState } from 'react'
import type { InknoteNoteMeta, InknotePaperStyle, InknoteSettings } from '@shared/inknote/types'
import { APP_VERSION } from '@shared/constants'
import { PAPER_COLORS, PAPER_STYLES } from '@shared/inknote/constants'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Drawer, confirm } from '../../../components/overlay'
import { Segmented, SettingRow, Slider, Switch } from '../../../components/form'
import { useInknoteStore } from '../store'

const SECTIONS = [
  ['tools', 'inknote.settings.tools'],
  ['paper', 'inknote.settings.paper'],
  ['gestures', 'inknote.settings.gestures'],
  ['data', 'inknote.settings.data'],
  ['about', 'inknote.settings.about'],
] as const

export function SettingsDrawer({ open, onClose, note, settings, onOpenSnapshots }: {
  open: boolean
  onClose: () => void
  note: InknoteNoteMeta | null
  settings: InknoteSettings
  onOpenSnapshots: () => void
}) {
  const [section, setSection] = useState<string>('tools')
  const updateSettings = useInknoteStore((state) => state.updateSettings)
  const resetSettings = useInknoteStore((state) => state.resetSettings)
  const updateNoteMeta = useInknoteStore((state) => state.updateNoteMeta)
  const paper = note?.paper ?? settings.defaultPaper
  const setPaper = (patch: Partial<InknoteNoteMeta['paper']>) => {
    if (!note) return
    void updateNoteMeta({ paper: { ...note.paper, ...patch } })
  }
  return (
    <Drawer open={open} onClose={onClose} title={t('inknote.settings.title')} width={430}>
      <div className="flex min-h-0 flex-1">
        <nav className="w-32 shrink-0 border-r border-[var(--border-subtle)] p-2" aria-label={t('inknote.settings.title')}>
          {SECTIONS.map(([id, key]) => (
            <button key={id} type="button" onClick={() => setSection(id)} className={cn('mb-0.5 block w-full rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12)]', section === id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'hover:bg-[var(--bg-hover)]')}>{t(key as MessageKey)}</button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-3 pb-6">
          {section === 'tools' && (
            <div>
              <SettingRow title={t('inknote.settings.finger_draw')}><Switch checked={settings.fingerDraw} onChange={(value) => void updateSettings({ fingerDraw: value })} label={t('inknote.settings.finger_draw')} /></SettingRow>
              <SettingRow title={t('inknote.settings.auto_page')}><Switch checked={settings.autoPage} onChange={(value) => void updateSettings({ autoPage: value })} label={t('inknote.settings.auto_page')} /></SettingRow>
              <SettingRow title={t('inknote.settings.text_size')}><Slider value={settings.textSize} min={12} max={72} step={1} onChange={(value) => void updateSettings({ textSize: value })} label={t('inknote.settings.text_size')} className="w-40" /></SettingRow>
              <SettingRow title={t('inknote.settings.font')}><Segmented value={settings.fontFamily} options={([['system', 'inknote.settings.system'], ['rounded', 'inknote.settings.rounded'], ['serif', 'inknote.settings.serif'], ['mono', 'inknote.settings.mono']] as const).map(([value, key]) => ({ value, label: t(key) }))} onChange={(value) => void updateSettings({ fontFamily: value })} label={t('inknote.settings.font')} /></SettingRow>
              <SettingRow title={t('inknote.settings.stroke_width')}><Slider value={settings.penWidth} min={1} max={30} step={0.5} onChange={(value) => void updateSettings({ penWidth: value, ballpenWidth: value })} label={t('inknote.settings.stroke_width')} className="w-40" /></SettingRow>
            </div>
          )}
          {section === 'paper' && (
            <div>
              <SettingRow title={t('inknote.settings.paper')}>
                <div className="flex max-w-[240px] flex-wrap justify-end gap-1">
                  {PAPER_STYLES.map((style) => (
                    <button key={style.id} type="button" aria-label={t(style.nameKey as MessageKey)} aria-pressed={paper.style === style.id} onClick={() => setPaper({ style: style.id as InknotePaperStyle })} className={cn('h-8 w-8 rounded-[var(--r-xs)] border text-[length:var(--text-10)]', paper.style === style.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-default)]')}>{style.id.slice(0, 2)}</button>
                  ))}
                </div>
              </SettingRow>
              <SettingRow title={t('inknote.text.color')}>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {PAPER_COLORS.map((color) => (
                    <button key={color.id} type="button" aria-label={t(color.nameKey as MessageKey)} aria-pressed={paper.color === color.id} onClick={() => setPaper({ color: color.id })} className={cn('size-6 rounded-full ring-1 ring-[var(--border-default)]', paper.color === color.id && 'ring-2 ring-[var(--accent)]')} style={{ background: color.bg }} />
                  ))}
                </div>
              </SettingRow>
              <SettingRow title={t('inknote.settings.spacing')}><Segmented value={paper.spacing} options={([['tight', 'inknote.settings.tight'], ['normal', 'inknote.settings.normal'], ['wide', 'inknote.settings.wide']] as const).map(([value, key]) => ({ value, label: t(key) }))} onChange={(value) => setPaper({ spacing: value })} label={t('inknote.settings.spacing')} /></SettingRow>
              <SettingRow title={t('inknote.settings.page_size')}>
                <Segmented value={(note?.pageWidth ?? 816) > (note?.pageHeight ?? 1056) ? 'wide' : 'standard'} options={[{ value: 'standard', label: t('inknote.settings.standard') }, { value: 'wide', label: t('inknote.settings.wide') }]} onChange={(value) => {
                  if (!note) return
                  void updateNoteMeta(value === 'wide' ? { pageWidth: 1056, pageHeight: 816 } : { pageWidth: 816, pageHeight: 1056 })
                }} label={t('inknote.settings.page_size')} />
              </SettingRow>
            </div>
          )}
          {section === 'gestures' && (
            <div>
              <SettingRow title={t('inknote.settings.two_finger')}><Segmented value={settings.twoFingerAction} options={([['undo', 'inknote.gesture.undo'], ['redo', 'inknote.gesture.redo'], ['off', 'inknote.gesture.off']] as const).map(([value, key]) => ({ value, label: t(key) }))} onChange={(value) => void updateSettings({ twoFingerAction: value })} label={t('inknote.settings.two_finger')} /></SettingRow>
              <SettingRow title={t('inknote.settings.three_finger')}><Segmented value={settings.threeFingerAction} options={([['redo', 'inknote.gesture.redo'], ['off', 'inknote.gesture.off']] as const).map(([value, key]) => ({ value, label: t(key) }))} onChange={(value) => void updateSettings({ threeFingerAction: value })} label={t('inknote.settings.three_finger')} /></SettingRow>
              <SettingRow title={t('inknote.settings.toolbar')}><Segmented value={settings.toolbar} options={([['top', 'inknote.settings.top'], ['left', 'inknote.settings.left'], ['bottom', 'inknote.settings.bottom']] as const).map(([value, key]) => ({ value, label: t(key) }))} onChange={(value) => void updateSettings({ toolbar: value })} label={t('inknote.settings.toolbar')} /></SettingRow>
            </div>
          )}
          {section === 'data' && (
            <div>
              <SettingRow title={t('inknote.settings.auto_backup')}><Switch checked={settings.autoBackup} onChange={(value) => void updateSettings({ autoBackup: value })} label={t('inknote.settings.auto_backup')} /></SettingRow>
              <div className="space-y-1 pt-2">
                <Button block variant="secondary" onClick={onOpenSnapshots}>{t('inknote.settings.snapshots')}</Button>
                <Button block variant="ghost" onClick={() => void confirm({ title: t('inknote.settings.cleanup'), confirmLabel: t('inknote.settings.cleanup') }).then((ok) => ok ? inknotePrune() : undefined)}>{t('inknote.settings.cleanup')}</Button>
              </div>
            </div>
          )}
          {section === 'about' && (
            <div className="space-y-2 pt-2 text-[length:var(--text-12)]">
              <SettingRow title={t('inknote.settings.version')}><span className="text-[var(--text-tertiary)]">{APP_VERSION}</span></SettingRow>
              <Button block variant="ghost" onClick={() => void confirm({ title: t('inknote.settings.reset'), description: t('inknote.settings.reset_confirm'), confirmLabel: t('inknote.settings.reset') }).then((ok) => ok ? resetSettings() : undefined)}>{t('inknote.settings.reset')}</Button>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}

async function inknotePrune(): Promise<void> {
  const { inknoteApi } = await import('../api')
  await inknoteApi.pruneAssets()
}

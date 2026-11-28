import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { ProjectIntakeConfig, ProjectProperty, ProjectShare } from '@shared/project/model'
import { PROJECT_INTAKE_PROPERTY_TYPES } from '@shared/project/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { projectInputToStamp, projectStampToInput } from '@shared/project/date'
import { confirm, Modal } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { deleteProjectShare, getProjectShare, putProjectShare } from './api'

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export function ShareDialog({ boardId, properties = [], onClose }: { boardId: string, properties?: ProjectProperty[], onClose: () => void }): ReactElement {
  const [share, setShare] = useState<ProjectShare | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [intakeTitle, setIntakeTitle] = useState('')
  const toast = useUi((state) => state.toast)

  const load = useCallback(() => {
    setLoaded(false)
    setFailed(false)
    getProjectShare(boardId)
      .then((result) => {
        setShare(result)
        setExpiresAt(result?.expiresAt ? projectStampToInput(result.expiresAt) : '')
        setIntakeTitle(result?.intake.title ?? '')
        setLoaded(true)
      })
      .catch((reason: unknown) => {
        setFailed(true)
        setLoaded(true)
        toast({ title: errorText(reason), tone: 'danger' })
      })
  }, [boardId, toast])

  useEffect(load, [load])

  const guard = useCallback(async (action: () => Promise<void>) => {
    try { await action() } catch (reason) { toast({ title: errorText(reason), tone: 'danger' }) }
  }, [toast])

  const saveIntake = (next: ProjectIntakeConfig): void => {
    void guard(async () => { setShare(await putProjectShare(boardId, { intake: next })) })
  }

  const link = share ? `${window.location.origin}/p/${share.slug}` : ''
  const intakeProperties = properties.filter((property) => PROJECT_INTAKE_PROPERTY_TYPES.includes(property.type))

  return (
    <Modal open onClose={onClose} title={t('project.share.title')} width={480}>
      {!loaded
        ? <LoadingBlock />
        : failed
          ? (
              <div className="space-y-3">
                <p role="alert" className="text-[length:var(--text-13)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
                <Button size="sm" onClick={load}>{t('project.common.retry')}</Button>
              </div>
            )
          : !share
            ? (
                <div className="space-y-3">
                  <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('project.share.not_shared')}</p>
                  <Button variant="primary" onClick={() => void guard(async () => { setShare(await putProjectShare(boardId, {})) })}>{t('project.share.enable')}</Button>
                </div>
              )
            : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Input className="min-w-0 flex-1" readOnly value={link} aria-label={t('project.share.link')} />
                  <Button
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(link)
                        .then(() => toast({ title: t('project.share.copy'), tone: 'success' }))
                        .catch(() => toast({ title: t('project.card.copy_link_failed'), tone: 'danger' }))
                    }}
                  >
                    {t('project.share.copy')}
                  </Button>
                </div>
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.share.views', { count: share.views })}</p>
                <DatePicker
                  label={t('project.share.expires')}
                  value={expiresAt}
                  onChange={(raw) => {
                    setExpiresAt(raw)
                    void guard(async () => {
                      const next = raw ? projectInputToStamp(raw) : null
                      setShare(await putProjectShare(boardId, { expiresAt: next }))
                    })
                  }}
                />
                <Checkbox
                  label={t('project.share.show_comments')}
                  checked={share.showComments}
                  onChange={(checked) => { void guard(async () => { setShare(await putProjectShare(boardId, { showComments: checked })) }) }}
                />
                <section className="space-y-2 border-t border-[var(--border-subtle)] pt-3" aria-label={t('project.intake.title')}>
                  <Checkbox
                    label={t('project.intake.enable')}
                    checked={share.intake.enabled}
                    onChange={(enabled) => saveIntake({ ...share.intake, enabled })}
                  />
                  {share.intake.enabled && (
                    <>
                      <Checkbox
                        label={t('project.intake.editable')}
                        checked={share.intake.editable}
                        onChange={(editable) => saveIntake({ ...share.intake, editable })}
                      />
                      <Input
                        className="w-full"
                        value={intakeTitle}
                        placeholder={t('project.intake.title')}
                        aria-label={t('project.intake.title')}
                        onChange={(event) => setIntakeTitle(event.target.value)}
                        onBlur={() => { if (intakeTitle !== share.intake.title) saveIntake({ ...share.intake, title: intakeTitle }) }}
                      />
                      {intakeProperties.length === 0
                        ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.intake.no_fields')}</p>
                        : intakeProperties.map((property) => {
                            const included = share.intake.propertyIds.includes(property.id)
                            const required = share.intake.requiredPropertyIds.includes(property.id)
                            return (
                              <div key={property.id} className="flex flex-wrap items-center gap-3">
                                <Checkbox
                                  label={property.name}
                                  checked={included}
                                  onChange={(checked) => saveIntake({
                                    ...share.intake,
                                    propertyIds: checked ? [...share.intake.propertyIds, property.id] : share.intake.propertyIds.filter((id) => id !== property.id),
                                    requiredPropertyIds: checked ? share.intake.requiredPropertyIds : share.intake.requiredPropertyIds.filter((id) => id !== property.id),
                                  })}
                                />
                                {included && (
                                  <Checkbox
                                    label={t('project.intake.required')}
                                    checked={required}
                                    onChange={(checked) => saveIntake({
                                      ...share.intake,
                                      requiredPropertyIds: checked ? [...share.intake.requiredPropertyIds, property.id] : share.intake.requiredPropertyIds.filter((id) => id !== property.id),
                                    })}
                                  />
                                )}
                              </div>
                            )
                          })}
                    </>
                  )}
                </section>
                <div className="flex justify-center rounded-[var(--r-md)] bg-[var(--plate-lightest)] p-3"><QRCodeSVG value={link} size={120} /></div>
                {!share.hasPassword && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const feed = `${window.location.origin}/api/project/public/${encodeURIComponent(share.slug)}/calendar.ics`
                      void navigator.clipboard.writeText(feed)
                        .then(() => toast({ title: t('project.share.calendar_copied'), tone: 'success' }))
                        .catch(() => toast({ title: t('project.card.copy_link_failed'), tone: 'danger' }))
                    }}
                  >
                    {t('project.share.calendar')}
                  </Button>
                )}
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!password.trim()) return
                    void guard(async () => { setShare(await putProjectShare(boardId, { password })); setPassword('') })
                  }}
                >
                  <Input className="min-w-0 flex-1" type="password" value={password} placeholder={t('project.share.password')} aria-label={t('project.share.password')} onChange={(event) => setPassword(event.target.value)} />
                  <Button type="submit" size="sm" disabled={!password.trim()}>{t('common.save')}</Button>
                </form>
                <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                  {share.hasPassword ? t('project.share.password_protected') : t('project.share.password_set_hint')}
                </p>
                {share.hasPassword && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      void guard(async () => {
                        const ok = await confirm({
                          title: t('project.share.remove_password_confirm'),
                          description: t('project.share.password_hint'),
                          tone: 'danger',
                          confirmLabel: t('project.share.remove_password'),
                        })
                        if (!ok) return
                        setShare(await putProjectShare(boardId, { password: null }))
                      })
                    }}
                  >
                    {t('project.share.remove_password')}
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    void guard(async () => {
                      const ok = await confirm({ title: t('project.share.disable'), tone: 'danger', confirmLabel: t('project.share.disable') })
                      if (!ok) return
                      await deleteProjectShare(boardId)
                      setShare(null)
                    })
                  }}
                >
                  {t('project.share.disable')}
                </Button>
              </div>
            )}
    </Modal>
  )
}
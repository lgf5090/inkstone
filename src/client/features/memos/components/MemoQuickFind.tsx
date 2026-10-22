import { useId, useState, type FormEvent, type ReactElement } from 'react'
import { Braces, Search } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { Field, Input, Segmented } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'
import { memoErrorMessage } from '../errors'
import { navigateMemoUrl, type MemoUrlState } from '../url-state'

type QuickFindMode = 'text' | 'cel'

interface QuickFindFailure {
  message: string
  position: number | null
}

export interface MemoQuickFindProps {
  open: boolean
  query: Pick<MemoUrlState, 'q' | 'filter'>
  onClose: () => void
}

/**
 * One dialog for both spellings of a lookup: plain words land in `q`, an expression lands in `filter`
 * only after the server's own validator accepts it.
 */
export function MemoQuickFind({ open, query, onClose }: MemoQuickFindProps): ReactElement {
  const formId = useId()
  const [mode, setMode] = useState<QuickFindMode>(query.q.trim() || !query.filter.trim() ? 'text' : 'cel')
  const [text, setText] = useState(query.q)
  const [expression, setExpression] = useState(query.filter)
  const [checking, setChecking] = useState(false)
  const [failure, setFailure] = useState<QuickFindFailure | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (checking) return
    const value = (mode === 'text' ? text : expression).trim()
    setFailure(null)
    if (!value) {
      setFailure({ message: t('memos.quick_find.required'), position: null })
      return
    }
    if (mode === 'cel') {
      setChecking(true)
      try {
        const result = await memosApi.views.validate(value)
        if (!result.ok) {
          setFailure({
            message: result.error?.message ?? t('memos.views.filter_invalid'),
            position: result.error?.position ?? null,
          })
          return
        }
      } catch (error) {
        setFailure({ message: memoErrorMessage(error), position: null })
        return
      } finally {
        setChecking(false)
      }
    }
    const params = new URLSearchParams(window.location.search)
    params.delete('q')
    params.delete('filter')
    params.set(mode === 'text' ? 'q' : 'filter', value)
    navigateMemoUrl(window.location.pathname, params.toString())
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!checking}
      title={t('memos.quick_find.title')}
      description={t('memos.quick_find.description')}
      width={520}
      footer={(
        <>
          <Button variant="ghost" disabled={checking} onClick={onClose}>{t('memos.common.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" loading={checking}>
            {checking ? t('memos.quick_find.checking') : t('memos.quick_find.submit')}
          </Button>
        </>
      )}
    >
      <form id={formId} onSubmit={(event) => void submit(event)} className="space-y-3">
        <Segmented
          value={mode}
          size="sm"
          label={t('memos.quick_find.mode')}
          options={[
            { value: 'text', label: t('memos.quick_find.mode_text') },
            { value: 'cel', label: t('memos.quick_find.mode_cel') },
          ]}
          onChange={(next) => {
            setMode(next)
            setFailure(null)
          }}
        />
        {mode === 'text' ? (
          <Field label={t('memos.quick_find.text_label')} hint={t('memos.quick_find.text_hint')}>
            <Input
              data-autofocus
              type="search"
              value={text}
              leading={<Search size={13} />}
              invalid={failure !== null}
              placeholder={t('memos.quick_find.text_placeholder')}
              onChange={(event) => {
                setText(event.target.value)
                setFailure(null)
              }}
              className="[&::-webkit-search-cancel-button]:hidden"
            />
          </Field>
        ) : (
          <Field label={t('memos.quick_find.cel_label')} hint={t('memos.quick_find.cel_hint')}>
            <Input
              data-autofocus
              value={expression}
              leading={<Braces size={13} />}
              invalid={failure !== null}
              placeholder={t('memos.quick_find.cel_placeholder')}
              onChange={(event) => {
                setExpression(event.target.value)
                setFailure(null)
              }}
              className="font-mono text-[length:var(--text-12)]"
            />
          </Field>
        )}
        {failure ? (
          <div role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
            <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
              {failure.message}
            </p>
            {failure.position !== null ? (
              <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                {t('memos.views.validation_position', { position: failure.position + 1 })}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  )
}

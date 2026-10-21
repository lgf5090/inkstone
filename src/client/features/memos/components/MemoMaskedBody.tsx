import { useId, useState, type ReactElement } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { MemoBody, type MemoBodyProps } from './MemoBody'

export interface MemoMaskedBodyProps extends MemoBodyProps {
  blurred: boolean
}

export function MemoMaskedBody({
  blurred,
  className,
  ...body
}: MemoMaskedBodyProps): ReactElement {
  const [revealed, setRevealed] = useState(false)
  const bodyId = useId()
  const hidden = blurred && !revealed
  return (
    <div className={cn('relative min-w-0', className)} data-memo-blurred={blurred ? 'true' : undefined}>
      <div
        id={bodyId}
        data-memo-mask={hidden ? 'hidden' : 'revealed'}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        className={cn(hidden && 'select-none blur-[6px]')}
      >
        <MemoBody {...body} />
      </div>
      {blurred ? (
        <div className={cn(hidden ? 'absolute inset-0 flex items-center justify-center' : 'mt-2 flex justify-end')}>
          <Button
            size="sm"
            variant={hidden ? 'secondary' : 'ghost'}
            icon={hidden ? <Eye size={13} /> : <EyeOff size={13} />}
            aria-expanded={!hidden}
            aria-controls={bodyId}
            onClick={() => setRevealed((value) => !value)}
          >
            {hidden ? t('memos.blur.reveal') : t('memos.blur.hide')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

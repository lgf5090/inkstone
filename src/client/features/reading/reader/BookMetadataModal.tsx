import { useId, useState } from 'react'
import { Modal } from '../../../components/overlay'
import { Button } from '../../../components/primitives'
import { Input, Slider } from '../../../components/form'
import { t } from '../../../lib/i18n'
import type { BookMetadata, BookRecord } from '../types'

export function BookMetadataModal({ book, onClose, onSave }: { book: BookRecord; onClose: () => void; onSave: (author: string, metadata: BookMetadata) => void | Promise<void> }) {
  const id = useId()
  const [author, setAuthor] = useState(book.author)
  const [series, setSeries] = useState(book.metadata?.series ?? '')
  const [rating, setRating] = useState(book.metadata?.rating ?? 0)
  const [tags, setTags] = useState(book.metadata?.tags?.join(', ') ?? '')
  const save = async () => {
    await onSave(author.trim(), {
      series: series.trim(),
      rating,
      tags: [...new Set(tags.split(/[,\uFF0C]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
    })
    onClose()
  }
  return (
    <Modal open onClose={onClose} title={t('reading.edit_metadata')} width={480}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={save}>{t('common.save')}</Button></>}>
      <div className="flex flex-col gap-4 p-4">
        <label className="flex flex-col gap-1" htmlFor={`${id}-author`}>
          <span>{t('reading.author')}</span>
          <Input id={`${id}-author`} value={author} onChange={(event) => setAuthor(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1" htmlFor={`${id}-series`}>
          <span>{t('reading.series')}</span>
          <Input id={`${id}-series`} value={series} onChange={(event) => setSeries(event.target.value)} />
        </label>
        <Slider label={t('reading.rating')} value={rating} min={0} max={5} step={0.5} onChange={setRating} suffix="★" />
        <label className="flex flex-col gap-1" htmlFor={`${id}-tags`}>
          <span>{t('reading.tags')}</span>
          <Input id={`${id}-tags`} value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
      </div>
    </Modal>
  )
}

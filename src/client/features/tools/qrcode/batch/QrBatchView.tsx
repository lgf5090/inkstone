import React, { useState } from 'react'
import {
  Archive,
  CheckCircle2,
  Dices,
  Layers,
  ListPlus,
} from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { useQrCodeStore } from '../store'
import type { QrExportFormat } from '../../../../../shared/tools/qrcode/types'
import {
  generateRandomString,
  runBatchGeneration,
  type BatchItemConfig,
} from './batch-engine'

export const QrBatchView: React.FC = () => {
  const [inputMode, setInputMode] = useState<'text' | 'random'>('text')
  const [linesText, setLinesText] = useState<string>(
    'https://inkstone.app/doc1\nhttps://inkstone.app/doc2\nhttps://inkstone.app/doc3'
  )
  const [randomCount, setRandomCount] = useState<number>(10)
  const [randomLength, setRandomLength] = useState<number>(12)
  const [filenamePrefix, setFilenamePrefix] = useState<string>('batch-qr-')

  const [format, setFormat] = useState<QrExportFormat>('png')
  const [size, setSize] = useState<number>(600)
  const [randomizeStyle, setRandomizeStyle] = useState<boolean>(false)

  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [downloadReady, setDownloadReady] = useState<boolean>(false)

  const options = useQrCodeStore((s) => s.options)

  const handleStartBatch = async () => {
    let items: BatchItemConfig[] = []

    if (inputMode === 'text') {
      const lines = linesText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (lines.length === 0) return

      items = lines.map((text, idx) => ({
        text,
        filename: `${filenamePrefix}${idx + 1}-${text.slice(0, 16).replace(/[^\w-]/g, '_')}`,
      }))
    } else {
      for (let i = 0; i < randomCount; i++) {
        const text = generateRandomString(randomLength)
        items.push({
          text,
          filename: `${filenamePrefix}${i + 1}-${text}`,
        })
      }
    }

    setIsGenerating(true)
    setProgress({ current: 0, total: items.length })
    setDownloadReady(false)

    try {
      const zipBlob = await runBatchGeneration({
        items,
        size,
        format,
        randomizeStyle,
        baseOptions: options,
        onProgress: (current, total) => setProgress({ current, total }),
      })

      const url = URL.createObjectURL(zipBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filenamePrefix}bundle-${Date.now()}.zip`
      a.click()
      URL.revokeObjectURL(url)

      setDownloadReady(true)
    } catch {
      // safe fallback
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {/* Header */}
        <div className="border-b border-[var(--border-subtle)] pb-4">
          <div className="flex items-center gap-2">
            <Layers size={22} className="text-[var(--accent)]" />
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              {t('tools.qrcode.batch.title')}
            </h2>
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {t('tools.qrcode.batch.subtitle')}
          </p>
        </div>

        {/* Input Mode Selector */}
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] pb-3">
          <button
            type="button"
            onClick={() => setInputMode('text')}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
              inputMode === 'text'
                ? 'bg-[var(--accent)] text-white shadow-xs'
                : 'bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <ListPlus size={14} />
            <span>{t('tools.qrcode.batch.mode_lines')}</span>
          </button>
          <button
            type="button"
            onClick={() => setInputMode('random')}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
              inputMode === 'random'
                ? 'bg-[var(--accent)] text-white shadow-xs'
                : 'bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Dices size={14} />
            <span>{t('tools.qrcode.batch.mode_random')}</span>
          </button>
        </div>

        {/* Main Configuration Card */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
          {/* Data Source Column */}
          <div className="space-y-4 md:col-span-7">
            {inputMode === 'text' ? (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-[var(--text-primary)]">
                  {t('tools.qrcode.batch.lines_label')}
                </label>
                <textarea
                  rows={8}
                  value={linesText}
                  onChange={(e) => setLinesText(e.target.value)}
                  placeholder={t('tools.qrcode.batch.lines_placeholder')}
                  className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 font-mono text-xs text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--accent)] focus:outline-hidden"
                />
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {t('tools.qrcode.batch.lines_count', {
                    count: linesText.split('\n').filter((l) => l.trim()).length,
                  })}
                </span>
              </div>
            ) : (
              <div className="space-y-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-[var(--text-secondary)]">
                    <span>{t('tools.qrcode.batch.random_amount')}</span>
                    <span className="font-mono text-[var(--text-primary)]">{randomCount}</span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={100}
                    step={1}
                    value={randomCount}
                    onChange={(e) => setRandomCount(Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-[var(--text-secondary)]">
                    <span>{t('tools.qrcode.batch.random_length')}</span>
                    <span className="font-mono text-[var(--text-primary)]">{`${randomLength} chars`}</span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={40}
                    step={1}
                    value={randomLength}
                    onChange={(e) => setRandomLength(Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Export Settings Column */}
          <div className="space-y-4 md:col-span-5">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  {t('tools.qrcode.batch.filename_prefix')}
                </label>
                <input
                  type="text"
                  value={filenamePrefix}
                  onChange={(e) => setFilenamePrefix(e.target.value)}
                  className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-1.5 text-xs text-[var(--text-primary)] font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-[var(--text-secondary)]">
                  {t('tools.qrcode.export.format_label')}
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {(['png', 'jpg', 'svg', 'webp'] as QrExportFormat[]).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setFormat(fmt)}
                      className={`rounded py-1 text-xs uppercase font-medium transition-colors ${
                        format === fmt
                          ? 'bg-[var(--accent)] text-white shadow-xs'
                          : 'bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-[var(--text-secondary)]">
                  <span>{t('tools.qrcode.export.size_label')}</span>
                  <span className="font-mono text-[var(--text-primary)]">{`${size}px`}</span>
                </div>
                <input
                  type="range"
                  min={300}
                  max={1200}
                  step={50}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                />
              </div>

              <div className="border-t border-[var(--border-subtle)] pt-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={randomizeStyle}
                    onChange={(e) => setRandomizeStyle(e.target.checked)}
                    className="rounded accent-[var(--accent)]"
                  />
                  <span>{t('tools.qrcode.batch.randomize_styles')}</span>
                </label>
              </div>
            </div>

            {/* Action Card */}
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 space-y-3">
              <button
                type="button"
                disabled={isGenerating}
                onClick={handleStartBatch}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] py-2.5 text-xs font-semibold text-white shadow-md hover:opacity-95 disabled:opacity-50"
              >
                {isGenerating ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    <span>
                      {t('tools.qrcode.batch.generating_progress', {
                        current: progress?.current ?? 0,
                        total: progress?.total ?? 0,
                      })}
                    </span>
                  </>
                ) : (
                  <>
                    <Archive size={15} />
                    <span>{t('tools.qrcode.batch.generate_zip')}</span>
                  </>
                )}
              </button>

              {downloadReady && (
                <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 size={14} />
                  <span>{t('tools.qrcode.batch.download_finished')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

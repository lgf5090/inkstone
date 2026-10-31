import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import type { ColorSpaceValues } from '@shared/tools/color/types'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'
import { colorSpaceItems } from '../lib/color-format'

export interface ColorSpaceDisplayProps {
  spaces: ColorSpaceValues
}

export function ColorSpaceDisplay({ spaces }: ColorSpaceDisplayProps) {
  const copyColor = useColorStudioStore((s) => s.copyColor)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const items = colorSpaceItems(spaces)

  const handleCopy = (item: { key: string; label: string; value: string }) => {
    copyColor(item.value, item.label)
    setCopiedKey(item.key)
    setTimeout(() => {
      setCopiedKey(null)
    }, 1500)
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
        {t('tools.color.studio.spaces')}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {items.map((item) => {
          const isCopied = copiedKey === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => handleCopy(item)}
              aria-label={`Copy ${item.label} value ${item.value}`}
              className="flex items-center justify-between p-2.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-default)] transition-all text-left group"
            >
              <div className="min-w-0 pr-2">
                <span className="block text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                  {item.label}
                </span>
                <span className="block text-[length:var(--text-12)] font-mono text-[var(--text-primary)] truncate mt-0.5 font-medium">
                  {item.value}
                </span>
              </div>
              <div className="shrink-0 p-1.5 rounded text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]">
                {isCopied ? (
                  <Check size={14} className="text-[var(--accent)]" />
                ) : (
                  <Copy size={14} />
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

import {
  Clipboard,
  Contact,
  Globe,
  Mail,
  Minus,
  Phone,
  Plus,
  QrCode,
  RotateCcw,
  Type,
  Wifi,
} from 'lucide-react'
import { useQrCodeStore } from '../store'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { TextContentForm } from './TextContentForm'
import { UrlContentForm } from './UrlContentForm'
import { WifiContentForm } from './WifiContentForm'
import { VCardContentForm } from './VCardContentForm'
import { EmailContentForm } from './EmailContentForm'
import { PhoneContentForm } from './PhoneContentForm'
import type { QrContentType } from '../../../../../shared/tools/qrcode/types'

const CONTENT_TABS = [
  { id: 'url', labelKey: 'tools.qrcode.content.tab_url', icon: Globe },
  { id: 'text', labelKey: 'tools.qrcode.content.tab_text', icon: Type },
  { id: 'wifi', labelKey: 'tools.qrcode.content.tab_wifi', icon: Wifi },
  { id: 'vcard', labelKey: 'tools.qrcode.content.tab_vcard', icon: Contact },
  { id: 'email', labelKey: 'tools.qrcode.content.tab_email', icon: Mail },
  { id: 'phone', labelKey: 'tools.qrcode.content.tab_phone', icon: Phone },
] as const

export function QrContentEditor() {
  const isOpen = useQrCodeStore((s) => s.contentAccordionOpen)
  const toggleOpen = useQrCodeStore((s) => s.toggleContentAccordion)
  const contentType = useQrCodeStore((s) => s.contentType)
  const setContentType = useQrCodeStore((s) => s.setContentType)
  const clearContent = useQrCodeStore((s) => s.clearContent)
  const setTextContent = useQrCodeStore((s) => s.setTextContent)
  const setUrlContent = useQrCodeStore((s) => s.setUrlContent)

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text.trim())) {
          setContentType('url')
          setUrlContent(text.trim())
        } else {
          setContentType('text')
          setTextContent(text)
        }
      }
    } catch {
    }
  }

  return (
    <section
      aria-label={t('tools.qrcode.content.accordion_title')}
      className="flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-sm"
    >
      <header
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleOpen()
          }
        }}
        className={cn(
          'flex h-12 cursor-pointer items-center justify-between px-3.5 select-none',
          'transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'hover:bg-[var(--bg-hover)]',
          isOpen && 'border-b border-[var(--border-subtle)]'
        )}
      >
        <div className="flex items-center gap-2.5">
          <QrCode size={18} className="text-[var(--accent)]" />
          <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('tools.qrcode.content.accordion_title')}
          </h3>
        </div>
        <div className="text-[var(--text-tertiary)]">
          {isOpen ? <Minus size={16} /> : <Plus size={16} />}
        </div>
      </header>

      {isOpen && (
        <div className="flex flex-col gap-3.5 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {CONTENT_TABS.map((tab) => {
                const Icon = tab.icon
                const isSelected = contentType === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setContentType(tab.id as QrContentType)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-[var(--r-md)] px-2.5 py-1 text-[length:var(--text-12)] font-medium',
                      'transition-[background-color,color] duration-[var(--dur-fast)]',
                      isSelected
                        ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xs'
                        : 'bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    )}
                  >
                    <Icon size={13} />
                    <span>{t(tab.labelKey)}</span>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <Tooltip label={t('tools.qrcode.content.paste_clipboard')}>
                <IconButton
                  size="sm"
                  label={t('tools.qrcode.content.paste_clipboard')}
                  onClick={handlePaste}
                >
                  <Clipboard size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label={t('tools.qrcode.content.clear_content')}>
                <IconButton
                  size="sm"
                  label={t('tools.qrcode.content.clear_content')}
                  onClick={clearContent}
                >
                  <RotateCcw size={14} />
                </IconButton>
              </Tooltip>
            </div>
          </div>

          <div className="min-h-0">
            {contentType === 'text' && <TextContentForm />}
            {contentType === 'url' && <UrlContentForm />}
            {contentType === 'wifi' && <WifiContentForm />}
            {contentType === 'vcard' && <VCardContentForm />}
            {contentType === 'email' && <EmailContentForm />}
            {contentType === 'phone' && <PhoneContentForm />}
          </div>
        </div>
      )}
    </section>
  )
}

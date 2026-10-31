import { useMemo } from 'react'
import { create } from 'zustand'
import type {
  QrCodeSettings,
  QrContentType,
  QrEmailContent,
  QrErrorCorrectionLevel,
  QrExportFormat,
  QrEyeShape,
  QrPhoneContent,
  QrPreset,
  QrStylingOptions,
  QrToolkitOptions,
  QrVCardContent,
  QrWifiContent,
} from '../../../../shared/tools/qrcode/types'
import { DEFAULT_QR_OPTIONS } from './engine/qr-engine'

export type BeautifyTab = 'template' | 'shape' | 'logo' | 'text' | 'color' | 'ai'

// The export size the slider offers and the workbench accepts; server defaults are clamped into it.
export const EXPORT_SIZE_MIN = 300
export const EXPORT_SIZE_MAX = 2000
export const EXPORT_SIZE_STEP = 100
export const EXPORT_SIZE_DEFAULT = 1000

export const QR_ECC_LEVELS: QrErrorCorrectionLevel[] = ['L', 'M', 'Q', 'H']
export interface QrCodeState {
  contentAccordionOpen: boolean
  beautifyAccordionOpen: boolean
  activeBeautifyTab: BeautifyTab

  contentType: QrContentType
  textContent: string
  urlContent: string
  wifiContent: QrWifiContent
  vcardContent: QrVCardContent
  emailContent: QrEmailContent
  phoneContent: QrPhoneContent

  options: QrStylingOptions
  currentEyeShape: QrEyeShape

  exportSize: number
  exportFormat: QrExportFormat
  defaultsApplied: boolean

  infoModalOpen: boolean
  fullscreenModalOpen: boolean

  toggleContentAccordion: () => void
  setContentAccordionOpen: (open: boolean) => void
  toggleBeautifyAccordion: () => void
  setBeautifyAccordionOpen: (open: boolean) => void
  setActiveBeautifyTab: (tab: BeautifyTab) => void

  setContentType: (type: QrContentType) => void
  setTextContent: (text: string) => void
  setUrlContent: (url: string) => void
  setWifiContent: (wifi: Partial<QrWifiContent>) => void
  setVcardContent: (vcard: Partial<QrVCardContent>) => void
  setEmailContent: (email: Partial<QrEmailContent>) => void
  setPhoneContent: (phone: Partial<QrPhoneContent>) => void
  clearContent: () => void

  setOptions: (options: Partial<QrStylingOptions>) => void
  setToolkitOptions: (toolkit: Partial<QrToolkitOptions>) => void
  setEyeShape: (shape: QrEyeShape) => void
  applyPreset: (preset: QrPreset) => void
  resetOptions: () => void

  setExportSize: (size: number) => void
  setExportFormat: (format: QrExportFormat) => void
  applyServerDefaults: (settings: QrCodeSettings) => void

  setInfoModalOpen: (open: boolean) => void
  setFullscreenModalOpen: (open: boolean) => void
}

export function encodeQrData(
  type: QrContentType,
  state: {
    textContent: string
    urlContent: string
    wifiContent: QrWifiContent
    vcardContent: QrVCardContent
    emailContent: QrEmailContent
    phoneContent: QrPhoneContent
  }
): string {
  switch (type) {
    case 'text':
      return state.textContent.trim()
    case 'url': {
      const url = state.urlContent.trim()
      if (!url) return ''
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url
      return `https://${url}`
    }
    case 'wifi': {
      const { ssid, password, encryption, hidden } = state.wifiContent
      if (!ssid.trim()) return ''
      const enc = encryption === 'none' ? 'nopass' : encryption.toUpperCase()
      const esc = (val: string) => val.replace(/([\\;,:"])/g, '\\$1')
      return `WIFI:S:${esc(ssid)};T:${enc};P:${esc(password || '')};H:${hidden ? 'true' : 'false'};;`
    }
    case 'vcard': {
      const vcard = state.vcardContent || {}
      const firstName = (vcard.firstName || '').trim()
      const lastName = (vcard.lastName || '').trim()
      const phone = (vcard.phone || '').trim()
      const mobile = (vcard.mobile || '').trim()
      const email = (vcard.email || '').trim()
      const organization = (vcard.organization || '').trim()
      const title = (vcard.title || '').trim()
      const url = (vcard.url || '').trim()
      const address = (vcard.address || '').trim()
      const fullName = `${lastName}${firstName}`.trim() || firstName || lastName
      if (!fullName && !phone && !email && !mobile) return ''
      const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        fullName ? `FN:${fullName}` : '',
        `N:${lastName};${firstName};;;`,
        organization ? `ORG:${organization}` : '',
        title ? `TITLE:${title}` : '',
        phone ? `TEL;TYPE=WORK,VOICE:${phone}` : '',
        mobile ? `TEL;TYPE=CELL,VOICE:${mobile}` : '',
        email ? `EMAIL;TYPE=PREF,INTERNET:${email}` : '',
        url ? `URL:${url}` : '',
        address ? `ADR;TYPE=WORK:;;${address};;;;` : '',
        'END:VCARD',
      ].filter(Boolean)
      return lines.join('\n')
    }
    case 'email': {
      const email = state.emailContent || {}
      const to = (email.to || '').trim()
      if (!to) return ''
      const params = new URLSearchParams()
      if (email.subject?.trim()) params.set('subject', email.subject.trim())
      if (email.body?.trim()) params.set('body', email.body.trim())
      const query = params.toString()
      return `mailto:${encodeURIComponent(to)}${query ? `?${query}` : ''}`
    }
    case 'phone': {
      const phoneContent = state.phoneContent || {}
      const phone = (phoneContent.phone || (phoneContent as any).number || '').trim()
      if (!phone) return ''
      const message = (phoneContent.message || '').trim()
      if (message) {
        return `smsto:${phone}:${message}`
      }
      return `tel:${phone}`
    }
    default:
      return state.textContent.trim()
  }
}

export const useQrCodeStore = create<QrCodeState>((set, get) => ({
  contentAccordionOpen: true,
  beautifyAccordionOpen: true,
  activeBeautifyTab: 'template',

  contentType: 'url',
  textContent: '',
  urlContent: 'https://github.com',
  wifiContent: {
    ssid: '',
    password: '',
    encryption: 'WPA',
    hidden: false,
  },
  vcardContent: {
    firstName: '',
    lastName: '',
    phone: '',
    mobile: '',
    email: '',
    organization: '',
    title: '',
    url: '',
    address: '',
  },
  emailContent: {
    to: '',
    subject: '',
    body: '',
  },
  phoneContent: {
    phone: '',
    message: '',
  },

  options: { ...DEFAULT_QR_OPTIONS },
  currentEyeShape: 'square',

  exportSize: EXPORT_SIZE_DEFAULT,
  exportFormat: 'png',
  defaultsApplied: false,

  infoModalOpen: false,
  fullscreenModalOpen: false,

  toggleContentAccordion: () => set((s) => ({ contentAccordionOpen: !s.contentAccordionOpen })),
  setContentAccordionOpen: (open) => set({ contentAccordionOpen: open }),
  toggleBeautifyAccordion: () => set((s) => ({ beautifyAccordionOpen: !s.beautifyAccordionOpen })),
  setBeautifyAccordionOpen: (open) => set({ beautifyAccordionOpen: open }),
  setActiveBeautifyTab: (tab) => set({ activeBeautifyTab: tab }),

  setContentType: (type) => set({ contentType: type }),
  setTextContent: (text) => set({ textContent: text }),
  setUrlContent: (url) => set({ urlContent: url }),
  setWifiContent: (wifi) => set((s) => ({ wifiContent: { ...s.wifiContent, ...wifi } })),
  setVcardContent: (vcard) => set((s) => ({ vcardContent: { ...s.vcardContent, ...vcard } })),
  setEmailContent: (email) => set((s) => ({ emailContent: { ...s.emailContent, ...email } })),
  setPhoneContent: (phone) => set((s) => ({ phoneContent: { ...s.phoneContent, ...phone } })),
  clearContent: () =>
    set({
      textContent: '',
      urlContent: '',
      wifiContent: { ssid: '', password: '', encryption: 'WPA', hidden: false },
      vcardContent: { firstName: '', lastName: '', phone: '', mobile: '', email: '', organization: '', title: '', url: '', address: '' },
      emailContent: { to: '', subject: '', body: '' },
      phoneContent: { phone: '', message: '' },
    }),

  setOptions: (newOpts) =>
    set((s) => ({
      options: {
        ...s.options,
        ...newOpts,
        dotsOptions: { ...s.options.dotsOptions, ...newOpts.dotsOptions },
        cornersSquareOptions: { ...s.options.cornersSquareOptions, ...newOpts.cornersSquareOptions },
        cornersDotOptions: { ...s.options.cornersDotOptions, ...newOpts.cornersDotOptions },
        backgroundOptions: { ...s.options.backgroundOptions, ...newOpts.backgroundOptions },
        frameOptions: { ...s.options.frameOptions, ...newOpts.frameOptions },
        textOptions: { ...s.options.textOptions, ...newOpts.textOptions },
        logoOptions: { ...s.options.logoOptions, ...newOpts.logoOptions },
        toolkitOptions: { ...s.options.toolkitOptions, ...newOpts.toolkitOptions },
      },
    })),

  setToolkitOptions: (toolkit) =>
    set((s) => ({
      options: {
        ...s.options,
        toolkitOptions: {
          ...s.options.toolkitOptions,
          ...toolkit,
        },
      },
    })),

  setEyeShape: (shape) => set({ currentEyeShape: shape }),

  applyPreset: (preset) =>
    set((s) => ({
      options: {
        ...s.options,
        ...preset.options,
        dotsOptions: { ...s.options.dotsOptions, ...preset.options.dotsOptions },
        cornersSquareOptions: { ...s.options.cornersSquareOptions, ...preset.options.cornersSquareOptions },
        cornersDotOptions: { ...s.options.cornersDotOptions, ...preset.options.cornersDotOptions },
        backgroundOptions: { ...s.options.backgroundOptions, ...preset.options.backgroundOptions },
        frameOptions: { ...s.options.frameOptions, ...preset.options.frameOptions },
      },
      currentEyeShape: preset.options.cornersSquareOptions?.type === 'dot' ? 'circle' : 'square',
    })),

  resetOptions: () => set({ options: { ...DEFAULT_QR_OPTIONS }, currentEyeShape: 'square' }),

  setExportSize: (size) =>
    set({ exportSize: Math.min(EXPORT_SIZE_MAX, Math.max(EXPORT_SIZE_MIN, Math.round(size))) }),
  setExportFormat: (format) => set({ exportFormat: format }),

  applyServerDefaults: (settings) => {
    // Starting values land once per session: re-applying them on every visit to the tools tab would
    // overwrite styling the reader already changed in this workbench.
    if (get().defaultsApplied) return
    const size = Math.min(EXPORT_SIZE_MAX, Math.max(EXPORT_SIZE_MIN, Math.round(settings.defaultSize)))
    const eccKnown = QR_ECC_LEVELS.includes(settings.defaultErrorCorrection)
    set((s) => ({
      defaultsApplied: true,
      exportSize: size,
      exportFormat: settings.defaultFormat,
      options: eccKnown ? { ...s.options, errorCorrectionLevel: settings.defaultErrorCorrection } : s.options,
    }))
  },

  setInfoModalOpen: (open) => set({ infoModalOpen: open }),
  setFullscreenModalOpen: (open) => set({ fullscreenModalOpen: open }),
}))

/**
 * The encoded payload as a render-time value. A component that read it through a store getter during
 * render stayed stale: the getter is a stable function reference, so editing the content never
 * re-rendered the panel and it kept drawing — and exporting — the previous payload.
 */
export function useQrPayload(): string {
  const contentType = useQrCodeStore((s) => s.contentType)
  const textContent = useQrCodeStore((s) => s.textContent)
  const urlContent = useQrCodeStore((s) => s.urlContent)
  const wifiContent = useQrCodeStore((s) => s.wifiContent)
  const vcardContent = useQrCodeStore((s) => s.vcardContent)
  const emailContent = useQrCodeStore((s) => s.emailContent)
  const phoneContent = useQrCodeStore((s) => s.phoneContent)
  return useMemo(
    () => encodeQrData(contentType, { textContent, urlContent, wifiContent, vcardContent, emailContent, phoneContent }),
    [contentType, textContent, urlContent, wifiContent, vcardContent, emailContent, phoneContent],
  )
}

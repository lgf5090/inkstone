import { create } from 'zustand'
import type {
  QrContentType,
  QrEmailContent,
  QrExportFormat,
  QrEyeShape,
  QrPhoneContent,
  QrPreset,
  QrRecord,
  QrStylingOptions,
  QrVCardContent,
  QrWifiContent,
} from '../../../../shared/tools/qrcode/types'
import { DEFAULT_QR_OPTIONS } from './engine/qr-engine'

export type BeautifyTab = 'template' | 'shape' | 'logo' | 'text' | 'color'
export type QrNavView = 'generator' | 'history' | 'templates' | 'settings'

export interface QrCodeState {
  activeView: QrNavView
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

  selectedRecord: QrRecord | null
  infoModalOpen: boolean
  fullscreenModalOpen: boolean

  setActiveView: (view: QrNavView) => void
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
  setEyeShape: (shape: QrEyeShape) => void
  applyPreset: (preset: QrPreset) => void
  resetOptions: () => void

  setExportSize: (size: number) => void
  setExportFormat: (format: QrExportFormat) => void

  setSelectedRecord: (record: QrRecord | null) => void
  setInfoModalOpen: (open: boolean) => void
  setFullscreenModalOpen: (open: boolean) => void

  getEncodedPayload: () => string
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
  activeView: 'generator',
  contentAccordionOpen: false,
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

  exportSize: 1000,
  exportFormat: 'png',

  selectedRecord: null,
  infoModalOpen: false,
  fullscreenModalOpen: false,

  setActiveView: (view) => set({ activeView: view }),
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

  setExportSize: (size) => set({ exportSize: size }),
  setExportFormat: (format) => set({ exportFormat: format }),

  setSelectedRecord: (record) => set({ selectedRecord: record }),
  setInfoModalOpen: (open) => set({ infoModalOpen: open }),
  setFullscreenModalOpen: (open) => set({ fullscreenModalOpen: open }),

  getEncodedPayload: () => {
    const s = get()
    return encodeQrData(s.contentType, {
      textContent: s.textContent,
      urlContent: s.urlContent,
      wifiContent: s.wifiContent,
      vcardContent: s.vcardContent,
      emailContent: s.emailContent,
      phoneContent: s.phoneContent,
    })
  },
}))

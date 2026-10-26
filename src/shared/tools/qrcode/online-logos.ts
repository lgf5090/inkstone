import type { OnlineLogo } from './types'

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`
}

const WECHAT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path fill="#07C160" d="M19.5 7C11.5 7 5 12.8 5 20c0 4 2.1 7.6 5.5 10l-1.4 4.2 4.9-2.5c1.7.5 3.6.8 5.5.8.5 0 1 0 1.5-.1-.4-1.1-.6-2.2-.6-3.4 0-6.6 6-12 13.5-12 .7 0 1.4 0 2.1.2C34.7 11.7 27.7 7 19.5 7z"/>
  <circle cx="14" cy="15" r="1.5" fill="#fff"/>
  <circle cx="23" cy="15" r="1.5" fill="#fff"/>
  <path fill="#07C160" d="M33.5 19c-6.6 0-12 4.7-12 10.5 0 5.8 5.4 10.5 12 10.5 1.5 0 3-.3 4.3-.8l3.9 2-1.1-3.4c2.8-1.9 4.4-4.8 4.4-8.3 0-5.8-5.4-10.5-12-10.5z"/>
  <circle cx="29.5" cy="26" r="1.3" fill="#fff"/>
  <circle cx="37.5" cy="26" r="1.3" fill="#fff"/>
</svg>`

const QQ_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path fill="#12B7F5" d="M24 4C14.1 4 8 12.2 8 22.8c0 4.6 1.5 9.1 4.2 12.5L10 41.5c-.3.8.5 1.5 1.2 1.1l5.4-3.1c2.3.9 4.8 1.5 7.4 1.5s5.1-.6 7.4-1.5l5.4 3.1c.8.4 1.5-.3 1.2-1.1l-2.2-6.2C38.5 31.9 40 27.4 40 22.8 40 12.2 33.9 4 24 4z"/>
  <ellipse cx="24" cy="26" rx="10" ry="11" fill="#fff"/>
  <path fill="#E53935" d="M15 22c2.5 3.5 15.5 3.5 18 0 1.5 3.5-1.5 6-9 6s-10.5-2.5-9-6z"/>
  <circle cx="19" cy="17" r="2" fill="#212121"/>
  <circle cx="29" cy="17" r="2" fill="#212121"/>
  <path fill="#FFA000" d="M21 20h6c0 2-1.3 3.5-3 3.5s-3-1.5-3-3.5z"/>
</svg>`

const TAOBAO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="12" fill="#FF5000"/>
  <path fill="#fff" d="M24 9c-7.2 0-13 4.2-13 11 0 5.4 3.8 9.2 9.2 10.6L18 36c-.2.5.3.9.7.7l5.8-3.4c-.2.9-.3 1.8-.3 2.7 0 1.1.9 2 2 2h.2c1.1 0 2-.9 2-2 0-1.1-.3-2.3-.7-3.4l4.3 2.5c.5.3 1-.1.8-.6l-1.9-4.8c4.6-1.7 7.9-5.7 7.9-10.7 0-6.8-5.8-11-14-11zm-4 13.5c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5 2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5zm8 0c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5 2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5z"/>
</svg>`

const WEIBO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path fill="#E6162D" d="M23.5 10c-9.7 0-17.5 6.2-17.5 13.8 0 7.2 7 12.7 15.8 13.6 11.2 1.2 19.2-5.4 19.2-11.9 0-4.8-4.2-8.3-9.5-9.3 2.1-.9 3.2-2.3 3.2-3.8 0-2.5-3-4.4-7.2-4.4-1.5 0-3 .2-4 .6v1.4zm2.1 22.8c-5.8.5-10.9-2-11.4-5.6-.5-3.6 3.7-6.9 9.5-7.4 5.8-.5 10.9 2 11.4 5.6.5 3.6-3.7 6.9-9.5 7.4z"/>
  <ellipse cx="23.2" cy="27" rx="3.5" ry="2" fill="#fff"/>
  <circle cx="24" cy="26.8" r="1.2" fill="#E6162D"/>
  <circle cx="36" cy="14" r="3" fill="#F29C38"/>
  <circle cx="40" cy="11" r="1.5" fill="#F29C38"/>
</svg>`

const QZONE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path fill="#FFC107" d="M24 4l5.8 12.8 13.9 1.6-10.3 9.5 2.8 13.7L24 34.6 11.8 41.6l2.8-13.7L4.3 18.4l13.9-1.6L24 4z"/>
  <path fill="#FFA000" d="M24 10l3.9 8.7 9.4 1.1-7 6.5 1.9 9.3L24 30.9l-8.2 4.7 1.9-9.3-7-6.5 9.4-1.1L24 10z"/>
</svg>`

const TWITTER_X_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="10" fill="#000"/>
  <path fill="#fff" d="M28.8 10h4.2L23.8 20.5 34.6 35h-8.5l-6.6-8.7-7.6 8.7H7.7l9.8-11.2L7.2 10h8.7l6 8 6.9-8zm-1.5 22.5h2.3L15.3 12.3H12.8l14.5 20.2z"/>
</svg>`

const FACEBOOK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="10" fill="#1877F2"/>
  <path fill="#fff" d="M29.5 25.5l.8-5.5h-5.3v-3.6c0-1.5.4-2.5 2.6-2.5h2.8V9.1c-.5-.1-2.2-.2-4.1-.2-4.1 0-6.9 2.5-6.9 7.1v4.1H14.7v5.5h4.7V39h5.7V25.5h4.4z"/>
</svg>`

const FINGERPRINT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <g fill="none" stroke="#0284C7" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 9c-7.2 0-13 5.8-13 13 0 4.2 1.8 7.5 3.5 10"/>
    <path d="M18.5 14C20 12.8 21.9 12 24 12c5.5 0 10 4.5 10 10 0 7.5-3.5 11.5-6.5 15.5"/>
    <path d="M15 22c0-5 4-9 9-9s9 4 9 9c0 6-3 10-5.5 13.5"/>
    <path d="M20 22c0-2.2 1.8-4 4-4s4 1.8 4 4c0 4.5-2 7.5-4 10.5"/>
    <path d="M24 25v3"/>
    <path d="M30 35c2-2.5 4.5-6.5 4.5-13 0-5.5-2.2-9.5-5.5-12"/>
    <path d="M12 30c1.5 3 4 6 7 9"/>
  </g>
</svg>`

const REDPACKET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect x="8" y="5" width="32" height="38" rx="5" fill="#E53935"/>
  <path fill="#D32F2F" d="M8 10c0-2.8 2.2-5 5-5h22c2.8 0 5 2.2 5 5v12c0 2-4 10-16 10S8 24 8 22V10z"/>
  <circle cx="24" cy="22" r="5" fill="#FFD54F"/>
  <circle cx="24" cy="22" r="3.5" fill="#FFC107"/>
  <path fill="#FFA000" d="M24 19.5v5M21.5 22h5"/>
</svg>`

export const ONLINE_LOGOS: OnlineLogo[] = [
  {
    id: 'wechat',
    name: 'WeChat',
    nameKey: 'tools.qrcode.logos.wechat',
    category: 'social',
    svg: WECHAT_SVG,
    dataUrl: svgToDataUrl(WECHAT_SVG),
  },
  {
    id: 'qq',
    name: 'QQ',
    nameKey: 'tools.qrcode.logos.qq',
    category: 'social',
    svg: QQ_SVG,
    dataUrl: svgToDataUrl(QQ_SVG),
  },
  {
    id: 'taobao',
    name: 'Taobao',
    nameKey: 'tools.qrcode.logos.taobao',
    category: 'payment',
    svg: TAOBAO_SVG,
    dataUrl: svgToDataUrl(TAOBAO_SVG),
  },
  {
    id: 'weibo',
    name: 'Weibo',
    nameKey: 'tools.qrcode.logos.weibo',
    category: 'social',
    svg: WEIBO_SVG,
    dataUrl: svgToDataUrl(WEIBO_SVG),
  },
  {
    id: 'qzone',
    name: 'Qzone',
    nameKey: 'tools.qrcode.logos.qzone',
    category: 'social',
    svg: QZONE_SVG,
    dataUrl: svgToDataUrl(QZONE_SVG),
  },
  {
    id: 'twitter',
    name: 'Twitter/X',
    nameKey: 'tools.qrcode.logos.twitter',
    category: 'social',
    svg: TWITTER_X_SVG,
    dataUrl: svgToDataUrl(TWITTER_X_SVG),
  },
  {
    id: 'facebook',
    name: 'Facebook',
    nameKey: 'tools.qrcode.logos.facebook',
    category: 'social',
    svg: FACEBOOK_SVG,
    dataUrl: svgToDataUrl(FACEBOOK_SVG),
  },
  {
    id: 'fingerprint',
    name: 'Fingerprint',
    nameKey: 'tools.qrcode.logos.fingerprint',
    category: 'util',
    svg: FINGERPRINT_SVG,
    dataUrl: svgToDataUrl(FINGERPRINT_SVG),
  },
  {
    id: 'redpacket',
    name: 'Red Packet',
    nameKey: 'tools.qrcode.logos.redpacket',
    category: 'payment',
    svg: REDPACKET_SVG,
    dataUrl: svgToDataUrl(REDPACKET_SVG),
  },
]

export function getOnlineLogoById(id: string): OnlineLogo | undefined {
  return ONLINE_LOGOS.find((logo) => logo.id === id)
}

export function getOnlineLogoDataUrl(id: string): string | undefined {
  const logo = getOnlineLogoById(id)
  return logo?.dataUrl
}

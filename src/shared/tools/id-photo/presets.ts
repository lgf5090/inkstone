export interface IdPhotoBgColorPreset {
  id: string
  nameKey: string
  color: string
  endColor?: string
  isGradient?: boolean
  descriptionKey?: string
}

export const ID_PHOTO_BG_PRESETS: readonly IdPhotoBgColorPreset[] = [
  {
    id: 'pure_white',
    nameKey: 'tools.id_photo.bg.pure_white',
    color: '#ffffff',
  },
  {
    id: 'light_gray',
    nameKey: 'tools.id_photo.bg.light_gray',
    color: '#F0F2F5',
  },
  {
    id: 'light_blue',
    nameKey: 'tools.id_photo.bg.light_blue',
    color: '#438EDB',
  },
  {
    id: 'tech_blue',
    nameKey: 'tools.id_photo.bg.tech_blue',
    color: '#004098',
  },
  {
    id: 'classic_red',
    nameKey: 'tools.id_photo.bg.classic_red',
    color: '#D9001B',
  },
  {
    id: 'crimson_red',
    nameKey: 'tools.id_photo.bg.crimson_red',
    color: '#8B0000',
  },
  {
    id: 'studio_charcoal',
    nameKey: 'tools.id_photo.bg.studio_charcoal',
    color: '#334155',
  },
  {
    id: 'gradient_blue',
    nameKey: 'tools.id_photo.bg.gradient_blue',
    color: '#3B82F6',
    endColor: '#1E3A8A',
    isGradient: true,
  },
  {
    id: 'gradient_red',
    nameKey: 'tools.id_photo.bg.gradient_red',
    color: '#EF4444',
    endColor: '#991B1B',
    isGradient: true,
  },
  {
    id: 'gradient_gray',
    nameKey: 'tools.id_photo.bg.gradient_gray',
    color: '#F1F5F9',
    endColor: '#94A3B8',
    isGradient: true,
  },
]

export interface AttirePreset {
  id: string
  nameKey: string
  gender: 'male' | 'female' | 'unisex'
  categoryKey: string
  previewSvg: string // SVG path representation for lightweight offline formal wear rendering
}

export const ATTIRE_PRESETS: readonly AttirePreset[] = [
  {
    id: 'male_suit_navy',
    nameKey: 'tools.id_photo.attire.male_navy_suit',
    gender: 'male',
    categoryKey: 'tools.id_photo.attire.suit',
    previewSvg: `<svg viewBox="0 0 400 300" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M70 290 L110 130 L160 160 L180 200 L200 290 Z" fill="#1e293b"/>
      <path d="M330 290 L290 130 L240 160 L220 200 L200 290 Z" fill="#1e293b"/>
      <path d="M160 160 L200 200 L240 160 L220 120 L180 120 Z" fill="#ffffff"/>
      <path d="M190 140 L210 140 L205 210 L195 210 Z" fill="#b91c1c"/>
      <path d="M110 130 L180 120 L170 170 Z" fill="#0f172a"/>
      <path d="M290 130 L220 120 L230 170 Z" fill="#0f172a"/>
    </svg>`,
  },
  {
    id: 'male_suit_black',
    nameKey: 'tools.id_photo.attire.male_black_suit',
    gender: 'male',
    categoryKey: 'tools.id_photo.attire.suit',
    previewSvg: `<svg viewBox="0 0 400 300" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M70 290 L110 130 L160 160 L180 200 L200 290 Z" fill="#18181b"/>
      <path d="M330 290 L290 130 L240 160 L220 200 L200 290 Z" fill="#18181b"/>
      <path d="M160 160 L200 200 L240 160 L220 120 L180 120 Z" fill="#ffffff"/>
      <path d="M192 140 L208 140 L204 210 L196 210 Z" fill="#0284c7"/>
      <path d="M110 130 L180 120 L170 170 Z" fill="#09090b"/>
      <path d="M290 130 L220 120 L230 170 Z" fill="#09090b"/>
    </svg>`,
  },
  {
    id: 'female_suit_navy',
    nameKey: 'tools.id_photo.attire.female_navy_suit',
    gender: 'female',
    categoryKey: 'tools.id_photo.attire.suit',
    previewSvg: `<svg viewBox="0 0 400 300" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M75 290 L120 140 L165 175 L185 210 L200 290 Z" fill="#1e293b"/>
      <path d="M325 290 L280 140 L235 175 L215 210 L200 290 Z" fill="#1e293b"/>
      <path d="M165 175 C180 200, 220 200, 235 175 L215 130 C205 135, 195 135, 185 130 Z" fill="#ffffff"/>
      <path d="M120 140 L185 130 L175 190 Z" fill="#0f172a"/>
      <path d="M280 140 L215 130 L225 190 Z" fill="#0f172a"/>
    </svg>`,
  },
  {
    id: 'female_shirt_white',
    nameKey: 'tools.id_photo.attire.female_white_shirt',
    gender: 'female',
    categoryKey: 'tools.id_photo.attire.shirt',
    previewSvg: `<svg viewBox="0 0 400 300" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M80 290 L125 140 L175 160 L185 210 L200 290 Z" fill="#f8fafc"/>
      <path d="M320 290 L275 140 L225 160 L215 210 L200 290 Z" fill="#f8fafc"/>
      <path d="M125 140 L185 130 L175 170 Z" fill="#e2e8f0"/>
      <path d="M275 140 L215 130 L225 170 Z" fill="#e2e8f0"/>
    </svg>`,
  },
]

export const PRINT_SHEET_PRESETS = [
  {
    id: '5inch',
    nameKey: 'tools.id_photo.print.paper_5inch',
    widthMm: 89,
    heightMm: 127,
    ratioLabel: '3R (89×127mm)',
  },
  {
    id: '6inch',
    nameKey: 'tools.id_photo.print.paper_6inch',
    widthMm: 102,
    heightMm: 152,
    ratioLabel: '4R (102×152mm)',
  },
  {
    id: 'a4',
    nameKey: 'tools.id_photo.print.paper_a4',
    widthMm: 210,
    heightMm: 297,
    ratioLabel: 'A4 (210×297mm)',
  },
] as const

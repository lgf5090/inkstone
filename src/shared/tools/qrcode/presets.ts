import { ONLINE_LOGOS } from './online-logos'
import type { QrPreset, QrPresetCategory } from './types'

const taobaoLogo = ONLINE_LOGOS.find((l) => l.id === 'taobao')?.dataUrl

export const QR_PRESETS: QrPreset[] = [
  {
    id: 'default',
    name: 'Default',
    nameKey: 'tools.qrcode.presets.default',
    category: 'minimal',
    description: 'Standard black and white square, classic high-contrast scanning',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'square',
        color: '#000000',
      },
      cornersSquareOptions: {
        type: 'square',
        color: '#000000',
      },
      cornersDotOptions: {
        type: 'square',
        color: '#000000',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'none',
      },
    },
  },
  {
    id: 'wecom',
    name: 'WeCom',
    nameKey: 'tools.qrcode.presets.wecom',
    category: 'minimal',
    description: 'Corporate blue connected dots with balanced eyes',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'classy-rounded',
        color: '#1877f2',
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#1877f2',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#1877f2',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'none',
      },
    },
  },
  {
    id: 'simple-dots',
    name: 'Simple Dots',
    nameKey: 'tools.qrcode.presets.simple_dots',
    category: 'minimal',
    description: 'Lightweight circular dots with minimalist eye shapes',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'dots',
        color: '#2c3e50',
      },
      cornersSquareOptions: {
        type: 'dot',
        color: '#2c3e50',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#2c3e50',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'none',
      },
    },
  },
  {
    id: 'liquid-gradient',
    name: 'Liquid Gradient',
    nameKey: 'tools.qrcode.presets.liquid_gradient',
    category: 'minimal',
    description: 'Blue-cyan linear gradient with smooth fluid aesthetic',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'rounded',
        gradient: {
          type: 'linear',
          rotation: 45,
          colorStops: [
            { offset: 0, color: '#6366f1' },
            { offset: 1, color: '#06b6d4' },
          ],
        },
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        gradient: {
          type: 'linear',
          rotation: 45,
          colorStops: [
            { offset: 0, color: '#6366f1' },
            { offset: 1, color: '#06b6d4' },
          ],
        },
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#6366f1',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'none',
      },
    },
  },
  {
    id: 'bar-gradient',
    name: 'Bar Gradient',
    nameKey: 'tools.qrcode.presets.bar_gradient',
    category: 'minimal',
    description: 'Sunset orange to pink horizontal gradient bars',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'classy',
        gradient: {
          type: 'linear',
          rotation: 90,
          colorStops: [
            { offset: 0, color: '#f97316' },
            { offset: 1, color: '#ec4899' },
          ],
        },
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#f97316',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#ec4899',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'none',
      },
    },
  },
  {
    id: 'square-jump',
    name: 'Square Jump',
    nameKey: 'tools.qrcode.presets.square_jump',
    category: 'minimal',
    description: 'Emerald to teal diagonal geometric rhythm',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'square',
        gradient: {
          type: 'linear',
          rotation: 135,
          colorStops: [
            { offset: 0, color: '#059669' },
            { offset: 1, color: '#0d9488' },
          ],
        },
      },
      cornersSquareOptions: {
        type: 'square',
        color: '#059669',
      },
      cornersDotOptions: {
        type: 'square',
        color: '#0d9488',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'none',
      },
    },
  },
  {
    id: 'dark-green-frame',
    name: 'Dark Green Frame',
    nameKey: 'tools.qrcode.presets.dark_green_frame',
    category: 'frame',
    description: 'Classic dark green ornamental frame with scan banner',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'classy',
        color: '#1b4332',
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#1b4332',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#2d6a4f',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'dark-green',
        label: 'SCAN TO LEARN MORE',
        color: '#1b4332',
        secondaryColor: '#d4af37',
      },
    },
  },
  {
    id: 'red-blue-gradient',
    name: 'Red Blue Gradient',
    nameKey: 'tools.qrcode.presets.red_blue_gradient',
    category: 'frame',
    description: 'Fluid dual-gradient border card, bold and eye-catching',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'rounded',
        gradient: {
          type: 'linear',
          rotation: 45,
          colorStops: [
            { offset: 0, color: '#ef4444' },
            { offset: 1, color: '#3b82f6' },
          ],
        },
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#ef4444',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#3b82f6',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'red-blue',
        label: 'SCAN TO VIEW',
        color: '#ef4444',
        secondaryColor: '#3b82f6',
      },
    },
  },
  {
    id: 'three-color-card',
    name: 'Three Color Card',
    nameKey: 'tools.qrcode.presets.three_color_card',
    category: 'frame',
    description: 'Memphis-inspired tri-color business card border',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'dots',
        color: '#1e293b',
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#ff6b6b',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#48dbfb',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'three-color',
        label: 'SCAN ME',
        color: '#ff6b6b',
        secondaryColor: '#ffd93d',
      },
    },
  },
  {
    id: 'heart-border',
    name: 'Heart Border',
    nameKey: 'tools.qrcode.presets.heart_border',
    category: 'frame',
    description: 'Romantic pink heart adorned border for couples and holidays',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'dots',
        color: '#e11d48',
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#e11d48',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#f43f5e',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'heart',
        label: 'LOVE & SCAN',
        color: '#f43f5e',
        secondaryColor: '#fda4af',
      },
    },
  },
  {
    id: 'liquid-stamp',
    name: 'Liquid Stamp',
    nameKey: 'tools.qrcode.presets.liquid_stamp',
    category: 'frame',
    description: 'Cinnabar red fluid seal stamp frame with authentic badge',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'rounded',
        color: '#be123c',
      },
      cornersSquareOptions: {
        type: 'dot',
        color: '#be123c',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#e11d48',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'liquid-stamp',
        label: '★ AUTHENTIC ★',
        color: '#be123c',
        secondaryColor: '#fb7185',
      },
    },
  },
  {
    id: 'pacman',
    name: 'Pacman',
    nameKey: 'tools.qrcode.presets.pacman',
    category: 'artistic',
    description: 'Retro arcade dark neon pixel frame',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'dots',
        color: '#facc15',
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#3b82f6',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#facc15',
      },
      backgroundOptions: {
        color: '#0f172a',
      },
      frameOptions: {
        type: 'pacman',
        label: 'READY! 1UP',
        color: '#3b82f6',
        secondaryColor: '#facc15',
      },
    },
  },
  {
    id: 'taobao',
    name: 'Taobao',
    nameKey: 'tools.qrcode.presets.taobao',
    category: 'scenario',
    description: 'E-commerce vibrant orange with embedded Taobao logo',
    options: {
      errorCorrectionLevel: 'H',
      dotsOptions: {
        type: 'classy-rounded',
        color: '#ff5000',
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#ff5000',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#ff5000',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      logoOptions: {
        src: taobaoLogo,
        logoId: 'taobao',
        shape: 'rounded',
        shadow: true,
        size: 0.22,
        margin: 6,
        hideBackgroundDots: true,
      },
      frameOptions: {
        type: 'none',
      },
    },
  },
  {
    id: 'meme-bubble',
    name: 'Meme Bubble',
    nameKey: 'tools.qrcode.presets.meme_bubble',
    category: 'scenario',
    description: 'Fun cartoon callout bubble guiding users to scan',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'rounded',
        color: '#18181b',
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#18181b',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#18181b',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'meme-bubble',
        label: 'SCAN ME!',
        color: '#18181b',
        secondaryColor: '#facc15',
      },
    },
  },
  {
    id: 'mushroom-meme',
    name: 'Mushroom Meme',
    nameKey: 'tools.qrcode.presets.mushroom_meme',
    category: 'scenario',
    description: 'Classic playful meme character style with scan bubble',
    options: {
      errorCorrectionLevel: 'Q',
      dotsOptions: {
        type: 'dots',
        color: '#09090b',
      },
      cornersSquareOptions: {
        type: 'square',
        color: '#09090b',
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#09090b',
      },
      backgroundOptions: {
        color: '#ffffff',
      },
      frameOptions: {
        type: 'mushroom',
        label: 'SCAN ME',
        color: '#09090b',
        secondaryColor: '#ef4444',
      },
    },
  },
]

export function getPresetById(id: string): QrPreset | undefined {
  return QR_PRESETS.find((preset) => preset.id === id)
}

export function getPresetsByCategory(category: QrPresetCategory): QrPreset[] {
  return QR_PRESETS.filter((preset) => preset.category === category)
}

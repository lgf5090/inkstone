import { ONLINE_LOGOS } from './online-logos'
import type { QrPreset, QrPresetCategory } from './types'

const taobaoLogo = ONLINE_LOGOS.find((l) => l.id === 'taobao')?.dataUrl

export const QR_PRESETS: QrPreset[] = [
  {
    id: 'default',
    nameKey: 'tools.qrcode.presets.default',
    category: 'minimal',
    descriptionKey: 'tools.qrcode.presets.default_desc',
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
    nameKey: 'tools.qrcode.presets.wecom',
    category: 'minimal',
    descriptionKey: 'tools.qrcode.presets.wecom_desc',
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
    nameKey: 'tools.qrcode.presets.simple_dots',
    category: 'minimal',
    descriptionKey: 'tools.qrcode.presets.simple_dots_desc',
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
    nameKey: 'tools.qrcode.presets.liquid_gradient',
    category: 'minimal',
    descriptionKey: 'tools.qrcode.presets.liquid_gradient_desc',
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
    nameKey: 'tools.qrcode.presets.bar_gradient',
    category: 'minimal',
    descriptionKey: 'tools.qrcode.presets.bar_gradient_desc',
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
    nameKey: 'tools.qrcode.presets.square_jump',
    category: 'minimal',
    descriptionKey: 'tools.qrcode.presets.square_jump_desc',
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
    nameKey: 'tools.qrcode.presets.dark_green_frame',
    category: 'frame',
    descriptionKey: 'tools.qrcode.presets.dark_green_frame_desc',
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
    nameKey: 'tools.qrcode.presets.red_blue_gradient',
    category: 'frame',
    descriptionKey: 'tools.qrcode.presets.red_blue_gradient_desc',
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
    nameKey: 'tools.qrcode.presets.three_color_card',
    category: 'frame',
    descriptionKey: 'tools.qrcode.presets.three_color_card_desc',
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
    nameKey: 'tools.qrcode.presets.heart_border',
    category: 'frame',
    descriptionKey: 'tools.qrcode.presets.heart_border_desc',
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
    nameKey: 'tools.qrcode.presets.liquid_stamp',
    category: 'frame',
    descriptionKey: 'tools.qrcode.presets.liquid_stamp_desc',
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
    nameKey: 'tools.qrcode.presets.pacman',
    category: 'artistic',
    descriptionKey: 'tools.qrcode.presets.pacman_desc',
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
    nameKey: 'tools.qrcode.presets.taobao',
    category: 'scenario',
    descriptionKey: 'tools.qrcode.presets.taobao_desc',
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
    nameKey: 'tools.qrcode.presets.meme_bubble',
    category: 'scenario',
    descriptionKey: 'tools.qrcode.presets.meme_bubble_desc',
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
    nameKey: 'tools.qrcode.presets.mushroom_meme',
    category: 'scenario',
    descriptionKey: 'tools.qrcode.presets.mushroom_meme_desc',
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

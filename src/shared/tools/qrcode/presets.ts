/**
 * Pre-configured beautification presets for QR code styling.
 * Covers Minimal, Frame, Artistic, and Scenario categories.
 */

import { ONLINE_LOGOS } from './online-logos'
import type { QrPreset, QrPresetCategory } from './types'

const taobaoLogo = ONLINE_LOGOS.find((l) => l.id === 'taobao')?.dataUrl

export const QR_PRESETS: QrPreset[] = [
  // =================== 简洁分类 (Minimal) ===================
  {
    id: 'default',
    name: '默认模板',
    nameKey: 'tools.qrcode.presets.default',
    category: 'minimal',
    description: '标准黑白方块，经典高对比度扫码方案',
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
    name: '企业微信',
    nameKey: 'tools.qrcode.presets.wecom',
    category: 'minimal',
    description: '商务深蓝连景点阵，方圆码眼专业稳重',
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
    name: '简约圆点',
    nameKey: 'tools.qrcode.presets.simpleDots',
    category: 'minimal',
    description: '轻盈圆形散点点阵，搭配极简圆形码眼',
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
    name: '液态渐变',
    nameKey: 'tools.qrcode.presets.liquidGradient',
    category: 'minimal',
    description: '蓝紫双色线性流动渐变，圆润平滑现代美感',
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
    name: '长条渐变',
    nameKey: 'tools.qrcode.presets.barGradient',
    category: 'minimal',
    description: '落日金橙至品红横向渐变，流光溢彩',
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
    name: '方块跳动',
    nameKey: 'tools.qrcode.presets.squareJump',
    category: 'minimal',
    description: '翡翠绿至青蓝对角律动，几何感十足',
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

  // =================== 边框分类 (Frame) ===================
  {
    id: 'dark-green-frame',
    name: '墨绿边框',
    nameKey: 'tools.qrcode.presets.darkGreenFrame',
    category: 'frame',
    description: '雅致墨绿古典几何外框，自带扫一扫说明标识',
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
        label: '扫一扫 了解更多',
        color: '#1b4332',
        secondaryColor: '#d4af37',
      },
    },
  },
  {
    id: 'red-blue-gradient',
    name: '红蓝渐变',
    nameKey: 'tools.qrcode.presets.redBlueGradient',
    category: 'frame',
    description: '双色流体渐变边框卡片，吸睛醒目',
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
        label: '扫一扫 查看内容',
        color: '#ef4444',
        secondaryColor: '#3b82f6',
      },
    },
  },
  {
    id: 'three-color-card',
    name: '三色名片',
    nameKey: 'tools.qrcode.presets.threeColorCard',
    category: 'frame',
    description: '孟菲斯三色装饰名片边框，现代活力',
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
    name: '爱心边框',
    nameKey: 'tools.qrcode.presets.heartBorder',
    category: 'frame',
    description: '浪漫粉嫩爱心点缀外框，节日情侣表白首选',
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
    name: '液态印章',
    nameKey: 'tools.qrcode.presets.liquidStamp',
    category: 'frame',
    description: '朱砂红流体印章边框，典雅认证徽章质感',
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
        label: '★ 专属认证 ★',
        color: '#be123c',
        secondaryColor: '#fb7185',
      },
    },
  },

  // =================== 艺术分类 (Artistic) ===================
  {
    id: 'pacman',
    name: '吃豆人',
    nameKey: 'tools.qrcode.presets.pacman',
    category: 'artistic',
    description: '复古街机暗黑霓虹风，吃豆人游戏像素外框',
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

  // =================== 场景分类 (Scenario) ===================
  {
    id: 'taobao',
    name: '淘宝',
    nameKey: 'tools.qrcode.presets.taobao',
    category: 'scenario',
    description: '电商导购亮橙风，内置淘宝官方矢量标志',
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
    name: '恶搞表情',
    nameKey: 'tools.qrcode.presets.memeBubble',
    category: 'scenario',
    description: '自带萌趣卡通引导气泡，趣味十足',
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
        label: '快去扫码！',
        color: '#18181b',
        secondaryColor: '#facc15',
      },
    },
  },
  {
    id: 'mushroom-meme',
    name: '蘑菇头表情',
    nameKey: 'tools.qrcode.presets.mushroomMeme',
    category: 'scenario',
    description: '经典蘑菇头搞怪风格，附带表情包扫码气泡',
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
        label: '扫一扫嘛',
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

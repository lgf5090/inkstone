/**
 * Curated Gradient Presets (Linear, Radial, Conic)
 */

import type { GradientConfig } from '../types'

export interface GradientPresetItem {
  id: string
  name: string
  tags: string[]
  config: GradientConfig
}

export const GRADIENT_PRESETS: GradientPresetItem[] = [
  {
    id: 'grad-01',
    name: 'Sunset Mirage',
    tags: ['warm', 'sunset', 'vibrant'],
    config: {
      type: 'linear',
      angle: 135,
      stops: [
        { id: '1', color: '#ff512f', offset: 0 },
        { id: '2', color: '#dd2476', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
  {
    id: 'grad-02',
    name: 'Deep Oceanic',
    tags: ['cold', 'ocean', 'blue'],
    config: {
      type: 'linear',
      angle: 90,
      stops: [
        { id: '1', color: '#2b5876', offset: 0 },
        { id: '2', color: '#4e4376', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
  {
    id: 'grad-03',
    name: 'Neon Cyberpunk',
    tags: ['neon', 'dark', 'cyber'],
    config: {
      type: 'linear',
      angle: 45,
      stops: [
        { id: '1', color: '#f72585', offset: 0 },
        { id: '2', color: '#7209b7', offset: 50 },
        { id: '3', color: '#4cc9f0', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
  {
    id: 'grad-04',
    name: 'Lush Forest',
    tags: ['nature', 'green', 'fresh'],
    config: {
      type: 'linear',
      angle: 120,
      stops: [
        { id: '1', color: '#11998e', offset: 0 },
        { id: '2', color: '#38ef7d', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
  {
    id: 'grad-05',
    name: 'Nordic Dawn',
    tags: ['minimal', 'soft', 'pastel'],
    config: {
      type: 'linear',
      angle: 180,
      stops: [
        { id: '1', color: '#e0c3fc', offset: 0 },
        { id: '2', color: '#8ec5fc', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
  {
    id: 'grad-06',
    name: 'Warm Flame',
    tags: ['warm', 'fire', 'red'],
    config: {
      type: 'linear',
      angle: 90,
      stops: [
        { id: '1', color: '#f12711', offset: 0 },
        { id: '2', color: '#f5af19', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
  {
    id: 'grad-07',
    name: 'Purple Mist',
    tags: ['purple', 'mystic', 'smooth'],
    config: {
      type: 'linear',
      angle: 45,
      stops: [
        { id: '1', color: '#654ea3', offset: 0 },
        { id: '2', color: '#eaafc8', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
  {
    id: 'grad-08',
    name: 'Cosmic Radial',
    tags: ['dark', 'radial', 'space'],
    config: {
      type: 'radial',
      angle: 0,
      stops: [
        { id: '1', color: '#8a2387', offset: 0 },
        { id: '2', color: '#e94057', offset: 50 },
        { id: '3', color: '#f27121', offset: 100 },
      ],
      useOklabInterpolation: true,
    },
  },
]

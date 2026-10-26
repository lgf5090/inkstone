/**
 * Flat UI Color Palettes (Default, Chinese, American, Aussie, British, Spanish, etc.)
 */

export interface UiPaletteGroup {
  id: string
  name: string
  description?: string
  colors: Array<{
    name: string
    hex: string
  }>
}

export const FLAT_UI_PALETTES: UiPaletteGroup[] = [
  {
    id: 'flat-default',
    name: 'Flat UI Classic',
    colors: [
      { name: 'Turquoise', hex: '#1abc9c' },
      { name: 'Emerald', hex: '#2ecc71' },
      { name: 'Peter River', hex: '#3498db' },
      { name: 'Amethyst', hex: '#9b59b6' },
      { name: 'Wet Asphalt', hex: '#34495e' },
      { name: 'Green Sea', hex: '#16a085' },
      { name: 'Nephritis', hex: '#27ae60' },
      { name: 'Belize Hole', hex: '#2980b9' },
      { name: 'Wisteria', hex: '#8e44ad' },
      { name: 'Midnight Blue', hex: '#2c3e50' },
      { name: 'Sun Flower', hex: '#f1c40f' },
      { name: 'Carrot', hex: '#e67e22' },
      { name: 'Alizarin', hex: '#e74c3c' },
      { name: 'Clouds', hex: '#ecf0f1' },
      { name: 'Concrete', hex: '#95a5a6' },
      { name: 'Orange', hex: '#f39c12' },
      { name: 'Pumpkin', hex: '#d35400' },
      { name: 'Pomegranate', hex: '#c0392b' },
      { name: 'Silver', hex: '#bdc3c7' },
      { name: 'Asbestos', hex: '#7f8c8d' },
    ],
  },
  {
    id: 'flat-chinese',
    name: 'Chinese Palette',
    colors: [
      { name: 'Golden Sand', hex: '#eccc68' },
      { name: 'Coral', hex: '#ff7f50' },
      { name: 'Wild Watermelon', hex: '#ff6b81' },
      { name: 'Peace', hex: '#a4b0be' },
      { name: 'Grisaille', hex: '#57606f' },
      { name: 'Orange', hex: '#ffa502' },
      { name: 'Bruschetta Tomato', hex: '#ff4757' },
      { name: 'Watermelon', hex: '#2ed573' },
      { name: 'Bay Wharf', hex: '#747d8c' },
      { name: 'Prestige Blue', hex: '#2f3542' },
      { name: 'Lime Soap', hex: '#7bed9f' },
      { name: 'French Sky Blue', hex: '#70a1ff' },
      { name: 'Saturated Sky', hex: '#5352ed' },
      { name: 'Clear Chill', hex: '#1e90ff' },
      { name: 'Bright Greek', hex: '#3742fa' },
    ],
  },
  {
    id: 'flat-american',
    name: 'American Palette',
    colors: [
      { name: 'Light Greenish Blue', hex: '#55efc4' },
      { name: 'Faded Poster', hex: '#81ecec' },
      { name: 'Green Darner Tail', hex: '#74b9ff' },
      { name: 'Shy Moment', hex: '#a29bfe' },
      { name: 'City Lights', hex: '#dfe6e9' },
      { name: 'Mint Leaf', hex: '#00b894' },
      { name: 'Robins Egg Blue', hex: '#00cec9' },
      { name: 'Electron Blue', hex: '#0984e3' },
      { name: 'Exodus Fruit', hex: '#6c5ce7' },
      { name: 'Soothing Breeze', hex: '#b2bec3' },
      { name: 'Sour Lemon', hex: '#ffeaa7' },
      { name: 'First Date', hex: '#fab1a0' },
      { name: 'Pink Glamour', hex: '#ff7675' },
      { name: 'Pico-8 Pink', hex: '#fd79a8' },
      { name: 'American River', hex: '#636e72' },
      { name: 'Bright Yarrow', hex: '#fdcb6e' },
      { name: 'Orange Hibiscus', hex: '#e17055' },
      { name: 'Chi-Gong', hex: '#d63031' },
      { name: 'Prunus Avium', hex: '#e84393' },
      { name: 'Dracula Orchid', hex: '#2d3436' },
    ],
  },
  {
    id: 'flat-aussie',
    name: 'Aussie Palette',
    colors: [
      { name: 'Beekeeper', hex: '#f6e58d' },
      { name: 'Spiced Nectarine', hex: '#ffbe76' },
      { name: 'Pink Glamour', hex: '#ff7979' },
      { name: 'June Bud', hex: '#badc58' },
      { name: 'Coastal Breeze', hex: '#dff9fb' },
      { name: 'Turbo', hex: '#f9ca24' },
      { name: 'Quince Jelly', hex: '#f0932b' },
      { name: 'Carmine Pink', hex: '#eb4d4b' },
      { name: 'Pure Apple', hex: '#6ab04c' },
      { name: 'Hint of Ice Pack', hex: '#c7ecee' },
      { name: 'Middle Blue', hex: '#7ed6df' },
      { name: 'Heliotrope', hex: '#e056fd' },
      { name: 'Exodus Fruit', hex: '#686de0' },
      { name: 'Deep Koamaru', hex: '#30336b' },
      { name: 'Soaring Eagle', hex: '#95afc0' },
      { name: 'Greenland Green', hex: '#22a6b3' },
      { name: 'Steel Pink', hex: '#be2edd' },
      { name: 'Blurple', hex: '#4834d4' },
      { name: 'Deep Cove', hex: '#130f40' },
      { name: 'Wizard Grey', hex: '#535c68' },
    ],
  },
]

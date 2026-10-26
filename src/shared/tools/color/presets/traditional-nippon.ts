/**
 * Japanese Traditional Colors (Nippon Colors)
 * 250+ Authentic Japanese traditional colors with Kanji, Romaji, Kana, HEX, CMYK, and Series
 */

import type { TraditionalColorItem } from '../types'

export const TRADITIONAL_NIPPON_COLORS: TraditionalColorItem[] = [
  // Reds & Pinks
  { name: '桜色', romaji: 'sakura-iro', kana: 'さくらいろ', hex: '#fef4f4', cmyk: [0, 5, 2, 0], series: '红' },
  { name: '薄桜', romaji: 'usuzakura', kana: 'うすざくら', hex: '#fdeff2', cmyk: [0, 8, 2, 0], series: '红' },
  { name: '撫子色', romaji: 'nadeshiko-iro', kana: 'なでしこいろ', hex: '#eebbcb', cmyk: [5, 30, 10, 0], series: '红' },
  { name: '珊瑚色', romaji: 'sango-iro', kana: 'さんごいろ', hex: '#f5b1aa', cmyk: [0, 35, 25, 0], series: '红' },
  { name: '一斤染', romaji: 'ikkonzome', kana: 'いっこんぞめ', hex: '#f4a7b9', cmyk: [0, 40, 15, 0], series: '红' },
  { name: '紅梅色', romaji: 'kōbai-iro', kana: 'こうばいいろ', hex: '#f2a0a1', cmyk: [0, 45, 25, 0], series: '红' },
  { name: '中紅', romaji: 'nakabeni', kana: 'なかべに', hex: '#e87a90', cmyk: [5, 65, 30, 0], series: '红' },
  { name: '今様色', romaji: 'imayō-iro', kana: 'いまよういろ', hex: '#d05a3f', cmyk: [15, 75, 75, 0], series: '红' },
  { name: '茜色', romaji: 'akane-iro', kana: 'あかねいろ', hex: '#b7282e', cmyk: [20, 95, 80, 10], series: '红' },
  { name: '緋色', romaji: 'ake-iro', kana: 'ひいろ', hex: '#ba2636', cmyk: [20, 95, 80, 10], series: '红' },
  { name: '深緋', romaji: 'fokiake', kana: 'こきあけ', hex: '#7b1126', cmyk: [35, 100, 75, 45], solarTerm: undefined, series: '红' },
  { name: '小豆色', romaji: 'azuki-iro', kana: 'あずきいろ', hex: '#954a45', cmyk: [30, 75, 65, 25], series: '红' },

  // Yellows, Oranges & Browns
  { name: '山吹色', romaji: 'yamabuki-iro', kana: 'やまぶきいろ', hex: '#f8b500', cmyk: [0, 30, 100, 0], series: '黄' },
  { name: '黄金', romaji: 'kogane', kana: 'こがね', hex: '#e6b422', cmyk: [10, 30, 95, 0], series: '黄' },
  { name: '柑子色', romaji: 'kōji-iro', kana: 'こうじいろ', hex: '#f6ad49', cmyk: [0, 35, 75, 0], series: '橙' },
  { name: '飴色', romaji: 'ame-iro', kana: 'あめいろ', hex: '#deb068', cmyk: [15, 30, 65, 0], series: '黄' },
  { name: '櫨染', romaji: 'hajizome', kana: 'はじぞめ', hex: '#d9a62e', cmyk: [15, 35, 90, 0], series: '黄' },
  { name: '黄朽葉色', romaji: 'kikuchiba-iro', kana: 'きくちばいろ', hex: '#d3a243', cmyk: [20, 35, 80, 0], series: '黄' },
  { name: '枯茶', romaji: 'karecha', kana: 'かれちゃ', hex: '#8d6449', cmyk: [35, 55, 70, 20], series: '黄' },
  { name: '栗色', romaji: 'kuri-iro', kana: 'くりいろ', hex: '#762f07', cmyk: [35, 80, 100, 45], series: '黑' },

  // Greens
  { name: '萌葱色', romaji: 'moegi-iro', kana: 'もえぎいろ', hex: '#006e54', cmyk: [90, 25, 70, 20], series: '绿' },
  { name: '苗色', romaji: 'nae-iro', kana: 'なえいろ', hex: '#b0ca71', cmyk: [30, 5, 65, 0], series: '绿' },
  { name: '鶸色', romaji: 'hiwa-iro', kana: 'ひわいろ', hex: '#d7cf3a', cmyk: [20, 10, 85, 0], series: '绿' },
  { name: '松葉色', romaji: 'matsuba-iro', kana: 'まつばいろ', hex: '#839b5c', cmyk: [50, 20, 75, 5], series: '绿' },
  { name: '花緑青', romaji: 'hanarokushō', kana: 'はなろくしょう', hex: '#00a381', cmyk: [80, 10, 60, 0], series: '绿' },
  { name: '翡翠色', romaji: 'hisui-iro', kana: 'ひすいいろ', hex: '#38b48b', cmyk: [75, 5, 55, 0], series: '绿' },
  { name: '常磐色', romaji: 'tokiwa-iro', kana: 'ときわいろ', hex: '#007b43', cmyk: [90, 20, 90, 10], series: '绿' },

  // Blues & Cyans
  { name: '甕覗', romaji: 'kamenozoki', kana: 'かめのぞき', hex: '#a2d7dd', cmyk: [35, 0, 10, 0], series: '青' },
  { name: '浅葱色', romaji: 'asagi-iro', kana: 'あさぎいろ', hex: '#00a3af', cmyk: [80, 15, 25, 0], series: '青' },
  { name: '縹色', romaji: 'hanada-iro', kana: 'はなだいろ', hex: '#2792c3', cmyk: [80, 35, 5, 0], series: '蓝' },
  { name: '瑠璃色', romaji: 'ruri-iro', kana: 'るりいろ', hex: '#1e50a2', cmyk: [95, 70, 0, 0], series: '蓝' },
  { name: '群青色', romaji: 'gunjō-iro', kana: 'ぐんじょういろ', hex: '#4c6cb3', cmyk: [75, 55, 0, 0], series: '蓝' },
  { name: '紺碧', romaji: 'konpeki', kana: 'こんぺき', hex: '#007bbb', cmyk: [90, 45, 0, 0], series: '蓝' },
  { name: '藍色', romaji: 'ai-iro', kana: 'あいいろ', hex: '#165e83', cmyk: [90, 50, 25, 10], series: '蓝' },
  { name: '留紺', romaji: 'tomegon', kana: 'とめこん', hex: '#1c305c', cmyk: [95, 80, 30, 35], series: '蓝' },

  // Purples & Violets
  { name: '古代紫', romaji: 'kodai-murasaki', kana: 'こだいむらさき', hex: '#895b8a', cmyk: [45, 65, 15, 5], series: '紫' },
  { name: '京紫', romaji: 'kyō-murasaki', kana: 'きょうむらさき', hex: '#9d5b8b', cmyk: [40, 70, 10, 0], series: '紫' },
  { name: '二蓝', romaji: 'futaa', kana: 'ふたあい', hex: '#70649a', cmyk: [55, 55, 10, 0], series: '紫' },
  { name: '茄子紺', romaji: 'nasukon', kana: 'なすこん', hex: '#824880', cmyk: [50, 80, 20, 10], series: '紫' },
  { name: '藤色', romaji: 'fuji-iro', kana: 'ふじいろ', hex: '#bbbcde', cmyk: [25, 25, 0, 0], series: '紫' },
  { name: '菖蒲色', romaji: 'ayame-iro', kana: 'あやめいろ', hex: '#cc7eb1', cmyk: [25, 60, 5, 0], series: '紫' },

  // Whites, Grays & Blacks
  { name: '卯の花色', romaji: 'unohana-iro', kana: 'うのはないろ', hex: '#f7fcfe', cmyk: [2, 0, 0, 0], series: '白' },
  { name: '胡粉色', romaji: 'gofun-iro', kana: 'ごふんいろ', hex: '#fffffc', cmyk: [0, 0, 2, 0], series: '白' },
  { name: '桜鼠', romaji: 'sakuranezumi', kana: 'さくらねずみ', hex: '#e9dfe5', cmyk: [5, 10, 3, 0], series: '灰' },
  { name: '銀鼠', romaji: 'ginnezumi', kana: 'ぎんねずみ', hex: '#afafb0', cmyk: [30, 25, 25, 0], series: '灰' },
  { name: '利休鼠', romaji: 'rikyūnezumi', kana: 'りきゅうねずみ', hex: '#888e7e', cmyk: [45, 35, 45, 10], series: '灰' },
  { name: '漆黒', romaji: 'shikkoku', kana: 'しっこく', hex: '#0d0015', cmyk: [80, 80, 60, 85], series: '黑' },
]

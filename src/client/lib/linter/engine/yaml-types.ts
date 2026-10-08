import type {CST} from 'yaml';
import {QuoteCharacter} from './yaml';

export interface YamlProperties {
  lineWidth: number,
  quotingType: QuoteCharacter,
  forceQuotes: boolean,
}

export interface Key {
  value?: string;
}

export interface YamlCSTTokens {
  offset?: number,
  type: string,
  indent?: number,
  start?: number;
  end?: number;
  items: CST.CollectionItem[];
}

export interface YamlNode {
  constructor: { name: string };
  key?: Key;
  value?: unknown;
  items?: [string, unknown][];
  moved?: boolean;
  srcTokens?: YamlCSTTokens;
}

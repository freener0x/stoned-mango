// What gets written into a file's tags for a result (the code shown on screen is the code written).

import type { Result } from '../../engine/analysis.ts';
import { camelot, mixKey, openKey, respell, standardKey } from '../notation.ts';
import type { Settings } from '../settings.ts';
import type { KeyTags } from './files.ts';

export const TAGGABLE = ['.mp3', '.wav', '.wave'];
export const isTaggable = (name: string) => TAGGABLE.some((ext) => name.toLowerCase().endsWith(ext));

export function keyTags(r: Result, s: Pick<Settings, 'codeRule' | 'spelling' | 'tagFormat' | 'tagModeFrame'>): KeyTags | null {
  if (!r.key) return null;
  const m = mixKey(r.key, s.codeRule);
  const tkey = s.tagFormat === 'camelot' ? camelot(m) : s.tagFormat === 'openkey' ? openKey(m) : standardKey(m, s.spelling);
  return { tkey, keyMode: s.tagModeFrame ? respell(r.label, s.spelling) : null };
}

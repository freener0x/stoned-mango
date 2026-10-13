// How a key looks everywhere in the app: its name, its DJ code chip, and confidence meters.

import type { CSSProperties } from 'react';
import type { Result } from '../engine/analysis.ts';
import type { Section } from '../engine/timeline.ts';
import { useSettings } from './context.ts';
import { camelot, codeFor, isApprox, mixKey, mixKeyName, pretty, respell, showsMixKey, type MixKey } from './notation.ts';

// Around the Camelot wheel, like the colours DJs know from it: 1 aqua ... 4 yellow ... 8 magenta ... 12 cyan.
const HUES = [172, 148, 104, 58, 36, 14, 350, 318, 285, 248, 218, 194];

export function keyHue(m: MixKey): number {
  return HUES[parseInt(camelot(m), 10) - 1];
}

/** A key's colour for drawing (timeline sections): the chip colour. */
export function keyColour(m: MixKey, alpha = 1): string {
  return `hsl(${keyHue(m)} 75% ${m.minor ? 70 : 80}% / ${alpha})`;
}

/** Engine text (labels, notes) in the user's spelling, with ♯ and ♭. */
export function useText(): (s: string) => string {
  const { settings } = useSettings();
  return (s: string) => pretty(respell(s, settings.spelling));
}

export function Chip({ m, code, large }: { m: MixKey; code: string; large?: boolean }) {
  const style = { '--h': keyHue(m) } as CSSProperties;
  return (
    <span className={`chip${m.minor ? ' minor' : ''}${large ? ' large' : ''}`} style={style}>
      {code}
    </span>
  );
}

type Keyed = Pick<Result, 'key' | 'label'> | Pick<Section, 'key' | 'label'>;

/**
 * "A minor · 8A", "D Dorian · 8B (C major)", per the key display setting.
 * ``full`` always shows the name too (the song view).
 */
export function KeyLabel({ r, full, large }: { r: Keyed; full?: boolean; large?: boolean }) {
  const { settings } = useSettings();
  const text = useText();
  if (!r.key) return <span className="key none">{text(r.label)}</span>;
  const m = mixKey(r.key, settings.codeRule);
  const codeOnly = settings.notation === 'camelot' || settings.notation === 'openkey';
  // maqam, makam and raga scales: the nearest major/minor key's code, marked ≈
  const approx = isApprox(r.key) ? '≈' : '';
  const plain = codeFor(m, settings.notation) ?? (full ? camelot(m) : null);
  const code = plain && approx + plain;
  const name = text(r.label);
  const mix = showsMixKey(r.key, m) ? `${approx ? '≈ ' : ''}${text(mixKeyName(m, settings.spelling))}` : null;
  return (
    <span className={`key${large ? ' large' : ''}`} title={codeOnly && !full ? name : undefined}>
      {(!codeOnly || full) && <span className="key-name">{name}</span>}
      {code && <Chip m={m} code={code} large={large} />}
      {mix && (!codeOnly || full) && <span className="key-mix">({mix})</span>}
    </span>
  );
}

/** A level-meter style bar for a 0..1 value. */
export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}
      style={{ '--v': `${pct}%` } as CSSProperties}>
      <span className="meter-fill" />
    </span>
  );
}

/** The key confidence (home note and major/minor), the number calibrated on real music. */
export const sureOf = (r: Result) => r.key_confidence ?? r.confidence;

// The song's timeline: its sections coloured by key (with the Camelot wheel's colours),
// the loudness over time, and the playhead. Click or tap to move the playhead; with the
// keyboard, the arrow keys move it 5 seconds (Shift: 30).

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { loudness, type Envelope } from '../engine/envelope.ts';
import type { Section } from '../engine/timeline.ts';
import { useSettings } from './context.ts';
import { clock } from './exporters.ts';
import { keyColour, useText } from './keys.tsx';
import { codeFor, isApprox, mixKey, camelot, type CodeRule } from './notation.ts';

interface Props {
  duration: number;
  segments: Section[];
  envelope?: Envelope;
  time: number;
  onSeek(t: number): void;
}

const LANE = 24;
const AXIS = 18;
const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

export function Timeline({ duration, segments, envelope, time, onSeek }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const { settings } = useSettings();
  const text = useText();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const dpr = window.devicePixelRatio || 1;
    const h = c.clientHeight;
    c.width = Math.round(width * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, c, width, h, { duration, segments, envelope, time, hover, rule: settings.codeRule,
      name: (s: Section) => {
        if (!s.key) return { code: '', name: text(s.label) };
        const m = mixKey(s.key, settings.codeRule);
        return { code: `${isApprox(s.key) ? '≈' : ''}${codeFor(m, settings.notation) ?? camelot(m)}`, name: text(s.label) };
      } });
  }, [width, duration, segments, envelope, time, hover, settings, text]);

  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((e.clientX - box.left) / box.width) * duration));
  };
  const section = (t: number) => segments.find((s) => t >= s.start && t < s.end) ?? segments[segments.length - 1];
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 30 : 5;
    const to = { ArrowLeft: time - step, ArrowRight: time + step, Home: 0, End: duration }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onSeek(Math.max(0, Math.min(duration, to)));
  };
  const current = section(time);
  const tip = hover !== null ? section(hover) : null;

  return (
    <div className="timeline" ref={wrap}>
      <canvas ref={canvas} className="timeline-canvas" tabIndex={0} role="slider" aria-label="Playhead position"
        aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
        aria-valuetext={`${clock(time)}${current ? `, ${text(current.label)}` : ''}`}
        onPointerDown={(e) => onSeek(at(e))}
        onPointerMove={(e) => e.pointerType === 'mouse' && setHover(at(e))}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey} />
      {hover !== null && tip && (
        <div className="timeline-tip" style={{ left: `${(hover / duration) * 100}%` }}>
          {clock(hover)} · {text(tip.label)}
        </div>
      )}
    </div>
  );
}

interface DrawData extends Omit<Props, 'onSeek'> {
  hover: number | null;
  rule: CodeRule;
  name(s: Section): { code: string; name: string };
}

function draw(ctx: CanvasRenderingContext2D, el: HTMLElement, w: number, h: number, d: DrawData): void {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const font = v('--font-ui') || 'system-ui, sans-serif';
  const x = (t: number) => (d.duration > 0 ? (t / d.duration) * w : 0);
  const waveTop = LANE + 6;
  const waveH = h - LANE - AXIS - 10;
  const mid = waveTop + waveH / 2;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = v('--tl-bg');
  ctx.fillRect(0, 0, w, h - AXIS);

  // Sections: a coloured lane with the key, and a tint behind the loudness.
  ctx.textBaseline = 'middle';
  for (const [i, s] of d.segments.entries()) {
    const x0 = x(s.start);
    const x1 = x(s.end);
    const m = s.key ? mixKey(s.key, d.rule) : null;
    ctx.fillStyle = m ? keyColour(m) : v('--line-strong');
    ctx.fillRect(x0, 0, x1 - x0, LANE);
    ctx.fillStyle = m ? keyColour(m, 0.13) : 'transparent';
    ctx.fillRect(x0, LANE, x1 - x0, h - LANE - AXIS);
    if (i > 0) {
      ctx.fillStyle = v('--tl-boundary');
      ctx.fillRect(Math.round(x0) - 1, 0, 2, h - AXIS);
    }
    const { code, name } = d.name(s);
    const room = x1 - x0 - 12;
    ctx.fillStyle = m ? '#101114' : v('--text');
    for (const label of [`${code}  ${name}`.trim(), code, '']) {
      ctx.font = `600 12px ${font}`;
      if (label && ctx.measureText(label).width <= room) {
        ctx.fillText(label, x0 + 6, LANE / 2 + 1);
        break;
      }
    }
  }

  // Loudness: one bar per pixel column, mirrored around the middle; brighter where already played.
  if (d.envelope && d.envelope.values.length) {
    const { step, values } = d.envelope;
    const played = x(d.time);
    for (let px = 0; px < w; px++) {
      const t0 = (px / w) * d.duration;
      const t1 = ((px + 1) / w) * d.duration;
      let peak = 0;
      for (let i = Math.floor(t0 / step); i <= Math.min(values.length - 1, Math.floor(t1 / step)); i++) peak = Math.max(peak, values[i]);
      const amp = Math.max(0.5, loudness(peak) * (waveH / 2));
      ctx.fillStyle = px < played ? v('--tl-wave-played') : v('--tl-wave');
      ctx.fillRect(px, mid - amp, 1, amp * 2);
    }
  }

  // Time axis.
  ctx.fillStyle = v('--panel');
  ctx.fillRect(0, h - AXIS, w, AXIS);
  ctx.fillStyle = v('--muted');
  ctx.font = `11px ${v('--font-mono') || 'monospace'}`;
  const every = TICKS.find((t) => x(t) >= 56) ?? TICKS[TICKS.length - 1];
  for (let t = 0; t <= d.duration; t += every) {
    const tx = Math.round(x(t));
    ctx.fillRect(tx, h - AXIS, 1, 4);
    const label = clock(t);
    const lw = ctx.measureText(label).width;
    if (tx + lw + 3 <= w) ctx.fillText(label, tx + 3, h - AXIS / 2 + 1);
  }

  // Playhead and hover line.
  if (d.hover !== null) {
    ctx.fillStyle = v('--tl-hover');
    ctx.fillRect(Math.round(x(d.hover)), 0, 1, h - AXIS);
  }
  ctx.fillStyle = v('--accent');
  const px = Math.min(w - 2, Math.round(x(d.time)));
  ctx.fillRect(px - 1, 0, 2, h - AXIS);
}

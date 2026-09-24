import { ROLE_ALIASES } from '../core/selector.ts';
import type { ElementSummary, Rect } from '../types.ts';

/**
 * Selector generation for recorded elements.
 *
 * Produces candidates in order of how well they survive change: an explicit
 * accessibility identifier first, then role + visible label, then scoping by a
 * labelled ancestor. The recording session checks each candidate against the
 * live tree and keeps the first one that matches exactly one element.
 */

/** Preferred DSL name for each raw role (the reverse of ROLE_ALIASES). */
const ROLE_NAMES: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  // Earlier aliases win; `tab` and `field` are listed after the names we prefer.
  for (const [alias, role] of Object.entries(ROLE_ALIASES)) {
    if (!role || out[role]) continue;
    if (alias === 'tab' || alias === 'field') continue;
    out[role] = alias;
  }
  return out;
})();

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

/**
 * Quotes a value for the selector DSL, or returns undefined when the value
 * cannot be expressed safely (both quote kinds, or the `>>` chain separator).
 */
export function quoteValue(v: string): string | undefined {
  if (v.includes('>>')) return undefined;
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  return undefined;
}

/**
 * Identifiers that are generated per launch or per build and so would make a
 * selector that passes once and then never again.
 */
export function isStableIdentifier(id: string | undefined): id is string {
  if (!id || id.length > 120) return false;
  if (/^_NS:\d+$/.test(id)) return false;                 // AppKit auto ids
  if (/^\d+$/.test(id)) return false;                     // bare runtime ids (e.g. Win32 control ids)
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return false; // UUIDs
  if (/\s/.test(id) || id.includes('>>')) return false;
  return true;
}

/** Labels longer than this read as content, not as a control's name. */
const MAX_LABEL = 80;

function label(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return t && t.length <= MAX_LABEL ? t : undefined;
}

/** Candidates that identify `el` on its own, without any ancestor. */
function ownCandidates(el: ElementSummary): string[] {
  const role = roleName(el.role);
  const out: string[] = [];
  if (isStableIdentifier(el.identifier)) out.push(`#${el.identifier}`);

  const attrs: [string, string | undefined][] = [
    ['title', label(el.title)],
    ['desc', label(el.description)],
    ['help', label(el.help)],
  ];
  for (const [key, v] of attrs) {
    const q = v && quoteValue(v);
    if (q) out.push(`${role}[${key}=${q}]`);
  }
  const ph = label(el.placeholder);
  const qph = ph && quoteValue(ph);
  if (qph) out.push(`${role}[text=${qph}]`);

  // A static text's value *is* its label. For editable controls the value is
  // user data and changes, so it is never used to find them.
  if (el.role === 'AXStaticText' || el.role === 'Text') {
    const v = label(el.value);
    const q = v && quoteValue(v);
    if (q) out.push(`${role}[value=${q}]`);
  }
  return out;
}

/** Roles that are only ever structural wrappers and make poor anchors. */
const ANONYMOUS = new Set(['AXGroup', 'AXScrollArea', 'AXSplitGroup', 'AXLayoutArea', 'AXUnknown', 'Pane', 'Custom']);

/**
 * All selector candidates for an element, best first.
 *
 * When the element has no usable label of its own (an icon-only button, a
 * blank text field) it is scoped under the nearest ancestor that does have
 * one: `group[title="Account"] >> textfield`.
 */
export function selectorCandidates(el: ElementSummary, ancestors: ElementSummary[] = []): string[] {
  const own = ownCandidates(el);
  const out = [...own];

  // Windows are the scope already, so anchors come from inside them.
  const inside = ancestors.filter((a) => a.role !== 'AXWindow' && a.role !== 'Window' && a.role !== 'AXSheet');
  for (const a of inside.slice(0, 6)) {
    if (ANONYMOUS.has(a.role) && !isStableIdentifier(a.identifier) && !label(a.title) && !label(a.description)) continue;
    const anchor = ownCandidates(a)[0];
    if (!anchor) continue;
    const leaf = own[0] ?? roleName(el.role);
    out.push(`${anchor} >> ${leaf}`);
    if (own.length) break;
  }

  out.push(roleName(el.role));
  return [...new Set(out)];
}

/** Appends `:nth(i)` to a selector's last step. */
export function withNth(selector: string, index: number): string {
  return `${selector}:nth(${index})`;
}

/** A short human description of an element, for step lists. */
export function describeElement(el: ElementSummary | undefined): string {
  if (!el) return 'element';
  const name = label(el.title) ?? label(el.description) ?? label(el.placeholder) ?? label(el.help)
    ?? (el.role === 'AXStaticText' ? label(el.value) : undefined) ?? el.identifier;
  const role = roleName(el.role).replace(/^AX/, '').toLowerCase();
  return name ? `${role} “${name}”` : role;
}

/** True when two rects are the same element's bounds, give or take a pixel. */
export function sameRect(a: Rect | undefined, b: Rect | undefined, tolerance = 2): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

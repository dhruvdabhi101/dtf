import type { Selector, SelectorPath } from '../types.ts';

/**
 * Friendly role names, so tests read like the UI rather than like the AX API.
 * Unknown names pass through untouched, which lets you use any raw AX role.
 */
export const ROLE_ALIASES: Record<string, string> = {
  button: 'AXButton',
  checkbox: 'AXCheckBox',
  radio: 'AXRadioButton',
  text: 'AXStaticText',
  textfield: 'AXTextField',
  textarea: 'AXTextArea',
  field: 'AXTextField',
  window: 'AXWindow',
  menu: 'AXMenu',
  menuitem: 'AXMenuItem',
  menubar: 'AXMenuBar',
  menubaritem: 'AXMenuBarItem',
  group: 'AXGroup',
  image: 'AXImage',
  link: 'AXLink',
  list: 'AXList',
  row: 'AXRow',
  cell: 'AXCell',
  table: 'AXTable',
  tab: 'AXRadioButton',
  toolbar: 'AXToolbar',
  slider: 'AXSlider',
  popup: 'AXPopUpButton',
  sheet: 'AXSheet',
  scrollarea: 'AXScrollArea',
  webarea: 'AXWebArea',
  any: '',
  '*': '',
};

function normaliseRole(raw: string): string | undefined {
  const key = raw.toLowerCase();
  if (key in ROLE_ALIASES) {
    const mapped = ROLE_ALIASES[key];
    return mapped === '' ? undefined : mapped;
  }
  return raw;
}

/**
 * Parses one step of the string DSL.
 *
 *   button[title="Save"]        role + exact title
 *   text[contains=Welcome]      role + substring across all label attributes
 *   #save-button                identifier shorthand
 *   "Quit"                      bare string: substring across all label attributes
 *   menuitem[title=Quit]:nth(1) positional disambiguation
 */
function parseStep(raw: string): Selector {
  let step = raw.trim();
  const sel: Selector = {};

  const nth = step.match(/:nth\((\d+)\)\s*$/);
  if (nth) {
    sel.nth = Number(nth[1]);
    step = step.slice(0, nth.index).trim();
  }

  if (step.startsWith('#')) {
    sel.identifier = step.slice(1);
    return sel;
  }

  const quoted = step.match(/^"(.*)"$/s) ?? step.match(/^'(.*)'$/s);
  if (quoted) {
    sel.text = quoted[1];
    return sel;
  }

  const bracket = step.indexOf('[');
  const rolePart = (bracket === -1 ? step : step.slice(0, bracket)).trim();
  if (rolePart) {
    const role = normaliseRole(rolePart);
    if (role) sel.role = role;
  }

  if (bracket === -1) {
    // No attribute filter and no recognised role: treat it as free text.
    if (!sel.role && rolePart) sel.text = rolePart;
    return sel;
  }

  const close = step.lastIndexOf(']');
  if (close < bracket) throw new Error(`unbalanced '[' in selector step: ${raw}`);
  const attrs = step.slice(bracket + 1, close);

  for (const pair of splitTopLevel(attrs, ',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      sel.text = pair.trim();
      continue;
    }
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    applyAttr(sel, key, value, raw);
  }
  return sel;
}

function applyAttr(sel: Selector, key: string, value: string, raw: string) {
  switch (key) {
    case 'title': sel.title = value; break;
    case 'contains': sel.text = value; break;
    case 'text': sel.text = value; break;
    case 'titleContains': sel.titleContains = value; break;
    case 'match': sel.titleMatch = value; break;
    case 'titleMatch': sel.titleMatch = value; break;
    case 'value': sel.value = value; break;
    case 'valueContains': sel.valueContains = value; break;
    case 'desc':
    case 'description': sel.description = value; break;
    case 'descContains':
    case 'descriptionContains': sel.descriptionContains = value; break;
    case 'help': sel.help = value; break;
    case 'helpContains': sel.helpContains = value; break;
    case 'id':
    case 'identifier': sel.identifier = value; break;
    case 'subrole': sel.subrole = value; break;
    case 'enabled': sel.enabled = value !== 'false'; break;
    case 'focused': sel.focused = value !== 'false'; break;
    case 'nth': sel.nth = Number(value); break;
    case 'maxDepth': sel.maxDepth = Number(value); break;
    default:
      throw new Error(`unknown selector attribute '${key}' in: ${raw}`);
  }
}

/** Splits on `sep` while ignoring separators inside quotes. */
function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === sep) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out.filter((s) => s.trim().length > 0);
}

/** Normalises any accepted selector form into the array the driver expects. */
export function toSelectorPath(input: SelectorPath): Selector[] {
  if (typeof input === 'string') {
    return input.split('>>').map(parseStep);
  }
  return Array.isArray(input) ? input : [input];
}

/** Renders a selector back to something readable for failure messages. */
export function describeSelector(input: SelectorPath): string {
  if (typeof input === 'string') return input;
  const path = Array.isArray(input) ? input : [input];
  return path
    .map((s) =>
      Object.entries(s)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' '),
    )
    .join(' >> ');
}

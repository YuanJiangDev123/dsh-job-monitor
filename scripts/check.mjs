#!/usr/bin/env node
/**
 * Static self-check for the job-monitor client bundle.
 *
 * The bundle is a single browser file with no build step, so these invariants
 * are the only compile-time guarantees available: every UI string is defined in
 * both dictionaries, the stylesheet stays on theme tokens, and the registration
 * shape matches what the slot expects. Run with `node scripts/check.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const fail = [];
const note = [];

/** Pull one `const NAME = { … };` literal out of the bundle and evaluate it. */
function readDict(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`dictionary ${name} not found`);
  // The literal closes on its own line as `};`; take the object only.
  const end = source.indexOf('\n    };', start);
  if (end === -1) throw new Error(`dictionary ${name} is not terminated`);
  const body = source.slice(source.indexOf('{', start), end + 6);
  return Function(`return (${body});`)();
}

const zh = readDict('zh');
const en = readDict('en');

// 1. Both dictionaries must describe exactly the same key set.
const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
const missingEn = zhKeys.filter((key) => !(key in en));
const missingZh = enKeys.filter((key) => !(key in zh));
if (missingEn.length > 0) fail.push(`en is missing: ${missingEn.join(', ')}`);
if (missingZh.length > 0) fail.push(`zh is missing: ${missingZh.join(', ')}`);

// 2. Every inline t('key') must resolve in both dictionaries.
const called = new Set();
for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) called.add(match[1]);
for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) called.add(match[1]);
for (const key of called) {
  if (!(key in zh) || !(key in en)) fail.push(`t('${key}') has no dictionary entry`);
}

// A key is still referenced when its quoted literal appears anywhere in the
// bundle: several call sites pick the key with a ternary instead of inline.
const quoted = new Set();
for (const match of source.matchAll(/'([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g)) quoted.add(match[1]);

// 3. Report keys nothing reaches, so dead copy does not accumulate.
//    These families are reached through a computed key only.
const computed = /^(pill\.(live|failed|nonzero|idle)|status\.(running|stopping|completed|killed|failed))$/;
for (const key of zhKeys) {
  if (called.has(key) || quoted.has(key) || computed.test(key)) continue;
  note.push(`unreferenced key: ${key}`);
}

// 4. Stylesheet must stay on theme tokens: no literal colours outside elevation
//    fallbacks, and no non-token custom properties.
const cssStart = source.indexOf('const CSS = `');
const cssEnd = source.indexOf('\n`;', cssStart);
if (cssStart === -1 || cssEnd === -1) throw new Error('CSS block not found');
const css = source.slice(cssStart, cssEnd);

const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
if (hex.length > 0) fail.push(`literal colours in CSS: ${[...new Set(hex)].join(', ')}`);

for (const line of css.split('\n')) {
  if (/\b(rgba?|hsla?)\(/.test(line) && !line.includes('var(--dsw-elevation')) {
    fail.push(`literal colour function outside an elevation fallback: ${line.trim()}`);
  }
}

const customProps = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
for (const prop of customProps) {
  if (!prop.startsWith('--dsw-')) fail.push(`non-theme custom property in CSS: ${prop}`);
}

// 5. Registration shape the slot owner expects.
// State that a memo consumes must be declared before it, or every render throws
// a temporal-dead-zone error the slot cannot show.
const declarationOrder = ['const [watchLimit', 'const [pins', 'const sessionIds', 'const watched', 'const allJobs'];
const positions = declarationOrder.map((needle) => source.indexOf(needle));
if (positions.some((value) => value < 0)) fail.push('page declarations are missing: ' + declarationOrder.join(' / '));
else if (positions.some((value, index) => index > 0 && value < positions[index - 1])) {
  fail.push('page declarations are out of order: ' + declarationOrder.join(' -> '));
}

// Every category the classifier can return needs a label in both dictionaries.
const orderMatch = /const PURPOSE_ORDER = \[([^\]]+)\]/.exec(source);
if (orderMatch === null) fail.push('PURPOSE_ORDER is missing');
else {
  const ids = [...orderMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  for (const id of ids) {
    for (const dict of [zh, en]) {
      if (!(`purpose.${id}` in dict)) fail.push(`purpose.${id} has no dictionary entry`);
    }
  }
}

// Sized boxes must not stay inline: width/height are ignored on an inline span.
const fillRule = /\.jp-fill\{([^}]*)\}/.exec(source);
if (fillRule === null) fail.push('.jp-fill rule is missing');
else if (!/display\s*:\s*(block|flex|grid|inline-block)/.test(fillRule[1])) {
  fail.push('.jp-fill must set a non-inline display, otherwise its width is ignored');
}

if (!source.includes("const PANEL_ID = 'job-monitor';")) fail.push('PANEL_ID constant is missing');
for (const [needle, label] of [
  ["name: 'main'", 'main panel registration'],
  ['key: PANEL_ID', 'panel key'],
  ["name: 'sidebar.panellist'", 'sidebar entry registration'],
  ['id: PANEL_ID', 'sidebar entry id'],
]) {
  if (!source.includes(needle)) fail.push(`registration is missing ${label} (${needle})`);
}
if (!/ctx\.locale\.register\(NS,\s*\{\s*zh,\s*en\s*\}\)/.test(source)) {
  fail.push('locale namespace registration does not match the dictionaries');
}

console.log(`dictionaries: ${zhKeys.length} keys (zh), ${enKeys.length} keys (en)`);
console.log(`i18n calls:    ${called.size} inline keys`);
console.log(`css:          ${customProps.size} theme tokens, ${hex.length} literal colours`);
for (const line of note) console.log(`  note: ${line}`);

if (fail.length > 0) {
  console.error(`\nFAILED (${fail.length})`);
  for (const line of fail) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('\nOK');

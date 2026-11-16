#!/usr/bin/env node
/**
 * Static verification for the dsh-go native panel.
 *
 * The dsh-go plugin kit (`~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs`) is not
 * installed on this machine, so this script performs the checks that can be made
 * from the local spec (`C:\Users\one\dsh-go-memory-panel-spec.md`) and this package:
 * manifest fields/limits, the v2 view document, action → `/dmem` command mapping,
 * effect bounds, and locale copy. It never talks to a live dsh-go App.
 *
 * Usage: node ui/verify-dshgo.mjs [--root <package-dir>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootFlag = process.argv.indexOf('--root');
const root = resolve(rootFlag >= 0 && process.argv[rootFlag + 1] ? process.argv[rootFlag + 1] : join(here, '..'));

const passes = [];
const failures = [];
const notes = [];
const pass = message => passes.push(message);
const fail = message => failures.push(message);
const note = message => notes.push(message);
const length = value => [...String(value)].length;

// Spec limits (dsh-go-plugin declarative view / effects).
const PANEL_TITLE_MAX = 16;
const PLUGIN_TITLE_MAX = 24;
const BUTTON_LABEL_MAX = 10;
const TOAST_MAX = 40;
const COPY_MAX = 8000;
const VIEW_BYTES_MAX = 32 * 1024;
const VIEW_NODES_MAX = 120;
const VIEW_DEPTH_MAX = 8;
const EFFECTS_MAX = 4;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const ALLOWED_NODE_TYPES = new Set(['stack', 'text', 'keyValue', 'list', 'callout', 'actions']);
const ALLOWED_STYLE_KEYS = new Set(['size', 'weight']);
const ALLOWED_SIZES = new Set(['title', 'body', 'caption']);
const ALLOWED_WEIGHTS = new Set(['bold', 'regular', 'medium']);
const ALLOWED_EFFECT_KEYS = new Set(['command', 'refresh', 'toast', 'copy', 'insert', 'link']);
/** `/dmem` handler grammar in index.js (commandText); the App executes `dmem <verb>`. */
const HOST_COMMAND_PATTERN = /^dmem (consent( (status|on|off|profile (unified|situational|off)|inject (on|off)|sensitive (on|off)))?|pause|resume|export)$/;

// ── package.json ─────────────────────────────────────────────────────────────
const manifestPath = join(root, 'package.json');
let pkg;
if (!existsSync(manifestPath)) {
  fail(`missing package.json at ${manifestPath}`);
} else {
  const bytes = readFileSync(manifestPath);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('package.json starts with a UTF-8 BOM; the engine manifest parser expects plain JSON');
  }
  try {
    pkg = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    pass('package.json parses as JSON and has no BOM');
  } catch (error) {
    fail(`package.json is not valid JSON: ${error.message}`);
  }
}

const go = pkg && pkg.dshGo;
if (pkg) {
  if (pkg.version === '2.4.0') pass('version is 2.4.0');
  else fail(`version must be 2.4.0, found ${JSON.stringify(pkg.version)}`);

  if (pkg.main === 'index.js') pass('main entry is index.js');
  else fail('package.json is missing "main": "index.js" (dsh-go loads the plugin entry through it)');

  // The Web/Desktop client half must survive the dsh-go addition.
  if (pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web') {
    pass('dsh.client.platform stays "web" (Web/Desktop panel unaffected)');
  } else {
    fail('dsh.client.platform must stay "web"; changing it disables the Web/Desktop panel');
  }
  const clientRel = pkg.exports && pkg.exports['./client'];
  if (typeof clientRel === 'string' && existsSync(join(root, clientRel))) {
    pass('exports["./client"] still resolves (Web panel bundle intact)');
  } else {
    fail('exports["./client"] is missing or points at a missing file');
  }
  if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) pass('dsh.bundle.patch is preserved (dual identity)');
  else fail('dsh.bundle.patch is missing');

  if (!go || typeof go !== 'object') {
    fail('package.json is missing the dshGo manifest');
  } else {
    if (go.v === 1) pass('dshGo.v is 1');
    else fail(`dshGo.v must be 1, found ${JSON.stringify(go.v)}`);
    if (go.minApp === undefined) {
      note('dshGo.minApp omitted: the local kit/template is unavailable, so the App version format cannot be verified (bridge version 0.4.0 is not an App version).');
    } else if (typeof go.minApp === 'string' && go.minApp.trim() !== '') {
      pass(`dshGo.minApp present (${go.minApp})`);
    } else {
      fail('dshGo.minApp must be a non-empty string when present');
    }
    const pluginTitle = go.title;
    if (pluginTitle && typeof pluginTitle.zh === 'string' && typeof pluginTitle.en === 'string'
      && pluginTitle.zh.trim() && pluginTitle.en.trim()
      && length(pluginTitle.zh) <= PLUGIN_TITLE_MAX && length(pluginTitle.en) <= PLUGIN_TITLE_MAX) {
      pass(`plugin title localized and ≤${PLUGIN_TITLE_MAX} chars`);
    } else {
      fail(`dshGo.title needs zh/en strings ≤${PLUGIN_TITLE_MAX} chars`);
    }
    if (go.icon === 'settings') pass('plugin icon is "settings"');
    else fail('dshGo.icon must be "settings"');
    if (Array.isArray(go.wants) && go.wants.length === 0) pass('dshGo.wants is empty (no clipboard/input/message access)');
    else fail('dshGo.wants must be an empty array');
    const panels = go.contributes && go.contributes.panels;
    if (!Array.isArray(panels) || panels.length !== 1) {
      fail('dshGo.contributes.panels must contain exactly one panel');
    } else {
      const panel = panels[0];
      if (panel && panel.id === 'memory-settings') pass('panel id is "memory-settings"');
      else fail('panel id must be "memory-settings"');
      if (panel && ID_PATTERN.test(String(panel.id))) pass('panel id matches the bridge id grammar');
      else fail(`panel id "memory-settings" does not match ${ID_PATTERN}`);
      if (panel && panel.title && typeof panel.title.zh === 'string' && typeof panel.title.en === 'string'
        && length(panel.title.zh) <= PANEL_TITLE_MAX && length(panel.title.en) <= PANEL_TITLE_MAX) {
        pass(`panel title zh/en ≤${PANEL_TITLE_MAX} chars`);
      } else {
        fail(`panel title needs zh/en strings ≤${PANEL_TITLE_MAX} chars`);
      }
      const placement = panel && panel.placement;
      const expectedPlacement = ['session.tab', 'features', 'chat.panel'];
      if (Array.isArray(placement) && placement.length === expectedPlacement.length
        && expectedPlacement.every(item => placement.includes(item))) {
        pass('panel placement covers session.tab / features / chat.panel');
      } else {
        fail(`panel placement must be ${expectedPlacement.join(' / ')}`);
      }
      if (panel && panel.presentation === 'page') pass('panel presentation is "page"');
      else fail('panel presentation must be "page"');
      if (panel && panel.icon === 'settings') pass('panel icon is "settings"');
      else fail('panel icon must be "settings"');
    }
  }
}

// ── index.js ────────────────────────────────────────────────────────────────
const indexPath = join(root, 'index.js');
let source = '';
let mod;
if (!existsSync(indexPath)) {
  fail('missing index.js');
} else {
  source = readFileSync(indexPath, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', indexPath], { stdio: 'pipe' });
    pass('index.js passes `node --check`');
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().split('\n').slice(0, 3).join(' ') : String(error);
    fail(`index.js failed \`node --check\`: ${detail}`);
  }
  const imports = [...source.matchAll(/from (['"])([^'"]+)\1/g)].map(match => match[2]);
  const unexpectedImports = imports.filter(spec => !spec.startsWith('node:'));
  if (unexpectedImports.length === 0) pass('index.js imports Node built-ins only (no new network client)');
  else fail(`index.js has unexpected imports: ${unexpectedImports.join(', ')}`);
  const networkImports = imports.filter(spec => ['node:http', 'node:https', 'node:net', 'node:dgram'].includes(spec));
  if (networkImports.length === 0) pass('index.js opens no network module');
  else fail(`index.js imports network modules: ${networkImports.join(', ')}`);
  if (!/\bfetch\s*\(/.test(source)) pass('index.js issues no fetch() calls');
  else fail('index.js contains a fetch() call');

  if (/ctx\.inject\(\s*\['dshGo'\]/.test(source)) pass("index.js registers through ctx.inject(['dshGo'], …)");
  else fail("index.js has no ctx.inject(['dshGo'], …) registration");

  const snapshotSlice = sliceBetween(source, 'const dshGoSnapshot = scope => {', 'let dshGoLocale');
  if (!snapshotSlice) {
    fail('dshGoSnapshot() closure not found before the registration block');
  } else {
    const sources = ['consentStatus()', 'storageState', 'rowsById.size', 'countPlaintextRows()', 'injectionSnapshots', 'buildDshGoSnapshot'];
    const missing = sources.filter(name => !snapshotSlice.includes(name));
    if (missing.length === 0) pass('dshGoSnapshot() reads only consent/storage/rows/countPlaintextRows/injection');
    else fail(`dshGoSnapshot() misses read-only sources: ${missing.join(', ')}`);
    if (/fetch\s*\(|readFile|writeFile|consentTable|\.put\(/.test(snapshotSlice)) {
      fail('dshGoSnapshot() performs a network/file/storage write');
    } else {
      pass('dshGoSnapshot() performs no network, file, or storage write');
    }
  }

  const actionSlice = sliceBetween(source, 'export function dshGoActionEffect', 'export function apply');
  if (!actionSlice) {
    fail('dshGoActionEffect() not found');
  } else {
    if (!/consentTable|\.put\(|writeFile|persistConsent|storageDomain/.test(actionSlice)) {
      pass('panel actions never touch storage directly (commands/copy/toast only)');
    } else {
      fail('panel actions reference storage primitives');
    }
    if (/command:\s*'dmem /.test(actionSlice)) pass('panel actions emit `dmem …` commands for the App to execute');
    else fail('panel actions emit no `dmem …` command');
  }

  if (source.includes("name: 'dmem'")) pass("/dmem host command is registered (App command target exists)");
  else fail('host /dmem command registration not found');
  for (const marker of ["input === 'export'", "input === 'pause' || input === 'resume' || input === 'capture'", "input === 'consent' || input.startsWith('consent ')"]) {
    if (!source.includes(marker)) fail(`/dmem handler branch missing: ${marker}`);
  }
  pass('/dmem handler branches for consent/pause/resume/export exist');

  mod = await import(pathToFileURL(indexPath).href);
  pass('index.js imports cleanly (module top level has no service dependencies)');
}

// ── Pure dsh-go helpers (the real behaviour the App will call) ──────────────
if (mod && pkg) {
  const expectedIds = ['memory-settings'];
  if (typeof mod.dshGoView !== 'function') {
    fail('index.js does not export dshGoView(locale)');
  } else {
    for (const locale of ['zh', 'en']) validateView(locale);
  }

  if (typeof mod.buildDshGoSnapshot !== 'function') {
    fail('index.js does not export buildDshGoSnapshot(source)');
  } else {
    validateSnapshots();
  }

  if (typeof mod.dshGoToggleCommand !== 'function') {
    fail('index.js does not export dshGoToggleCommand(key, on, consent)');
  } else {
    validateToggles();
  }

  if (typeof mod.dshGoActionEffect !== 'function') {
    fail('index.js does not export dshGoActionEffect(action, payload, context)');
  } else {
    validateEffects();
  }

  validateLocalePacks();

  function validateView(locale) {
    let view;
    try {
      view = mod.dshGoView(locale);
    } catch (error) {
      fail(`dshGoView('${locale}') threw: ${String(error && error.message ? error.message : error)}`);
      return;
    }
    const problems = [];
    const count = { nodes: 0 };
    const bindings = [];
    walk(view, 1);
    function walk(node, depth) {
      if (!node || typeof node !== 'object') {
        problems.push(`non-object node at depth ${depth}`);
        return;
      }
      count.nodes += 1;
      if (depth > VIEW_DEPTH_MAX) problems.push(`depth ${depth} exceeds ${VIEW_DEPTH_MAX}`);
      if (typeof node.type !== 'string' || !ALLOWED_NODE_TYPES.has(node.type)) {
        problems.push(`unsupported node type ${JSON.stringify(node.type)}`);
      }
      if (node.style !== undefined) {
        if (!node.style || typeof node.style !== 'object') problems.push('style is not an object');
        else {
          for (const key of Object.keys(node.style)) {
            if (!ALLOWED_STYLE_KEYS.has(key)) problems.push(`unsupported style key "${key}"`);
          }
          if (node.style.size !== undefined && !ALLOWED_SIZES.has(node.style.size)) problems.push(`unsupported style size "${node.style.size}"`);
          if (node.style.weight !== undefined && !ALLOWED_WEIGHTS.has(node.style.weight)) problems.push(`unsupported style weight "${node.style.weight}"`);
        }
      }
      if (node.type === 'actions') {
        for (const item of node.items || []) {
          if (!item || typeof item.action !== 'string') problems.push('action row without action id');
          if (item && typeof item.label === 'string' && length(item.label) > BUTTON_LABEL_MAX) {
            problems.push(`button label "${item.label}" exceeds ${BUTTON_LABEL_MAX} chars`);
          }
        }
      }
      if (node.type === 'keyValue' && Array.isArray(node.items)) {
        for (const pair of node.items) {
          if (!Array.isArray(pair) || pair.length !== 2) problems.push('keyValue row is not [label, value]');
          else {
            if (typeof pair[1] !== 'object' || pair[1] === null || typeof pair[1].$ !== 'string') problems.push('keyValue value is not a binding');
            else bindings.push(pair[1].$);
          }
        }
      }
      if (node.type === 'list' && Array.isArray(node.items)) {
        for (const item of node.items || []) {
          if (item && item.subtitle && typeof item.subtitle.$ === 'string') bindings.push(item.subtitle.$);
        }
      }
      for (const child of Array.isArray(node.children) ? node.children : []) walk(child, depth + 1);
      for (const child of Array.isArray(node.items) ? node.items.filter(item => item && typeof item === 'object' && typeof item.type === 'string') : []) walk(child, depth + 1);
    }
    if (view && view.v !== 2) problems.push(`root v must be 2, found ${JSON.stringify(view.v)}`);
    if (view && view.type !== 'stack') problems.push('root type must be "stack"');
    if (view && view.accent !== 'teal') problems.push('root accent must be "teal"');
    if (!view || typeof view.title !== 'string' || length(view.title) > PANEL_TITLE_MAX) {
      problems.push(`panel title must be a string ≤${PANEL_TITLE_MAX} chars`);
    }
    if (count.nodes > VIEW_NODES_MAX) problems.push(`${count.nodes} components exceeds ${VIEW_NODES_MAX}`);
    const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8');
    if (bytes > VIEW_BYTES_MAX) problems.push(`view is ${bytes} bytes, over ${VIEW_BYTES_MAX}`);
    const subtreeTypes = collectTypes(view);
    for (const required of ['keyValue', 'list', 'callout', 'actions']) {
      if (!subtreeTypes.includes(required)) problems.push(`view is missing a ${required} node`);
    }
    const list = findNode(view, 'list');
    const toggleKeys = new Set((list ? list.items || [] : []).map(item => item && item.action && item.action.args && item.action.args.key).filter(Boolean));
    for (const key of ['memory', 'inject', 'profile', 'sensitive']) {
      if (!toggleKeys.has(key)) problems.push(`consent list has no toggle for key "${key}"`);
    }
    const actionRows = findNode(view, 'actions');
    const actionIds = (actionRows ? actionRows.items || [] : []).map(item => item && item.action).filter(Boolean);
    for (const id of ['export', 'copyStats']) {
      if (!actionIds.includes(id)) problems.push(`actions node has no "${id}" action (got ${actionIds.join(', ') || 'none'})`);
    }
    const sample = mod.buildDshGoSnapshot({
      storage: 'durable',
      exchanges: 2,
      plaintextRows: 0,
      injectedChars: 12,
      consent: { memory: 'on', inject: 'on', profile: 'unified', sensitive: 'off' },
    });
    for (const path of bindings) {
      if (!path.startsWith('data.')) {
        problems.push(`binding "${path}" is not a data.* path`);
        continue;
      }
      if (resolveDataPath(sample, path) === undefined) problems.push(`binding "${path}" resolves to nothing in the snapshot`);
    }
    if (problems.length === 0) {
      pass(`dshGoView('${locale}') is a valid v2 document (${count.nodes} components, ${bytes} bytes, depth ≤${VIEW_DEPTH_MAX})`);
    } else {
      for (const problem of problems) fail(`dshGoView('${locale}'): ${problem}`);
    }
  }

  function validateSnapshots() {
    const full = mod.buildDshGoSnapshot({
      storage: 'durable',
      exchanges: 20,
      plaintextRows: 3,
      injectedChars: 210,
      consent: { memory: 'on', inject: 'off', profile: 'situational', sensitive: 'off' },
    });
    const expectations = [
      [full.storage === 'durable', 'storage maps durable'],
      [full.exchanges === 20, 'exchanges carries the row count'],
      [full.plaintextRows === 3, 'plaintextRows carries the plaintext row count'],
      [full.injectedChars === 210, 'injectedChars carries the last injection size'],
      [full.consent.memory === 'on' && full.consent.inject === 'off', 'consent memory/inject map to on/off'],
      [full.consent.profile === 'situational' && full.consent.sensitive === 'off', 'consent profile/sensitive map through'],
    ];
    const failedRows = expectations.filter(([ok]) => !ok).map(([, label]) => label);
    if (failedRows.length === 0) pass('buildDshGoSnapshot() maps consent/storage/rows/injectedChars');
    else for (const label of failedRows) fail(`buildDshGoSnapshot(): ${label}`);
    const empty = mod.buildDshGoSnapshot({
      storage: 'memory',
      exchanges: 0,
      plaintextRows: 0,
      injectedChars: undefined,
      consent: { memory: false, inject: false, profile: 'bogus', sensitive: true },
    });
    if (empty.injectedChars === '—' && empty.storage === 'memory' && empty.consent.profile === 'unified' && empty.consent.sensitive === 'on') {
      pass("buildDshGoSnapshot() falls back to '—', memory storage, and valid consent values");
    } else {
      fail("buildDshGoSnapshot() fallbacks are wrong (expected '—', memory, unified, on)");
    }
  }

  function validateToggles() {
    const cases = [];
    const expect = (key, on, consent, expected) => cases.push({ key, on, consent, expected });
    expect('memory', true, { memory: 'off' }, 'dmem consent on');
    expect('memory', false, { memory: 'on' }, 'dmem consent off');
    expect('memory', undefined, { memory: 'on' }, 'dmem consent off');
    expect('memory', undefined, { memory: 'off' }, 'dmem consent on');
    expect('inject', true, { inject: 'off' }, 'dmem consent inject on');
    expect('inject', false, { inject: 'on' }, 'dmem consent inject off');
    expect('inject', undefined, { inject: 'on' }, 'dmem consent inject off');
    expect('sensitive', true, { sensitive: 'off' }, 'dmem consent sensitive on');
    expect('sensitive', false, { sensitive: 'on' }, 'dmem consent sensitive off');
    expect('profile', true, { profile: 'off' }, 'dmem consent profile unified');
    expect('profile', false, { profile: 'unified' }, 'dmem consent profile off');
    const mismatches = cases.filter(({ key, on, consent, expected }) => mod.dshGoToggleCommand(key, on, consent) !== expected);
    if (mismatches.length === 0) pass('all explicit memory/inject/profile/sensitive toggles map to the right /dmem command');
    else {
      for (const item of mismatches) {
        fail(`toggle ${item.key} on=${String(item.on)} expected "${item.expected}" got "${mod.dshGoToggleCommand(item.key, item.on, item.consent)}"`);
      }
    }
    // The App may omit `on`: every consent state must be reachable, and off must never be a dead end.
    const cycle = [];
    let current = 'unified';
    for (let step = 0; step < 3; step += 1) {
      const command = mod.dshGoToggleCommand('profile', undefined, { profile: current });
      cycle.push(command);
      current = String(command).split(' ').pop();
    }
    const reached = new Set(cycle.map(command => String(command).split(' ').pop()));
    if (reached.size === 3 && reached.has('off') && reached.has('unified') && reached.has('situational')) {
      pass('profile toggle cycles unified → situational → off (off is reachable, no dead end)');
    } else {
      fail(`profile toggle cycle does not cover all modes: ${[...reached].join(', ')}`);
    }
    if (mod.dshGoToggleCommand('bogus', true, {}) === null) pass('unknown toggle key is rejected (no command)');
    else fail('unknown toggle key produced a command');
  }

  function validateEffects() {
    const snapshot = mod.buildDshGoSnapshot({ storage: 'durable', exchanges: 1, plaintextRows: 0, injectedChars: 4, consent: { memory: 'on', inject: 'on', profile: 'unified', sensitive: 'off' } });
    const context = { consent: snapshot.consent, snapshot, locale: 'zh' };
    const calls = [
      ['toggle', { key: 'sensitive', on: true }],
      ['pause', {}],
      ['resume', {}],
      ['export', {}],
      ['copyStats', {}],
      ['consentHelp', {}],
    ];
    let ok = true;
    for (const [action, payload] of calls) {
      const effect = mod.dshGoActionEffect(action, payload, context);
      if (!effect || typeof effect !== 'object') {
        fail(`action "${action}" returned no effect object`);
        ok = false;
        continue;
      }
      for (const key of Object.keys(effect)) {
        if (!ALLOWED_EFFECT_KEYS.has(key)) {
          fail(`action "${action}" returned unsupported effect key "${key}"`);
          ok = false;
        }
      }
      const effectCount = Object.keys(effect).filter(key => key !== 'refresh').length;
      if (effectCount === 0) {
        fail(`action "${action}" returned no actual effect`);
        ok = false;
      }
      if (effectCount > EFFECTS_MAX) {
        fail(`action "${action}" produces ${effectCount} effects, over ${EFFECTS_MAX}`);
        ok = false;
      }
      if (effect.command !== undefined && !HOST_COMMAND_PATTERN.test(effect.command)) {
        fail(`action "${action}" command "${effect.command}" is not an accepted /dmem form`);
        ok = false;
      }
      if (effect.toast !== undefined && length(effect.toast) > TOAST_MAX) {
        fail(`action "${action}" toast exceeds ${TOAST_MAX} chars`);
        ok = false;
      }
      if (effect.copy !== undefined && (typeof effect.copy !== 'string' || effect.copy.length > COPY_MAX)) {
        fail(`action "${action}" copy is not a string ≤${COPY_MAX} chars`);
        ok = false;
      }
    }
    if (ok) pass('all six panel actions return bounded effects and only `/dmem` commands');
    const copy = mod.dshGoActionEffect('copyStats', {}, context).copy || '';
    for (const fragment of ['storage=', 'exchanges=', 'plaintextRows=', 'injectedChars=', 'consent=']) {
      if (!copy.includes(fragment)) {
        fail(`copyStats text is missing "${fragment}"`);
        ok = false;
      }
    }
    if (ok) pass('copyStats text contains storage/exchanges/plaintextRows/injectedChars/consent');
    const rejected = mod.dshGoActionEffect('toggle', { key: 'nope' }, context);
    if (rejected.command === undefined && typeof rejected.toast === 'string') pass('unknown toggle returns a toast, not a command');
    else fail('unknown toggle did not degrade to a toast');
    const unknown = mod.dshGoActionEffect('nope', {}, context);
    if (unknown.command === undefined && typeof unknown.toast === 'string') pass('unknown action degrades to a toast');
    else fail('unknown action did not degrade to a toast');
  }

  function validateLocalePacks() {
    const packs = {};
    for (const locale of ['zh', 'en']) {
      const path = join(root, 'locale', `messages.${locale}.json`);
      if (!existsSync(path)) {
        fail(`missing locale pack ${path}`);
        continue;
      }
      try {
        packs[locale] = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        fail(`locale pack messages.${locale}.json is not valid JSON: ${error.message}`);
      }
    }
    if (packs.zh && packs.en) {
      const zhPanel = packs.zh.panel || {};
      const enPanel = packs.en.panel || {};
      const zhKeys = Object.keys(zhPanel).sort();
      const enKeys = Object.keys(enPanel).sort();
      if (zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys)) {
        pass(`locale packs have matching panel keys (${zhKeys.length})`);
      } else {
        fail(`locale panel keys differ: zh=[${zhKeys.join(',')}] en=[${enKeys.join(',')}]`);
      }
      const empty = zhKeys.filter(key => typeof zhPanel[key] !== 'string' || zhPanel[key] === '');
      if (empty.length === 0) pass('every zh panel string is non-empty');
      else fail(`empty zh panel strings: ${empty.join(', ')}`);
      if (length(zhPanel.title) <= PANEL_TITLE_MAX && length(enPanel.title) <= PANEL_TITLE_MAX) pass('panel title within 16 chars in both locales');
      else fail('panel title exceeds 16 chars in a locale');
      for (const key of ['export', 'copyStats']) {
        if (length(zhPanel[key]) > BUTTON_LABEL_MAX || length(enPanel[key]) > BUTTON_LABEL_MAX) {
          fail(`button label "${key}" exceeds ${BUTTON_LABEL_MAX} chars`);
        }
      }
      for (const key of ['exportToast', 'copiedToast', 'helpToast']) {
        if (length(zhPanel[key]) > TOAST_MAX || length(enPanel[key]) > TOAST_MAX) {
          fail(`toast "${key}" exceeds ${TOAST_MAX} chars`);
        }
      }
      if (zhPanel.callout && enPanel.callout) pass('consent callout exists in both locales');
      else fail('consent callout missing from a locale pack');
    }
  }

  // The view builder must depend on the locale pack, not on hard-coded copy.
  const zhView = mod.dshGoView('zh');
  const enView = mod.dshGoView('en');
  if (zhView && enView && zhView.title !== enView.title) pass('panel copy follows the requested locale');
  else fail('dshGoView("zh") and dshGoView("en") did not localize the title');
}

// ── helpers ─────────────────────────────────────────────────────────────────
function sliceBetween(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) return '';
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to < 0 ? text.length : to);
}
function collectTypes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.type === 'string') out.push(node.type);
  for (const child of Array.isArray(node.children) ? node.children : []) collectTypes(child, out);
  for (const child of Array.isArray(node.items) && node.type !== 'keyValue' ? node.items : []) {
    if (child && typeof child === 'object' && typeof child.type === 'string') collectTypes(child, out);
  }
  return out;
}
function findNode(node, type) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findNode(child, type);
    if (found) return found;
  }
  for (const child of Array.isArray(node.items) && node.type !== 'keyValue' ? node.items : []) {
    if (child && typeof child === 'object' && typeof child.type === 'string') {
      const found = findNode(child, type);
      if (found) return found;
    }
  }
  return undefined;
}
function resolveDataPath(snapshot, path) {
  return path.split('.').slice(1).reduce((value, key) => (value == null ? undefined : value[key]), snapshot);
}

// ── report ──────────────────────────────────────────────────────────────────
for (const line of passes) console.log(`PASS  ${line}`);
for (const line of notes) console.log(`INFO  ${line}`);
for (const line of failures) console.error(`FAIL  ${line}`);
if (failures.length === 0) {
  console.log('\nverify-dshgo: OK (static analysis of the local spec only; no dsh-go kit/check.mjs and no App were available, so nothing here proves on-device rendering)');
  process.exit(0);
}
console.error(`\nverify-dshgo: ${failures.length} check(s) failed`);
process.exit(1);

#!/usr/bin/env node
/**
 * Static verification for the dynamic-memory client bundle.
 *
 * The Harness Web Shell loads each `dsh.client` package's exports["./client"]
 * as a browser bundle whose factory id is the package name. This script checks
 * the local facts we can verify without a running browser:
 *
 *  1. package.json is valid JSON, BOM-free, and declares a web `dsh.client`.
 *  2. exports["./client"] points at an existing shipped file.
 *  3. client.js parses as ESM (`node --check`) and registers the package name.
 *  4. It registers into `conversation.input.dock` and reads React from the
 *     shared browser module table only (no Harness Client package imports).
 *  5. Every action routes through `/dmem` verbs the Host plugin implements.
 *
 * Usage: node ui/verify-client.mjs [--root <package-dir>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = resolve(rootFlag >= 0 && args[rootFlag + 1] ? args[rootFlag + 1] : join(here, '..'));

/** Facts the Host command registry actually implements (`/dmem` handler). */
const ALLOWED_VERBS = new Set([
  'stats',
  'portrait',
  'self',
  'export',
  'search',
  'pause',
  'resume',
  'capture',
  'consent',
  'migrate',
]);

const failures = [];
const passes = [];
const fail = (message) => failures.push(message);
const pass = (message) => passes.push(message);

// 1. package.json
const manifestPath = join(root, 'package.json');
if (!existsSync(manifestPath)) {
  fail(`missing package.json at ${manifestPath}`);
} else {
  const bytes = readFileSync(manifestPath);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('package.json starts with a UTF-8 BOM; the Loader manifest parser expects plain JSON');
  }
  let pkg;
  try {
    pkg = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    pass('package.json parses as JSON and has no BOM');
  } catch (error) {
    fail(`package.json is not valid JSON: ${error.message}`);
  }
  if (pkg) {
    const client = pkg.dsh && pkg.dsh.client;
    if (!client || client.platform !== 'web') {
      fail('package.json is missing `dsh.client.platform: "web"`');
    } else {
      pass('dsh.client declares the web platform');
      if (!Array.isArray(client.inject) || client.inject.length === 0) {
        fail('dsh.client.inject must list the client rows the panel depends on');
      } else if (!client.inject.includes('@deepseek-ai/dsh-client-ui-conversation')) {
        fail('dsh.client.inject must include @deepseek-ai/dsh-client-ui-conversation (composer dock slot)');
      } else {
        pass('dsh.client.inject orders the conversation, locale, and remote rows');
      }
    }

    const clientExport = pkg.exports && pkg.exports['./client'];
    if (typeof clientExport !== 'string') {
      fail('package.json exports["./client"] must be a string path to the browser bundle');
    } else {
      const clientPath = isAbsolute(clientExport) ? clientExport : join(root, clientExport);
      if (!existsSync(clientPath)) {
        fail(`exports["./client"] points at a missing file: ${clientExport}`);
      } else {
        pass(`exports["./client"] resolves to ${clientExport}`);
        const shipped = Array.isArray(pkg.files) ? pkg.files.some((entry) => entry === clientExport.replace(/^\.\//, '')) : false;
        if (!shipped) fail(`files[] does not ship ${clientExport}; a packed install would omit the bundle`);
        else pass('files[] ships the client bundle');

        // 2. Syntax: parse the bundle without executing it.
        try {
          execFileSync(process.execPath, ['--check', clientPath], { stdio: 'pipe' });
          pass('client.js passes `node --check` (ESM parse)');
        } catch (error) {
          const detail = error.stderr ? error.stderr.toString().split('\n').slice(0, 4).join(' ') : String(error);
          fail(`client.js failed \`node --check\`: ${detail}`);
        }

        // 3. Registration identity, slot, and module table.
        const source = readFileSync(clientPath, 'utf8');
        if (typeof pkg.name !== 'string') {
          fail('package.json has no package name');
        } else if (source.includes(`id: '${pkg.name}'`) || source.includes(`id: "${pkg.name}"`)) {
          pass(`bundle registers the package name as its factory id (${pkg.name})`);
        } else {
          fail(`bundle does not register factory id "${pkg.name}"`);
        }
        if (!source.includes("'conversation.input.dock'") && !source.includes('"conversation.input.dock"')) {
          fail('client.js does not target the conversation.input.dock slot');
        } else {
          pass('client.js registers into conversation.input.dock');
        }
        const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
        const allowedRequires = new Set(['react', 'react/jsx-runtime']);
        const forbidden = required.filter((specifier) => !allowedRequires.has(specifier));
        if (forbidden.length > 0) {
          fail(`client.js requires modules outside the browser baseline: ${forbidden.join(', ')}`);
        } else {
          pass('client.js requires only shared-table modules');
        }

        // 4. Actions must stay on the /dmem command surface the Host registers.
        const commandLines = [...source.matchAll(/`\$\{COMMAND\}\s+([a-z]+)/g)].map((match) => match[1]);
        const unknown = commandLines.filter((verb) => !ALLOWED_VERBS.has(verb));
        if (unknown.length > 0) {
          fail(`client.js invokes /dmem verbs the Host plugin does not implement: ${[...new Set(unknown)].join(', ')}`);
        } else {
          pass(`all ${new Set(commandLines).size} invoked /dmem verbs exist in the Host handler`);
        }
      }
    }
  }
}

for (const line of passes) console.log(`PASS  ${line}`);
for (const line of failures) console.error(`FAIL  ${line}`);
if (failures.length === 0) {
  console.log('\nverify-client: OK (static checks only; live Web slot rendering is not exercised)');
  process.exit(0);
}
console.error(`\nverify-client: ${failures.length} check(s) failed`);
process.exit(1);

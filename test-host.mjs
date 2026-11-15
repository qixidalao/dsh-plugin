#!/usr/bin/env node
// In-memory mock host fixture: exercises the plugin lifecycle without a real Harness.
// Covers: durable open, prompt/tool registration, session capture, dispose ordering
// (in-flight writes are awaited before the domain closes), restart recovery.
import assert from 'node:assert/strict';
import { apply } from './index.js';

const message = text => ({ content: [{ type: 'text', text }] });

function makeStorage() {
  const tables = new Map();
  const order = [];
  const domain = {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const map = tables.get(name);
      return {
        async put(key, value) {
          order.push(`put:${name}:${key}`);
          map.set(key, value);
        },
        async delete(key) {
          order.push(`delete:${name}:${key}`);
          map.delete(key);
        },
        entries() {
          return [...map.entries()];
        },
      };
    },
    async close() {
      order.push('close');
    },
  };
  return { domain, order, tables };
}

function makeHost(storage) {
  const handlers = new Map();
  const effects = [];
  const tools = [];
  const prompts = [];
  const commands = [];
  const agent = {
    id: 'session-fixture',
    ctx: {
      effect(setup) {
        effects.push(setup());
        return () => {};
      },
      tools: {
        register(tool) {
          tools.push(tool);
          return () => {};
        },
      },
    },
  };
  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'systemPrompt') return { context: options => { prompts.push(options); return () => {}; } };
      if (name === 'storageDomain') return { open: async () => storage.domain };
      if (name === 'agents') return { list: () => [agent] };
      if (name === 'commands') return { register: options => { commands.push(options); return () => {}; } };
      return undefined;
    },
    inject(_names, callback) {
      return callback(ctx);
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect(setup) {
      effects.push(setup());
      return () => {};
    },
    agent,
  };
  const emit = (sessionId, event) => handlers.get('session/event')?.({ id: sessionId }, event);
  const dispose = async () => {
    for (const cleanup of effects.reverse()) {
      if (typeof cleanup === 'function') await cleanup();
    }
  };
  return { ctx, agent, tools, prompts, commands, emit, dispose };
}

const storage = makeStorage();
const host = makeHost(storage);
apply(host.ctx, { autoIndexSessions: false, warmup: false, capture: true });
await new Promise(resolve => setTimeout(resolve, 5));

assert.equal(host.tools.length, 1, 'tool registered');
assert.equal(host.prompts.length, 1, 'system prompt registered');
assert.equal(host.commands.length, 1, 'command registered');

const before = storage.order.length;
host.emit('session-fixture', { type: 'user/message', data: message('fixture 用户问题：部署 example.com') });
host.emit('session-fixture', { type: 'assistant/message', data: { message: message('fixture 助手回答：部署完成') } });
host.emit('session-fixture', { type: 'turn/end', data: {} });

// Dispose immediately: the in-flight write must be awaited before close.
await host.dispose();
assert.ok(storage.order.includes('close'), 'domain closed');
const putIndex = storage.order.findIndex(entry => entry.startsWith('put:exchanges:'));
const closeIndex = storage.order.indexOf('close');
assert.ok(putIndex >= 0, 'exchange persisted');
assert.ok(putIndex < closeIndex, 'write completes before close');
assert.ok(storage.order.length > before, 'writes happened after capture');

// Restart with the same storage: rows load back from disk.
const host2 = makeHost(storage);
apply(host2.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const stats = await host2.tools[0].execute({ action: 'stats' });
assert.equal(stats.exchanges, 1, 'restart recovers persisted exchange');
assert.equal(stats.storage, 'durable', 'durable storage state');
assert.equal(stats.withoutSummary, 0, 'auto summary fills summaries');
const storedRow = [...storage.tables.get('exchanges').values()][0];
assert.equal(storedRow.user, '', 'no plaintext user text stored');
assert.equal(storedRow.assistant, '', 'no plaintext assistant text stored');
assert.ok(storedRow.summary.length > 0, 'summary retained');
assert.ok(typeof storedRow.textHash === 'string' && storedRow.pointer, 'hash + pointer retained');
const found = await host2.tools[0].execute({ action: 'search', query: '部署 example.com' });
assert.ok(found.matches.length >= 1, 'summary-only row is searchable');

// capture=false: events are ignored.
const host3 = makeHost(makeStorage());
apply(host3.ctx, { autoIndexSessions: false, warmup: false, capture: false });
await new Promise(resolve => setTimeout(resolve, 5));
host3.emit('session-fixture', { type: 'user/message', data: message('这条不该被捕获') });
host3.emit('session-fixture', { type: 'assistant/message', data: { message: message('也不该') } });
host3.emit('session-fixture', { type: 'turn/end', data: {} });
await new Promise(resolve => setTimeout(resolve, 10));
const stats3 = await host3.tools[0].execute({ action: 'stats' });
assert.equal(stats3.exchanges, 0, 'capture=false ignores events');
assert.equal(stats3.capture, 'paused', 'stats reports paused capture');

// Deleting an exchange clears facet/observation references and marks the facet for recompute.
const recent = await host2.tools[0].execute({ action: 'recent', limit: 1 });
const exchangeId = recent.exchanges[0].id;
// Each portrait version binds its own sources: the old version keeps its set in history.
await host2.tools[0].execute({ action: 'learn', facet: 'dynamics', content: 'fixture 动态', sourceIds: [exchangeId] });
await host2.tools[0].execute({ action: 'learn', facet: 'dynamics', content: 'fixture 动态 v2' });
const versionedFacet = [...storage.tables.get('portrait').values()].find(row => row.facet === 'dynamics');
assert.ok(versionedFacet.history[0].sourceExchangeIds.includes(exchangeId), 'old version keeps its own sources');
assert.equal(versionedFacet.sourceExchangeIds.length, 0, 'new version does not inherit old sources');
await host2.tools[0].execute({ action: 'learn', facet: 'thinking', content: 'fixture 结论', sourceIds: [exchangeId] });
const observed = await host2.tools[0].execute({ action: 'observe', type: 'explicit_fact', content: 'fixture 观察', sourceIds: [exchangeId] });
await host2.tools[0].execute({ action: 'forget', id: exchangeId });
const afterForget = await host2.tools[0].execute({ action: 'stats' });
assert.equal(afterForget.facetsNeedingRecompute, 1, 'facet marked for recompute after cascade delete');
const storedObservation = [...storage.tables.get('observations').values()].find(row => row.id === observed.id);
assert.ok(storedObservation && !storedObservation.sourceIds.includes(exchangeId), 'observation reference cleared');
const storedFacet = [...storage.tables.get('portrait').values()].find(row => row.facet === 'thinking');
assert.ok(storedFacet && storedFacet.needsRecompute === true, 'facet flag persisted');
await host2.dispose();

console.log('host fixture: 16 checks passed');

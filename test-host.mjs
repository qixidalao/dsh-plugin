#!/usr/bin/env node
// In-memory mock host fixture: exercises the plugin lifecycle without a real Harness.
// Covers: durable open, prompt/tool registration, session capture, dispose ordering
// (in-flight writes are awaited before the domain closes), restart recovery, and
// index-only hydration from fake local sessions (metadata cleaning + explicit failures).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { apply, extractiveSummary } from './index.js';

const message = text => ({ content: [{ type: 'text', text }] });
const hashText = text => createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 24);

let checks = 0;
const ok = (value, label) => { checks += 1; assert.ok(value, label); };
const equal = (actual, expected, label) => { checks += 1; assert.equal(actual, expected, label); };
const matches = (value, pattern, label) => { checks += 1; assert.match(String(value), pattern, label); };

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

function makeHost(storage, services = {}) {
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
      if (name === 'sessionQuery') return services.sessionQuery;
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

// Minimal stand-in for the host's sessionQuery service: readSession returns a snapshot.
function makeSessionQuery(sessions) {
  const reads = [];
  return {
    reads,
    async readSession(sessionId) {
      reads.push(String(sessionId));
      const snapshot = sessions[String(sessionId)];
      if (!snapshot) throw new Error(`unknown session ${sessionId}`);
      return snapshot;
    },
  };
}

// A persisted index-only row (v2.1 storage: summary/hash/pointer, no plaintext).
function indexOnlyRow({ id, sessionId, time, user, assistant }) {
  return {
    id,
    sessionId,
    workspace: null,
    kind: 'episodic',
    time,
    updatedAt: time,
    user: '',
    assistant: '',
    textHash: hashText(`${user}\n${assistant}`),
    pointer: { sessionId, time },
    summary: extractiveSummary(user, assistant),
    keywords: [],
    entities: [],
    importance: 0.35,
    accessCount: 0,
    lastAccessAt: null,
    supersededBy: null,
    history: [],
    sourceIds: [],
  };
}

const seedRow = (storage, row) => storage.domain.table('exchanges').put(`r_${row.id}`, row);

const storage = makeStorage();
const host = makeHost(storage);
apply(host.ctx, { autoIndexSessions: false, warmup: false, capture: true });
await new Promise(resolve => setTimeout(resolve, 5));

equal(host.tools.length, 1, 'tool registered');
equal(host.prompts.length, 1, 'system prompt registered');
equal(host.commands.length, 1, 'command registered');

const before = storage.order.length;
host.emit('session-fixture', { type: 'user/message', data: message('fixture 用户问题：部署 example.com') });
host.emit('session-fixture', { type: 'assistant/message', data: { message: message('fixture 助手回答：部署完成') } });
host.emit('session-fixture', { type: 'turn/end', data: {} });

// Dispose immediately: the in-flight write must be awaited before close.
await host.dispose();
ok(storage.order.includes('close'), 'domain closed');
const putIndex = storage.order.findIndex(entry => entry.startsWith('put:exchanges:'));
const closeIndex = storage.order.indexOf('close');
ok(putIndex >= 0, 'exchange persisted');
ok(putIndex < closeIndex, 'write completes before close');
ok(storage.order.length > before, 'writes happened after capture');

// Restart with the same storage: rows load back from disk.
const host2 = makeHost(storage);
apply(host2.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const stats = await host2.tools[0].execute({ action: 'stats' });
equal(stats.exchanges, 1, 'restart recovers persisted exchange');
equal(stats.storage, 'durable', 'durable storage state');
equal(stats.withoutSummary, 0, 'auto summary fills summaries');
const storedRow = [...storage.tables.get('exchanges').values()][0];
equal(storedRow.user, '', 'no plaintext user text stored');
equal(storedRow.assistant, '', 'no plaintext assistant text stored');
ok(storedRow.summary.length > 0, 'summary retained');
ok(typeof storedRow.textHash === 'string' && storedRow.pointer, 'hash + pointer retained');
const found = await host2.tools[0].execute({ action: 'search', query: '部署 example.com' });
ok(found.matches.length >= 1, 'summary-only row is searchable');

// capture=false: events are ignored.
const host3 = makeHost(makeStorage());
apply(host3.ctx, { autoIndexSessions: false, warmup: false, capture: false });
await new Promise(resolve => setTimeout(resolve, 5));
host3.emit('session-fixture', { type: 'user/message', data: message('这条不该被捕获') });
host3.emit('session-fixture', { type: 'assistant/message', data: { message: message('也不该') } });
host3.emit('session-fixture', { type: 'turn/end', data: {} });
await new Promise(resolve => setTimeout(resolve, 10));
const stats3 = await host3.tools[0].execute({ action: 'stats' });
equal(stats3.exchanges, 0, 'capture=false ignores events');
equal(stats3.capture, 'paused', 'stats reports paused capture');

// Deleting an exchange clears facet/observation references and marks the facet for recompute.
const recent = await host2.tools[0].execute({ action: 'recent', limit: 1 });
const exchangeId = recent.exchanges[0].id;
// Each portrait version binds its own sources: the old version keeps its set in history.
await host2.tools[0].execute({ action: 'learn', facet: 'dynamics', content: 'fixture 动态', sourceIds: [exchangeId] });
await host2.tools[0].execute({ action: 'learn', facet: 'dynamics', content: 'fixture 动态 v2' });
const versionedFacet = [...storage.tables.get('portrait').values()].find(row => row.facet === 'dynamics');
ok(versionedFacet.history[0].sourceExchangeIds.includes(exchangeId), 'old version keeps its own sources');
equal(versionedFacet.sourceExchangeIds.length, 0, 'new version does not inherit old sources');
await host2.tools[0].execute({ action: 'learn', facet: 'thinking', content: 'fixture 结论', sourceIds: [exchangeId] });
const observed = await host2.tools[0].execute({ action: 'observe', type: 'explicit_fact', content: 'fixture 观察', sourceIds: [exchangeId] });
await host2.tools[0].execute({ action: 'forget', id: exchangeId });
const afterForget = await host2.tools[0].execute({ action: 'stats' });
equal(afterForget.facetsNeedingRecompute, 1, 'facet marked for recompute after cascade delete');
const storedObservation = [...storage.tables.get('observations').values()].find(row => row.id === observed.id);
ok(storedObservation && !storedObservation.sourceIds.includes(exchangeId), 'observation reference cleared');
const storedFacet = [...storage.tables.get('portrait').values()].find(row => row.facet === 'thinking');
ok(storedFacet && storedFacet.needsRecompute === true, 'facet flag persisted');
await host2.dispose();

// ---------------------------------------------------------------------------
// Hydration (a): a stripped row is hydrated from local session events. Capture
// stores the LAST assistant message of a turn, so hydration must pair the same
// way (a first-assistant-only hash would miss), and the raw session text still
// carries the harness "Current runtime context" block that must be cleaned.
// ---------------------------------------------------------------------------
const hydrateStorage = makeStorage();
const hydratedUser = '修部署 example.com 并验证';
const hydratedAssistant = '部署完成 example.com，已验证 200';
const rawUser = `${hydratedUser}\n\nCurrent runtime context. Time sampled while preparing turn 1, step 1: 2026-11-16T07:48:51+08:00[Asia/Shanghai]`;
const hydrateTime = Date.now() - 60000;
const hydrateSession = {
  session: { id: 'session-hydrate', cwd: null },
  events: [
    { type: 'user/message', time: hydrateTime, data: message(rawUser) },
    { type: 'turn/start', time: hydrateTime, data: {} },
    { type: 'assistant/message', time: hydrateTime + 1000, data: { message: message('先检查配置') } },
    { type: 'assistant/message', time: hydrateTime + 2000, data: { message: message(hydratedAssistant) } },
    { type: 'turn/end', time: hydrateTime + 3000, data: {} },
  ],
};
await seedRow(hydrateStorage, indexOnlyRow({
  id: 'ex-hydrate',
  sessionId: 'session-hydrate',
  time: hydrateTime + 3000,
  user: hydratedUser,
  assistant: hydratedAssistant,
}));
const hydrateSessions = makeSessionQuery({ 'session-hydrate': hydrateSession });
const hydrateHost = makeHost(hydrateStorage, { sessionQuery: hydrateSessions });
apply(hydrateHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const hydrated = await hydrateHost.tools[0].execute({ action: 'search', query: '部署 example.com' });
const hydratedMatch = hydrated.matches.find(match => match.id === 'ex-hydrate');
ok(hydratedMatch, 'index-only row is searchable');
equal(hydratedMatch && hydratedMatch.sourceAvailable, true, 'hydration succeeded');
equal(hydratedMatch && hydratedMatch.user, hydratedUser, 'hydrated user text is cleaned and complete');
ok(hydratedMatch && !hydratedMatch.user.includes('Current runtime context'), 'no harness runtime metadata in hydrated user text');
equal(hydratedMatch && hydratedMatch.assistant, hydratedAssistant, 'last assistant message of the turn is hydrated');
ok(hydrateSessions.reads.includes('session-hydrate'), 'hydration read the row session');

// ---------------------------------------------------------------------------
// Hydration (b): no hash/prefix/time candidate exists. The row must stay empty
// with sourceAvailable=false and a hydrationError; no text may be fabricated.
// ---------------------------------------------------------------------------
const missStorage = makeStorage();
const missUser = '部署 example.com 后检查日志';
const missAssistant = '日志正常，无错误';
const missTime = Date.now() - 600000;
const missSession = {
  session: { id: 'session-miss', cwd: null },
  events: [
    { type: 'user/message', time: missTime, data: message('完全无关的运行时问题，只提到 example.com') },
    { type: 'turn/start', time: missTime, data: {} },
    { type: 'assistant/message', time: missTime + 1000, data: { message: message('无关的回答') } },
    { type: 'turn/end', time: missTime + 2000, data: {} },
  ],
};
await seedRow(missStorage, indexOnlyRow({
  id: 'ex-miss',
  sessionId: 'session-miss',
  time: missTime + 300000,
  user: missUser,
  assistant: missAssistant,
}));
const missHost = makeHost(missStorage, { sessionQuery: makeSessionQuery({ 'session-miss': missSession }) });
apply(missHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const missed = await missHost.tools[0].execute({ action: 'search', query: '部署 example.com' });
const missMatch = missed.matches.find(match => match.id === 'ex-miss');
ok(missMatch, 'unresolvable row is still searchable');
equal(missMatch && missMatch.sourceAvailable, false, 'hydration failure is explicit');
equal(missMatch && missMatch.user, '', 'no fabricated user text');
equal(missMatch && missMatch.assistant, '', 'no fabricated assistant text');
matches(missMatch && missMatch.hydrationError, /no matching user message/, 'hydrationError names the failure');
ok(missMatch && !String(missMatch.user).includes('完全无关'), 'wrong session text is never returned');

// ---------------------------------------------------------------------------
// Hydration (c): two different prompts share the stored summary prefix and the
// time window, so the row is ambiguous. It must refuse instead of guessing.
// ---------------------------------------------------------------------------
const ambStorage = makeStorage();
const ambHead = '部署 example.com 后验证同一个共同前缀的歧义场景文本';
const ambUserA = `${ambHead} A 分支`;
const ambUserB = `${ambHead} B 分支`;
const ambTime = Date.now() - 90000;
const ambSession = {
  session: { id: 'session-amb', cwd: null },
  events: [
    { type: 'user/message', time: ambTime, data: message(ambUserA) },
    { type: 'turn/start', time: ambTime, data: {} },
    { type: 'assistant/message', time: ambTime + 500, data: { message: message('分支A的会话回答') } },
    { type: 'turn/end', time: ambTime + 1000, data: {} },
    { type: 'user/message', time: ambTime + 1500, data: message(ambUserB) },
    { type: 'turn/start', time: ambTime + 1500, data: {} },
    { type: 'assistant/message', time: ambTime + 2000, data: { message: message('分支B的会话回答') } },
    { type: 'turn/end', time: ambTime + 2000, data: {} },
  ],
};
await seedRow(ambStorage, indexOnlyRow({
  id: 'ex-amb',
  sessionId: 'session-amb',
  time: ambTime + 1000,
  user: ambUserA,
  assistant: '原始回答A',
}));
const ambHost = makeHost(ambStorage, { sessionQuery: makeSessionQuery({ 'session-amb': ambSession }) });
apply(ambHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const ambiguous = await ambHost.tools[0].execute({ action: 'search', query: '部署 example.com' });
const ambMatch = ambiguous.matches.find(match => match.id === 'ex-amb');
ok(ambMatch, 'ambiguous row is still searchable');
equal(ambMatch && ambMatch.sourceAvailable, false, 'ambiguous hydration is refused');
equal(ambMatch && ambMatch.user, '', 'ambiguous hydration returns no text');
matches(ambMatch && ambMatch.hydrationError, /ambiguous summary-prefix match/, 'ambiguity is reported');

console.log(`host fixture: ${checks} checks passed`);

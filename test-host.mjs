#!/usr/bin/env node
// In-memory mock host fixture: exercises the plugin lifecycle without a real Harness.
// Covers: durable open, prompt/tool registration, session capture, dispose ordering
// (in-flight writes are awaited before the domain closes), restart recovery, migrate
// schema/command discovery and execution, index-only hydration from fake local sessions
// (metadata cleaning, repeated-prompt disambiguation + explicit failures), the
// summary-based cross-session digest and its real injected-count stats, and repair
// that never writes plaintext back (with a live plaintext count).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// The migrate action exists in the handler but must also be reachable through the tool
// schema (additionalProperties=false would otherwise reject mode/confirm).
const actionSchema = host.tools[0].parameters.properties;
ok(actionSchema.action.enum.includes('migrate'), 'migrate is accepted by the action enum');
ok(actionSchema.mode && actionSchema.mode.enum.includes('strip'), 'migrate mode=strip is described');
ok(actionSchema.confirm && actionSchema.confirm.type === 'boolean', 'migrate confirm is described');
const commandHelp = await host.commands[0].handler({ agent: host.agent, rawInput: 'unknown-command' });
matches(commandHelp.text, /migrate/, '/dmem command list mentions migrate');

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

// ---------------------------------------------------------------------------
// Hydration (d): a terse prompt ("继续") whose summary was revised into an
// impression. The exact extractive prefix is gone, but the summary still quotes
// the request and the opening of the reply; hydration must accept the unique
// session pair and return its real assistant text (never the summary text).
// ---------------------------------------------------------------------------
const shortStorage = makeStorage();
const shortUser = '继续';
const shortAssistant = '当前 13 个已跟踪修改文件，先核对清单再提交';
const shortTime = Date.now() - 120000;
const shortSession = {
  session: { id: 'session-short', cwd: null },
  events: [
    { type: 'user/message', time: shortTime, data: message(shortUser) },
    { type: 'turn/start', time: shortTime, data: {} },
    { type: 'assistant/message', time: shortTime + 800, data: { message: message('先读取 git status') } },
    { type: 'assistant/message', time: shortTime + 1600, data: { message: message(shortAssistant) } },
    { type: 'turn/end', time: shortTime + 2000, data: {} },
  ],
};
const shortSeed = indexOnlyRow({
  id: 'ex-short',
  sessionId: 'session-short',
  time: shortTime + 2000,
  user: shortUser,
  assistant: shortAssistant,
});
// Impression-style summary: requests + reply opening are quoted, separators differ.
shortSeed.summary = '继续 当前 13 个已跟踪修改文件，先核对清单（另有 2 个待办）';
shortSeed.textHash = hashText('stale hash from an older capture');
await seedRow(shortStorage, shortSeed);
const shortHost = makeHost(shortStorage, { sessionQuery: makeSessionQuery({ 'session-short': shortSession }) });
apply(shortHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const shortFound = await shortHost.tools[0].execute({ action: 'search', query: '已跟踪修改文件' });
const shortMatch = shortFound.matches.find(match => match.id === 'ex-short');
ok(shortMatch, 'short-prompt row is searchable');
equal(shortMatch && shortMatch.sourceAvailable, true, 'short prompt hydrates from the summary excerpt');
equal(shortMatch && shortMatch.user, shortUser, 'short user text is exact');
equal(shortMatch && shortMatch.assistant, shortAssistant, 'assistant text comes from the session, not the summary');

// ---------------------------------------------------------------------------
// Hydration (e): two turns repeat the terse prompt "继续" and their replies share
// the same opening, so the revised summary cannot pick one. Hydration must refuse
// with no text instead of returning one of them.
// ---------------------------------------------------------------------------
const repeatStorage = makeStorage();
const repeatTime = Date.now() - 900000;
const repeatHead = '公共开头完全相同但后面不同的回答';
const repeatSession = {
  session: { id: 'session-repeat', cwd: null },
  events: [
    { type: 'user/message', time: repeatTime, data: message('继续') },
    { type: 'turn/start', time: repeatTime, data: {} },
    { type: 'assistant/message', time: repeatTime + 500, data: { message: message(`${repeatHead}甲`) } },
    { type: 'turn/end', time: repeatTime + 1000, data: {} },
    { type: 'user/message', time: repeatTime + 2000, data: message('继续') },
    { type: 'turn/start', time: repeatTime + 2000, data: {} },
    { type: 'assistant/message', time: repeatTime + 2500, data: { message: message(`${repeatHead}乙`) } },
    { type: 'turn/end', time: repeatTime + 3000, data: {} },
  ],
};
const repeatSeed = indexOnlyRow({
  id: 'ex-repeat',
  sessionId: 'session-repeat',
  time: repeatTime + 100000,
  user: '继续',
  assistant: `${repeatHead}甲`,
});
repeatSeed.summary = `用户说继续 ${repeatHead}`;
repeatSeed.textHash = hashText('stale hash for the repeated prompt');
await seedRow(repeatStorage, repeatSeed);
const repeatHost = makeHost(repeatStorage, { sessionQuery: makeSessionQuery({ 'session-repeat': repeatSession }) });
apply(repeatHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const repeated = await repeatHost.tools[0].execute({ action: 'search', query: '公共开头' });
const repeatMatch = repeated.matches.find(match => match.id === 'ex-repeat');
ok(repeatMatch, 'repeated-prompt row is still searchable');
equal(repeatMatch && repeatMatch.sourceAvailable, false, 'ambiguous short-prompt hydration is refused');
equal(repeatMatch && repeatMatch.user, '', 'ambiguous short prompt returns no user text');
equal(repeatMatch && repeatMatch.assistant, '', 'ambiguous short prompt returns no assistant text');
matches(repeatMatch && repeatMatch.hydrationError, /ambiguous summary-(tail|content) match/, 'short-prompt ambiguity is reported');

// ---------------------------------------------------------------------------
// Hydration (f): an older capture summarized the turn from its first assistant
// message, while hydration pairs the last one. The summary tail is an exact
// prefix of that earlier message, so the pair is recovered and the matched real
// message is returned.
// ---------------------------------------------------------------------------
const tailStorage = makeStorage();
const tailTime = Date.now() - 240000;
const tailFirst = '先读取当前配置并核对清单';
const tailLast = '当前 13 个已跟踪修改文件，已核对完成';
const tailSession = {
  session: { id: 'session-tail', cwd: null },
  events: [
    { type: 'user/message', time: tailTime, data: message('继续') },
    { type: 'turn/start', time: tailTime, data: {} },
    { type: 'assistant/message', time: tailTime + 700, data: { message: message(tailFirst) } },
    { type: 'assistant/message', time: tailTime + 1400, data: { message: message(tailLast) } },
    { type: 'turn/end', time: tailTime + 2000, data: {} },
  ],
};
const tailSeed = indexOnlyRow({
  id: 'ex-tail',
  sessionId: 'session-tail',
  time: tailTime + 2000,
  user: '继续',
  assistant: tailFirst,
});
tailSeed.textHash = hashText('stale hash from an older capture');
await seedRow(tailStorage, tailSeed);
const tailHost = makeHost(tailStorage, { sessionQuery: makeSessionQuery({ 'session-tail': tailSession }) });
apply(tailHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const tailFound = await tailHost.tools[0].execute({ action: 'search', query: '读取当前配置' });
const tailMatch = tailFound.matches.find(match => match.id === 'ex-tail');
ok(tailMatch, 'older-capture row is searchable');
equal(tailMatch && tailMatch.sourceAvailable, true, 'summary tail recovers an earlier assistant message');
equal(tailMatch && tailMatch.user, '继续', 'tail hydration keeps the short user text');
equal(tailMatch && tailMatch.assistant, tailFirst, 'tail hydration returns the verified message, not the last one');

// ---------------------------------------------------------------------------
// Hydration (g): two turns repeat the exact prompt "继续" with different replies
// and no usable hash/summary prefix. Only the row time can pick the turn, so the
// pair dedupe must be user+assistant (not user alone) and a time tie must fail
// explicitly instead of returning the wrong reply.
// ---------------------------------------------------------------------------
const repeatPairStorage = makeStorage();
const repeatPairTime = Date.now() - 1200000;
const repeatPairSession = {
  session: { id: 'session-repeat-pair', cwd: null },
  events: [
    { type: 'user/message', time: repeatPairTime, data: message('继续') },
    { type: 'turn/start', time: repeatPairTime, data: {} },
    { type: 'assistant/message', time: repeatPairTime + 800, data: { message: message('第一条完全不同的回答内容甲') } },
    { type: 'turn/end', time: repeatPairTime + 1000, data: {} },
    { type: 'user/message', time: repeatPairTime + 2000, data: message('继续') },
    { type: 'turn/start', time: repeatPairTime + 2000, data: {} },
    { type: 'assistant/message', time: repeatPairTime + 2800, data: { message: message('第二条完全不同的回答内容乙') } },
    { type: 'turn/end', time: repeatPairTime + 3000, data: {} },
  ],
};
const repeatPairSeed = (id, time) => {
  const row = indexOnlyRow({
    id,
    sessionId: 'session-repeat-pair',
    time,
    user: '继续',
    assistant: '第二条完全不同的回答内容乙',
  });
  row.summary = '印象：以前部署完成，这次完全不同的问题需要继续排查';
  row.textHash = hashText(`stale hash for ${id}`);
  return row;
};
await seedRow(repeatPairStorage, repeatPairSeed('ex-repeat-near', repeatPairTime + 3000));
await seedRow(repeatPairStorage, repeatPairSeed('ex-repeat-tie', repeatPairTime + 2000));
const repeatPairHost = makeHost(repeatPairStorage, { sessionQuery: makeSessionQuery({ 'session-repeat-pair': repeatPairSession }) });
apply(repeatPairHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const repeatPairFound = await repeatPairHost.tools[0].execute({ action: 'search', query: '完全不同 排查' });
const nearMatch = repeatPairFound.matches.find(match => match.id === 'ex-repeat-near');
const tieMatch = repeatPairFound.matches.find(match => match.id === 'ex-repeat-tie');
ok(nearMatch && tieMatch, 'repeated-prompt rows are searchable');
equal(nearMatch && nearMatch.sourceAvailable, true, 'time-unique repeated prompt hydrates');
equal(nearMatch && nearMatch.user, '继续', 'repeated prompt keeps the exact user text');
equal(nearMatch && nearMatch.assistant, '第二条完全不同的回答内容乙', 'time tiebreak returns the correct repeated turn');
equal(tieMatch && tieMatch.sourceAvailable, false, 'equidistant repeated prompt stays ambiguous');
equal(tieMatch && tieMatch.user, '', 'ambiguous repeated prompt returns no user text');
equal(tieMatch && tieMatch.assistant, '', 'ambiguous repeated prompt returns no assistant text');
matches(tieMatch && tieMatch.hydrationError, /ambiguous time-window match/, 'time tie is reported as ambiguous');

// ---------------------------------------------------------------------------
// Digest (index-only): no row carries plaintext user text anymore, so the
// injected cross-session digest must be built from summaries. A current-session
// prompt that overlaps a stored summary must render that summary, and stats must
// report the count renderContext actually injected (not a jaccard approximation).
// ---------------------------------------------------------------------------
const digestStorage = makeStorage();
const digestUser = '继续修复部署 example.com 的注入问题并给出验证结果';
const digestReply = '注入问题已修复，复验通过';
const digestSeed = indexOnlyRow({
  id: 'ex-digest',
  sessionId: 'session-other',
  time: Date.now() - 60000,
  user: digestUser,
  assistant: digestReply,
});
digestSeed.summary = '部署 example.com 的注入问题已修复并复验通过';
await seedRow(digestStorage, digestSeed);
const digestHost = makeHost(digestStorage);
apply(digestHost.ctx, { autoIndexSessions: false, warmup: false, capture: true });
await new Promise(resolve => setTimeout(resolve, 5));
digestHost.emit('session-fixture', { type: 'user/message', data: message(digestUser) });
const beforeInject = await digestHost.tools[0].execute({ action: 'stats' });
equal(beforeInject.injection.digestCount, 0, 'stats is 0 before any prompt injection was recorded');
ok(beforeInject.injection.digestReason, 'stats explains why no injection is recorded yet');
const injected = digestHost.prompts[0].text({ scope: { id: 'session-fixture' } });
matches(injected, /记忆速览|Memory digest/, 'digest section is injected');
ok(injected.includes('部署 example.com 的注入问题'), 'injected digest contains the stored summary');
const digestStats = await digestHost.tools[0].execute({ action: 'stats' });
ok(digestStats.injection && digestStats.injection.digestCount >= 1, 'stats reports the real injected digest count');
equal(digestStats.injection.digestReason, null, 'no blocker reason when the digest was injected');
ok(digestStats.injection.chars > 0, 'stats keeps the injected prompt size');
await digestHost.dispose();

// Digest count (b): when only the current session has summaries, nothing is
// injected and stats must report a real 0 with an explicit reason (never a stale
// or approximated count).
const noDigestStorage = makeStorage();
await seedRow(noDigestStorage, indexOnlyRow({
  id: 'ex-current-only',
  sessionId: 'session-fixture',
  time: Date.now() - 60000,
  user: digestUser,
  assistant: digestReply,
}));
const noDigestHost = makeHost(noDigestStorage);
apply(noDigestHost.ctx, { autoIndexSessions: false, warmup: false, capture: true });
await new Promise(resolve => setTimeout(resolve, 5));
noDigestHost.emit('session-fixture', { type: 'user/message', data: message(digestUser) });
const noDigestText = noDigestHost.prompts[0].text({ scope: { id: 'session-fixture' } });
ok(!/记忆速览|Memory digest/.test(noDigestText), 'current-session-only summaries are not injected');
const noDigestStats = await noDigestHost.tools[0].execute({ action: 'stats' });
equal(noDigestStats.injection.digestCount, 0, 'digestCount is 0 when only the current session has summaries');
matches(noDigestStats.injection.digestReason, /no cross-session summaries/, 'digestCount 0 carries an explicit reason');
await noDigestHost.dispose();

// ---------------------------------------------------------------------------
// Repair (index-only): rebuilding missing user text must never write plaintext
// back. Keywords/entities refresh from summary + in-memory session prompt, a
// legacy "assistant-only" row gets its plaintext cleared, and plaintextRows is a
// live count (a legacy row outside repair's scope keeps its plaintext, so repair
// does not pretend the store is fully stripped).
// ---------------------------------------------------------------------------
const repairStorage = makeStorage();
const repairTime = Date.now() - 300000;
const repairUser = '修复部署 example.com 的注入问题';
const repairAssistant = '注入问题已修复，复验通过';
const repairSession = {
  session: { id: 'session-repair', cwd: null },
  events: [
    { type: 'user/message', time: repairTime, data: message(repairUser) },
    { type: 'turn/start', time: repairTime, data: {} },
    { type: 'assistant/message', time: repairTime + 1000, data: { message: message(repairAssistant) } },
    { type: 'turn/end', time: repairTime + 1500, data: {} },
  ],
};
await seedRow(repairStorage, indexOnlyRow({
  id: 'ex-repair',
  sessionId: 'session-repair',
  time: repairTime + 1500,
  user: repairUser,
  assistant: repairAssistant,
}));
const legacyRow = ({ id, time, user = '', assistant = '' }) => ({
  id,
  sessionId: 'session-repair',
  workspace: null,
  kind: 'episodic',
  time,
  updatedAt: time,
  user,
  assistant,
  textHash: '',
  pointer: null,
  summary: '',
  keywords: [],
  entities: [],
  importance: 0.35,
  accessCount: 0,
  lastAccessAt: null,
  supersededBy: null,
  history: [],
  sourceIds: [],
});
// Legacy "assistant-only" row: user text already gone, assistant plaintext survived.
await seedRow(repairStorage, legacyRow({ id: 'ex-assistant-only', time: repairTime + 1200, assistant: '仅助手旧明文' }));
// Legacy row that still has a user prompt: outside repair's scope; migrate strips it.
await seedRow(repairStorage, legacyRow({ id: 'ex-legacy', time: repairTime + 1300, user: '旧明文用户', assistant: '旧明文回答' }));
const repairHost = makeHost(repairStorage, { sessionQuery: makeSessionQuery({ 'session-repair': repairSession }) });
apply(repairHost.ctx, { autoIndexSessions: false, warmup: false });
await new Promise(resolve => setTimeout(resolve, 5));
const repaired = await repairHost.tools[0].execute({ action: 'repair', limit: 5 });
ok(repaired.repaired >= 2, 'repair rebuilt index metadata for both index-only rows');
equal(repaired.plaintextCleared, 1, 'repair reports the assistant-only plaintext it cleared');
equal(repaired.plaintextRows, 1, 'repair plaintextRows is a live count, not a hardcoded 0');
matches(repaired.note, /assistant-only/, 'repair result explains the assistant-only clearing');
const repairStats = await repairHost.tools[0].execute({ action: 'stats' });
equal(repairStats.plaintextRows, 1, 'stats reports the same live plaintext count');
equal(repairStats.missingUser, 2, 'both repaired rows still have no plaintext user text');
const repairedRow = [...repairStorage.tables.get('exchanges').values()].find(row => row.id === 'ex-repair');
equal(repairedRow.user, '', 'repair does not restore user plaintext');
equal(repairedRow.assistant, '', 'repair does not restore assistant plaintext');
ok(repairedRow.keywords.length > 0, 'repair recovered keywords');
ok(repairedRow.entities.includes('example.com'), 'repair recovered entities');
const assistantOnlyRow = [...repairStorage.tables.get('exchanges').values()].find(row => row.id === 'ex-assistant-only');
equal(assistantOnlyRow.user, '', 'assistant-only row stays user-free');
equal(assistantOnlyRow.assistant, '', 'assistant-only plaintext is cleared (index-only)');
ok(assistantOnlyRow.keywords.length > 0, 'assistant-only row got index metadata from the session prompt');
const legacyRowAfter = [...repairStorage.tables.get('exchanges').values()].find(row => row.id === 'ex-legacy');
equal(legacyRowAfter.user, '旧明文用户', 'legacy row outside repair scope is left untouched');
equal(legacyRowAfter.assistant, '旧明文回答', 'legacy row plaintext is left for migrate to strip');

// ---------------------------------------------------------------------------
// /dmem migrate: the command must run the same strip implementation as the tool
// action, refuse without confirm=true and reject unknown modes. The export goes
// to a temp file so the fixture never touches the real store export.
// ---------------------------------------------------------------------------
const migrateStorage = makeStorage();
const migrateTime = Date.now() - 600000;
await seedRow(migrateStorage, legacyRow({ id: 'ex-migrate', time: migrateTime, user: '旧明文用户问题', assistant: '旧明文助手回答' }));
const migrateExportPath = join(tmpdir(), `dmem-migrate-fixture-${process.pid}-${Date.now()}.md`);
const migrateHost = makeHost(migrateStorage);
apply(migrateHost.ctx, { autoIndexSessions: false, warmup: false, exportPath: migrateExportPath });
await new Promise(resolve => setTimeout(resolve, 5));
const migrateToolRefusal = await migrateHost.tools[0].execute({ action: 'migrate', mode: 'strip' });
matches(migrateToolRefusal.error, /confirm=true/, 'tool migrate without confirm is refused');
const migrateRefusal = await migrateHost.commands[0].handler({ agent: migrateHost.agent, rawInput: 'migrate mode=strip' });
matches(migrateRefusal.text, /confirm=true/, '/dmem migrate without confirm is refused');
const migrateBadMode = await migrateHost.commands[0].handler({ agent: migrateHost.agent, rawInput: 'migrate mode=erase confirm=true' });
matches(migrateBadMode.text, /mode=strip/, '/dmem migrate rejects unknown modes');
const migrateBefore = [...migrateStorage.tables.get('exchanges').values()].find(row => row.id === 'ex-migrate');
equal(migrateBefore.user, '旧明文用户问题', 'refused migrate leaves plaintext intact');
const migrateDone = await migrateHost.commands[0].handler({ agent: migrateHost.agent, rawInput: 'migrate mode=strip confirm=true' });
matches(migrateDone.text, /已移除明文 1 条/, '/dmem migrate executes the strip');
const migrateAfter = [...migrateStorage.tables.get('exchanges').values()].find(row => row.id === 'ex-migrate');
equal(migrateAfter.user, '', 'migrate clears user plaintext');
equal(migrateAfter.assistant, '', 'migrate clears assistant plaintext');
ok(migrateAfter.summary.length > 0, 'migrate keeps an extractive summary');
ok(migrateAfter.textHash, 'migrate keeps the text hash');
ok(migrateAfter.pointer, 'migrate keeps the pointer');
const migrateStats = await migrateHost.tools[0].execute({ action: 'stats' });
equal(migrateStats.plaintextRows, 0, 'migrate leaves plaintextRows at 0');
ok(existsSync(migrateExportPath), 'migrate wrote the rollback export before stripping');
await unlink(migrateExportPath).catch(() => {});

// ---------------------------------------------------------------------------
// Consent (C1-C4): conservative defaults, the tool action and /dmem command share
// one implementation, memory off stops capture + injection, and the choice survives
// a restart because it is persisted (never reopened by a later default).
// ---------------------------------------------------------------------------
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const emitTurn = (host, user, assistant = '好的，收到') => {
  host.emit('session-fixture', { type: 'user/message', data: message(user) });
  host.emit('session-fixture', { type: 'assistant/message', data: { message: message(assistant) } });
  host.emit('session-fixture', { type: 'turn/end', data: {} });
};

const consentStorage = makeStorage();
const consentHost = makeHost(consentStorage);
apply(consentHost.ctx, { autoIndexSessions: false, warmup: false });
await tick();
const defaultConsent = await consentHost.tools[0].execute({ action: 'consent' });
equal(defaultConsent.consent.memory, 'on', 'C1 defaults on for compatibility');
equal(defaultConsent.consent.inject, 'on', 'C2 defaults on');
equal(defaultConsent.consent.profile, 'unified', 'C3 defaults to a unified portrait');
equal(defaultConsent.consent.sensitive, 'off', 'C4 defaults off (conservative)');
const defaultStatus = await consentHost.commands[0].handler({ agent: consentHost.agent, rawInput: 'consent status' });
matches(defaultStatus.text, /C1 跨会话记忆：on/, '/dmem consent status reports C1');
matches(defaultStatus.text, /C4 敏感观察：off/, '/dmem consent status reports C4');

const consentOff = await consentHost.commands[0].handler({ agent: consentHost.agent, rawInput: 'consent off' });
matches(consentOff.text, /C1 跨会话记忆：off/, '/dmem consent off switches memory off');
equal(consentHost.prompts[0].text({ scope: { id: 'session-fixture' } }), '', 'memory off suppresses injection');
emitTurn(consentHost, '这条在同意关闭后不该被记住');
await tick();
const consentOffStats = await consentHost.tools[0].execute({ action: 'stats' });
equal(consentOffStats.exchanges, 0, 'memory off captures nothing');
equal(consentOffStats.capture, 'paused', 'memory off reports capture paused');
equal(consentOffStats.consent.memory, 'off', 'stats exposes the consent state');
equal(consentOffStats.injection.digestReason, 'memory consent is off', 'stats explains the suppressed injection');
await consentHost.dispose();
ok(consentStorage.tables.get('consent').has('state'), 'consent state is written to durable storage');
equal([...consentStorage.tables.get('consent').values()][0].schemaVersion, 1, 'persisted consent row carries schemaVersion');

// Restart with the same storage: the persisted user choice wins over the defaults.
const consentHost2 = makeHost(consentStorage);
apply(consentHost2.ctx, { autoIndexSessions: false, warmup: false });
await tick();
const persistedConsent = await consentHost2.tools[0].execute({ action: 'consent' });
equal(persistedConsent.consent.memory, 'off', 'consent survives a restart');
equal(consentHost2.prompts[0].text({ scope: { id: 'session-fixture' } }), '', 'injection stays off after restart');
const consentOn = await consentHost2.commands[0].handler({ agent: consentHost2.agent, rawInput: 'consent on' });
matches(consentOn.text, /C1 跨会话记忆：on/, '/dmem consent on re-enables memory');
emitTurn(consentHost2, '重新开启之后这条应该被记住');
await tick();
const consentOnStats = await consentHost2.tools[0].execute({ action: 'stats' });
equal(consentOnStats.exchanges, 1, 'capture resumes after consent on');
equal(consentOnStats.capture, 'on', 'capture reports on again');
const invalidToggle = await consentHost2.tools[0].execute({ action: 'consent', consent: { sensitive: 'maybe' } });
matches(invalidToggle.error, /must be on\/off/, 'invalid consent values are rejected');
const consentProfileUsage = await consentHost2.commands[0].handler({ agent: consentHost2.agent, rawInput: 'consent profile' });
matches(consentProfileUsage.text, /consent profile unified\|situational\|off/, 'missing profile mode prints usage');
await consentHost2.dispose();

// C2 in isolation: injection off keeps capture, but the prompt receives nothing.
const injectStorage = makeStorage();
const injectUser = '继续修复部署 example.com 的注入问题并给出验证结果';
await seedRow(injectStorage, indexOnlyRow({
  id: 'ex-inject-off',
  sessionId: 'session-other',
  time: Date.now() - 60000,
  user: injectUser,
  assistant: '注入问题已修复，复验通过',
}));
const injectHost = makeHost(injectStorage);
apply(injectHost.ctx, { autoIndexSessions: false, warmup: false, consent: { inject: false } });
await tick();
const injectOffStatus = await injectHost.tools[0].execute({ action: 'consent' });
equal(injectOffStatus.consent.inject, 'off', 'config.consent.inject override is applied');
injectHost.emit('session-fixture', { type: 'user/message', data: message(injectUser) });
equal(injectHost.prompts[0].text({ scope: { id: 'session-fixture' } }), '', 'inject off suppresses the prompt section');
injectHost.emit('session-fixture', { type: 'assistant/message', data: { message: message('注入关闭但捕获仍写') } });
injectHost.emit('session-fixture', { type: 'turn/end', data: {} });
await tick();
const injectOffStats = await injectHost.tools[0].execute({ action: 'stats' });
equal(injectOffStats.exchanges, 2, 'inject off still captures the turn');
equal(injectOffStats.injection.digestReason, 'injection consent is off', 'stats names the injection consent reason');
const injectOn = await injectHost.commands[0].handler({ agent: injectHost.agent, rawInput: 'consent inject on' });
matches(injectOn.text, /C2 自动注入：on/, '/dmem consent inject on switches injection on');
const injectRestored = injectHost.prompts[0].text({ scope: { id: 'session-fixture' } });
ok(injectRestored.length > 0, 'inject on restores the prompt section');
matches(injectRestored, /记忆速览|Memory digest/, 'restored injection renders the digest');
equal((await injectHost.tools[0].execute({ action: 'stats' })).injection.digestCount, 1, 'stats counts the restored digest');
await injectHost.dispose();

// C3: profile off suppresses portrait injection and refuses portrait writes.
const profileStorage = makeStorage();
await profileStorage.domain.table('portrait').put('p_habits', {
  facet: 'habits',
  content: '深夜 提交 代码 的 习惯',
  updatedAt: Date.now(),
  keywords: ['深夜'],
  history: [],
  sourceExchangeIds: [],
  sourceObservationIds: [],
  needsRecompute: false,
});
const profileHost = makeHost(profileStorage);
apply(profileHost.ctx, { autoIndexSessions: false, warmup: false, consent: { profile: 'off' } });
await tick();
const profileOffStatus = await profileHost.tools[0].execute({ action: 'consent' });
equal(profileOffStatus.consent.profile, 'off', 'config.consent.profile override is applied');
const profileOffPrompt = profileHost.prompts[0].text({ scope: { id: 'session-fixture' } });
ok(!profileOffPrompt.includes('深夜 提交 代码'), 'profile off suppresses portrait injection');
const profileLearnRefused = await profileHost.tools[0].execute({ action: 'learn', facet: 'preferences', content: '画像关闭时不该写入' });
matches(profileLearnRefused.error, /profile consent is off/, 'profile off refuses portrait writes');
const profileOn = await profileHost.tools[0].execute({ action: 'consent', consent: { profile: 'unified' } });
equal(profileOn.consent.profile, 'unified', 'tool action consent switches the portrait mode');
const profileLearn = await profileHost.tools[0].execute({ action: 'learn', facet: 'preferences', content: '偏好先给结论' });
ok(!profileLearn.error, 'profile writes resume after consent on');
const profileOnPrompt = profileHost.prompts[0].text({ scope: { id: 'session-fixture' } });
ok(profileOnPrompt.includes('深夜 提交 代码'), 'profile on injects the portrait again');
const situational = await profileHost.commands[0].handler({ agent: profileHost.agent, rawInput: 'consent profile situational' });
matches(situational.text, /C3 画像：situational/, 'situational portrait mode is persisted');
const badProfile = await profileHost.tools[0].execute({ action: 'consent', consent: { profile: 'personality' } });
matches(badProfile.error, /profile must be one of/, 'unknown portrait modes are rejected');
await profileHost.dispose();

// C4: sensitive observations are injected only with explicit consent; private never.
const sensitiveStorage = makeStorage();
const sensitiveHost = makeHost(sensitiveStorage);
apply(sensitiveHost.ctx, { autoIndexSessions: false, warmup: false, consent: { sensitive: true } });
await tick();
equal((await sensitiveHost.tools[0].execute({ action: 'consent' })).consent.sensitive, 'on', 'config.consent.sensitive override is applied');
const sensitiveObs = await sensitiveHost.tools[0].execute({
  action: 'observe',
  type: 'constraint',
  content: '用户健康限制；作息限制',
  sensitivity: 'sensitive',
  mention: 'if_asked',
});
ok(sensitiveObs.id, 'sensitive observation stored');
sensitiveHost.emit('session-fixture', { type: 'user/message', data: message('请检查健康限制和作息限制并给出建议') });
const sensitiveVisible = sensitiveHost.prompts[0].text({ scope: { id: 'session-fixture' } });
ok(sensitiveVisible.includes('健康限制'), 'sensitive observation is injected only after consent');
const sensitiveOff = await sensitiveHost.commands[0].handler({ agent: sensitiveHost.agent, rawInput: 'consent sensitive off' });
matches(sensitiveOff.text, /C4 敏感观察：off/, '/dmem consent sensitive off switches C4 off');
const sensitiveHidden = sensitiveHost.prompts[0].text({ scope: { id: 'session-fixture' } });
ok(!sensitiveHidden.includes('健康限制'), 'sensitive observation is not injected while C4 is off');
await sensitiveHost.tools[0].execute({ action: 'consent', consent: { sensitive: true } });
const privateObs = await sensitiveHost.tools[0].execute({
  action: 'observe',
  type: 'constraint',
  content: '私密观察内容不可注入',
  sensitivity: 'private',
});
ok(privateObs.id, 'private observation stored');
const privateHidden = sensitiveHost.prompts[0].text({ scope: { id: 'session-fixture' } });
ok(!privateHidden.includes('私密观察内容不可注入'), 'private observations are never injected even after C4 consent');
equal((await sensitiveHost.tools[0].execute({ action: 'stats' })).consent.sensitive, 'on', 'stats reflects the C4 switch');
await sensitiveHost.dispose();

// Config-level master switch: consent.memory=false must behave like /dmem consent off.
const configOffStorage = makeStorage();
const configOffHost = makeHost(configOffStorage);
apply(configOffHost.ctx, { autoIndexSessions: false, warmup: false, consent: { memory: false } });
await tick();
equal((await configOffHost.tools[0].execute({ action: 'consent' })).consent.memory, 'off', 'config.consent.memory=false is honored');
configOffHost.emit('session-fixture', { type: 'user/message', data: message('配置层面关闭记忆') });
configOffHost.emit('session-fixture', { type: 'assistant/message', data: { message: message('不该写入') } });
configOffHost.emit('session-fixture', { type: 'turn/end', data: {} });
await tick();
const configOffStats = await configOffHost.tools[0].execute({ action: 'stats' });
equal(configOffStats.exchanges, 0, 'config-off memory captures nothing');
equal(configOffHost.prompts[0].text({ scope: { id: 'session-fixture' } }), '', 'config-off memory injects nothing');
await configOffHost.dispose();

// ---------------------------------------------------------------------------
// Consent hardening: memory off must block explicit writes too (observe/learn/
// deepen/correct), not only automatic capture. The persisted consent row carries a
// schemaVersion so v0 rows (written before the field existed) migrate on read.
// ---------------------------------------------------------------------------
const writeBlockStorage = makeStorage();
const writeBlockHost = makeHost(writeBlockStorage);
apply(writeBlockHost.ctx, { autoIndexSessions: false, warmup: false });
await tick();
const keptObs = await writeBlockHost.tools[0].execute({ action: 'observe', type: 'explicit_fact', content: '关闭前写入的观察' });
ok(keptObs.id, 'observation written while memory consent is on');
emitTurn(writeBlockHost, '关闭前记录的一轮对话', '关闭前写入的回复');
await tick();
const keptExchange = (await writeBlockHost.tools[0].execute({ action: 'recent', limit: 1 })).exchanges[0];
ok(keptExchange && keptExchange.id, 'exchange captured while memory consent is on');
await writeBlockHost.commands[0].handler({ agent: writeBlockHost.agent, rawInput: 'consent off' });
const blockedObserve = await writeBlockHost.tools[0].execute({ action: 'observe', type: 'explicit_fact', content: '关闭后不该写入' });
matches(blockedObserve.error, /memory consent is off: observe/, 'memory off rejects observe writes');
const blockedLearn = await writeBlockHost.tools[0].execute({ action: 'learn', facet: 'habits', content: '关闭后不该写画像' });
matches(blockedLearn.error, /memory consent is off: learn/, 'memory off rejects learn writes');
const blockedDeepen = await writeBlockHost.tools[0].execute({ action: 'deepen', id: keptExchange.id, summary: '关闭后不该改印象' });
matches(blockedDeepen.error, /memory consent is off: deepen/, 'memory off rejects deepen writes');
const blockedCorrect = await writeBlockHost.tools[0].execute({ action: 'correct', id: keptObs.id, content: '关闭后不该纠正' });
matches(blockedCorrect.error, /memory consent is off: correct/, 'memory off rejects correct writes');
const blockedStats = await writeBlockHost.tools[0].execute({ action: 'stats' });
equal(blockedStats.exchanges, 1, 'blocked writes do not add exchanges');
equal(blockedStats.observations.current, 1, 'blocked writes do not add observations');
const readOnlyRecent = await writeBlockHost.tools[0].execute({ action: 'recent', limit: 1 });
equal(readOnlyRecent.total, 1, 'reads stay available while memory consent is off');
await writeBlockHost.dispose();

// A v0 consent row (no schemaVersion) must keep every value and migrate in place.
const legacyConsentStorage = makeStorage();
await legacyConsentStorage.domain.table('consent').put('state', {
  memory: false,
  inject: true,
  profile: 'off',
  sensitive: true,
  updatedAt: Date.now() - 5000,
});
const legacyConsentHost = makeHost(legacyConsentStorage);
apply(legacyConsentHost.ctx, { autoIndexSessions: false, warmup: false });
await tick();
const legacyConsent = await legacyConsentHost.tools[0].execute({ action: 'consent' });
equal(legacyConsent.consent.memory, 'off', 'legacy v0 row keeps its C1 value');
equal(legacyConsent.consent.profile, 'off', 'legacy v0 row keeps its C3 value');
equal(legacyConsent.consent.sensitive, 'on', 'legacy v0 row keeps its C4 value');
equal(legacyConsent.consent.schemaVersion, 1, 'legacy v0 row is read as the current schema');
const legacyStored = [...legacyConsentStorage.tables.get('consent').values()][0];
equal(legacyStored.schemaVersion, 1, 'migrated v0 row is written back with schemaVersion');
legacyConsentHost.emit('session-fixture', { type: 'user/message', data: message('旧数据迁移后仍然禁止写入') });
legacyConsentHost.emit('session-fixture', { type: 'assistant/message', data: { message: message('不该写入') } });
legacyConsentHost.emit('session-fixture', { type: 'turn/end', data: {} });
await tick();
equal((await legacyConsentHost.tools[0].execute({ action: 'stats' })).exchanges, 0, 'migrated legacy consent still blocks capture');
const legacyWriteOff = await legacyConsentHost.tools[0].execute({ action: 'observe', type: 'explicit_fact', content: '旧数据下不该写入' });
matches(legacyWriteOff.error, /memory consent is off/, 'migrated legacy consent still blocks explicit writes');
await legacyConsentHost.dispose();
const legacyConsentHost2 = makeHost(legacyConsentStorage);
apply(legacyConsentHost2.ctx, { autoIndexSessions: false, warmup: false });
await tick();
const reloadedConsent = await legacyConsentHost2.tools[0].execute({ action: 'consent' });
equal(reloadedConsent.consent.memory, 'off', 'migrated consent survives the next restart');
equal(reloadedConsent.consent.profile, 'off', 'migrated profile value survives the next restart');
equal(reloadedConsent.consent.schemaVersion, 1, 'reloaded row stays on the current schema');
await legacyConsentHost2.dispose();

// A row from a newer build is read tolerantly (known fields only) and not rewritten.
const futureConsentStorage = makeStorage();
await futureConsentStorage.domain.table('consent').put('state', {
  schemaVersion: 99,
  memory: false,
  inject: false,
  profile: 'situational',
  sensitive: true,
  futureField: 'kept by the newer build',
  updatedAt: Date.now() - 5000,
});
const futureConsentHost = makeHost(futureConsentStorage);
apply(futureConsentHost.ctx, { autoIndexSessions: false, warmup: false });
await tick();
const futureConsent = await futureConsentHost.tools[0].execute({ action: 'consent' });
equal(futureConsent.consent.memory, 'off', 'future row is read with the known fields');
equal(futureConsent.consent.profile, 'situational', 'future row keeps a known profile value');
const futureStored = [...futureConsentStorage.tables.get('consent').values()][0];
equal(futureStored.schemaVersion, 99, 'future row is not blindly rewritten on read');
await futureConsentHost.dispose();

console.log(`host fixture: ${checks} checks passed`);

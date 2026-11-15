#!/usr/bin/env node
// Pure-function tests for the memory plugin (no Harness runtime required).
import assert from 'node:assert/strict';
import { entitiesOf, buildEntityIndex, rankExchanges, isReAsk, cleanUserText, snippetOf, computeGapState, isStale, selectForArchive, renderContext, styleOf, buildSpeakerBaseline, speakerContinuity, selfDeclarationCues, lintTraitLabel } from './index.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

const row = (overrides) => ({
  id: overrides.id,
  sessionId: overrides.sessionId || 's1',
  time: overrides.time ?? Date.now(),
  updatedAt: overrides.time ?? Date.now(),
  user: overrides.user || '',
  assistant: overrides.assistant || '',
  summary: overrides.summary || '',
  keywords: overrides.keywords || [],
  entities: overrides.entities || entitiesOf(overrides.user || '', overrides.assistant || ''),
  importance: overrides.importance ?? 0.35,
  accessCount: overrides.accessCount || 0,
  lastAccessAt: null,
  supersededBy: overrides.supersededBy || null,
  archivedAt: overrides.archivedAt || null,
  archivedReason: null,
  weight: overrides.weight ?? 1,
  kind: 'episodic',
  workspace: overrides.workspace || null,
  history: [],
  sourceIds: [],
});

check('entities: host, dotted name, path, acronym', () => {
  const found = entitiesOf('部署到 https://example.com 后，用 Dropdown.vue 重建，路径 C:\\Users\\demo\\app，涉及 AIOS 与 WSL');
  assert.ok(found.includes('example.com'), 'host');
  assert.ok(found.includes('dropdown.vue'), 'dotted');
  assert.ok(found.includes('aios'), 'acronym');
  assert.ok(found.includes('wsl'), 'acronym 2');
});

check('entities: ignores generic words and short tokens', () => {
  const found = entitiesOf('the and for with that this http https');
  assert.deepEqual(found, []);
});

check('entity index: maps entity to rows', () => {
  const a = row({ id: 'a', assistant: 'see example.com' });
  const b = row({ id: 'b', assistant: 'example.com again' });
  const index = buildEntityIndex([a, b]);
  assert.equal(index.get('example.com').size, 2);
});

check('rank: entity-only query still finds rows', () => {
  const target = row({ id: 'e1', assistant: '已部署到 example.com' });
  const other = row({ id: 'e2', assistant: '完全无关的一段话' });
  const result = rankExchanges([target, other], { query: 'example.com', limit: 5 });
  assert.equal(result.matches[0].id, 'e1');
  assert.ok(result.matches[0].signals.entity >= 1);
});

check('rank: superseded rows are down-ranked unless requested', () => {
  const old = row({ id: 'old', user: '部署到哪', assistant: '旧答案提到 alpha beta gamma', supersededBy: 'new', time: Date.now() - 1000 });
  const fresh = row({ id: 'new', user: '部署到哪', assistant: '新答案提到 alpha beta gamma delta' });
  const normal = rankExchanges([old, fresh], { query: '部署到哪 alpha beta gamma', limit: 5 });
  assert.equal(normal.matches[0].id, 'new');
  const included = rankExchanges([old, fresh], { query: '部署到哪 alpha beta gamma', limit: 5, includeSuperseded: true });
  assert.equal(included.matches.length, 2);
});

check('rank: importance raises the score', () => {
  const low = row({ id: 'low', assistant: 'mobile upload bug fixed', importance: 0.1 });
  const high = row({ id: 'high', assistant: 'mobile upload bug fixed', importance: 0.95 });
  const result = rankExchanges([low, high], { query: 'mobile upload', limit: 5, timeBoost: 0, phraseWeight: 0, impressionWeight: 0, entityWeight: 0 });
  assert.equal(result.matches[0].id, 'high');
});

check('rank: sort=oldest and time window', () => {
  const older = row({ id: 'older', assistant: 'alpha beta', time: Date.parse('2026-11-01T00:00:00Z') });
  const newer = row({ id: 'newer', assistant: 'alpha beta', time: Date.parse('2026-11-10T00:00:00Z') });
  const oldest = rankExchanges([newer, older], { query: 'alpha beta', sort: 'oldest', limit: 5 });
  assert.equal(oldest.matches[0].id, 'older');
  const window = rankExchanges([newer, older], { query: 'alpha beta', from: '2026-11-05T00:00:00Z', limit: 5 });
  assert.equal(window.matches.length, 1);
  assert.equal(window.matches[0].id, 'newer');
});

check('rank: touch records access but does not raise importance', () => {
  const target = row({ id: 'touch', assistant: 'alpha beta' });
  rankExchanges([target], { query: 'alpha', limit: 5, touch: true });
  assert.equal(target.accessCount, 1);
  assert.ok(target.lastAccessAt > 0);
  assert.equal(target.importance, 0.35);
});

check('isReAsk: same question, different answer', () => {
  assert.equal(isReAsk('部署到哪了', '部署在 A 服务器，端口 8080', '部署到哪了', '现在换到了 B 服务器，端口 9090'), true);
  assert.equal(isReAsk('部署到哪了', '部署在 A 服务器', '部署到哪了', '部署在 A 服务器'), false);
  assert.equal(isReAsk('部署到哪了', '部署在 A 服务器', '今天天气怎么样', '晴，25 度'), false);
});

check('cleanUserText: strips harness runtime context', () => {
  const text = '把插件装好\nCurrent runtime context. This snapshot supersedes earlier ones.\nCurrent working directory: C:\\Users\\demo';
  assert.equal(cleanUserText(text), '把插件装好');
  assert.equal(cleanUserText('Current runtime context. x'), '');
});

check('snippet: centers on the matched term and stays bounded', () => {
  const text = `${'前置内容 '.repeat(60)}关键命中 here ${'后续内容 '.repeat(60)}`;
  const snippet = snippetOf(text, ['关键命中'], 120);
  assert.ok(snippet.length <= 122, `length ${snippet.length}`);
  assert.ok(snippet.includes('关键命中'), 'keeps the matched term');
  assert.equal(snippetOf('短文本', ['短'], 120), '短文本');
});

check('confidence: single unambiguous match is high', () => {
  const target = row({ id: 'c1', assistant: 'example.com 部署完成，公网返回 200' });
  const other = row({ id: 'c2', assistant: '完全无关的天气记录' });
  const result = rankExchanges([target, other], { query: 'example.com 公用', limit: 5 });
  assert.ok(['high', 'medium'].includes(result.confidence.label), `got ${result.confidence.label}`);
});

check('reasons: phrase and entity matches are reported', () => {
  const target = row({ id: 'r1', assistant: '已修复并部署到 example.com' });
  const result = rankExchanges([target], { query: 'example.com', limit: 5 });
  const reasons = result.matches[0].reasons;
  assert.ok(reasons.includes('phrase'), reasons.join(','));
  assert.ok(reasons.some(reason => reason.startsWith('entity:')), reasons.join(','));
});

check('entities: quoted names are extracted', () => {
  const found = entitiesOf('把「记忆插件」接进《部署文档》，顺带看 “Dropdown.vue”');
  assert.ok(found.includes('记忆插件'), found.join(','));
  assert.ok(found.includes('部署文档'), found.join(','));
});

check('snippet: prefers sentence boundaries', () => {
  const text = `第一句话内容。${'中间内容，'.repeat(40)}命中关键词在这里。最后一句。`;
  const snippet = snippetOf(text, ['命中关键词'], 80);
  assert.ok(snippet.includes('命中关键词'), snippet);
  assert.ok(snippet.endsWith('。') || snippet.endsWith('…'), snippet.slice(-4));
});

check('confidence: a dominant hit beats a crowded field', () => {
  const strong = row({ id: 's1', assistant: 'example.com 部署完成，公网返回 200' });
  const noise = ['a', 'b', 'c'].map(id => row({ id, assistant: 'cloud 部署 公网 200 的其它记录 alpha' }));
  const strongResult = rankExchanges([strong, ...noise], { query: 'example.com 公网 200', limit: 5 });
  const crowdedResult = rankExchanges(noise.map((entry, index) => row({ id: `n${index}`, assistant: 'cloud 部署 公网 200 alpha' })), { query: 'cloud 部署 公网 200', limit: 5 });
  assert.ok(strongResult.confidence.separation >= crowdedResult.confidence.separation, `${strongResult.confidence.separation} vs ${crowdedResult.confidence.separation}`);
});

check('gap: computes idle days from the newest active memory', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const rows = [
    row({ id: 'a', assistant: 'x', time: Date.parse('2025-06-01T00:00:00Z') }),
    row({ id: 'arc', assistant: 'y', time: Date.parse('2025-05-01T00:00:00Z'), archivedAt: now }),
  ];
  const gap = computeGapState(rows, now);
  assert.ok(gap.gapDays > 1600, String(gap.gapDays));
  assert.equal(gap.lastActivityAt, Date.parse('2025-06-01T00:00:00Z'));
  assert.equal(computeGapState([], now).gapDays, null);
});

check('stale: portraits older than the fresh window', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  assert.equal(isStale(Date.parse('2026-01-01T00:00:00Z'), now, 180), true);
  assert.equal(isStale(Date.parse('2029-12-01T00:00:00Z'), now, 180), false);
});

check('archive selection: idle rows only, by age or ids', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const rows = [
    row({ id: 'old', assistant: 'x', time: Date.parse('2025-01-01T00:00:00Z') }),
    row({ id: 'new', assistant: 'y', time: Date.parse('2029-12-01T00:00:00Z') }),
  ];
  const byAge = selectForArchive(rows, { now, olderThanDays: 730 });
  assert.deepEqual(byAge.map(entry => entry.id), ['old']);
  const byId = selectForArchive(rows, { now, ids: ['new'] });
  assert.deepEqual(byId.map(entry => entry.id), ['new']);
});

check('rank: archived rows are hidden by default and down-weighted when included', () => {
  const now = Date.now();
  const active = row({ id: 'active', assistant: 'deploy example.com', time: now });
  const archived = row({ id: 'archived', assistant: 'deploy example.com', time: now, archivedAt: now, weight: 0.3 });
  const hidden = rankExchanges([active, archived], { query: 'deploy example.com', limit: 5 });
  assert.equal(hidden.matches.length, 1);
  assert.equal(hidden.matches[0].id, 'active');
  const included = rankExchanges([active, archived], { query: 'deploy example.com', limit: 5, includeArchived: true });
  assert.equal(included.matches.length, 2);
  assert.ok(included.matches[0].id === 'active', 'active ranks first');
  const archivedMatch = included.matches.find(match => match.id === 'archived');
  assert.equal(archivedMatch.archived, true);
  assert.ok(archivedMatch.score < included.matches[0].score);
});

check('injection: long gap shows a time boundary and suppresses the digest', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const gap = { lastActivityAt: Date.parse('2025-06-01T00:00:00Z'), gapDays: 1675 };
  const digestRow = row({ id: 'd1', summary: '部署 公网', user: '部署到哪', time: Date.parse('2025-06-01T00:00:00Z') });
  const text = renderContext({
    portraitRows: new Map(),
    portraitChars: 240,
    portraitBudget: 900,
    selfRows: undefined,
    selfChars: 180,
    selfBudget: 520,
    digest: [digestRow],
    digestChars: 100,
    lastUserText: '部署',
    gap,
    gapDays: 30,
    staleFacets: new Set(),
  });
  assert.ok(text.includes('时间分界'), text.slice(0, 80));
  assert.ok(!text.includes('记忆速览'), 'digest is not injected during a long gap');
});

check('injection: stale portrait facets are flagged', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const portrait = new Map([['identity', { facet: 'identity', content: '独立开发者', updatedAt: Date.parse('2026-01-01T00:00:00Z') }]]);
  const text = renderContext({
    portraitRows: portrait,
    portraitChars: 240,
    portraitBudget: 900,
    selfRows: undefined,
    selfChars: 180,
    selfBudget: 520,
    digest: [],
    digestChars: 100,
    lastUserText: '',
    gap: { lastActivityAt: now, gapDays: 0 },
    gapDays: 30,
    staleFacets: new Set(['identity']),
  });
  assert.ok(text.includes('可能过时'), text.slice(0, 120));
});

check('identity: style fingerprint and self-declaration cues', () => {
  const style = styleOf('把 这个 修好，好吗？？');
  assert.ok(style.cjkRatio > 0.5 && style.questionRate > 0);
  assert.deepEqual(selfDeclarationCues('我是新来的，用这台电脑登录'), ['我是新来的']);
  assert.deepEqual(selfDeclarationCues('继续修这个 bug'), []);
});

check('identity: same speaker scores higher than a different speaker', () => {
  const familiar = '把这个插件重载一下，再用 search 查 example.com 的部署记录，确认 example.com 返回 200';
  const baseline = buildSpeakerBaseline([
    row({ id: 'b1', assistant: 'a', user: familiar }),
    row({ id: 'b2', assistant: 'a', user: familiar }),
    row({ id: 'b3', assistant: 'a', user: familiar }),
  ]);
  assert.ok(baseline.messages >= 3);
  const same = speakerContinuity([familiar, familiar], baseline, { gapDays: 1 });
  assert.ok(same.score > 0.5, `same=${same.score}`);
  const other = speakerContinuity(['今天天气不错，帮我写一首关于春天的诗吧。', '再来一首，要古风一点的。'], baseline, { gapDays: 900 });
  assert.ok(other.score < same.score, `other=${other.score} same=${same.score}`);
  const insufficient = speakerContinuity(['只说一句'], baseline, {});
  assert.equal(insufficient.label, 'insufficient');
});

check('injection: identity drift adds a cautious note', () => {
  const text = renderContext({
    portraitRows: new Map(),
    portraitChars: 240,
    portraitBudget: 900,
    selfRows: undefined,
    selfChars: 180,
    selfBudget: 520,
    digest: [],
    digestChars: 100,
    lastUserText: '我是新来的，这台电脑不是我的',
    gap: { lastActivityAt: Date.now(), gapDays: 0 },
    gapDays: 30,
    staleFacets: new Set(),
    identity: {
      score: 0.21,
      label: 'drifted',
      evidence: { vocabOverlap: 0.2, entityOverlap: 0, styleSimilarity: 0.3, gapDays: 900, selfDeclarations: ['我是新来的'] },
    },
  });
  assert.ok(text.includes('身份连续性'), text.slice(0, 80));
  assert.ok(text.includes('不要默认套用用户画像'), text.slice(0, 160));
});

check('observations: types are separated in injection, private ones hidden', () => {
  const text = renderContext({
    portraitRows: new Map(),
    portraitChars: 240,
    portraitBudget: 900,
    selfRows: undefined,
    selfChars: 180,
    selfBudget: 520,
    digest: [],
    digestChars: 100,
    lastUserText: '',
    gap: null,
    gapDays: 30,
    staleFacets: new Set(),
    observations: [
      { id: 'o1', type: 'behavior_observation', kind: 'observed', text: '连续三次推迟处理任务', status: 'current', confidence: null, alternatives: [], sensitivity: 'normal', contradicts: [] },
      { id: 'o2', type: 'inferred_motivation', kind: 'inferred', text: '可能担心失败', status: 'current', confidence: 0.4, alternatives: ['优先级低'], sensitivity: 'normal', contradicts: ['o3'] },
      { id: 'o3', type: 'emotional_state', kind: 'self_reported', text: '最近压力大', status: 'current', confidence: null, alternatives: [], sensitivity: 'private', contradicts: ['o2'] },
    ],
    observationChars: 120,
    observationBudget: 400,
  });
  assert.ok(text.includes('观察与推断'), text.slice(0, 80));
  assert.ok(text.includes('事实：连续三次推迟'));
  assert.ok(text.includes('推断 0.40'), text.slice(0, 200));
  assert.ok(text.includes('也可能：优先级低'));
  assert.ok(!text.includes('最近压力大'), 'private observation text is hidden');
  assert.ok(text.includes('私密观察'), 'hidden count is reported');
  assert.ok(text.includes('未解矛盾'), 'unresolved contradictions are flagged');
});

check('lint: trait labels get a warning, evidence-backed ones do not', () => {
  assert.ok(lintTraitLabel('用户比较懒惰', []));
  assert.equal(lintTraitLabel('用户比较懒惰', ['exchange-1']), null);
  assert.equal(lintTraitLabel('连续三次推迟了任务，当时在做别的项目', []), null);
  // A long label is not an excuse (no length bypass).
  assert.ok(lintTraitLabel('用户比较懒惰，'.repeat(30), []));
  // Context description is accepted without evidence ids.
  assert.equal(lintTraitLabel('用户比较固执，当时在赶交付', []), null);
});

check('confidence: stable regardless of display sort order', () => {
  const now = Date.now();
  const rows = [
    row({ id: 'a', assistant: 'example.com 部署完成 200', time: now }),
    row({ id: 'b', assistant: 'example.com 部署记录', time: now - 86400000 }),
    row({ id: 'c', assistant: '无关内容', time: now - 9 * 86400000 }),
  ];
  const byRelevance = rankExchanges(rows, { query: 'example.com 部署', sort: 'relevance', limit: 3 });
  const byRecent = rankExchanges(rows, { query: 'example.com 部署', sort: 'recent', limit: 3 });
  const byOldest = rankExchanges(rows, { query: 'example.com 部署', sort: 'oldest', limit: 3 });
  assert.equal(byRelevance.confidence.score, byRecent.confidence.score);
  assert.equal(byRelevance.confidence.label, byRecent.confidence.label);
  assert.equal(byRelevance.confidence.score, byOldest.confidence.score);
  assert.ok(byRelevance.confidence.margin >= 0);
});

check('contradictions: only counted while both sides are current', () => {
  const base = {
    portraitRows: new Map(), portraitChars: 240, portraitBudget: 900,
    selfRows: undefined, selfChars: 180, selfBudget: 520,
    digest: [], digestChars: 100, lastUserText: '',
    gap: null, gapDays: 30, staleFacets: new Set(),
  };
  const live = { id: 'l1', type: 'behavior_observation', kind: 'observed', text: '行为一', status: 'current', confidence: null, alternatives: [], sensitivity: 'normal', contradicts: ['dead'] };
  const dead = { id: 'dead', type: 'behavior_observation', kind: 'observed', text: '行为二', status: 'superseded', confidence: null, alternatives: [], sensitivity: 'normal', contradicts: ['l1'] };
  const text = renderContext({ ...base, observations: [live, dead] });
  assert.ok(!text.includes('未解矛盾'), text.slice(0, 120));
});

check('observations: corrections render before inferences', () => {
  const base = {
    portraitRows: new Map(), portraitChars: 240, portraitBudget: 900,
    selfRows: undefined, selfChars: 180, selfBudget: 520,
    digest: [], digestChars: 100, lastUserText: '',
    gap: null, gapDays: 30, staleFacets: new Set(),
  };
  const corrected = { id: 'c', kind: 'corrected', type: 'correction', text: '纠正内容', status: 'current', confidence: null, alternatives: [], sensitivity: 'normal', contradicts: [] };
  const inferred = { id: 'i', kind: 'inferred', type: 'inferred_motivation', text: '推断内容', status: 'current', confidence: 0.4, alternatives: ['备选'], sensitivity: 'normal', contradicts: [] };
  const text = renderContext({ ...base, observations: [inferred, corrected] });
  assert.ok(text.indexOf('纠正内容') < text.indexOf('推断内容'), 'corrected first');
});

check('observations: unrelated ones are gated out of injection', () => {
  const base = {
    portraitRows: new Map(), portraitChars: 240, portraitBudget: 900,
    selfRows: undefined, selfChars: 180, selfBudget: 520,
    digest: [], digestChars: 100,
    gap: null, gapDays: 30, staleFacets: new Set(),
  };
  const psychology = { id: 'p', kind: 'inferred', type: 'emotional_state', text: '用户可能压力很大', status: 'current', confidence: 0.4, alternatives: ['只是忙'], sensitivity: 'normal', contradicts: [] };
  const relevant = renderContext({ ...base, lastUserText: 'pressure 压力', observations: [psychology] });
  assert.ok(relevant.includes('用户可能压力很大'), relevant.slice(0, 120));
  const unrelated = renderContext({ ...base, lastUserText: '帮我修一下 index.js 的语法', observations: [psychology] });
  assert.ok(!unrelated.includes('用户可能压力很大'), unrelated.slice(0, 120));
});

console.log(`\n${passed} checks passed`);

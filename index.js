import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// All runtime-facing text lives in locale packs. Core cognition stays language-agnostic;
// only the language adapters (tokenizer fallback, word lists, phrases) are locale data.
const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locale');
const loadPack = code => {
  try {
    return JSON.parse(readFileSync(join(LOCALE_DIR, `messages.${code}.json`), 'utf8'));
  } catch {
    return null;
  }
};
const PACKS = { en: loadPack('en'), zh: loadPack('zh') };
export const SUPPORTED_LOCALES = Object.keys(PACKS).filter(code => PACKS[code]);
export function packFor(code) {
  return PACKS[code] || PACKS.en || { labels: { facets: {}, selfFacets: {} }, injection: {}, commands: {}, traitWords: [], selfDeclarationPatterns: [], entityStopwords: [] };
}
export function detectLocale(text) {
  const source = String(text || '');
  const cjk = (source.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  return cjk >= 2 && cjk >= latin * 0.2 ? 'zh' : 'en';
}
function translate(messages, key, values = {}) {
  const parts = String(key).split('.');
  let value = messages;
  for (const part of parts) value = value == null ? undefined : value[part];
  if (typeof value !== 'string') return '';
  return value.replace(/\{(\w+)\}/g, (_, name) => (values[name] === undefined ? `{${name}}` : String(values[name])));
}

const MAX_TEXT = 40000;
const MAX_PROMPT_CHARS = 1200;
const MAX_KEYWORDS = 160;
const MAX_ENTITIES = 24;
const HISTORY_LIMIT = 20;
const DEFAULT_IMPORTANCE = 0.35;
const DEFAULT_ARCHIVED_WEIGHT = 0.3;
const DEFAULT_ARCHIVE_AFTER_DAYS = 730;
const DEFAULT_GAP_DAYS = 30;
const DEFAULT_FRESH_DAYS = 180;
const KINDS = ['episodic', 'semantic', 'procedural'];

/** Cheap, language-neutral extractive summary: no LLM call, fills the cross-session digest. */
export function extractiveSummary(user, assistant) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const pick = (text, limit) => {
    const cut = text.slice(0, limit);
    const dot = cut.search(/[。.!?！？\n]/);
    return dot > 10 ? cut.slice(0, dot + 1) : cut;
  };
  const u = clean(user);
  const a = clean(assistant);
  if (!u) return a.slice(0, 120);
  return `${pick(u, 90)}${a ? ' ' + pick(a, 60) : ''}`.slice(0, 160);
}
const FACETS = ['habits', 'preferences', 'thinking', 'dynamics', 'psychology', 'past', 'identity'];
const FACET_LABELS = {
  habits: '用户习惯',
  preferences: '喜好',
  thinking: '思维',
  dynamics: '近期动态',
  psychology: '心理',
  past: '过往',
  identity: '身份画像',
};
const SELF_FACETS = ['habits', 'preferences', 'psychology', 'experience'];
const OBSERVATION_TYPES = [
  'explicit_fact', 'explicit_preference', 'behavior_observation', 'self_reflection',
  'inferred_motivation', 'emotional_state', 'decision_record', 'relationship_context',
  'habit_pattern', 'contradiction', 'goal', 'constraint', 'correction',
];
const OBSERVATION_KINDS = ['observed', 'self_reported', 'inferred', 'corrected'];
const OBSERVATION_STATUS = ['current', 'withdrawn', 'superseded', 'proposed'];
const MENTION_VALUES = ['proactive', 'if_asked', 'never'];
const OBSERVATION_SCOPES = ['transient', 'situational', 'durable'];
const DEFAULT_OBSERVATION_SCOPE = {
  emotional_state: 'transient',
  goal: 'situational',
  decision_record: 'situational',
  relationship_context: 'situational',
  behavior_observation: 'situational',
  inferred_motivation: 'situational',
};
const SCOPE_TTL_DAYS = { transient: 3, situational: 30, durable: null };

/** Scope is derived on read for legacy observations; nothing is written back. */
export function scopeOf(row) {
  if (row && OBSERVATION_SCOPES.includes(row.scope)) return row.scope;
  return DEFAULT_OBSERVATION_SCOPE[row?.type] || 'durable';
}

export function ttlDaysOf(row) {
  const scope = scopeOf(row);
  return scope === 'durable' ? null : SCOPE_TTL_DAYS[scope];
}

export function observationExpired(row, now = Date.now(), ttl = SCOPE_TTL_DAYS) {
  const scope = scopeOf(row);
  const days = scope === 'durable' ? null : ttl[scope] ?? SCOPE_TTL_DAYS[scope];
  if (days === null || days === undefined) return false;
  // Only independent corroboration or creation may renew TTL; editing links must not.
  const anchor = Number(row?.lastCorroboratedAt) || Number(row?.createdAt) || 0;
  return anchor > 0 && now - anchor > days * 86400000;
}

/**
 * Independent corroboration: a *different* session observing the same thing extends the
 * TTL and gives a bounded confidence boost. Same-session repeats are a no-op.
 */
export function applyCorroboration(row, sessionId, now = Date.now()) {
  if (!row || !sessionId) return false;
  const sessions = Array.isArray(row.sessions) ? row.sessions : [];
  if (sessions.includes(String(sessionId))) return false;
  row.sessions = [...sessions, String(sessionId)];
  row.lastCorroboratedAt = now;
  row.updatedAt = now;
  return true;
}

/** A corroborating quote must actually appear in this session's user messages. */
export function findQuoteInTexts(quote, texts) {
  const needle = String(quote || '').replace(/\s+/g, '');
  if (needle.length < 4) return false;
  return (Array.isArray(texts) ? texts : []).some(text => String(text || '').replace(/\s+/g, '').includes(needle));
}

/** Inferred confidence decays with age and gets a bounded boost from independent sessions. */
export function effectiveObservationConfidence(row, { now = Date.now(), halfLifeDays = 90 } = {}) {
  if (row?.kind !== 'inferred' || row.confidence === null || row.confidence === undefined) return null;
  const base = Math.max(0, Math.min(1, Number(row.confidence) || 0));
  // Rehearsal resets the forgetting curve: age from the last independent corroboration.
  const anchor = Number(row.lastCorroboratedAt) || Number(row.createdAt) || now;
  const ageDays = Math.max(0, (now - anchor) / 86400000);
  const decayed = base * 0.5 ** (ageDays / Math.max(1, halfLifeDays));
  const sessions = Array.isArray(row.sessions) ? new Set(row.sessions).size : 1;
  const boost = 0.1 * Math.min(2, Math.max(0, sessions - 1));
  return Math.max(0, Math.min(1, decayed + boost));
}
/** Disclosure policy: whether the assistant may raise this observation unprompted. */
export function mentionOf(row) {
  if (row && MENTION_VALUES.includes(row.mention)) return row.mention;
  if (row && row.sensitivity === 'private') return 'never';
  const scope = scopeOf(row);
  if (row && (row.sensitivity === 'sensitive'
    || scope === 'transient'
    || row.type === 'relationship_context'
    || row.type === 'emotional_state')) return 'if_asked';
  return 'proactive';
}

const REFLECT_DEFAULT = { minSessions: 3, jaccardMin: 0.5, maxProposals: 5 };

/**
 * Consolidation candidate builder: cluster current observations by content similarity and
 * only propose a pattern seen in >= minSessions *distinct* sessions. Drafts are `proposed`
 * and never injected; a human/model review accepts or rejects them.
 */
export function buildReflectProposals(rows, options = {}) {
  const { minSessions, jaccardMin, maxProposals } = { ...REFLECT_DEFAULT, ...options };
  const clusters = [];
  for (const row of rows) {
    if (!row || row.status !== 'current' || row.kind === 'corrected' || !row.text) continue;
    const tokens = new Set(tokensOf(row.text));
    let home = clusters.find(cluster => jaccard([...tokens], [...cluster.tokens]) >= jaccardMin);
    if (!home) {
      home = { tokens, rows: [] };
      clusters.push(home);
    }
    home.rows.push(row);
  }
  const proposals = [];
  for (const cluster of clusters) {
    const sessions = new Set(cluster.rows.flatMap(row => (Array.isArray(row.sessions) ? row.sessions : [])));
    if (sessions.size < minSessions) continue;
    const text = [...cluster.rows].sort((left, right) => right.text.length - left.text.length)[0].text;
    proposals.push({
      type: 'habit_pattern',
      kind: 'inferred',
      status: 'proposed',
      text,
      confidence: Number(Math.min(0.8, 0.2 + 0.1 * sessions.size).toFixed(2)),
      alternatives: ['只是同一段时间里的共同语境'],
      sourceIds: cluster.rows.map(row => row.id),
      sessions: [...sessions],
    });
  }
  return proposals.slice(0, maxProposals);
}

/** Cross-layer duplicate detection between portrait facets and observations. */
export function findCrossLayerDuplicates(portraitRows, observations, { jaccardMin = 0.6 } = {}) {
  const facets = portraitRows instanceof Map ? [...portraitRows.values()] : portraitRows;
  const pairs = [];
  for (const facet of facets) {
    if (!facet || !facet.content) continue;
    const facetTokens = new Set(tokensOf(facet.content));
    for (const row of observations) {
      if (!row || row.status !== 'current' || !row.text) continue;
      const similarity = jaccard([...facetTokens], [...new Set(tokensOf(row.text))]);
      if (similarity >= jaccardMin) pairs.push({ facet: facet.facet, observationId: row.id, similarity: Number(similarity.toFixed(2)) });
    }
  }
  return pairs;
}

function traitPattern(locale = 'zh') {
  const words = packFor(locale).traitWords || [];
  if (!words.length) return null;
  return new RegExp('(' + words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\const TRAIT_LABEL_PATTERN = /(懒惰|内向|固执|敏感|焦虑|抑郁|自恋|社恐|讨好型|完美主义|强迫|回避型|依赖型|玻璃心|脾气差|人格|性格)/;')).join('|') + ')', 'i');
}
const TRAIT_CONTEXT_HINT = /(当时|因为|情境|场景|那次|反复|跨情境|context)/;
/** Trait adjectives are fine only with real evidence or an explicit situation; length is not an excuse. */
export function lintTraitLabel(text, knownSourceIds = [], locale = 'zh') {
  const value = String(text || '');
  const pattern = traitPattern(locale);
  if (!pattern || !pattern.test(value)) return null;
  if (Array.isArray(knownSourceIds) && knownSourceIds.some(id => typeof id === 'string' && id)) return null;
  if (TRAIT_CONTEXT_HINT.test(value)) return null;
  return '这更像人格标签而不是证据：建议记录“具体行为 + 当时情境 + 至少一个替代解释”，或改用 observe epistemic=inferred 并附 context/alternatives；用户本人纠正过的内容应优先。';
}
const SELF_LABELS = {
  habits: '助手习惯',
  preferences: '助手喜好',
  psychology: '工作方式',
  experience: '可核对经验',
};
const ASSISTANT_TARGET = 'assistant';
const USER_TARGET = 'user';

const DOMAIN_SPEC = {
  name: 'dynamic_memory',
  version: 1,
  layout: 'per-record',
  tables: {
    exchanges: {
      valueSchema: {
        parse(value) {
          if (value === null || typeof value !== 'object') throw new Error('dynamic-memory exchange must be an object');
          for (const field of ['id', 'sessionId', 'user', 'assistant', 'summary']) {
            if (typeof value[field] !== 'string') throw new Error(`dynamic-memory exchange field "${field}" must be a string`);
          }
          if (typeof value.time !== 'number' || !Number.isFinite(value.time)) throw new Error('dynamic-memory exchange field "time" must be a finite number');
          if (!Array.isArray(value.keywords) || value.keywords.some(keyword => typeof keyword !== 'string')) throw new Error('dynamic-memory exchange field "keywords" must be a string array');
          const history = Array.isArray(value.history)
            ? value.history
              .filter(entry => entry && typeof entry.summary === 'string' && typeof entry.at === 'number')
              .slice(-HISTORY_LIMIT)
            : [];
          return {
            ...value,
            updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : value.time,
            kind: KINDS.includes(value.kind) ? value.kind : 'episodic',
            workspace: typeof value.workspace === 'string' ? value.workspace : null,
            entities: Array.isArray(value.entities) ? value.entities.filter(entity => typeof entity === 'string').slice(0, MAX_ENTITIES) : [],
            importance: typeof value.importance === 'number' && Number.isFinite(value.importance)
              ? Math.max(0, Math.min(1, value.importance))
              : DEFAULT_IMPORTANCE,
            accessCount: Number.isFinite(value.accessCount) ? value.accessCount : 0,
            lastAccessAt: Number.isFinite(value.lastAccessAt) ? value.lastAccessAt : null,
            supersededBy: typeof value.supersededBy === 'string' ? value.supersededBy : null,
            archivedAt: Number.isFinite(value.archivedAt) ? value.archivedAt : null,
            archivedReason: typeof value.archivedReason === 'string' ? value.archivedReason : null,
            weight: Number.isFinite(value.weight) ? Math.max(0, Math.min(1, value.weight)) : 1,
            history,
            sourceIds: Array.isArray(value.sourceIds) ? value.sourceIds.filter(id => typeof id === 'string') : [],
          };
        },
      },
    },
    portrait: {
      valueSchema: {
        parse(value) {
          if (value === null || typeof value !== 'object') throw new Error('dynamic-memory portrait must be an object');
          if (typeof value.facet !== 'string' || !value.facet.trim()) throw new Error('dynamic-memory portrait field "facet" must be a non-empty string');
          if (typeof value.content !== 'string') throw new Error('dynamic-memory portrait field "content" must be a string');
          if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) throw new Error('dynamic-memory portrait field "updatedAt" must be a finite number');
          if (!Array.isArray(value.keywords) || value.keywords.some(keyword => typeof keyword !== 'string')) throw new Error('dynamic-memory portrait field "keywords" must be a string array');
          const history = Array.isArray(value.history)
            ? value.history
              .filter(entry => entry && typeof entry.content === 'string' && typeof entry.at === 'number')
              .slice(-HISTORY_LIMIT)
            : [];
          return {
            ...value,
            history,
            sourceExchangeIds: Array.isArray(value.sourceExchangeIds) ? value.sourceExchangeIds.filter(id => typeof id === 'string') : [],
            sourceObservationIds: Array.isArray(value.sourceObservationIds) ? value.sourceObservationIds.filter(id => typeof id === 'string') : [],
            needsRecompute: value.needsRecompute === true,
          };
        },
      },
    },
    self: {
      valueSchema: {
        parse(value) {
          if (value === null || typeof value !== 'object') throw new Error('dynamic-memory self portrait must be an object');
          if (typeof value.facet !== 'string' || !value.facet.trim()) throw new Error('dynamic-memory self portrait field "facet" must be a non-empty string');
          if (typeof value.content !== 'string') throw new Error('dynamic-memory self portrait field "content" must be a string');
          if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) throw new Error('dynamic-memory self portrait field "updatedAt" must be a finite number');
          if (!Array.isArray(value.keywords) || value.keywords.some(keyword => typeof keyword !== 'string')) throw new Error('dynamic-memory self portrait field "keywords" must be a string array');
          const history = Array.isArray(value.history)
            ? value.history
              .filter(entry => entry && typeof entry.content === 'string' && typeof entry.at === 'number')
              .slice(-HISTORY_LIMIT)
            : [];
          return {
            ...value,
            history,
            sourceExchangeIds: Array.isArray(value.sourceExchangeIds) ? value.sourceExchangeIds.filter(id => typeof id === 'string') : [],
            sourceObservationIds: Array.isArray(value.sourceObservationIds) ? value.sourceObservationIds.filter(id => typeof id === 'string') : [],
            needsRecompute: value.needsRecompute === true,
          };
        },
      },
    },
    observations: {
      valueSchema: {
        parse(value) {
          if (value === null || typeof value !== 'object') throw new Error('dynamic-memory observation must be an object');
          if (typeof value.id !== 'string' || typeof value.text !== 'string') throw new Error('dynamic-memory observation needs id and text');
          if (!OBSERVATION_TYPES.includes(value.type)) throw new Error(`dynamic-memory observation type must be one of ${OBSERVATION_TYPES.join(', ')}`);
          if (!OBSERVATION_KINDS.includes(value.kind)) throw new Error(`dynamic-memory observation kind must be one of ${OBSERVATION_KINDS.join(', ')}`);
          const status = OBSERVATION_STATUS.includes(value.status) ? value.status : 'current';
          return {
            ...value,
            status,
            confidence: typeof value.confidence === 'number' && Number.isFinite(value.confidence)
              ? Math.max(0, Math.min(1, value.confidence))
              : null,
            context: typeof value.context === 'string' ? value.context : null,
            quote: typeof value.quote === 'string' ? value.quote : null,
            alternatives: Array.isArray(value.alternatives) ? value.alternatives.filter(entry => typeof entry === 'string') : [],
            sourceIds: Array.isArray(value.sourceIds) ? value.sourceIds.filter(entry => typeof entry === 'string') : [],
            contradicts: Array.isArray(value.contradicts) ? value.contradicts.filter(entry => typeof entry === 'string') : [],
            conditionalContradicts: Array.isArray(value.conditionalContradicts) ? value.conditionalContradicts.filter(entry => typeof entry === 'string') : [],
            sessions: Array.isArray(value.sessions) ? value.sessions.filter(entry => typeof entry === 'string') : [],
            lastCorroboratedAt: Number.isFinite(value.lastCorroboratedAt) ? value.lastCorroboratedAt : undefined,
            scope: OBSERVATION_SCOPES.includes(value.scope) ? value.scope : undefined,
            mention: MENTION_VALUES.includes(value.mention) ? value.mention : undefined,
            correctionOf: typeof value.correctionOf === 'string' ? value.correctionOf : null,
            sensitivity: ['normal', 'sensitive', 'private'].includes(value.sensitivity) ? value.sensitivity : 'normal',
            createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
            updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
          };
        },
      },
    },
  },
};

const TOOL = {
  name: 'dynamic_memory',
  description: 'Cross-session memory: search/recent/entities (retrieval), deepen/learn/portrait (write/read), observe/correct/observations/contradict (evidence layer), identity (continuity evidence), reflect/review/recompute/duplicates, archive/restore/export/stats/index/repair/forget. search returns compact snippets with confidence; use full=true to quote. Details in README.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['recent', 'search', 'deepen', 'forget', 'portrait', 'learn', 'stats', 'entities', 'export', 'index', 'repair', 'archive', 'restore', 'identity', 'observe', 'correct', 'observations', 'contradict', 'reflect', 'review', 'recompute', 'duplicates'] },
      query: { type: 'string', description: 'Search keywords; several words are scored together.' },
      id: { type: 'string', description: 'Exchange id from a recent or search result.' },
      summary: { type: 'string', description: 'Concise impression: what the user wanted, what was done, the reply, and durable details.' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Extra keywords to index under.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results; defaults to 3 for recent, 10 for search.' },
      allSessions: { type: 'boolean', description: 'For recent: include earlier sessions.' },
      facet: { type: 'string', enum: [...new Set([...FACETS, ...SELF_FACETS])], description: 'User facets: habits, preferences, thinking, dynamics, psychology, past, identity. Assistant facets (target=assistant): habits, preferences, psychology (=工作方式), experience (=可核对经验).' },
      target: { type: 'string', enum: [USER_TARGET, ASSISTANT_TARGET], description: 'For portrait/learn/forget: whose portrait, user (default) or assistant (this agent).' },
      content: { type: 'string', description: 'For learn: complete consolidated text of that facet, replacing the previous text.' },
      from: { type: 'string', description: 'Search lower time bound, ISO date or epoch ms.' },
      to: { type: 'string', description: 'Search upper time bound, ISO date or epoch ms.' },
      sort: { type: 'string', enum: ['relevance', 'recent', 'oldest'], description: 'Search order; defaults to relevance, or recent for "latest/最近" queries.' },
      includeHistory: { type: 'boolean', description: 'For portrait: include previous versions.' },
      sourceIds: { type: 'array', items: { type: 'string' }, description: 'For learn/observe: exchange ids this conclusion came from.' },
      sourceObservationIds: { type: 'array', items: { type: 'string' }, description: 'For learn: observation ids the facet was summarized from; correcting/deleting one marks the facet for recompute.' },
      kind: { type: 'string', enum: KINDS, description: 'Search layer filter.' },
      scope: { type: 'string', enum: ['workspace', 'all'], description: 'Search scope; default workspace.' },
      includeSuperseded: { type: 'boolean', description: 'Search: also rank exchanges superseded by a re-ask.' },
      includeArchived: { type: 'boolean', description: 'Search: also rank archived exchanges (old memories kept as low-weight reference).' },
      ids: { type: 'array', items: { type: 'string' }, description: 'For archive/restore: specific exchange ids.' },
      olderThanDays: { type: 'integer', minimum: 0, maximum: 36500, description: 'For archive: move exchanges idle for at least this many days.' },
      entity: { type: 'string', description: 'For entities: list this entity\'s related exchanges.' },
      observationType: { type: 'string', enum: OBSERVATION_TYPES, description: 'For observe/observations: memory type (explicit_fact, explicit_preference, behavior_observation, self_reflection, inferred_motivation, emotional_state, decision_record, relationship_context, habit_pattern, contradiction, goal, constraint, correction).' },
      epistemic: { type: 'string', enum: OBSERVATION_KINDS, description: 'For observe: observed (direct behavior/quote), self_reported (user explains themselves), inferred (hypothesis, needs confidence + alternatives), corrected.' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'For inferred observations: rough confidence, not a calibrated probability.' },
      context: { type: 'string', description: 'For observe: the situation (time, environment, constraints) that makes the observation interpretable.' },
      alternatives: { type: 'array', items: { type: 'string' }, description: 'For inferred observations: at least one alternative explanation.' },
      quote: { type: 'string', description: 'For observe: the user\'s exact words when the observation came from a direct quote. Required for corroborates: it must appear in this session\'s user messages (>=4 chars).' },
      sensitivity: { type: 'string', enum: ['normal', 'sensitive', 'private'], description: 'For observe: how sensitive this observation is; private ones are minimized in injection.' },
      status: { type: 'string', enum: OBSERVATION_STATUS, description: 'For observations: filter by status (current/withdrawn/superseded).' },
      observationScope: { type: 'string', enum: OBSERVATION_SCOPES, description: 'For observe: transient (emotional state, ~3d), situational (goal/decision/behavior/inference, ~30d) or durable (facts/preferences/constraints). Defaults derive from type; TTL only stops injection, it never deletes.' },
      includePrivate: { type: 'boolean', description: 'For observations: reveal private observation text. Defaults to masked.' },
      mention: { type: 'string', enum: MENTION_VALUES, description: 'For observe: proactive (may raise it), if_asked (tone only, never bring it up; default for sensitive/transient/emotional), never (not injected; listable only).' },
      conditional: { type: 'boolean', description: 'For contradict: mark the pair as situationally conflicting (different contexts), so it is not counted as an unresolved contradiction.' },
      decision: { type: 'string', enum: ['accept', 'reject'], description: 'For review: accept a proposed observation (becomes current) or reject it (withdrawn).' },
      corroborates: { type: 'string', description: 'For observe: id of an existing observation independently observed by another session. Requires a verifiable quote from the current user message; same session is a no-op.' },
      full: { type: 'boolean', description: 'Search/recent: return complete user and assistant paragraphs instead of snippets.' },
      snippetChars: { type: 'integer', minimum: 80, maximum: 4000, description: 'Snippet length for compact results.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render(_args, value) {
      return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
    },
  },
};

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
    .slice(0, MAX_TEXT);
}

const META_MARKERS = [
  /Current runtime context\./i,
  /^Time sampled while preparing turn/m,
  /^Browser time zone for this request/m,
  /^Elapsed since/m,
  /^You are an AI agent powered by/m,
  /^You are the Team Lead named/m,
  /^## 用户画像（参考）/m,
  /^## 动态记忆（最近印象）/m,
  /^## 记忆速览/m,
];

export function cleanUserText(text) {
  let out = String(text || '');
  for (const marker of META_MARKERS) {
    const index = out.search(marker);
    if (index >= 0) out = out.slice(0, index);
  }
  return out.trim();
}

function tokensOf(...values) {
  const found = [];
  for (const value of values) {
    const text = String(value || '');
    for (const match of text.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) found.push(match[0]);
    for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
      if (run.length <= 2) found.push(run);
      else for (let index = 0; index + 2 <= run.length; index += 1) found.push(run.slice(index, index + 2));
    }
    // Crude but language-neutral fallback for Arabic/Cyrillic/Thai/etc. word scripts,
    // so retrieval does not silently return nothing outside zh/en.
    for (const run of text.match(/[\u0370-\u03ff\u0400-\u04ff\u0590-\u06ff\u0e00-\u0eff\u0900-\u097f]+/g) || []) {
      if (run.length >= 2) found.push(run.toLowerCase());
    }
  }
  return found;
}

function keywordsOf(...values) {
  return [...new Set(tokensOf(...values))].slice(0, MAX_KEYWORDS);
}

const ENTITY_STOPWORDS = new Set([
  ...(PACKS.en?.entityStopwords || []),
  ...(PACKS.zh?.entityStopwords || []),
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'http', 'https', 'www', 'com',
  'tostring', 'constructor', 'undefined', 'object',
]);

/** Extract stable named references: hosts, paths, kebab/snake/dotted identifiers, CamelCase and acronyms. */
export function entitiesOf(...values) {
  const found = new Set();
  for (const value of values) {
    const text = String(value || '');
    for (const match of text.matchAll(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s"'`)]*)?/gi)) {
      const host = match[0].replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
      if (host.includes('.') && host.length >= 5) found.add(host);
    }
    for (const match of text.matchAll(/[a-z]:\\[^\s"'`<>]+/gi)) found.add(match[0].toLowerCase());
    for (const match of text.matchAll(/\b[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+\b/gi)) found.add(match[0].toLowerCase());
    for (const match of text.matchAll(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) found.add(match[0].toLowerCase());
    for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]{2,}\b/g)) {
      const token = match[0].toLowerCase();
      if (token.length >= 3) found.add(token);
    }
    for (const match of text.matchAll(/\b[A-Z]{2,6}\b/g)) found.add(match[0].toLowerCase());
    // Quoted names work across languages: “项目名”, 「组件名」, 《文档》
    for (const match of text.matchAll(/[「『《“"]([^」』》”"\n]{2,20})[」』》”"]/g)) {
      const name = match[1].trim().toLowerCase();
      if (name.length >= 2) found.add(name);
    }
  }
  return [...found]
    .filter(entity => entity.length >= 3 && !ENTITY_STOPWORDS.has(entity))
    .slice(0, MAX_ENTITIES);
}

export function buildEntityIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    for (const entity of rowEntities(row)) {
      let set = index.get(entity);
      if (!set) {
        set = new Set();
        index.set(entity, set);
      }
      set.add(row);
    }
  }
  return index;
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function uuid() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function recordKey(id) {
  return `r_${id}`;
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（完整原文请用 dynamic_memory search 查询）`;
}

/** Best-effort evidence excerpt: centered on the first query token, never the whole document. */
export function snippetOf(text, terms, limit) {
  const source = String(text || '');
  if (!source) return '';
  if (source.length <= limit) return source;
  const lowered = source.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    if (term.length < 2) continue;
    const index = lowered.indexOf(term);
    if (index >= 0 && (hit < 0 || index < hit)) hit = index;
  }
  if (hit < 0) return `${source.slice(0, limit)}…`;
  let start = Math.max(0, Math.min(hit - Math.floor(limit / 3), source.length - limit));
  let end = Math.min(source.length, start + limit);
  // Prefer whole sentences: move the edges to the nearest boundary within a small padding.
  const pad = Math.floor(limit / 4);
  const before = source.slice(Math.max(0, start - pad), start).search(/[。！？!?;\n][^。！？!?;\n]*$/);
  if (before >= 0) start = Math.max(0, start - pad + before + 1);
  const afterIndex = source.slice(end, Math.min(source.length, end + pad)).search(/[。！？!?;\n]/);
  if (afterIndex >= 0) end = Math.min(source.length, end + afterIndex + 1);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

function toTimestamp(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

const tokenCache = new WeakMap();
function rowTokens(row) {
  let tokens = tokenCache.get(row);
  if (!tokens) {
    tokens = tokensOf(cleanUserText(row.user), row.assistant, row.summary, row.keywords.join(' '));
    tokenCache.set(row, tokens);
  }
  return tokens;
}
const entityCache = new WeakMap();
function rowEntities(row) {
  let entities = entityCache.get(row);
  if (!entities) {
    entities = Array.isArray(row.entities) && row.entities.length ? row.entities : entitiesOf(cleanUserText(row.user), row.assistant, row.summary);
    entityCache.set(row, entities);
  }
  return entities;
}

// Per-row token statistics reused across searches; invalidated whenever a row's text changes.
const docCache = new WeakMap();
function docOf(row) {
  let doc = docCache.get(row);
  if (!doc) {
    const tokens = rowTokens(row);
    const freq = new Map();
    for (const token of tokens) freq.set(token, (freq.get(token) || 0) + 1);
    doc = { freq, length: Math.max(1, tokens.length), tokenSet: new Set(tokens) };
    docCache.set(row, doc);
  }
  return doc;
}
function invalidateRow(row) {
  tokenCache.delete(row);
  docCache.delete(row);
  entityCache.delete(row);
}
function haystackOf(row) {
  const doc = docOf(row);
  if (doc.haystack === undefined) doc.haystack = `${cleanUserText(row.user)}\n${row.assistant}`.toLowerCase().replace(/\s+/g, '');
  return doc.haystack;
}

export function confidenceFromScores(values, coverage = 1) {
  const scores = [...values].sort((left, right) => right - left);
  if (!scores.length) return { score: 0, label: 'none', margin: 0, separation: 0, coverage: 0 };
  const best = scores[0];
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
  const deviation = Math.sqrt(variance);
  const spread = deviation > 1e-6 ? (best - mean) / deviation : (scores.length === 1 ? 2 : 0);
  const separation = Math.max(0, Math.min(1, spread / 2));
  const absolute = best / (best + 4);
  const runnerUp = scores[1] || 0;
  const margin = scores.length > 1 ? (best - runnerUp) / Math.max(1e-6, best) : 1;
  const blended = Math.max(0, Math.min(1, 0.3 * absolute + 0.35 * margin + 0.35 * separation));
  // Low query coverage means the top hit is probably accidental; push confidence down.
  const coverageFactor = Math.min(1, Math.max(0, coverage) / 0.6);
  const adjusted = blended * coverageFactor;
  // A high/medium claim also requires that at least half the query's IDF mass matched.
  const enoughCoverage = coverage >= 0.5;
  const label = adjusted >= 0.62 && enoughCoverage ? 'high' : adjusted >= 0.38 && enoughCoverage ? 'medium' : 'low';
  return {
    score: Number(adjusted.toFixed(2)),
    label,
    margin: Number(margin.toFixed(2)),
    separation: Number(separation.toFixed(2)),
    coverage: Number(Math.max(0, Math.min(1, coverage)).toFixed(2)),
  };
}

/**
 * Pure ranking function; also used by the offline evaluation script.
 * Options: query, from, to, sort, limit, kind, workspace, scope, now, timeBoost,
 * decayDays, phraseWeight, impressionWeight, entityWeight, importanceWeight,
 * includeSuperseded, entityIndex, touch.
 */
export function rankExchanges(rows, options = {}) {
  const query = String(options.query || '').trim();
  const terms = [...new Set(tokensOf(query))];
  const sortRequested = ['relevance', 'recent', 'oldest'].includes(options.sort) ? options.sort : undefined;
  const wantsLatest = /最近|刚刚|刚才|上次|上一次|latest|recent|last time/i.test(query);
  const sort = sortRequested || (wantsLatest ? 'recent' : 'relevance');
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const timeBoost = Number.isFinite(options.timeBoost) ? options.timeBoost : 0.4;
  const decayDays = Number.isFinite(options.decayDays) ? options.decayDays : 180;
  const phraseWeight = Number.isFinite(options.phraseWeight) ? options.phraseWeight : 3;
  const impressionWeight = Number.isFinite(options.impressionWeight) ? options.impressionWeight : 0.05;
  const entityWeight = Number.isFinite(options.entityWeight) ? options.entityWeight : 0.9;
  const importanceWeight = Number.isFinite(options.importanceWeight) ? options.importanceWeight : 0.4;
  const includeSuperseded = options.includeSuperseded === true;
  const includeArchived = options.includeArchived === true;
  const archivedWeight = Number.isFinite(options.archivedWeight) ? options.archivedWeight : DEFAULT_ARCHIVED_WEIGHT;
  const from = toTimestamp(options.from);
  const to = toTimestamp(options.to);

  const candidates = rows.filter(row => {
    if (!String(row.user || '').trim() && !String(row.assistant || '').trim()) return false;
    if (options.kind && row.kind !== options.kind) return false;
    if (row.archivedAt && !includeArchived) return false;
    if (options.workspace && options.scope !== 'all' && row.workspace && row.workspace !== options.workspace) return false;
    if (from !== undefined && row.time < from) return false;
    if (to !== undefined && row.time > to) return false;
    return true;
  });

  const empty = { matches: [], total: 0, sort, searchedTerms: terms.slice(0, 24), timeWindow: { from: from ?? null, to: to ?? null } };
  if (!candidates.length) return empty;

  const queryEntities = new Set(entitiesOf(query));
  const entityIndex = options.entityIndex || buildEntityIndex(candidates);

  const docs = candidates.map(row => {
    const doc = docOf(row);
    return { row, freq: doc.freq, length: doc.length, tokenSet: doc.tokenSet };
  });
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
  const documentFrequency = new Map();
  for (const term of terms) {
    let count = 0;
    for (const doc of docs) if (doc.tokenSet.has(term)) count += 1;
    documentFrequency.set(term, count);
  }
  const total = docs.length;
  const idfOf = term => {
    const df = documentFrequency.get(term) || 0;
    return Math.log(1 + (total - df + 0.5) / (df + 0.5));
  };
  // Upper bound a perfect match could reach: every query term saturated (k1+1=2.2).
  // Using this instead of "max score seen" keeps absolute match quality, so a query
  // that only shares one common bigram cannot look like a strong hit (K2).
  const maxPossible = terms.reduce((sum, term) => sum + idfOf(term) * 2.2, 0) || 1;
  const totalIdf = terms.reduce((sum, term) => sum + idfOf(term), 0);
  const avgIdf = terms.length ? totalIdf / terms.length : 1;
  const totalUnits = totalIdf + queryEntities.size * avgIdf;
const phrase = query.toLowerCase().replace(/\s+/g, '');
const timeIntent = wantsLatest || /(当时|以前|去年|上周|上个月|那天|之前|过去|\d{4}[-/年])/i.test(query);
const recencyWeight = timeIntent ? 1 : 0.3;

  const scored = [];
  for (const doc of docs) {
    const { row } = doc;
    let bm25 = 0;
    let matched = 0;
    for (const term of terms) {
      const freq = doc.freq.get(term) || 0;
      if (!freq) continue;
      matched += 1;
      const norm = 1.2 * (1 - 0.75 + 0.75 * (doc.length / avgLength));
      bm25 += idfOf(term) * ((freq * 2.2) / (freq + norm));
    }
    const matchedEntities = rowEntities(row).filter(entity => queryEntities.has(entity));
    const entityHit = Math.min(3, matchedEntities.length);
    if (!matched && !entityHit) continue;
    const bm25n = (2.5 * bm25) / maxPossible;
    const matchedIdf = terms.reduce((sum, term) => sum + (doc.freq.get(term) ? idfOf(term) : 0), 0);
    // IDF-weighted coverage: sharing only common bigrams ("所有", "练习") does not count as
    // knowing what the query is about, so weak matches keep a low confidence.
    const coverage = totalUnits
      ? Math.min(1, (matchedIdf + new Set(matchedEntities).size * avgIdf) / totalUnits)
      : 0;
    const haystack = haystackOf(row);
    const phraseHit = phrase.length >= 2 && haystack.includes(phrase) ? 1 : 0;
    const impressionHit = terms.reduce((sum, term) => sum + ((row.summary || '').toLowerCase().includes(term) ? 1 : 0), 0);
    const reasons = [];
    if (phraseHit) reasons.push('phrase');
    if (impressionHit) reasons.push('impression');
    for (const entity of matchedEntities.slice(0, 2)) reasons.push(`entity:${entity}`);
    if (bm25 > 0) reasons.push('bm25');
    if (row.archivedAt) reasons.push('archived');
    const ageDays = Math.max(0, (now - row.time) / 86400000);
    const recency = timeBoost * Math.exp(-ageDays / decayDays);
    const importance = Math.max(0, Math.min(1, Number(row.importance) || DEFAULT_IMPORTANCE));
    // Importance decays when the memory has not been touched for a long time;
    // retrieval no longer raises it (see touch below), so no self-reinforcing loop.
    const lastSeen = Math.max(Number(row.lastAccessAt) || 0, Number(row.updatedAt) || 0, Number(row.time) || 0);
    const idleDays = Math.max(0, (now - lastSeen) / 86400000);
    const effectiveImportance = importance * Math.exp(-idleDays / (decayDays * 2));
    const supersededFactor = row.supersededBy && !includeSuperseded ? 0.5 : 1;
    const archivedFactor = row.archivedAt ? (Number.isFinite(row.weight) ? row.weight : archivedWeight) : 1;
    scored.push({
      row,
      bm25,
      bm25n,
      coverage,
      phraseHit,
      impressionHit,
      entityHit,
      recency,
      reasons,
      signals: {
        bm25: Number(bm25.toFixed(3)),
        phrase: phraseHit,
        impression: impressionHit,
        entity: entityHit,
        recency: Number(recency.toFixed(3)),
        coverage: Number(coverage.toFixed(2)),
        importance: Number(effectiveImportance.toFixed(2)),
      },
      matchedEntities,
      supersededFactor,
      archivedFactor,
      effectiveImportance,
    });
  }

  for (const item of scored) {
    const base = item.bm25n
      + item.phraseHit * phraseWeight
      + Math.min(4, item.impressionHit) * impressionWeight
      + item.entityHit * entityWeight
      + item.recency * recencyWeight;
    item.score = base * (1 + importanceWeight * item.effectiveImportance) * item.supersededFactor * item.archivedFactor;
  }

  // Confidence is computed on the score order, before any time-based display sort.
  const byScore = [...scored].sort((left, right) => right.score - left.score || right.row.time - left.row.time);
  const topCoverage = byScore[0]?.coverage ?? 1;
  const confidence = confidenceFromScores(byScore.map(item => item.score), topCoverage);

  if (sort === 'recent') scored.sort((left, right) => right.row.time - left.row.time || right.score - left.score);
  else if (sort === 'oldest') scored.sort((left, right) => left.row.time - right.row.time || right.score - left.score);
  else scored.sort((left, right) => right.score - left.score || right.row.time - left.row.time);

  const top = scored.slice(0, limit);
  if (options.touch) {
    const touchedAt = Date.now();
    for (const item of top) {
      // Access is recorded for retrieval statistics only; importance is raised by
      // deepen/correction, not by being searched repeatedly.
      item.row.accessCount = (item.row.accessCount || 0) + 1;
      item.row.lastAccessAt = touchedAt;
    }
  }

  return {
    matches: top.map(({ row, score, signals, matchedEntities, reasons, coverage }) => ({
      id: row.id,
      sessionId: row.sessionId,
      workspace: row.workspace || null,
      kind: row.kind || 'episodic',
      time: new Date(row.time).toISOString(),
      score: Number(score.toFixed(3)),
      coverage: Number(coverage.toFixed(2)),
      signals,
      reasons,
      entities: matchedEntities.slice(0, 6),
      user: cleanUserText(row.user),
      userMissing: !cleanUserText(row.user),
      assistant: row.assistant,
      summary: row.summary,
      importance: Number((Number(row.importance) || DEFAULT_IMPORTANCE).toFixed(2)),
      supersededBy: row.supersededBy || null,
      archived: Boolean(row.archivedAt),
      archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
      impressionHistory: (row.history || []).map(entry => new Date(entry.at).toISOString()),
    })),
    confidence,
    total: scored.length,
    sort,
    searchedTerms: terms.slice(0, 24),
    timeWindow: { from: from ?? null, to: to ?? null },
  };
}

export function isReAsk(previousUser, previousAssistant, user, assistant) {
  const userSimilarity = jaccard([...new Set(tokensOf(user))], [...new Set(tokensOf(cleanUserText(previousUser)))]);
  if (userSimilarity < 0.8) return false;
  const assistantSimilarity = jaccard([...new Set(tokensOf(assistant))], [...new Set(tokensOf(previousAssistant))]);
  return assistantSimilarity < 0.6;
}

/** How long the whole memory store has been idle, used to detect a long gap. */
export function computeGapState(rows, now = Date.now()) {
  let lastActivityAt = null;
  for (const row of rows) {
    if (row.archivedAt) continue;
    if (typeof row.time === 'number' && (lastActivityAt === null || row.time > lastActivityAt)) lastActivityAt = row.time;
  }
  if (lastActivityAt === null) return { lastActivityAt: null, gapDays: null };
  return { lastActivityAt, gapDays: Math.max(0, (now - lastActivityAt) / 86400000) };
}

/** A portrait facet is stale when it has not been revised for longer than freshDays. */
export function isStale(updatedAt, now = Date.now(), freshDays = DEFAULT_FRESH_DAYS) {
  if (!Number.isFinite(updatedAt)) return false;
  return now - updatedAt > freshDays * 86400000;
}

/**
 * Decide which rows to move into the archive (回收区): idle for at least `olderThanDays`.
 * Archived rows keep a low weight and are excluded from default retrieval and injection.
 */
export function selectForArchive(rows, { now = Date.now(), olderThanDays = DEFAULT_ARCHIVE_AFTER_DAYS, ids = [] } = {}) {
  const idSet = new Set(ids);
  const cutoff = now - olderThanDays * 86400000;
  return rows.filter(row => {
    if (row.archivedAt) return false;
    if (idSet.size) return idSet.has(row.id);
    return typeof row.time === 'number' && row.time <= cutoff;
  });
}

/** Cues that a speaker may not be the person the portrait was built from. Evidence only, never a verdict. */
export function selfDeclarationCues(text, locale = 'zh') {
  const source = String(text || '');
  return (packFor(locale).selfDeclarationPatterns || [])
    .map(pattern => {
      try {
        return source.match(new RegExp(pattern, 'i'))?.[0];
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

/** Cheap style fingerprint of one user message, used to compare speakers without any hardcoded identity rules. */
export function styleOf(text) {
  const source = String(text || '');
  const length = source.length;
  const cjk = (source.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  const punctuation = (source.match(/[，。！？、；：,.!?;:]/g) || []).length;
  const emoji = (source.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
  const question = (source.match(/[？?]/g) || []).length;
  const exclaim = (source.match(/[！!]/g) || []).length;
  return {
    length,
    cjkRatio: length ? cjk / length : 0,
    latinRatio: length ? latin / length : 0,
    punctuationRate: length ? punctuation / length : 0,
    emojiRate: length ? emoji / length : 0,
    questionRate: length ? question / length : 0,
    exclaimRate: length ? exclaim / length : 0,
  };
}

const STYLE_FIELDS = ['cjkRatio', 'latinRatio', 'punctuationRate', 'emojiRate', 'questionRate', 'exclaimRate'];
function styleSimilarity(left, right) {
  let distance = 0;
  for (const field of STYLE_FIELDS) distance += Math.abs((left?.[field] || 0) - (right?.[field] || 0));
  return Math.max(0, 1 - distance / STYLE_FIELDS.length);
}

export function averageStyle(styles) {
  if (!styles.length) return null;
  const average = {};
  for (const field of STYLE_FIELDS) average[field] = styles.reduce((sum, style) => sum + (style[field] || 0), 0) / styles.length;
  average.length = styles.reduce((sum, style) => sum + (style.length || 0), 0) / styles.length;
  return average;
}

/**
 * Build a speaker baseline from user messages of other sessions: top tokens, entities and average style.
 * This is knowledge distilled from memory, not a hardcoded user model.
 */
export function buildSpeakerBaseline(rows, { excludeSessionId } = {}) {
  const texts = [];
  const entityCounts = new Map();
  for (const row of rows) {
    if (row.archivedAt) continue;
    if (excludeSessionId && String(row.sessionId) === String(excludeSessionId)) continue;
    const user = cleanUserText(row.user);
    if (!user) continue;
    texts.push(user);
    for (const entity of rowEntities(row)) entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
  }
  const messages = texts.length;
  if (!messages) return { messages: 0, tokens: new Set(), entities: new Set(), style: null };
  const frequency = new Map();
  for (const text of texts) for (const token of tokensOf(text)) frequency.set(token, (frequency.get(token) || 0) + 1);
  const tokens = new Set([...frequency.entries()].sort((left, right) => right[1] - left[1]).slice(0, 300).map(([token]) => token));
  const entities = new Set([...entityCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 80).map(([entity]) => entity));
  return { messages, tokens, entities, style: averageStyle(texts.map(styleOf)) };
}

/**
 * Evidence-based continuity report between the current speaker and the stored baseline.
 * The caller (the model) decides what it means; the plugin only measures.
 */
export function speakerContinuity(currentTexts, baseline, { gapDays } = {}) {
  const texts = currentTexts.filter(text => String(text || '').trim());
  const declarations = texts.flatMap(selfDeclarationCues);
  if (!baseline || !baseline.messages || texts.length < 2) {
    return {
      score: null,
      label: 'insufficient',
      evidence: {
        currentMessages: texts.length,
        baselineMessages: baseline?.messages || 0,
        selfDeclarations: [...new Set(declarations)],
        gapDays: gapDays ?? null,
      },
    };
  }
  const currentTokens = new Set(tokensOf(...texts));
  let vocabHits = 0;
  for (const token of currentTokens) if (baseline.tokens.has(token)) vocabHits += 1;
  const vocabOverlap = currentTokens.size ? vocabHits / currentTokens.size : 0;
  const currentEntities = new Set(entitiesOf(...texts));
  let entityHits = 0;
  for (const entity of currentEntities) if (baseline.entities.has(entity)) entityHits += 1;
  const entityOverlap = currentEntities.size ? entityHits / currentEntities.size : 0;
  const style = averageStyle(texts.map(styleOf));
  const styleSimilarityScore = style && baseline.style ? styleSimilarity(style, baseline.style) : 0;
  const score = 0.45 * vocabOverlap + 0.2 * entityOverlap + 0.35 * styleSimilarityScore;
  const label = score >= 0.55 ? 'likely-same' : score >= 0.35 ? 'uncertain' : 'drifted';
  return {
    score: Number(score.toFixed(2)),
    label,
    evidence: {
      vocabOverlap: Number(vocabOverlap.toFixed(2)),
      entityOverlap: Number(entityOverlap.toFixed(2)),
      styleSimilarity: Number(styleSimilarityScore.toFixed(2)),
      currentMessages: texts.length,
      baselineMessages: baseline.messages,
      selfDeclarations: [...new Set(declarations)],
      gapDays: gapDays ?? null,
    },
  };
}

const RESIDENT_FACETS = new Set(['preferences', 'habits', 'thinking', 'identity']);
const RESIDENT_OBSERVATION_TYPES = new Set(['explicit_preference', 'habit_pattern', 'constraint', 'correction']);
const CUE_ONLY_TYPES = new Set(['emotional_state', 'relationship_context']);

/**
 * Count shared *words* (not overlapping bigrams): a 3+ character shared Chinese word
 * counts once, like a 2-character one. This keeps the cue rule consistent.
 */
export function sharedCueWords(text, userText, stopwords = new Set()) {
  const source = String(text || '');
  const user = String(userText || '');
  if (!source || !user) return 0;
  let count = 0;
  for (const run of source.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length < 2) continue;
    const shared = [];
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      shared.push(user.includes(bigram) && !stopwords.has(bigram));
    }
    // Merge adjacent shared bigrams into one word ("后台运行" => one word, not two).
    let runLength = 0;
    for (const isShared of shared) {
      if (isShared) runLength += 1;
      else if (runLength) {
        count += 1;
        runLength = 0;
      }
    }
    if (runLength) count += 1;
  }
  for (const word of source.match(/[a-z0-9_]{2,}/gi) || []) {
    if (new RegExp(`(^|[^a-z0-9_])${word.toLowerCase()}([^a-z0-9_]|$)`, 'i').test(user)) count += 1;
  }
  return count;
}

export function renderContext({ portraitRows, portraitChars, portraitBudget, selfRows, selfChars, selfBudget, digest, digestChars, lastUserText, legacyRecent, recentLimit, promptChars, gap, gapDays, staleFacets, identity, observations, observationChars, observationBudget, stopwords, ttl, halfLifeDays, now, locale, messages: injectedMessages, facetList, userLabels, selfFacetList, selfLabels }) {
  const pack = injectedMessages || packFor(locale || 'zh').injection;
  const facets = Array.isArray(facetList) && facetList.length ? facetList : FACETS;
  const labels = userLabels || packFor('zh').labels.facets;
  const selfFacetsResolved = Array.isArray(selfFacetList) && selfFacetList.length ? selfFacetList : SELF_FACETS;
  const selfLabelsResolved = selfLabels || packFor('zh').labels.selfFacets;
  const sections = [];
  const userTokens = new Set(tokensOf(lastUserText || ''));
  const userEntities = new Set(entitiesOf(lastUserText || ''));
  const stopSet = stopwords instanceof Set ? stopwords : new Set();
  const chineseChars = (String(lastUserText || '').match(/[\u3400-\u9fff]/g) || []).length;
  const shortMessage = Boolean(lastUserText) && chineseChars < 6 && userEntities.size === 0;
  // Cue test: at least 2 shared non-stopword words (non-overlapping), or one shared entity.
  const hasCue = text => {
    if (!text) return false;
    if (!lastUserText) return true;
    if (shortMessage) return false;
    if (sharedCueWords(text, lastUserText, stopSet) >= 2) return true;
    return entitiesOf(text).some(entity => userEntities.has(entity));
  };
  const tr = (key, values) => translate(pack, key, values) || translate(packFor('zh').injection, key, values);
  if (gap && gap.gapDays !== null && gap.gapDays >= (gapDays || DEFAULT_GAP_DAYS)) {
    sections.push(
      tr('timeHeader'),
      tr('timeBody', { days: Math.round(gap.gapDays), date: new Date(gap.lastActivityAt).toISOString().slice(0, 10) }),
      '',
    );
  }
  const obs = Array.isArray(observations) ? observations.filter(row => row && row.status === 'current') : [];
  const clock = Number.isFinite(now) ? now : Date.now();
  const ttlConfig = ttl || SCOPE_TTL_DAYS;
  const active = obs
    .filter(row => !observationExpired(row, clock, ttlConfig))
    .filter(row => row.sensitivity !== 'private')
    .filter(row => mentionOf(row) !== 'never');
  const expiredHidden = obs.filter(row => observationExpired(row, clock, ttlConfig)).length;
  const privateHidden = obs.filter(row => row.sensitivity === 'private' && !observationExpired(row, clock, ttlConfig)).length;
  const mentionHidden = obs.filter(row => row.sensitivity !== 'private' && !observationExpired(row, clock, ttlConfig) && mentionOf(row) === 'never').length;
  if (active.length || expiredHidden || mentionHidden) {
    const kindLabel = pack.kindLabels || packFor('zh').kindLabels;
    const kindOrder = { corrected: 0, self_reported: 1, observed: 2, inferred: 3 };
    const resident = row => {
      if (row.sensitivity === 'sensitive' || row.sensitivity === 'private') return false;
      if (row.kind === 'corrected') return true;
      if (RESIDENT_OBSERVATION_TYPES.has(row.type)) return true;
      return row.kind === 'self_reported' && !CUE_ONLY_TYPES.has(row.type);
    };
    const ordered = [...active].sort((left, right) =>
      (resident(left) ? 0 : 1) - (resident(right) ? 0 : 1)
      || (kindOrder[left.kind] ?? 4) - (kindOrder[right.kind] ?? 4)
      || right.updatedAt - left.updatedAt);
    const obsById = new Map(active.map(row => [row.id, row]));
    const relevant = row => resident(row) || hasCue(`${row.text} ${(row.alternatives || []).join(' ')}`);
    const pairs = new Set();
    for (const row of ordered) {
      for (const peer of row.contradicts || []) {
        if (obsById.has(peer)) pairs.add([row.id, peer].sort().join('|'));
      }
    }
    let remaining = observationBudget;
    const lines = [];
    let gatedOut = 0;
    for (const row of ordered) {
      if (row.sensitivity === 'private') continue;
      if (!relevant(row)) {
        gatedOut += 1;
        continue;
      }
      if (remaining <= 40 || lines.length >= 6) {
        if (!resident(row)) gatedOut += 1;
        continue;
      }
      const label = kindLabel[row.kind] || row.kind;
      const disclosure = mentionOf(row) === 'if_asked' ? (pack.markerIfAsked || '') : '';
      const sensitivity = row.sensitivity === 'sensitive' ? (pack.markerSensitive || '') : '';
      const effective = row.kind === 'inferred' ? effectiveObservationConfidence(row, { now: clock, halfLifeDays }) : null;
      const confidence = effective !== null ? ` ${effective.toFixed(2)}` : '';
      const alternatives = row.alternatives?.length ? tr('alternativesSuffix', { items: row.alternatives.slice(0, 2).join(pack.listSeparator || ', ') }) : '';
      const line = `- ${disclosure}${sensitivity}${label}${confidence}${pack.separator || ': '}${truncate(row.text, observationChars)}${alternatives}`;
      lines.push(line);
      remaining -= line.length + 1;
    }
    if (lines.length || expiredHidden || mentionHidden) {
      sections.push(
        pack.observationHeader || '',
        pack.observationIntro || '',
        lines.join('\n'),
        privateHidden ? tr('observationsPrefix', { n: privateHidden }) : '',
        expiredHidden ? tr('expiredPrefix', { n: expiredHidden }) : '',
        mentionHidden ? tr('mentionPrefix', { n: mentionHidden }) : '',
        pairs.size ? tr('pairPrefix', { n: pairs.size }) : '',
        gatedOut ? tr('gatedPrefix', { n: gatedOut }) : '',
        '',
      );
    }
  }
  const staleSet = staleFacets instanceof Set ? staleFacets : new Set();
  const identityCues = identity?.evidence?.selfDeclarations || [];
  if (identity && (identity.label === 'drifted' || identityCues.length)) {
    const evidence = identity.evidence || {};
    const keep = (value) => (value === null || value === undefined ? '-' : value);
    const gapText = evidence.gapDays === null || evidence.gapDays === undefined ? tr('identityUnknown') : tr('identityDays', { n: Math.round(evidence.gapDays) });
    const cueText = identityCues.length ? tr('identityCue', { cues: identityCues.slice(0, 2).join(' / ') }) : '';
    sections.push(
      tr('identityHeader'),
      tr('identityBody', {
        score: identity.score ?? tr('identitySample'),
        vocab: keep(evidence.vocabOverlap),
        entity: keep(evidence.entityOverlap),
        style: keep(evidence.styleSimilarity),
        cues: cueText,
        gap: gapText,
      }),
      '',
    );
  }
  const portraitLines = facets
    .map(facet => ({ facet, row: portraitRows.get(facet) }))
    .filter(({ row }) => row && row.content.trim())
    .filter(({ facet, row }) => RESIDENT_FACETS.has(facet) || hasCue(row.content));
  if (portraitLines.length) {
    let remaining = portraitBudget;
    const rendered = [];
    for (const { facet, row } of portraitLines) {
      const label = `- ${labels[facet] || facet}${pack.separator || ': '}`;
      if (remaining <= label.length + 20) break;
      const text = truncate(row.content, Math.min(portraitChars, remaining - label.length - 2));
      const line = `${label}${text}${row.needsRecompute ? tr('needsRecompute') : ''}`;
      rendered.push(line);
      remaining -= line.length + 1;
    }
    if (rendered.length) {
      sections.push(
        tr('portraitHeader'),
        staleSet.size ? tr('portraitStale', { n: staleSet.size }) : tr('portraitIntro'),
        rendered.join('\n'),
        '',
      );
    }
  }
  const selfLines = (selfRows ? selfFacetsResolved.map(facet => ({ facet, row: selfRows.get(facet) })) : [])
    .filter(({ row }) => row && row.content.trim());
  if (selfLines.length) {
    let remaining = selfBudget;
    const rendered = [];
    for (const { facet, row } of selfLines) {
      const label = `- ${selfLabelsResolved[facet] || facet}${pack.separator || ': '}`;
      if (remaining <= label.length + 20) break;
      const text = truncate(row.content, Math.min(selfChars, remaining - label.length - 2));
      const line = `${label}${text}`;
      rendered.push(line);
      remaining -= line.length + 1;
    }
    if (rendered.length) {
      sections.push(tr('selfHeader'), tr('selfIntro'), rendered.join('\n'), '');
    }
  }
  const gapMode = Boolean(gap && gap.gapDays !== null && gap.gapDays >= (gapDays || DEFAULT_GAP_DAYS));
  const lastUserEntities = new Set(entitiesOf(lastUserText || ''));
  const relevantDigest = gapMode ? [] : digest.filter(row => {
    const overlap = jaccard([...new Set(tokensOf(lastUserText || ''))], [...new Set(tokensOf(String(row.user || ''), row.summary))]);
    if (overlap >= 0.06) return true;
    return rowEntities(row).some(entity => lastUserEntities.has(entity));
  });
  if (relevantDigest.length) {
    sections.push(
      tr('digestHeader'),
      tr('digestIntro'),
      relevantDigest.map(row => tr('digestLine', {
        date: new Date(row.time).toISOString().slice(0, 10),
        summary: truncate(String(row.summary || '').replace(/\s+/g, ' '), digestChars),
      })).join('\n'),
      '',
    );
  }
  if (legacyRecent && legacyRecent.length) {
    const parts = legacyRecent.map((row, index) => tr('legacyLine', {
      index: index + 1,
      user: truncate(row.user, promptChars),
      assistant: truncate(row.assistant, promptChars),
      impression: row.summary ? tr('legacyImpression', { summary: row.summary }) : '',
    }));
    sections.push(tr('legacyHeader'), tr('legacyIntro'), parts.join('\n'), '');
  }
  if (!sections.length) return '';
  sections.push(tr('instruction'));
  return sections.join('\n');
}

export function apply(ctx, config = {}) {
  return ctx.inject(['storageDomain', 'systemPrompt'], scoped => start(scoped, config));
}

async function start(ctx, config) {
  const logger = ctx.logger;
  const prompts = ctx.get('systemPrompt');
  const storageDomain = ctx.get('storageDomain');
  const agentsService = ctx.get('agents');
  const sessionQuery = ctx.get('sessionQuery');
  const commands = ctx.get('commands');

  const recentLimit = Math.max(1, Math.min(10, Number(config.recentExchanges) || 3));
  const promptChars = Math.max(200, Math.min(8000, Number(config.promptCharsPerExchange) || MAX_PROMPT_CHARS));
  const portraitChars = Math.max(80, Math.min(4000, Number(config.portraitCharsPerFacet) || 240));
  const portraitBudget = Math.max(120, Math.min(6000, Number(config.portraitBudget) || 900));
  const selfChars = Math.max(80, Math.min(2000, Number(config.assistantCharsPerFacet) || 180));
  const selfBudget = Math.max(120, Math.min(3000, Number(config.assistantBudget) || 520));
  const injectAssistantPortrait = config.injectAssistantPortrait !== false;
  const snippetChars = Math.max(80, Math.min(4000, Number(config.snippetChars) || 400));
  const maxPerSession = Math.max(50, Number(config.maxExchangesPerSession) || 1000);
  const dedupeJaccard = Math.max(0.5, Math.min(1, Number(config.dedupeJaccard) || 0.95));
  const decayDays = Math.max(7, Number(config.timeDecayDays) || 180);
  const timeBoost = Math.max(0, Math.min(3, Number(config.timeBoost) || 0.4));
  const injectRecentExchanges = config.injectRecentExchanges === true;
  const digestImpressions = Math.max(0, Math.min(10, Number(config.digestImpressions) || 2));
  const digestChars = Math.max(40, Math.min(500, Number(config.digestChars) || 100));
  const defaultScope = config.scope === 'all' ? 'all' : 'workspace';
  const observationBudget = Math.max(80, Math.min(2000, Number(config.observationBudget) || 420));
  const observationChars = Math.max(60, Math.min(600, Number(config.observationChars) || 180));
  const ttlConfig = {
    transient: Math.max(0.1, Number(config.ttlTransientDays) || SCOPE_TTL_DAYS.transient),
    situational: Math.max(1, Number(config.ttlSituationalDays) || SCOPE_TTL_DAYS.situational),
    durable: null,
  };
  const inferenceHalfLifeDays = Math.max(1, Number(config.inferenceHalfLifeDays) || 90);
  const configuredLocale = SUPPORTED_LOCALES.includes(config.locale) ? config.locale : null;
  const userFacets = Array.isArray(config.facets) && config.facets.length
    ? config.facets.filter(facet => typeof facet === 'string' && facet.trim()).map(facet => facet.trim()).slice(0, 24)
    : FACETS;
  const assistantFacets = Array.isArray(config.assistantFacets) && config.assistantFacets.length
    ? config.assistantFacets.filter(facet => typeof facet === 'string' && facet.trim()).map(facet => facet.trim()).slice(0, 24)
    : SELF_FACETS;
  const localeFor = text => configuredLocale || detectLocale(text);
  // Language follows the session, not a single tool result: if any recent user
  // message is Chinese, keep the session Chinese; otherwise English.
  const sessionLocaleFor = sessionKey => {
    if (configuredLocale) return configuredLocale;
    const key = String(sessionKey);
    const texts = [
      ...(rowsBySession.get(key) || []).slice(-5).map(row => cleanUserText(row.user)),
      lastUserBySession.get(key) || '',
    ].filter(Boolean);
    return texts.some(text => detectLocale(text) === 'zh') ? 'zh' : 'en';
  };
  const labelsFor = locale => ({ user: packFor(locale).labels.facets, self: packFor(locale).labels.selfFacets });
  let captureEnabled = config.capture !== false;
  const autoSummaryEnabled = config.autoSummary !== false;
  const identityNoticeEnabled = config.identityNotice === true;
  const archiveAfterDays = Math.max(7, Math.min(36500, Number(config.archiveAfterDays) || DEFAULT_ARCHIVE_AFTER_DAYS));
  const gapDays = Math.max(1, Math.min(36500, Number(config.gapDays) || DEFAULT_GAP_DAYS));
  const freshDays = Math.max(1, Math.min(36500, Number(config.freshDays) || DEFAULT_FRESH_DAYS));
  const autoArchive = config.autoArchive !== false;
  const archivedWeight = Math.max(0, Math.min(1, Number(config.archivedWeight) || DEFAULT_ARCHIVED_WEIGHT));
  const exportPath = typeof config.exportPath === 'string' && config.exportPath.trim()
    ? config.exportPath
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dynamic_memory', 'memory.md');

  let domain;
  let storageError;
  if (storageDomain) {
    try {
      domain = await storageDomain.open(DOMAIN_SPEC);
    } catch (error) {
      storageError = String(error);
      logger.warn(`dynamic-memory: durable storage unavailable, continuing in memory only: ${storageError}`);
    }
  } else {
    storageError = 'storageDomain service is unavailable';
    logger.warn('dynamic-memory: ctx.storageDomain is missing, keeping impressions in memory only');
  }
  const storageState = domain ? 'durable' : `memory-only (${storageError})`;

  const table = domain ? domain.table('exchanges') : undefined;
  const portraitTable = domain ? domain.table('portrait') : undefined;
  const selfTable = domain ? domain.table('self') : undefined;
  const observationsTable = domain ? domain.table('observations') : undefined;
  const rowsById = new Map();
  const rowsBySession = new Map();
  const portrait = new Map();
  const selfPortrait = new Map();
  const observations = new Map();
  const stats = { merged: 0, pruned: 0, superseded: 0, indexed: 0, knownSessions: null, lastConsolidatedAt: null };

  const addRow = row => {
    if (rowsById.has(row.id)) return;
    rowsById.set(row.id, row);
    let list = rowsBySession.get(row.sessionId);
    if (!list) {
      list = [];
      rowsBySession.set(row.sessionId, list);
    }
    list.push(row);
    list.sort((left, right) => left.time - right.time);
    if (list.length > maxPerSession) {
      const removed = list.splice(0, list.length - maxPerSession);
      for (const stale of removed) {
        rowsById.delete(stale.id);
        invalidateRow(stale);
        stats.pruned += 1;
        if (table) void table.delete(recordKey(stale.id)).catch(() => {});
      }
    }
  };

  const pendingWrites = new Set();
  const trackWrite = promise => {
    const task = Promise.resolve(promise);
    pendingWrites.add(task);
    task.finally(() => pendingWrites.delete(task)).catch(() => {});
    return task;
  };
  const persist = async row => {
    if (!table) return;
    await trackWrite(table.put(recordKey(row.id), row));
  };

  const dirty = new Set();
  const markDirty = row => dirty.add(row);
  const flushDirty = async () => {
    if (!dirty.size) return;
    const batch = [...dirty];
    dirty.clear();
    for (const row of batch) {
      if (!rowsById.has(row.id)) continue;
      await persist(row).catch(error => logger.warn(`dynamic-memory: cannot persist access stats: ${String(error)}`));
    }
  };
  let flushTimer;
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushDirty();
    }, 2000);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  const duplicateOf = (sessionId, user, assistant) => {
    const list = rowsBySession.get(sessionId) || [];
    const tokens = tokensOf(user, assistant);
    for (let index = list.length - 1; index >= 0 && index >= list.length - 8; index -= 1) {
      const candidate = list[index];
      if (candidate.user === user && candidate.assistant === assistant) return candidate;
      if (jaccard(tokens, rowTokens(candidate)) >= dedupeJaccard) return candidate;
    }
    return undefined;
  };

  const findReAsk = (sessionId, user, assistant) => {
    const list = rowsBySession.get(sessionId) || [];
    for (let index = list.length - 1; index >= 0 && index >= list.length - 12; index -= 1) {
      const candidate = list[index];
      if (isReAsk(candidate.user, candidate.assistant, user, assistant)) return candidate;
    }
    return undefined;
  };

  if (table) {
    for (const [, row] of table.entries()) {
      if (row && typeof row === 'object' && (String(row.assistant || '').trim() || cleanUserText(row.user))) addRow(row);
    }
  }
  if (portraitTable) {
    for (const [, row] of portraitTable.entries()) {
      if (row && typeof row === 'object' && userFacets.includes(row.facet)) portrait.set(row.facet, row);
    }
  }
  if (selfTable) {
    for (const [, row] of selfTable.entries()) {
      if (row && typeof row === 'object' && assistantFacets.includes(row.facet)) selfPortrait.set(row.facet, row);
    }
  }
  if (observationsTable) {
    for (const [, row] of observationsTable.entries()) {
      if (row && typeof row === 'object' && typeof row.id === 'string') observations.set(row.id, row);
    }
  }

  const persistObservation = async row => {
    if (!observationsTable) return;
    await trackWrite(observationsTable.put(`o_${row.id}`, row)).catch(error => logger.warn(`dynamic-memory: cannot persist observation: ${String(error)}`));
  };
  const OBSERVATION_PRIORITY = { corrected: 0, self_reported: 1, observed: 2, inferred: 3 };
  const currentObservations = (limit = 20) => [...observations.values()]
    .filter(row => row.status === 'current')
    .sort((left, right) => (OBSERVATION_PRIORITY[left.kind] ?? 4) - (OBSERVATION_PRIORITY[right.kind] ?? 4) || right.updatedAt - left.updatedAt)
    .slice(0, limit);
  const liveObservation = id => {
    const row = observations.get(id);
    return Boolean(row && row.status === 'current');
  };
  /** Remove an id from every observation/portrait reference so no dangling links remain. */
  const dropObservationReferences = async id => {
    for (const row of observations.values()) {
      if (row.id === id) continue;
      if (Array.isArray(row.contradicts) && row.contradicts.includes(id)) {
        row.contradicts = row.contradicts.filter(peer => peer !== id);
        row.updatedAt = Date.now();
        await persistObservation(row);
      }
      if (Array.isArray(row.conditionalContradicts) && row.conditionalContradicts.includes(id)) {
        row.conditionalContradicts = row.conditionalContradicts.filter(peer => peer !== id);
        row.updatedAt = Date.now();
        await persistObservation(row);
      }
      if (row.correctionOf === id) {
        row.correctionOf = null;
        row.updatedAt = Date.now();
        await persistObservation(row);
      }
    }
    await markFacetsStale(id);
  };
  /** Remove an exchange id from every facet/observation reference and mark facets for recompute. */
  const dropExchangeReferences = async id => {
    for (const [map, tableRef, prefix] of [[portrait, portraitTable, 'p_'], [selfPortrait, selfTable, 's_']]) {
      for (const [facet, row] of map) {
        if (!Array.isArray(row.sourceExchangeIds) || !row.sourceExchangeIds.includes(id)) continue;
        row.sourceExchangeIds = row.sourceExchangeIds.filter(source => source !== id);
        row.needsRecompute = true;
        if (tableRef) await trackWrite(tableRef.put(`${prefix}${facet}`, row)).catch(() => {});
      }
    }
    for (const row of observations.values()) {
      if (!Array.isArray(row.sourceIds) || !row.sourceIds.includes(id)) continue;
      row.sourceIds = row.sourceIds.filter(source => source !== id);
      await persistObservation(row);
    }
  };

  const addObservation = async (args, kind, sessionId) => {
    const at = Date.now();
    const requestedType = OBSERVATION_TYPES.includes(args.observationType) ? args.observationType
      : OBSERVATION_TYPES.includes(args.type) ? args.type : 'behavior_observation';
    const row = {
      id: uuid(),
      type: requestedType,
      text: String(args.content || args.text || '').trim().slice(0, 1000),
      kind,
      confidence: Number.isFinite(args.confidence) ? Math.max(0, Math.min(1, args.confidence)) : null,
      context: typeof args.context === 'string' ? args.context : null,
      quote: typeof args.quote === 'string' ? args.quote : null,
      alternatives: Array.isArray(args.alternatives) ? args.alternatives.filter(entry => typeof entry === 'string') : [],
      sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds : [],
      contradicts: [],
      conditionalContradicts: [],
      sessions: sessionId ? [String(sessionId)] : [],
      lastCorroboratedAt: at,
      scope: OBSERVATION_SCOPES.includes(args.observationScope) ? args.observationScope : undefined,
      correctionOf: null,
      sensitivity: ['normal', 'sensitive', 'private'].includes(args.sensitivity) ? args.sensitivity : 'normal',
      mention: MENTION_VALUES.includes(args.mention) ? args.mention : undefined,
      status: 'current',
      createdAt: at,
      updatedAt: at,
    };
    observations.set(row.id, row);
    await persistObservation(row);
    return row;
  };

  const archiveRow = async (row, reason) => {
    row.archivedAt = Date.now();
    row.archivedReason = reason;
    row.weight = archivedWeight;
    invalidateRow(row);
    await persist(row).catch(error => logger.warn(`dynamic-memory: cannot archive ${row.id}: ${String(error)}`));
  };
  const restoreRow = async row => {
    row.archivedAt = null;
    row.archivedReason = null;
    row.weight = 1;
    invalidateRow(row);
    await persist(row).catch(error => logger.warn(`dynamic-memory: cannot restore ${row.id}: ${String(error)}`));
  };

  const gapNow = computeGapState([...rowsById.values()], Date.now());
  const gapModeAtStart = gapNow.gapDays !== null && gapNow.gapDays >= gapDays;
  let autoArchived = 0;
  if (autoArchive && gapModeAtStart) {
    for (const row of selectForArchive([...rowsById.values()], { now: Date.now(), olderThanDays: archiveAfterDays })) {
      void archiveRow(row, `idle ${Math.round(gapNow.gapDays)} days`);
      autoArchived += 1;
    }
    logger.warn(`dynamic-memory: long gap (${Math.round(gapNow.gapDays)} days) detected; archived ${autoArchived} stale exchanges for reference only`);
  }
  stats.autoArchived = autoArchived;
  stats.gapDaysAtStart = gapNow.gapDays;

  const speakerBaselineCache = new Map();
  const speakerBaseline = sessionId => {
    const key = String(sessionId);
    const size = rowsById.size;
    const cached = speakerBaselineCache.get(key);
    if (cached && cached.size === size) return cached.baseline;
    const baseline = buildSpeakerBaseline([...rowsById.values()], { excludeSessionId: key });
    speakerBaselineCache.set(key, { size, baseline });
    return baseline;
  };

  let stopwordCache = { key: '', set: new Set() };
  /** Tokens that appear in >30% of user messages/observations are treated as stopwords for cue matching. */
  const stopwordsFor = () => {
    const key = `${rowsById.size}:${observations.size}`;
    if (stopwordCache.key === key) return stopwordCache.set;
    const frequency = new Map();
    let documents = 0;
    for (const row of rowsById.values()) {
      const text = cleanUserText(row.user);
      if (!text) continue;
      documents += 1;
      for (const token of new Set(tokensOf(text))) frequency.set(token, (frequency.get(token) || 0) + 1);
    }
    for (const row of observations.values()) {
      documents += 1;
      for (const token of new Set(tokensOf(`${row.text} ${(row.alternatives || []).join(' ')}`))) {
        frequency.set(token, (frequency.get(token) || 0) + 1);
      }
    }
    const set = new Set();
    if (documents > 20) {
      for (const [token, count] of frequency) if (count / documents > 0.3) set.add(token);
    }
    stopwordCache = { key, set };
    return set;
  };

  const strongIdentityReport = sessionId => {
    const report = identityReport(sessionId);
    const baseline = report.baseline?.messages || 0;
    const gap = report.evidence?.gapDays;
    const strong = report.label === 'drifted'
      && baseline >= 20
      && Number(report.score) < 0.3
      && (gap === null || gap === undefined || gap >= 3);
    return strong ? report : undefined;
  };

  const identityReport = sessionId => {
    const key = String(sessionId);
    const texts = (rowsBySession.get(key) || []).map(row => cleanUserText(row.user)).filter(Boolean);
    const live = lastUserBySession.get(key);
    if (live) texts.push(live);
    const gap = computeGapState([...rowsById.values()], Date.now());
    const report = speakerContinuity(texts.slice(-12), speakerBaseline(key), { gapDays: gap.gapDays });
    const baseline = speakerBaseline(key);
    return {
      ...report,
      baseline: {
        messages: baseline.messages,
        topTokens: [...baseline.tokens].slice(0, 12),
        topEntities: [...baseline.entities].slice(0, 8),
      },
      recommendation: report.label === 'drifted'
        ? '证据倾向于“不是同一个人”（或环境/心境大变）：先按新对话处理，不要套用画像；必要时确认身份，确认后用 learn 覆盖画像。'
        : report.label === 'uncertain'
          ? '证据不足以判定：可以继续参考画像，但降低依赖，遇到冲突以当前对话为准。'
          : report.label === 'likely-same'
            ? '证据支持是同一人：可以正常参考画像。'
            : '样本不足（当前发言少于 2 条或历史基线为空）：暂时无法判断，不要下结论。',
    };
  };

  const writeFacet = async (map, targetTable, keyPrefix, validFacets, facet, content, extraKeywords, sourceIds, sourceObservationIds) => {
    if (!validFacets.includes(facet)) throw new Error(`facet must be one of ${validFacets.join(', ')}`);
    const previous = map.get(facet);
    const next = content.trim().slice(0, 4000);
    const at = Date.now();
    const history = previous && previous.content !== next
      ? [...(previous.history || []), {
          content: previous.content,
          at: previous.updatedAt,
          sourceExchangeIds: [...(previous.sourceExchangeIds || [])],
          sourceObservationIds: [...(previous.sourceObservationIds || [])],
        }].slice(-HISTORY_LIMIT)
      : (previous?.history || []);
    const knownExchanges = (sourceIds || []).filter(id => rowsById.has(id));
    const knownObservations = (sourceObservationIds || []).filter(id => observations.has(id));
    const row = {
      facet,
      content: next,
      updatedAt: at,
      keywords: [...new Set([...keywordsOf(extraKeywords || [], content), ...(previous?.keywords || [])])].slice(0, MAX_KEYWORDS),
      history,
      // Each portrait version binds its own sources; history keeps the previous version's set.
      sourceExchangeIds: knownExchanges.slice(-100),
      sourceObservationIds: knownObservations.slice(-100),
      needsRecompute: false,
    };
    map.set(facet, row);
    if (targetTable) await trackWrite(targetTable.put(`${keyPrefix}${facet}`, row));
    return row;
  };

  const writePortrait = (facet, content, extraKeywords, sourceIds, sourceObservationIds) =>
    writeFacet(portrait, portraitTable, 'p_', userFacets, facet, content, extraKeywords, sourceIds, sourceObservationIds);
  const writeSelf = (facet, content, extraKeywords, sourceIds, sourceObservationIds) =>
    writeFacet(selfPortrait, selfTable, 's_', assistantFacets, facet, content, extraKeywords, sourceIds, sourceObservationIds);

  /** Mark every facet that cited this observation as needing a rewrite. */
  const markFacetsStale = async observationId => {
    for (const [map, table, prefix] of [[portrait, portraitTable, 'p_'], [selfPortrait, selfTable, 's_']]) {
      for (const [facet, row] of map) {
        if (!Array.isArray(row.sourceObservationIds) || !row.sourceObservationIds.includes(observationId)) continue;
        row.needsRecompute = true;
        row.sourceObservationIds = row.sourceObservationIds.filter(id => id !== observationId);
        if (table) await trackWrite(table.put(`${prefix}${facet}`, row)).catch(() => {});
      }
    }
  };

  const facetsOf = target => (target === ASSISTANT_TARGET ? assistantFacets : userFacets);
  const mapOf = target => (target === ASSISTANT_TARGET ? selfPortrait : portrait);
  const labelsOf = (target, locale = 'zh') => {
    const labels = labelsFor(locale);
    return target === ASSISTANT_TARGET ? labels.self : labels.user;
  };

  const restores = new Map();
  const restore = sessionId => {
    const key = String(sessionId);
    if (rowsBySession.has(key) || !sessionQuery) return Promise.resolve();
    if (restores.has(key)) return restores.get(key);
    const job = (async () => {
      const events = [];
      let workspace = null;
      try {
        const snapshot = await sessionQuery.readSession(sessionId);
        events.push(...(snapshot.events || []));
        workspace = snapshot.session?.cwd || null;
      } catch (error) {
        const live = ctx.get('sessions') ? ctx.get('sessions').get(sessionId) : undefined;
        if (live && typeof live.ownEvents === 'function') {
          events.push(...live.ownEvents());
          workspace = live.header?.cwd || null;
        } else {
          logger.warn(`dynamic-memory: cannot read session ${key}: ${String(error)}`);
        }
      }
      let pendingUser = '';
      let pendingAssistant = '';
      let lastTime = Date.now();
      const commit = async () => {
        if (!pendingUser || !pendingAssistant) return;
        const user = pendingUser;
        const assistant = pendingAssistant;
        pendingUser = '';
        pendingAssistant = '';
        if (duplicateOf(key, user, assistant)) return;
        const row = {
          id: uuid(),
          sessionId: key,
          workspace,
          kind: 'episodic',
          time: lastTime,
          updatedAt: lastTime,
          user,
          assistant,
          summary: autoSummaryEnabled ? extractiveSummary(user, assistant) : '',
          keywords: keywordsOf(user, assistant),
          entities: entitiesOf(user, assistant),
          importance: DEFAULT_IMPORTANCE,
          accessCount: 0,
          lastAccessAt: null,
          supersededBy: null,
          history: [],
          sourceIds: [],
        };
        addRow(row);
        await persist(row).catch(error => logger.warn(`dynamic-memory: cannot persist restored exchange: ${String(error)}`));
      };
      for (const event of events) {
        if (typeof event.time === 'number') lastTime = event.time;
        if (event.type === 'turn/start') {
          pendingAssistant = '';
        } else if (event.type === 'user/message') {
          await commit();
          pendingUser = cleanUserText(messageText(event.data));
        } else if (event.type === 'assistant/message') {
          const text = messageText(event.data && event.data.message);
          if (text) pendingAssistant = text;
        } else if (event.type === 'turn/end') {
          await commit();
        }
      }
      await commit();
      if (!rowsBySession.has(key)) rowsBySession.set(key, []);
    })();
    restores.set(key, job);
    return job;
  };

  const indexUnseen = async (limit) => {
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return { error: 'session query service is unavailable' };
    const records = await sessionQuery.listSessions();
    const unseen = records
      .filter(record => !rowsBySession.has(String(record.header.id)))
      .sort((left, right) => (right.header.createdAt || 0) - (left.header.createdAt || 0))
      .slice(0, Math.max(1, Math.min(50, limit)));
    for (const record of unseen) await restore(record.header.id);
    stats.indexed += unseen.length;
    stats.knownSessions = records.length;
    return {
      indexed: unseen.length,
      knownSessions: records.length,
      indexedSessions: rowsBySession.size,
      remaining: Math.max(0, records.length - rowsBySession.size),
    };
  };

  const repairMissingUser = async (limit) => {
    if (!sessionQuery) return { error: 'session query service is unavailable' };
    const targets = [...rowsBySession.entries()]
      .filter(([, list]) => list.some(row => !cleanUserText(row.user)))
      .slice(0, Math.max(1, Math.min(20, limit)));
    let repaired = 0;
    let sessions = 0;
    const details = [];
    for (const [sessionId, list] of targets) {
      let events = [];
      try {
        const snapshot = await sessionQuery.readSession(sessionId);
        events = snapshot.events || [];
      } catch {
        continue;
      }
      // Map every assistant message to the nearest preceding real user prompt, even when the
      // turn's own user message was only harness runtime context.
      const responses = [];
      let lastUser = '';
      let turnUser = '';
      for (const event of events) {
        if (event.type === 'turn/start') {
          turnUser = '';
        } else if (event.type === 'user/message') {
          const cleaned = cleanUserText(messageText(event.data));
          if (cleaned) {
            turnUser = cleaned;
            lastUser = cleaned;
          }
        } else if (event.type === 'assistant/message') {
          const text = messageText(event.data && event.data.message);
          if (text) responses.push({ assistant: text, at: event.time, user: turnUser || lastUser });
        }
      }
      if (!responses.length) continue;
      sessions += 1;
      let matchedHere = 0;
      let missingHere = 0;
      for (const row of list) {
        if (cleanUserText(row.user)) continue;
        missingHere += 1;
        let match = responses.find(entry => entry.assistant === row.assistant);
        if (!match) {
          let best = null;
          for (const entry of responses) {
            if (entry.at === null) continue;
            const distance = Math.abs(entry.at - row.time);
            if (distance > 5000) continue;
            if (!best || distance < best.distance) best = { entry, distance };
          }
          match = best ? best.entry : undefined;
        }
        if (!match || !match.user) continue;
        matchedHere += 1;
        row.user = match.user;
        row.keywords = [...new Set([...keywordsOf(row.user, row.assistant), ...row.keywords])].slice(0, MAX_KEYWORDS);
        row.entities = [...new Set([...entitiesOf(row.user, row.assistant), ...row.entities])].slice(0, MAX_ENTITIES);
        invalidateRow(row);
        repaired += 1;
        await persist(row).catch(() => {});
      }
      details.push({ sessionId, responses: responses.length, missing: missingHere, matched: matchedHere });
    }
    return { repaired, sessions, details: details.slice(0, 8) };
  };

  const consolidate = async sessionKey => {
    const list = rowsBySession.get(sessionKey);
    if (!list || list.length < 2) return { merged: 0 };
    let merged = 0;
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index];
      for (let other = index + 1; other < list.length; other += 1) {
        const candidate = list[other];
        if (jaccard(rowTokens(row), rowTokens(candidate)) < dedupeJaccard) continue;
        if (candidate.summary && candidate.summary !== row.summary) {
          row.summary = row.summary || candidate.summary;
          row.updatedAt = Math.max(row.updatedAt, candidate.updatedAt);
          row.keywords = [...new Set([...row.keywords, ...candidate.keywords])].slice(0, MAX_KEYWORDS);
          invalidateRow(row);
          await persist(row).catch(() => {});
        }
        row.accessCount = (row.accessCount || 0) + (candidate.accessCount || 0);
        row.importance = Math.max(row.importance || DEFAULT_IMPORTANCE, candidate.importance || DEFAULT_IMPORTANCE);
        rowsById.delete(candidate.id);
        invalidateRow(candidate);
        list.splice(other, 1);
        other -= 1;
        merged += 1;
        stats.merged += 1;
        if (table) await table.delete(recordKey(candidate.id)).catch(() => {});
      }
    }
    stats.lastConsolidatedAt = Date.now();
    return { merged };
  };

  const currentWorkspaceOf = agent => {
    try {
      const session = ctx.get('sessions') ? ctx.get('sessions').get(agent.id) : undefined;
      const directory = ctx.get('workingDirectory');
      if (session && directory && typeof directory.get === 'function') return directory.get(session) || null;
      return session?.header?.cwd || null;
    } catch {
      return null;
    }
  };

  const search = (args, workspace) => {
    const query = String(args.query || '').trim();
    const terms = [...new Set(tokensOf(query))];
    if (!terms.length && !entitiesOf(query).length) return { error: 'query is required and must contain at least two letters, digits, or Chinese characters' };
    if (args.from !== undefined && toTimestamp(args.from) === undefined) return { error: 'from must be an ISO date or epoch milliseconds' };
    if (args.to !== undefined && toTimestamp(args.to) === undefined) return { error: 'to must be an ISO date or epoch milliseconds' };
    const scope = args.scope === 'all' || args.scope === 'workspace' ? args.scope : defaultScope;
    const ranked = rankExchanges([...rowsById.values()], {
      query,
      from: args.from,
      to: args.to,
      sort: args.sort,
      limit: Math.max(1, Math.min(50, Number(args.limit) || 10)),
      kind: KINDS.includes(args.kind) ? args.kind : undefined,
      workspace,
      scope,
      timeBoost,
      decayDays,
      includeSuperseded: args.includeSuperseded === true,
      includeArchived: args.includeArchived === true,
      archivedWeight,
      touch: true,
    });
    for (const match of ranked.matches) {
      const row = rowsById.get(match.id);
      if (row) markDirty(row);
    }
    scheduleFlush();
    const portraitTerms = terms.filter(term => term.length >= 2);
    const portraitMatches = userFacets
      .map(facet => portrait.get(facet))
      .filter(row => row && row.content.trim())
      .map(row => {
        const haystack = `${row.content}\n${row.keywords.join(' ')}`.toLowerCase();
        const score = portraitTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { row, score };
      })
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map(({ row, score }) => ({ facet: row.facet, label: labelsOf(USER_TARGET, detectLocale(query))[row.facet] || row.facet, score, content: snippetOf(row.content, terms, snippetChars), updatedAt: new Date(row.updatedAt).toISOString() }));
    const full = args.full === true;
    const chars = Math.max(80, Math.min(4000, Number(args.snippetChars) || snippetChars));
    const matches = ranked.matches.map(match => (full
      ? match
      : {
          id: match.id,
          time: match.time,
          score: match.score,
          reasons: match.reasons,
          confidence: ranked.confidence.label,
          user: snippetOf(match.user, terms, chars),
          assistant: snippetOf(match.assistant, terms, chars),
          summary: match.summary ? snippetOf(match.summary, terms, chars) : '',
          supersededBy: match.supersededBy,
          archived: match.archived,
          entities: match.entities,
        }));
    return {
      ...ranked,
      matches,
      portraitMatches,
      archivedHidden: args.includeArchived === true ? 0 : [...rowsById.values()].filter(row => row.archivedAt).length,
      full,
      snippetChars: full ? null : chars,
      scope,
      storage: storageState,
      note: full ? 'Complete original paragraphs are returned.' : 'Compact evidence snippets; pass full=true only when quoting.',
    };
  };

  const topEntities = (limit, entityFilter) => {
    const index = buildEntityIndex([...rowsById.values()]);
    if (entityFilter) {
      const related = [...(index.get(String(entityFilter).toLowerCase()) || [])]
        .filter(row => rowsById.has(row.id))
        .sort((left, right) => right.time - left.time)
        .slice(0, limit)
        .map(row => ({ id: row.id, time: new Date(row.time).toISOString(), user: truncate(cleanUserText(row.user), 80), summary: truncate(row.summary, 80), importance: row.importance }));
      return { entity: String(entityFilter).toLowerCase(), related, count: related.length };
    }
    const entries = [...index.entries()]
      .map(([entity, set]) => ({ entity, count: [...set].filter(row => rowsById.has(row.id)).length }))
      .filter(entry => entry.count > 0)
      .sort((left, right) => right.count - left.count || left.entity.localeCompare(right.entity))
      .slice(0, limit);
    return { entities: entries, total: index.size, sample: entries.slice(0, 3).map(entry => entry.entity) };
  };

  const exportMarkdown = async () => {
    const lines = ['# 动态记忆', '', `生成时间：${new Date().toISOString()}`, ''];
    lines.push('## 用户画像', '');
    for (const facet of userFacets) {
      const row = portrait.get(facet);
      if (row && row.content.trim()) lines.push(`- **${labelsOf(USER_TARGET)[facet] || facet}**：${row.content}`);
    }
    const selfRowsExport = assistantFacets.map(facet => ({ facet, row: selfPortrait.get(facet) })).filter(({ row }) => row && row.content.trim());
    if (selfRowsExport.length) {
      lines.push('', '## 助手画像', '');
      for (const { facet, row } of selfRowsExport) lines.push(`- **${labelsOf(ASSISTANT_TARGET)[facet] || facet}**：${row.content}`);
    }
    const obsExport = [...observations.values()].filter(row => row.status === 'current').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    if (obsExport.length) {
      lines.push('', '## 观察与推断', '');
      const labels = { observed: '事实', self_reported: '自述', inferred: '推断', corrected: '纠正' };
      for (const row of obsExport) {
        if (row.sensitivity === 'private') {
          lines.push('- （1 条私密观察未导出）');
          continue;
        }
        const confidence = row.kind === 'inferred' && row.confidence !== null ? `（${row.confidence}）` : '';
        lines.push(`- **${labels[row.kind] || row.kind}${confidence}**：${row.text}`);
      }
    }
    lines.push('', '## 最近印象', '');
    const impressions = [...rowsById.values()]
      .filter(row => row.summary && !row.archivedAt)
      .sort((left, right) => right.time - left.time)
      .slice(0, 30);
    if (!impressions.length) lines.push('（还没有写过的印象）');
    for (const row of impressions) {
      lines.push(`- ${new Date(row.time).toISOString().slice(0, 10)} 用户：${cleanUserText(row.user).replace(/\s+/g, ' ').slice(0, 80)}`);
      lines.push(`  - 印象：${row.summary.replace(/\s+/g, ' ')}`);
    }
    const archivedCount = [...rowsById.values()].filter(row => row.archivedAt).length;
    if (archivedCount) lines.push('', `> 另有 ${archivedCount} 条旧记忆在回收区（权重 ${archivedWeight}，默认不参与检索与注入）。`);
    lines.push('', '## 统计', '');
    lines.push(`- 记录数：${rowsById.size}`);
    lines.push(`- 画像 facet：${[...portrait.values()].filter(row => row.content.trim()).length}`);
    lines.push(`- 存储：${storageState}`);
    await mkdir(join(exportPath, '..'), { recursive: true }).catch(() => {});
    await writeFile(exportPath, `${lines.join('\n')}\n`, 'utf8');
    return { path: exportPath, bytes: Buffer.byteLength(lines.join('\n'), 'utf8'), impressions: impressions.length, archived: archivedCount };
  };

  const captures = new Map();
  const lastUserBySession = new Map();
  const consolidationTimers = new Map();
  const scheduleConsolidation = sessionKey => {
    if (consolidationTimers.has(sessionKey)) return;
    const timer = setTimeout(() => {
      consolidationTimers.delete(sessionKey);
      void (async () => {
        try {
          await consolidate(sessionKey);
          await flushDirty();
        } catch (error) {
          logger.warn(`dynamic-memory: consolidation failed: ${String(error)}`);
        }
      })();
    }, 1500);
    if (typeof timer.unref === 'function') timer.unref();
    consolidationTimers.set(sessionKey, timer);
  };

  const commit = (key, state) => {
    const user = state.pendingUser;
    const assistant = state.pendingAssistant;
    if (!user || !assistant) return;
    state.pendingUser = '';
    state.pendingAssistant = '';
    if (duplicateOf(key, user, assistant)) return;
    const row = {
      id: uuid(),
      sessionId: key,
      workspace: state.workspace || null,
      kind: 'episodic',
      time: state.lastTime,
      updatedAt: state.lastTime,
      user,
      assistant,
      summary: autoSummaryEnabled ? extractiveSummary(user, assistant) : '',
      keywords: keywordsOf(user, assistant),
      entities: entitiesOf(user, assistant),
      importance: DEFAULT_IMPORTANCE,
      accessCount: 0,
      lastAccessAt: null,
      supersededBy: null,
      history: [],
      sourceIds: [],
    };
    addRow(row);
    const previousAsk = findReAsk(key, user, assistant);
    if (previousAsk && !previousAsk.supersededBy) {
      previousAsk.supersededBy = row.id;
      stats.superseded += 1;
      invalidateRow(previousAsk);
      void persist(previousAsk).catch(error => logger.warn(`dynamic-memory: cannot mark superseded: ${String(error)}`));
    }
    void persist(row).catch(error => logger.warn(`dynamic-memory: cannot persist exchange: ${String(error)}`));
  };

  const stopSessionEvents = ctx.on('session/event', (session, event) => {
    const key = String(session.id);
    const state = captures.get(key);
    if (!state) return;
    if (!captureEnabled) return;
    if (typeof event.time === 'number') state.lastTime = event.time;
    if (event.type === 'turn/start') {
      state.pendingAssistant = '';
      return;
    }
    if (event.type === 'user/message') {
      const cleaned = cleanUserText(messageText(event.data));
      if (!cleaned) return;
      commit(key, state);
      state.pendingUser = cleaned;
      state.lastUserText = cleaned;
      lastUserBySession.set(key, cleaned);
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data && event.data.message);
      if (text) state.pendingAssistant = text;
    } else if (event.type === 'turn/end') {
      commit(key, state);
      scheduleConsolidation(key);
    }
  });

  const statsSnapshot = agent => {
    const byKind = { episodic: 0, semantic: 0, procedural: 0 };
    for (const row of rowsById.values()) byKind[row.kind || 'episodic'] += 1;
    const withoutSummary = [...rowsById.values()].filter(row => !row.summary).length;
    const superseded = [...rowsById.values()].filter(row => row.supersededBy).length;
    const archived = [...rowsById.values()].filter(row => row.archivedAt).length;
    const active = [...rowsById.values()].filter(row => !row.archivedAt);
    const gap = computeGapState(active, Date.now());
    const stale = [...userFacets, ...assistantFacets].filter(facet => {
      const row = portrait.get(facet) || selfPortrait.get(facet);
      return row && isStale(row.updatedAt, Date.now(), freshDays);
    });
    const importance = [...rowsById.values()].reduce((sum, row) => sum + (Number(row.importance) || DEFAULT_IMPORTANCE), 0) / Math.max(1, rowsById.size);
    let injection = null;
    if (agent) {
      const sessionKey = String(agent.id);
      const digest = digestRows(sessionKey);
      const text = renderContext({
        portraitRows: portrait,
        portraitChars,
        portraitBudget,
        selfRows: injectAssistantPortrait ? selfPortrait : undefined,
        selfChars,
        selfBudget,
        digest,
        digestChars,
        lastUserText: lastUserBySession.get(sessionKey) || '',
        gap,
        gapDays,
        staleFacets: new Set(stale),
        identity: identityNoticeEnabled ? strongIdentityReport(sessionKey) : undefined,
        observations: currentObservations(20),
        locale: sessionLocaleFor(sessionKey),
        messages: packFor(sessionLocaleFor(sessionKey)).injection,
        facetList: userFacets,
        userLabels: labelsFor(sessionLocaleFor(sessionKey)).user,
        selfFacetList: assistantFacets,
        selfLabels: labelsFor(sessionLocaleFor(sessionKey)).self,
        observationChars,
        observationBudget,
        stopwords: stopwordsFor(),
        ttl: ttlConfig,
        halfLifeDays: inferenceHalfLifeDays,
        now: Date.now(),
      });
      injection = { chars: text.length, digestCount: digest.filter(row => jaccard([...new Set(tokensOf(lastUserBySession.get(sessionKey) || ''))], [...new Set(tokensOf(String(row.user || ''), row.summary))]) >= 0.06).length };
    }
    return {
      exchanges: rowsById.size,
      sessions: rowsBySession.size,
      knownSessions: stats.knownSessions,
      indexedByUs: stats.indexed,
      byKind,
      withoutSummary,
      missingUser: [...rowsById.values()].filter(row => !cleanUserText(row.user)).length,
      superseded,
      archived,
      archivedWeight,
      autoArchived: stats.autoArchived || 0,
      gapDays: gap.gapDays === null ? null : Number(gap.gapDays.toFixed(1)),
      lastActivityAt: gap.lastActivityAt ? new Date(gap.lastActivityAt).toISOString() : null,
      staleFacets: stale,
      facetsNeedingRecompute: [...portrait.values(), ...selfPortrait.values()].filter(row => row.needsRecompute).length,
      observations: {
        current: [...observations.values()].filter(row => row.status === 'current').length,
        inferred: [...observations.values()].filter(row => row.kind === 'inferred').length,
        corrections: [...observations.values()].filter(row => row.kind === 'corrected').length,
        proposed: [...observations.values()].filter(row => row.status === 'proposed').length,
        contradictions: [...observations.values()].filter(row => (row.contradicts || []).length).length,
        conditional: [...observations.values()].filter(row => (row.conditionalContradicts || []).length).length,
        expired: [...observations.values()].filter(row => row.status === 'current' && observationExpired(row, Date.now(), ttlConfig)).length,
      },
      portraitFacets: [...portrait.values()].filter(row => row.content.trim()).length,
      assistantFacets: [...selfPortrait.values()].filter(row => row.content.trim()).length,
      entities: buildEntityIndex([...rowsById.values()]).size,
      avgImportance: Number(importance.toFixed(2)),
      workspace: agent ? currentWorkspaceOf(agent) : null,
      scope: defaultScope,
      merged: stats.merged,
      pruned: stats.pruned,
      lastConsolidatedAt: stats.lastConsolidatedAt ? new Date(stats.lastConsolidatedAt).toISOString() : null,
      injection,
      exportPath,
      command: commandName,
      capture: captureEnabled ? 'on' : 'paused',
      storage: storageState,
    };
  };

  const registerAgent = agent => {
    if (setups.has(agent)) return;
    const key = String(agent.id);
    const setup = agent.ctx.effect(() => {
      void restore(agent.id);
      const state = { pendingUser: '', pendingAssistant: '', lastTime: Date.now(), workspace: currentWorkspaceOf(agent), lastUserText: lastUserBySession.get(key) || '' };
      captures.set(key, state);
      const agentLocale = sessionLocaleFor(key);
      const agentLabels = labelsFor(agentLocale);
      const stopTool = agent.ctx.tools.register({
        ...TOOL,
        description: packFor(agentLocale).toolDescription || TOOL.description,
        parameters: {
          ...TOOL.parameters,
          properties: {
            ...TOOL.parameters.properties,
            facet: {
              ...TOOL.parameters.properties.facet,
              enum: [...new Set([...userFacets, ...assistantFacets])],
              description: `User facets: ${userFacets.join(', ')}. Assistant facets (target=assistant): ${assistantFacets.join(', ')}.`,
            },
          },
        },
        async execute(args) {
          const action = args && args.action;
          await restore(agent.id);
          const own = rowsBySession.get(key) || [];
          if (action === 'recent') {
            const wanted = Math.max(1, Math.min(50, Number(args.limit) || recentLimit));
            const scope = args.scope === 'all' || args.scope === 'workspace' ? args.scope : defaultScope;
            const workspace = currentWorkspaceOf(agent);
            const pool = args.allSessions ? [...rowsById.values()] : own;
            const filtered = pool
              .filter(row => cleanUserText(row.user))
              .filter(row => !row.archivedAt)
              .filter(row => scope === 'all' || !row.workspace || row.workspace === workspace)
              .sort((left, right) => left.time - right.time);
            const full = args.full === true;
            const chars = Math.max(80, Math.min(4000, Number(args.snippetChars) || snippetChars));
            const terms = [...new Set(tokensOf(state.lastUserText || ''))];
            return {
              exchanges: filtered.slice(-wanted).map(row => ({
                id: row.id,
                time: new Date(row.time).toISOString(),
                user: full ? row.user : snippetOf(cleanUserText(row.user), terms, chars),
                assistant: full ? row.assistant : snippetOf(row.assistant, terms, chars),
                summary: row.summary,
                supersededBy: row.supersededBy || null,
                impressionUpdatedAt: row.updatedAt && row.updatedAt !== row.time ? new Date(row.updatedAt).toISOString() : null,
              })),
              total: filtered.length,
              full,
              scope,
              storage: storageState,
            };
          }
          if (action === 'search') return search(args, currentWorkspaceOf(agent));
          if (action === 'index') {
            try {
              return await indexUnseen(Number(args.limit) || 10);
            } catch (error) {
              return { error: `index failed: ${String(error)}` };
            }
          }
          if (action === 'repair') {
            try {
              return await repairMissingUser(Number(args.limit) || 5);
            } catch (error) {
              return { error: `repair failed: ${String(error)}` };
            }
          }
          if (action === 'archive' || action === 'restore') {
            const targets = Array.isArray(args.ids) && args.ids.length
              ? args.ids
              : (typeof args.id === 'string' ? [args.id] : []);
            if (action === 'restore') {
              const rows = targets.map(id => rowsById.get(id)).filter(Boolean);
              for (const row of rows) await restoreRow(row);
              return { restored: rows.length, ids: rows.slice(0, 5).map(row => row.id) };
            }
            const selected = selectForArchive([...rowsById.values()], {
              now: Date.now(),
              olderThanDays: Math.max(0, Math.min(36500, Number(args.olderThanDays) || archiveAfterDays)),
              ids: targets,
            });
            for (const row of selected) await archiveRow(row, targets.length ? 'manual' : `older than ${Number(args.olderThanDays) || archiveAfterDays} days`);
            return {
              archived: selected.length,
              weight: archivedWeight,
              ids: selected.slice(0, 5).map(row => row.id),
              hiddenFromDefaultSearch: true,
            };
          }
          if (action === 'entities') return topEntities(Math.max(1, Math.min(50, Number(args.limit) || 15)), typeof args.entity === 'string' ? args.entity : undefined);
          if (action === 'stats') return statsSnapshot(agent);
          if (action === 'identity') {
            const report = identityReport(key);
            return {
              sessionId: key,
              continuity: report.score,
              label: report.label,
              evidence: report.evidence,
              baseline: report.baseline,
              recommendation: report.recommendation,
              note: 'These are measurements distilled from memory, not a verdict. Decide yourself, and confirm with the user before switching portraits.',
            };
          }
          if (action === 'observe') {
            if (typeof args.corroborates === 'string' && args.corroborates) {
              const target = observations.get(args.corroborates);
              if (!target) return { error: 'Unknown observation id in corroborates.' };
              if (target.status !== 'current') return { error: 'Only current observations can be corroborated.' };
              const quote = typeof args.quote === 'string' ? args.quote.trim() : '';
              if (quote.length < 4) {
                return { error: 'corroborates requires quote (>=4 chars) from the current user message; independent corroboration must be verifiable.' };
              }
              const state = captures.get(key);
              let sessionTexts = [
                ...(rowsBySession.get(key) || []).map(row => cleanUserText(row.user)),
                lastUserBySession.get(key) || '',
                state?.pendingUser || '',
                state?.lastUserText || '',
              ];
              if (!findQuoteInTexts(quote, sessionTexts) && sessionQuery) {
                try {
                  const read = await sessionQuery.readSession(key);
                  const events = Array.isArray(read?.events) ? read.events : [];
                  sessionTexts = [...sessionTexts, ...events
                    .filter(event => event.type === 'user/message')
                    .map(event => cleanUserText(messageText(event.data)))];
                } catch {
                  // fall through to the validation error below
                }
              }
              if (!findQuoteInTexts(quote, sessionTexts)) {
                return { error: 'quote not found in this session\'s user messages; refusing to treat it as independent corroboration.' };
              }
              const added = applyCorroboration(target, key, Date.now());
              if (!target.quote) target.quote = quote;
              await persistObservation(target);
              return {
                corroborated: target.id,
                sessionAdded: added,
                sessions: new Set(target.sessions || []).size,
                effectiveConfidence: effectiveObservationConfidence(target, { halfLifeDays: inferenceHalfLifeDays }),
                note: added
                  ? 'Independent session recorded; TTL renewed and confidence boosted (bounded). Quote verified against this session.'
                  : 'Same session already recorded; no change.',
              };
            }
            const epistemic = OBSERVATION_KINDS.includes(args.epistemic) ? args.epistemic : 'observed';
            const text = String(args.content || args.text || '').trim();
            if (!text) return { error: 'content is required for action=observe' };
            if (epistemic === 'inferred' && (!Array.isArray(args.alternatives) || !args.alternatives.length)) {
              return { error: 'inferred observations need at least one alternative explanation (alternatives)' };
            }
            if (epistemic === 'inferred' && !Number.isFinite(args.confidence)) {
              return { error: 'inferred observations need an approximate confidence (0-1)' };
            }
            const row = await addObservation({ ...args, content: text }, epistemic, key);
            const knownSources = (args.sourceIds || []).filter(id => rowsById.has(id) || observations.has(id));
            const lint = lintTraitLabel(text, knownSources, localeFor(text));
            return {
              id: row.id,
              type: row.type,
              kind: row.kind,
              scope: scopeOf(row),
              mention: mentionOf(row),
              status: row.status,
              confidence: row.confidence,
              ...(lint ? { warning: lint } : {}),
            };
          }
          if (action === 'correct') {
            const original = typeof args.id === 'string' ? observations.get(args.id) : undefined;
            if (!original) return { error: 'Unknown observation id.' };
            if (original.status !== 'current') return { error: 'Only current observations can be corrected.' };
            const text = String(args.content || args.text || '').trim();
            if (!text) return { error: 'content is required for action=correct' };
            const at = Date.now();
            const inheritedContradictions = (original.contradicts || []).filter(id => liveObservation(id));
            const correction = {
              id: uuid(),
              type: 'correction',
              text,
              kind: 'corrected',
              confidence: null,
              context: original.context,
              quote: typeof args.quote === 'string' ? args.quote : null,
              alternatives: [],
              sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds : [],
              contradicts: inheritedContradictions,
              conditionalContradicts: [],
              sessions: [...new Set([...(original.sessions || []), key])],
              lastCorroboratedAt: at,
              // Inherit the *derived* scope: `original.scope` is usually undefined on legacy rows.
              scope: scopeOf(original),
              mention: original.mention,
              correctionOf: original.id,
              sensitivity: original.sensitivity,
              status: 'current',
              createdAt: at,
              updatedAt: at,
            };
            observations.set(correction.id, correction);
            // Copy (not move) contradiction links: the original keeps its own history and
            // regains them if the correction is later deleted.
            for (const peerId of inheritedContradictions) {
              const peer = observations.get(peerId);
              if (!peer) continue;
              peer.contradicts = [...new Set([...(peer.contradicts || []), correction.id])];
              peer.updatedAt = at;
              await persistObservation(peer);
            }
            original.status = 'superseded';
            original.updatedAt = at;
            original.supersededBy = correction.id;
            await persistObservation(correction);
            await persistObservation(original);
            await markFacetsStale(original.id);
            return {
              corrected: original.id,
              correctionId: correction.id,
              previous: { text: original.text, kind: original.kind },
              note: 'The original stays in the record as history; the correction is what future answers should use.',
            };
          }
          if (action === 'contradict') {
            const pair = Array.isArray(args.ids) ? args.ids : [];
            const [left, right] = pair.map(id => observations.get(id));
            if (!left || !right) return { error: 'contradict needs two existing observation ids.' };
            const at = Date.now();
            const conditional = args.conditional === true;
            const field = conditional ? 'conditionalContradicts' : 'contradicts';
            left[field] = [...new Set([...(left[field] || []), right.id])];
            right[field] = [...new Set([...(right[field] || []), left.id])];
            left.updatedAt = at;
            right.updatedAt = at;
            await persistObservation(left);
            await persistObservation(right);
            return {
              linked: [left.id, right.id],
              conditional,
              note: conditional
                ? 'Marked as situationally different (different contexts), so it is not counted as an unresolved contradiction.'
                : 'Contradictions are kept, not resolved. Ask the user which holds now.',
            };
          }
          if (action === 'observations') {
            const status = OBSERVATION_STATUS.includes(args.status) ? args.status : 'current';
            const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
            const list = [...observations.values()]
              .filter(row => row.status === status)
              .filter(row => !args.observationType || row.type === args.observationType)
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, limit)
              .map(row => ({
                id: row.id,
                type: row.type,
                kind: row.kind,
                text: row.sensitivity === 'private' && args.includePrivate !== true ? '[private observation]' : row.text,
                scope: scopeOf(row),
                mention: mentionOf(row),
                expired: observationExpired(row, Date.now(), ttlConfig),
                confidence: row.confidence,
                effectiveConfidence: effectiveObservationConfidence(row, { halfLifeDays: inferenceHalfLifeDays }),
                sessions: Array.isArray(row.sessions) ? new Set(row.sessions).size : 0,
                context: row.context,
                alternatives: row.alternatives,
                sensitivity: row.sensitivity,
                status: row.status,
                updatedAt: new Date(row.updatedAt).toISOString(),
                contradicts: row.contradicts,
                conditionalContradicts: row.conditionalContradicts || [],
                correctionOf: row.correctionOf,
              }));
            return { status, total: [...observations.values()].filter(row => row.status === status).length, observations: list };
          }
          if (action === 'reflect') {
            const current = [...observations.values()].filter(row => row.status === 'current');
            const proposals = buildReflectProposals(current, { minSessions: 3 });
            const existing = [...observations.values()].filter(row => row.status === 'proposed' || row.status === 'current');
            const fresh = proposals.filter(proposal => !existing.some(row => jaccard([...new Set(tokensOf(row.text))], [...new Set(tokensOf(proposal.text))]) >= 0.8));
            const at = Date.now();
            const created = [];
            for (const proposal of fresh.slice(0, 5)) {
              const row = {
                id: uuid(),
                type: proposal.type,
                text: proposal.text,
                kind: proposal.kind,
                confidence: proposal.confidence,
                context: null,
                quote: null,
                alternatives: proposal.alternatives,
                sourceIds: proposal.sourceIds,
                contradicts: [],
                conditionalContradicts: [],
                sessions: proposal.sessions,
                lastCorroboratedAt: at,
                correctionOf: null,
                sensitivity: 'normal',
                mention: 'proactive',
                status: 'proposed',
                createdAt: at,
                updatedAt: at,
              };
              observations.set(row.id, row);
              await persistObservation(row);
              created.push({ id: row.id, text: row.text, confidence: row.confidence, sessions: new Set(row.sessions || []).size });
            }
            return {
              proposals: created,
              total: created.length,
              note: 'Proposed drafts are not injected. Review them with action=review (decision=accept|reject).',
            };
          }
          if (action === 'review') {
            const row = typeof args.id === 'string' ? observations.get(args.id) : undefined;
            if (!row) return { error: 'Unknown observation id.' };
            if (row.status !== 'proposed') return { error: 'Only proposed drafts can be reviewed.' };
            const decision = args.decision === 'accept' ? 'accept' : 'reject';
            row.status = decision === 'accept' ? 'current' : 'withdrawn';
            row.updatedAt = Date.now();
            await persistObservation(row);
            return {
              id: row.id,
              status: row.status,
              note: decision === 'accept'
                ? 'Accepted: the observation is now current and may be injected (subject to scope/mention).'
                : 'Rejected: withdrawn and will not be injected.',
            };
          }
          if (action === 'recompute') {
            const target = args.target === ASSISTANT_TARGET ? ASSISTANT_TARGET : USER_TARGET;
            const valid = facetsOf(target);
            if (!valid.includes(args.facet)) return { error: `facet must be one of ${valid.join(', ')} for target=${target}` };
            const row = mapOf(target).get(args.facet);
            if (!row) return { error: 'That facet has no content yet.' };
            const sourceIds = Array.isArray(row.sourceObservationIds) ? row.sourceObservationIds : [];
            const liveObservations = sourceIds
              .map(id => observations.get(id))
              .filter(entry => entry && entry.status === 'current')
              .map(entry => ({ id: entry.id, kind: entry.kind, text: entry.text, confidence: entry.confidence, effectiveConfidence: effectiveObservationConfidence(entry, { halfLifeDays: inferenceHalfLifeDays }) }));
            const staleSourceIds = sourceIds.filter(id => { const entry = observations.get(id); return !entry || entry.status !== 'current'; });
            return {
              facet: row.facet,
              label: labelsOf(target)[row.facet],
              currentContent: row.content,
              updatedAt: new Date(row.updatedAt).toISOString(),
              needsRecompute: row.needsRecompute === true,
              liveObservations,
              staleSourceIds,
              previousContent: (row.history || []).slice(-2).map(entry => ({ content: entry.content, at: new Date(entry.at).toISOString(), sourceObservationIds: entry.sourceObservationIds || [] })),
              note: 'Rewrite with learn (include sourceObservationIds). Nothing is written automatically.',
            };
          }
          if (action === 'duplicates') {
            const pairs = findCrossLayerDuplicates(portrait, [...observations.values()]);
            return {
              pairs,
              total: pairs.length,
              note: 'Cross-layer duplicates between portrait facets and current observations. Review manually; nothing is deleted automatically.',
            };
          }
          if (action === 'export') {
            try {
              return await exportMarkdown();
            } catch (error) {
              return { error: `export failed: ${String(error)}` };
            }
          }
          if (action === 'portrait') {
            const target = args.target === ASSISTANT_TARGET ? ASSISTANT_TARGET : USER_TARGET;
            const valid = facetsOf(target);
            const map = mapOf(target);
            const labels = labelsOf(target);
            const facets = args.facet ? [args.facet].filter(facet => valid.includes(facet)) : valid;
            if (!facets.length) return { error: `facet must be one of ${valid.join(', ')}` };
            return {
              target,
              portrait: facets.map(facet => {
                const row = map.get(facet);
                return {
                  facet,
                  label: labels[facet],
                  content: row?.content || '',
                  updatedAt: row ? new Date(row.updatedAt).toISOString() : null,
                  sourceExchangeIds: row?.sourceExchangeIds || [],
                  ...(args.includeHistory ? { history: (row?.history || []).map(entry => ({ content: entry.content, at: new Date(entry.at).toISOString() })) } : {}),
                };
              }),
              storage: storageState,
            };
          }
          if (action === 'learn') {
            const target = args.target === ASSISTANT_TARGET ? ASSISTANT_TARGET : USER_TARGET;
            const valid = facetsOf(target);
            if (!valid.includes(args.facet)) return { error: `facet must be one of ${valid.join(', ')} for target=${target}` };
            if (typeof args.content !== 'string' || !args.content.trim()) return { error: 'content is required for action=learn' };
            if (target === USER_TARGET && args.facet === 'psychology') {
              const known = (args.sourceObservationIds || []).filter(id => observations.has(id));
              if (!known.length) {
                return { error: 'learn target=user facet=psychology requires at least one existing sourceObservationIds entry: psychological summaries must be traceable to observations.' };
              }
            }
            const row = target === ASSISTANT_TARGET
              ? await writeSelf(args.facet, args.content, args.keywords || [], args.sourceIds || [], args.sourceObservationIds || [])
              : await writePortrait(args.facet, args.content, args.keywords || [], args.sourceIds || [], args.sourceObservationIds || []);
            const knownSources = (args.sourceIds || []).filter(id => rowsById.has(id) || observations.has(id));
            const lint = lintTraitLabel(args.content, knownSources, localeFor(args.content));
            return {
              target,
              updated: {
                facet: row.facet,
                label: labelsOf(target)[row.facet],
                content: row.content,
                keywords: row.keywords.slice(0, 24),
                sourceExchangeIds: row.sourceExchangeIds,
                sourceObservationIds: row.sourceObservationIds,
                previousVersions: row.history.length,
              },
              ...(lint ? { warning: lint } : {}),
            };
          }
          if (action === 'deepen') {
            const row = typeof args.id === 'string' ? rowsById.get(args.id) : undefined;
            if (!row) return { error: 'Unknown exchange id. Read one with action=recent or action=search first.' };
            if (typeof args.summary !== 'string' || !args.summary.trim()) return { error: 'summary is required for action=deepen' };
            const next = args.summary.trim().slice(0, 4000);
            if (row.summary !== next) {
              if (row.summary) row.history = [...(row.history || []), { summary: row.summary, at: row.updatedAt || row.time }].slice(-HISTORY_LIMIT);
              row.summary = next;
              row.updatedAt = Date.now();
            }
            row.keywords = [...new Set([...keywordsOf(args.keywords || [], row.summary), ...row.keywords])].slice(0, MAX_KEYWORDS);
            row.entities = [...new Set([...row.entities, ...entitiesOf(row.summary, ...(args.keywords || []))])].slice(0, MAX_ENTITIES);
            row.importance = Math.min(1, Math.max(row.importance || DEFAULT_IMPORTANCE, 0.8));
            invalidateRow(row);
            await persist(row);
            return {
              updated: {
                id: row.id,
                summary: row.summary,
                updatedAt: new Date(row.updatedAt).toISOString(),
                previousVersions: (row.history || []).length,
                importance: row.importance,
                entities: row.entities.slice(0, 8),
              },
            };
          }
          if (action === 'forget') {
            const forgetTarget = args.target === ASSISTANT_TARGET ? ASSISTANT_TARGET : USER_TARGET;
            const forgetValid = facetsOf(forgetTarget);
            if (!args.id && forgetValid.includes(args.facet)) {
              const map = mapOf(forgetTarget);
              map.delete(args.facet);
              if (forgetTarget === ASSISTANT_TARGET) {
                if (selfTable) await selfTable.delete(`s_${args.facet}`);
              } else if (portraitTable) {
                await portraitTable.delete(`p_${args.facet}`);
              }
              return { clearedFacet: args.facet, target: forgetTarget, label: labelsOf(forgetTarget)[args.facet] };
            }
            if (typeof args.id === 'string' && observations.has(args.id)) {
              const target = observations.get(args.id);
              // If the deleted record was itself a correction, the original becomes current again.
              if (target.correctionOf) {
                const original = observations.get(target.correctionOf);
                if (original && original.status === 'superseded' && original.supersededBy === target.id) {
                  original.status = 'current';
                  original.supersededBy = null;
                  original.updatedAt = Date.now();
                  await persistObservation(original);
                }
              }
              observations.delete(args.id);
              if (observationsTable) await observationsTable.delete(`o_${args.id}`);
              await dropObservationReferences(args.id);
              return { forgotten: args.id, kind: 'observation' };
            }
            const row = typeof args.id === 'string' ? rowsById.get(args.id) : undefined;
            if (!row) return { error: 'Unknown exchange id, observation id, and no valid facet was given.' };
            rowsById.delete(row.id);
            invalidateRow(row);
            dirty.delete(row);
            const list = rowsBySession.get(row.sessionId);
            if (list) {
              const index = list.findIndex(candidate => candidate.id === row.id);
              if (index >= 0) list.splice(index, 1);
            }
            if (table) await table.delete(recordKey(row.id));
            await dropExchangeReferences(row.id);
            return { forgotten: row.id, referencesCleared: true };
          }
          return { error: 'Unknown action; expected recent, search, deepen, forget, portrait, learn, stats, entities or export.' };
        },
      });
      return () => {
        commit(key, state);
        captures.delete(key);
        stopTool();
        setups.delete(agent);
      };
    });
    setups.set(agent, setup);
  };

  const setups = new Map();

  for (const agent of agentsService ? agentsService.list() : []) registerAgent(agent);
  const stopCreated = ctx.on('agent/created', ({ agent }) => registerAgent(agent));
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const setup = setups.get(agent);
    if (setup) setup();
  });

  const commandText = async (invocation, rawInput) => {
    const workspace = currentWorkspaceOf(invocation.agent);
    const input = String(rawInput || '').trim();
    const commandLocale = sessionLocaleFor(invocation.agent.id);
    const commandMessages = packFor(commandLocale).commands || {};
    if (!input || input === 'stats') {
      const snapshot = statsSnapshot(invocation.agent);
      return [
        commandMessages.statsTitle || '动态记忆状态',
        `- 记录：${snapshot.exchanges} 条 / ${snapshot.sessions} 会话`,
        `- 画像：${snapshot.portraitFacets} 个 facet，实体：${snapshot.entities} 个`,
        `- 平均重要度：${snapshot.avgImportance}，未写印象：${snapshot.withoutSummary}`,
        `- 捕获：${snapshot.capture}，存储：${snapshot.storage}，工作区：${workspace || '未知'}`,
      ].join('\n');
    }
    if (input === 'pause' || input === 'resume' || input === 'capture') {
      if (input === 'pause') captureEnabled = false;
      else if (input === 'resume') captureEnabled = true;
      return input === 'capture'
        ? `自动捕获：${captureEnabled ? 'on' : 'paused'}`
        : `自动捕获已${captureEnabled ? '开启' : '暂停'}（/dmem ${captureEnabled ? 'pause' : 'resume'} 可切换）`;
    }
    if (input === 'portrait' || input === 'self') {
      const assistant = input === 'self';
      const facets = assistant ? assistantFacets : userFacets;
      const map = assistant ? selfPortrait : portrait;
      const labels = labelsOf(assistant ? ASSISTANT_TARGET : USER_TARGET, sessionLocaleFor(invocation.agent.id));
      const rows = facets.map(facet => ({ facet, row: map.get(facet) })).filter(({ row }) => row && row.content.trim());
      if (!rows.length) return assistant
        ? '还没有助手画像；先用 dynamic_memory learn target=assistant 写入。'
        : '还没有用户画像；先用 dynamic_memory learn 写入。';
      return [assistant ? '助手画像' : '用户画像', ...rows.map(({ facet, row }) => `- ${labels[facet]}：${row.content}`)].join('\n');
    }
    if (input === 'export') {
      const result = await exportMarkdown();
      return `已导出 ${result.impressions} 条印象到 ${result.path}（${result.bytes} 字节）`;
    }
    if (input.startsWith('search ')) {
      const query = input.slice(7).trim();
      if (!query) return '用法：/memory search <关键词>';
      const result = search({ query, limit: 3 }, workspace);
      if (result.error) return result.error;
      if (!result.matches.length) return `没有找到与「${query}」相关的记忆。`;
      return [
        `与「${query}」相关：`,
        ...result.matches.map((match, index) => `${index + 1}. ${new Date(match.time).toISOString().slice(0, 10)} 用户：${truncate(match.user || '（仅助手回复）', 80)}\n   印象：${truncate(match.summary || '—', 120)}`),
      ].join('\n');
    }
    return commandMessages.methods || '用法：/dmem [stats|portrait|self|export|search <关键词>|pause|resume|capture]';
  };

  const stopCommand = commands
    ? (() => {
        try {
          return commands.register({
            name: 'dmem',
            description: 'Inspect or export the dynamic memory store',
            input: { hint: 'stats | portrait | self | export | search <关键词>' },
            handler: async invocation => {
              try {
                return { kind: 'success', text: await commandText(invocation, invocation.rawInput) };
              } catch (error) {
                return { kind: 'error', text: `memory command failed: ${String(error)}` };
              }
            },
          });
        } catch (error) {
          logger.warn(`dynamic-memory: cannot register /dmem command: ${String(error)}`);
          return undefined;
        }
      })()
    : undefined;
  const commandName = stopCommand ? 'dmem' : null;

  const digestRows = currentSessionId => {
    if (!digestImpressions) return [];
    return [...rowsById.values()]
      .filter(row => row.summary && !row.archivedAt && row.sessionId !== currentSessionId && cleanUserText(row.user))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, digestImpressions);
  };

  const staleFacetSet = now => {
    const stale = new Set();
    for (const facet of [...FACETS, ...SELF_FACETS]) {
      const row = portrait.get(facet) || selfPortrait.get(facet);
      if (row && isStale(row.updatedAt, now, freshDays)) stale.add(facet);
    }
    return stale;
  };

  const stopPrompt = prompts
    ? prompts.context({
        name: 'dynamic-memory-recent',
        order: 940,
        text: assembleContext => {
          const scope = assembleContext && assembleContext.scope;
          const sessionId = scope && scope.id !== undefined ? String(scope.id) : undefined;
          if (!sessionId) return '';
          const rows = rowsBySession.get(sessionId) || [];
          const now = Date.now();
          return renderContext({
            portraitRows: portrait,
            portraitChars,
            portraitBudget,
            selfRows: injectAssistantPortrait ? selfPortrait : undefined,
            selfChars,
            selfBudget,
            digest: digestRows(sessionId),
            digestChars,
            lastUserText: lastUserBySession.get(sessionId) || '',
            legacyRecent: injectRecentExchanges ? rows.slice(-recentLimit) : [],
            recentLimit,
            promptChars,
            gap: computeGapState([...rowsById.values()], now),
            gapDays,
            staleFacets: staleFacetSet(now),
            identity: identityNoticeEnabled ? strongIdentityReport(sessionId) : undefined,
            observations: currentObservations(20),
            locale: sessionLocaleFor(sessionId),
            messages: packFor(sessionLocaleFor(sessionId)).injection,
            facetList: userFacets,
            userLabels: labelsFor(sessionLocaleFor(sessionId)).user,
            selfFacetList: assistantFacets,
            selfLabels: labelsFor(sessionLocaleFor(sessionId)).self,
            observationChars,
            observationBudget,
            stopwords: stopwordsFor(),
            ttl: ttlConfig,
            halfLifeDays: inferenceHalfLifeDays,
            now: Date.now(),
          });
        },
      })
    : undefined;

  const autoIndexTimer = config.autoIndexSessions === false
    ? undefined
    : setTimeout(() => {
        void indexUnseen(Math.max(1, Math.min(50, Number(config.indexBudget) || 10))).catch(error => logger.warn(`dynamic-memory: background index failed: ${String(error)}`));
      }, 3000);
  if (autoIndexTimer && typeof autoIndexTimer.unref === 'function') autoIndexTimer.unref();

  // Warm the token/haystack caches in the background so the first real search is not the slow path.
  const warmupTimer = config.warmup === false
    ? undefined
    : setTimeout(() => {
        try {
          rankExchanges([...rowsById.values()], { query: 'memory 记忆 任务', limit: 1 });
        } catch (error) {
          logger.warn(`dynamic-memory: warmup failed: ${String(error)}`);
        }
      }, 5000);
  if (warmupTimer && typeof warmupTimer.unref === 'function') warmupTimer.unref();

  return ctx.effect(() => async () => {
    if (autoIndexTimer) clearTimeout(autoIndexTimer);
    if (warmupTimer) clearTimeout(warmupTimer);
    stopSessionEvents();
    stopCreated();
    stopDisposed();
    if (stopPrompt) stopPrompt();
    if (stopCommand) stopCommand();
    if (flushTimer) clearTimeout(flushTimer);
    // Run any pending consolidation now instead of dropping it, then flush.
    for (const [sessionKey, timer] of consolidationTimers) {
      clearTimeout(timer);
      try {
        await consolidate(sessionKey);
      } catch (error) {
        logger.warn(`dynamic-memory: final consolidation failed: ${String(error)}`);
      }
    }
    consolidationTimers.clear();
    await flushDirty();
    for (const setup of [...setups.values()]) setup();
    setups.clear();
    // Wait for in-flight writes before closing the domain, otherwise the last
    // rows (captured at dispose time) can be lost or hit a closed backend.
    if (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
    if (domain) await domain.close().catch(error => logger.warn(`dynamic-memory: close failed: ${String(error)}`));
  });
}

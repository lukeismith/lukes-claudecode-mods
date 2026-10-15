// Pure, deterministic logic for repo-quiz. No engine calls and no I/O here:
// everything takes plain values and returns plain values, so it is cheap and
// testable.

import type {
  CitationCounts,
  CodeCitation,
  Counts3,
  FactBatchDraft,
  FactDraft,
  Flaw,
  FocusKind,
  GradeResult,
  ModelFamily,
  QuestionDraft,
  RatingCounts,
  Settings,
  Source,
  SourceCounts,
  StatsSummary,
  SupportVerdict,
  Tally,
  TallyBucket,
  TelemetryRecord,
  Usage,
} from '../types'

// ---------------------------------------------------------------- constants

/** Spawn a fact batch when this many or fewer saved facts remain. */
export const FACT_REFILL_AT = 2
export const REQUIZ_AFTER_MS = 90 * 24 * 3_600_000

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * The models no setting chooses. The question, fact and grade models come
 * from Settings. Each alias resolves to the newest model of its family.
 */
export const MODELS = { flaw: 'opus', support: 'haiku' } as const

const FAMILIES: readonly ModelFamily[] = ['haiku', 'sonnet', 'opus']

/** Question categories, rotated round-robin per repository. */
export const CATEGORIES: readonly string[] = [
  'Architecture and module boundaries',
  'Explain how this code works',
  'System design trade-offs',
  'Debugging scenario',
  'Language semantics and quirks',
  'Concurrency and asynchronous behavior',
  'Testing strategy',
  'Security and trust boundaries',
  'Performance and complexity',
  'Data modeling and API design',
]

// ---------------------------------------------------------------- settings

type NumberField = { fallback: number; min: number; max: number; isInteger: boolean }

// The ranges the Settings doc comments state. The fallbacks are plugin.json's
// defaults, which the engine fills in already; these cover a value it let through.
// Durations and money keep their fractions; counts and days are whole.
const NUMBER_FIELDS: Record<string, NumberField> = {
  questionsPerHour: { fallback: 4, min: 0, max: 20, isInteger: true },
  rapidReplyMinutes: { fallback: 3, min: 0, max: 60, isInteger: false },
  refresherEvery: { fallback: 3, min: 0, max: 20, isInteger: true },
  refresherMinAgeDays: { fallback: 30, min: 1, max: 3650, isInteger: true },
  dailyBudgetUsd: { fallback: 0, min: 0, max: 1000, isInteger: false },
}

/**
 * The value a number setting takes: rounded when it counts something, then
 * clamped to its range; the default when `value` is not a finite number. Null
 * when `field` is not a number setting. The /config hook uses it too, so the
 * menu shows what will apply.
 */
export function clampSetting(field: string, value: unknown): number | null {
  if (!Object.hasOwn(NUMBER_FIELDS, field)) return null
  const spec = NUMBER_FIELDS[field] as NumberField
  // The /config pickers store numbers as strings ("4", "0.50"), and the budget's "no limit" means 0.
  const parsed = typeof value === 'string' ? (value.trim() === 'no limit' ? 0 : Number(value)) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return spec.fallback
  const v = spec.isInteger ? Math.round(parsed) : parsed
  return Math.min(spec.max, Math.max(spec.min, v))
}

// Each entry lines up with CATEGORIES: the short key plugin.json lists, and
// stems of the full name's distinctive words, so "trade-offs", "async" or a
// full name pasted in also select a category.
const CATEGORY_MATCH: readonly { key: string; stems: readonly string[] }[] = [
  { key: 'architecture', stems: ['architect', 'module'] },
  { key: 'how code works', stems: ['explain', 'works'] },
  { key: 'system design', stems: ['system', 'trade-off', 'tradeoff'] },
  { key: 'debugging', stems: ['debug', 'scenario'] },
  { key: 'language semantics', stems: ['language', 'semantic', 'quirk'] },
  { key: 'concurrency', stems: ['concurren', 'async'] },
  { key: 'testing', stems: ['test', 'strategy'] },
  { key: 'security', stems: ['secur', 'trust'] },
  { key: 'performance', stems: ['perf', 'complexity'] },
  { key: 'data modeling', stems: ['data', 'model', 'api'] },
]

/** Comma-separated text (or a list) as trimmed, non-empty entries. */
function commaList(value: unknown): string[] {
  const items = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
  // "none" is the visible default in /config, and means no patterns.
  return items.map((s) => s.trim()).filter((s) => s !== '' && s.toLowerCase() !== 'none')
}

/** Full category names in CATEGORIES order for the tokens that match one; every category when none does. */
function parseCategories(value: unknown): string[] {
  const chosen = new Set<number>()
  for (const raw of commaList(value)) {
    const token = raw.toLowerCase().replace(/\s+/g, ' ')
    CATEGORY_MATCH.forEach((c, i) => {
      if (token === c.key || c.stems.some((stem) => token.includes(stem))) chosen.add(i)
    })
  }
  const picked = CATEGORIES.filter((_, i) => chosen.has(i))
  return picked.length ? picked : [...CATEGORIES]
}

/** The plugin's options as checked Settings: each value of the wrong type or outside its choices becomes the default, and numbers are clamped. Pure. */
export function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const num = (field: string) => clampSetting(field, options[field]) ?? 0
  const pick = <const T extends string>(field: string, choices: readonly T[], fallback: NoInfer<T>): T => {
    const v = options[field]
    return choices.find((c) => c === v) ?? fallback
  }
  const flag = (field: string, fallback: boolean) => {
    const v = options[field]
    return typeof v === 'boolean' ? v : fallback
  }
  return {
    questionsPerHour: num('questionsPerHour'),
    rapidReplyMinutes: num('rapidReplyMinutes'),
    mode: pick('mode', ['questions and facts', 'questions only', 'facts only'], 'questions and facts'),
    refresherEvery: num('refresherEvery'),
    refresherMinAgeDays: num('refresherMinAgeDays'),
    difficulty: pick('difficulty', ['collegiate', 'senior', 'staff'], 'senior'),
    categories: parseCategories(options.categories),
    flawReview: flag('flawReview', true),
    steWriting: flag('steWriting', true),
    sourcePolicy: pick('sourcePolicy', ['official preferred', 'official only'], 'official preferred'),
    excludePaths: commaList(options.excludePaths),
    questionModel: pick('questionModel', FAMILIES, 'opus'),
    questionEffort: pick('questionEffort', ['low', 'medium', 'high'], 'high'),
    factModel: pick('factModel', FAMILIES, 'sonnet'),
    gradeModel: pick('gradeModel', FAMILIES, 'sonnet'),
    dailyBudgetUsd: num('dailyBudgetUsd'),
    openPaneOnStart: flag('openPaneOnStart', true),
    toastOnNewQuestion: flag('toastOnNewQuestion', true),
    statusLine: flag('statusLine', true),
    telemetry: pick('telemetry', ['counts only', 'full', 'off'], 'counts only'),
  }
}

export const DEFAULT_SETTINGS: Settings = readSettings({})

// ---------------------------------------------------------------- choosing

export type ChooseInput = {
  now: number
  /** Gap since the user's previous prompt in ms; null for their first prompt this session. */
  gapMs: number | null
  /** Start times (epoch ms) of questions for this repository; may include ones older than an hour. */
  askedAt: number[]
  hasOpenQuestion: boolean
  isQuestionRunning: boolean
  isPaused: boolean
  isOff: boolean
  spentTodayUsd: number
  /** 0 means no cap. */
  dailyBudgetUsd: number
  /** 0 means facts only. */
  questionsPerHour: number
  /** A prompt this soon after the last gets a fact; 0 turns the rule off. */
  rapidReplyMs: number
  mode: Settings['mode']
}

export type ChooseReason =
  | 'off'
  | 'paused'
  | 'mode'
  | 'rate-limit'
  | 'rapid'
  | 'open-question'
  | 'question-running'
  | 'budget'

/**
 * `none` when off or paused (reasons say which). Otherwise `question` when every
 * rule passes, else `fact` with every failing rule listed in `reasons`.
 * Reaching the budget yields `fact` (saved facts cost nothing). Facts only (or
 * 0 questions per hour) fails the `mode` rule every time; questions only
 * yields `none` where a fact would have been chosen.
 */
export function chooseCard(input: ChooseInput): {
  kind: 'question' | 'fact' | 'none'
  reasons: ChooseReason[]
} {
  const reasons: ChooseReason[] = []
  if (input.isOff) reasons.push('off')
  if (input.isPaused) reasons.push('paused')
  if (reasons.length) return { kind: 'none', reasons }

  const isFactsOnly = input.mode === 'facts only' || input.questionsPerHour <= 0
  const lastHour = input.askedAt.filter((t) => input.now - t < HOUR_MS).length
  if (isFactsOnly) reasons.push('mode')
  if (input.questionsPerHour > 0 && lastHour >= input.questionsPerHour) reasons.push('rate-limit')
  if (input.rapidReplyMs > 0 && input.gapMs !== null && input.gapMs <= input.rapidReplyMs) reasons.push('rapid')
  if (input.hasOpenQuestion) reasons.push('open-question')
  if (input.isQuestionRunning) reasons.push('question-running')
  if (isOverBudget(input.spentTodayUsd, input.dailyBudgetUsd)) reasons.push('budget')
  if (!reasons.length) return { kind: 'question', reasons }
  return { kind: input.mode === 'questions only' && !isFactsOnly ? 'none' : 'fact', reasons }
}

/** True when today's estimate has reached a non-zero cap. */
export function isOverBudget(spentTodayUsd: number, dailyBudgetUsd: number): boolean {
  return dailyBudgetUsd > 0 && spentTodayUsd >= dailyBudgetUsd
}

/** True when the question with this 0-based per-repository counter is a refresher: every `every`-th one, never when `every` is 0. */
export function isRefresherTurn(questionCounter: number, every: number): boolean {
  return every > 0 && questionCounter % every === every - 1
}

/** The enabled category at `index` (wrapping) and the index to store for next time. An empty list falls back to every category. */
export function nextCategory(index: number, categories: readonly string[]): { category: string; nextIndex: number } {
  const list = categories.length ? categories : CATEGORIES
  const n = list.length
  const i = ((Math.trunc(index) % n) + n) % n || 0
  return { category: list[i] ?? '', nextIndex: (i + 1) % n }
}

// The read-only command and path checks for the agents live in hooks/guard.py,
// a settings PreToolUse hook: the mod never sees its own agents' tool calls.

// ---------------------------------------------------------------- parsing

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function tryParse(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return null
  }
}

// A block opens with a line that is exactly the fence and closes with ``` on a
// line of its own. Strict JSON escapes newlines inside strings, so a fence
// inside a string value never starts a line and is never taken for the close.
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm
const BARE_FENCE = /^```[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm

/** The last ```json fenced block in `text` (or, failing that, the last top-level {...}), parsed; null when none parses. A bare ``` block is tried before the brace scan. */
export function extractJson(text: string): unknown {
  for (const fence of [JSON_FENCE, BARE_FENCE]) {
    const blocks = [...text.matchAll(fence)].map((m) => m[1] ?? '')
    for (const block of blocks.reverse()) {
      const parsed = tryParse(block)
      if (parsed) return parsed.value
    }
  }
  return lastTopLevelObject(text)
}

/** The last balanced {...} that parses and is not inside an earlier one that parses. */
function lastTopLevelObject(text: string): unknown {
  // ponytail: rescans from each '{' until one parses, O(n²) on text full of
  // stray braces; agent replies are a few kilobytes, so it stays cheap.
  let found: unknown = null
  for (let start = text.indexOf('{'); start !== -1; ) {
    const end = matchingBrace(text, start)
    const parsed = end === -1 ? null : tryParse(text.slice(start, end + 1))
    if (parsed && isObj(parsed.value)) {
      found = parsed.value
      start = text.indexOf('{', end + 1)
    } else {
      start = text.indexOf('{', start + 1)
    }
  }
  return found
}

function matchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function parseCitation(v: unknown): CodeCitation | null {
  if (!isObj(v) || !nonEmpty(v.path) || !nonEmpty(v.quote)) return null
  const line = typeof v.line === 'string' ? Number(v.line) : v.line
  if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return null
  return { path: v.path, line: Math.trunc(line), quote: v.quote }
}

function parseSource(v: unknown): Source | null {
  if (!isObj(v) || !nonEmpty(v.url) || !nonEmpty(v.claim) || !nonEmpty(v.quote)) return null
  // Web links only: the pane renders these as clickable.
  if (!/^https?:\/\//i.test(v.url)) return null
  return { title: nonEmpty(v.title) ? v.title : v.url, url: v.url, claim: v.claim, quote: v.quote }
}

function parseFlaw(v: unknown): Flaw | null {
  if (!isObj(v) || !nonEmpty(v.summary)) return null
  const severity = typeof v.severity === 'string' ? v.severity.toLowerCase() : ''
  if (severity !== 'low' && severity !== 'medium' && severity !== 'high') return null
  return { summary: v.summary, severity, evidence: list(v.evidence, parseCitation) }
}

/** The well-formed items of an array; [] when it is missing or not an array. */
function list<T>(v: unknown, parse: (item: unknown) => T | null): T[] {
  return Array.isArray(v) ? v.map(parse).filter((x): x is T => x !== null) : []
}

/** The combined question text: `context`, a blank line, then `ask`, or `ask` alone when there is no context. */
export function joinQuestion(context: string, ask: string): string {
  return context.trim() === '' ? ask : `${context}\n\n${ask}`
}

/**
 * A QuestionDraft with every required field of the right type, or null.
 * Missing arrays become []; a missing flaw becomes null. A reply in the
 * older shape, with `question` and no `ask`, becomes an ask with no context.
 */
export function parseQuestion(text: string): QuestionDraft | null {
  const v = extractJson(text)
  // ask (or a legacy question) and answer are required. topic and category default to '' because
  // code chose the category already, and a paid run should not be lost to a label.
  if (!isObj(v) || !nonEmpty(v.answer)) return null
  const ask = nonEmpty(v.ask) ? v.ask.trim() : nonEmpty(v.question) ? v.question : null
  if (ask === null) return null
  const context = nonEmpty(v.ask) && typeof v.context === 'string' ? v.context.trim() : ''
  return {
    topic: typeof v.topic === 'string' ? v.topic : '',
    category: typeof v.category === 'string' ? v.category : '',
    context,
    ask,
    question: joinQuestion(context, ask),
    answer: v.answer,
    citations: list(v.citations, parseCitation),
    sources: list(v.sources, parseSource),
    flaw: parseFlaw(v.flaw),
  }
}

function parseFact(v: unknown): FactDraft | null {
  if (!isObj(v) || !nonEmpty(v.text)) return null
  return {
    topic: typeof v.topic === 'string' ? v.topic : '',
    text: v.text,
    citations: list(v.citations, parseCitation),
    sources: list(v.sources, parseSource),
    flaw: parseFlaw(v.flaw),
  }
}

/** A FactBatchDraft keeping only well-formed facts; null when none are. */
export function parseFactBatch(text: string): FactBatchDraft | null {
  const v = extractJson(text)
  const facts = list(isObj(v) ? v.facts : v, parseFact)
  return facts.length ? { facts } : null
}

export function parseGrade(text: string): GradeResult | null {
  const v = extractJson(text)
  if (!isObj(v) || typeof v.verdict !== 'string' || typeof v.feedback !== 'string') return null
  const verdict = v.verdict.toLowerCase().replace(/[_-]+/g, ' ').trim()
  if (verdict !== 'correct' && verdict !== 'partially correct' && verdict !== 'incorrect') return null
  return { verdict, feedback: v.feedback }
}

export function parseFlawVerdict(text: string): { isConfirmed: boolean; reason: string } | null {
  const v = extractJson(text)
  if (!isObj(v) || typeof v.isConfirmed !== 'boolean') return null
  return { isConfirmed: v.isConfirmed, reason: typeof v.reason === 'string' ? v.reason : '' }
}

export function parseSupport(text: string): SupportVerdict | null {
  const v = extractJson(text)
  const verdict = isObj(v) && typeof v.verdict === 'string' ? v.verdict.toLowerCase().trim() : ''
  return verdict === 'yes' || verdict === 'partial' || verdict === 'no' ? verdict : null
}

// ---------------------------------------------------------------- cost

export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }

/** USD per million tokens, by model family. Source and date in a comment beside it. */
// The 5.5 prices, from https://platform.claude.com/docs/en/about-claude/pricing.md,
// confirmed on 2026-10-09. The settings name aliases, and an alias resolves to
// the newest model of its family, so update this table when a family's newest
// model changes price. cacheWrite is the 5-minute rate, because the engine's
// usage does not say which duration was used. Opus and Sonnet 5.5 cache reads
// are 0.05x input.
export const PRICES: Record<ModelFamily, Price> = {
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  // ponytail: Haiku 5.5 at its rate for prompts up to 100K tokens. A request
  // over 100K prompt tokens pays 5x ($0.50 / $2.50 / $0.625 / $0.05); price per
  // request if a Haiku job ever sends prompts that large.
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
}

/** USD per web search. */
// $10 per 1,000 searches, from the same page on the same date as PRICES.
export const WEB_SEARCH_USD = 0.01

/** The family a model alias or id names (`opus` and `claude-opus-5-5` are both opus), or null. */
export function modelFamily(model: string): ModelFamily | null {
  const m = model.toLowerCase()
  return FAMILIES.find((family) => m.includes(family)) ?? null
}

// ponytail: rough per-question figures from early runs; the measured average replaces them once telemetry has history.
const QUESTION_USD_GUESS: Record<ModelFamily, number> = { haiku: 0.02, sonnet: 0.22, opus: 0.45 }

/** The price shown on the "New question" button: the measured average per question when there is one, else a rough figure for the model's family (Opus when unrecognized). */
export function estimateQuestionUsd(model: string, measuredUsd: number | null): number {
  return measuredUsd !== null && measuredUsd > 0 ? measuredUsd : QUESTION_USD_GUESS[modelFamily(model) ?? 'opus']
}

/** Estimated USD for one run, priced by the model's family. An unrecognized model is priced as Opus (the dearest), never as zero. */
export function costOf(usage: Usage, model: string, searches?: number): number {
  const p = PRICES[modelFamily(model) ?? 'opus']
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const tokens =
    n(usage.input_tokens) * p.input +
    n(usage.output_tokens) * p.output +
    n(usage.cache_creation_input_tokens) * p.cacheWrite +
    n(usage.cache_read_input_tokens) * p.cacheRead
  return tokens / 1_000_000 + n(searches) * WEB_SEARCH_USD
}

/** Rough USD before a call: promptChars / 4 input tokens plus expectedOutputTokens output tokens. */
export function estimateUsd(model: string, promptChars: number, expectedOutputTokens: number): number {
  return costOf(
    { input_tokens: promptChars / 4, output_tokens: expectedOutputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    model,
  )
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Local-time `YYYY-MM-DD`. */
export function dayKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Local-time `YYYY-MM`. */
export function monthKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

function addRun(bucket: TallyBucket | undefined, job: string, model: string, usd: number): TallyBucket {
  const b = bucket ?? { usd: 0, runs: 0, byJob: {}, byModel: {} }
  const bump = (c: { usd: number; runs: number } | undefined) => ({ usd: (c?.usd ?? 0) + usd, runs: (c?.runs ?? 0) + 1 })
  return {
    ...bump(b),
    byJob: { ...b.byJob, [job]: bump(b.byJob[job]) },
    byModel: { ...b.byModel, [model]: bump(b.byModel[model]) },
  }
}

/**
 * Adds one run to the tally (creating it when undefined). A different
 * sessionId resets `session`. Prunes `days` to the last 60. Returns a new object.
 */
export function addToTally(
  tally: Tally | undefined,
  entry: { sessionId: string; now: number; job: string; model: string; usd: number },
): Tally {
  const { sessionId, now, job, model, usd } = entry
  const day = dayKey(now)
  const month = monthKey(now)
  const days: Record<string, TallyBucket> = { ...tally?.days, [day]: addRun(tally?.days[day], job, model, usd) }
  // YYYY-MM-DD keys sort chronologically as strings.
  const keep = Object.keys(days).sort().slice(-60)
  return {
    sessionId,
    session: addRun(tally?.sessionId === sessionId ? tally.session : undefined, job, model, usd),
    days: Object.fromEntries(keep.flatMap((k) => (days[k] ? [[k, days[k]]] : []))),
    months: { ...tally?.months, [month]: addRun(tally?.months[month], job, model, usd) },
    lifetime: addRun(tally?.lifetime, job, model, usd),
  }
}

/** Today's and this session's USD from a tally (0 when absent or stale session). */
export function costLine(tally: Tally | undefined, sessionId: string, now: number): { todayUsd: number; sessionUsd: number } {
  return {
    todayUsd: tally?.days[dayKey(now)]?.usd ?? 0,
    sessionUsd: tally?.sessionId === sessionId ? tally.session.usd : 0,
  }
}

/** `$0.84`, `4¢`, `<1¢`. */
export function formatUsd(usd: number): string {
  if (!(usd > 0)) return '$0.00'
  if (usd < 0.01) return '<1¢'
  if (usd < 0.095) return `${Math.round(usd * 100)}¢`
  return `$${usd.toFixed(2)}`
}

/** The last segment of a slash-separated path, ignoring trailing slashes; '' for an empty path. */
export function baseName(path: string): string {
  return path.split('/').filter((part) => part !== '').pop() ?? ''
}

// ---------------------------------------------------------------- quotes and citations

/** Collapses whitespace runs to one space and trims; used on both sides of every quote comparison. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Finds `quote` (normalized, case-sensitive) in `fileText`. `exact` when it is
 * on a line within 3 of `line` (1-based; a quote may span lines); `moved` with
 * the corrected line when it is elsewhere; null when it is nowhere.
 */
export function matchQuote(fileText: string, line: number, quote: string): { line: number; status: 'exact' | 'moved' } | null {
  const q = normalize(quote)
  if (!q) return null
  // Normalize the file the same way, remembering the line of each kept character.
  let flat = ''
  const lineOf: number[] = []
  let current = 1
  for (let i = 0; i < fileText.length; i++) {
    const c = fileText[i] ?? ''
    if (/\s/.test(c)) {
      if (flat && !flat.endsWith(' ')) {
        flat += ' '
        lineOf.push(current)
      }
      if (c === '\n') current++
    } else {
      flat += c
      lineOf.push(current)
    }
  }
  let nearest: number | null = null
  for (let i = flat.indexOf(q); i !== -1; i = flat.indexOf(q, i + 1)) {
    const start = lineOf[i] ?? 1
    const end = lineOf[i + q.length - 1] ?? start
    if (line >= start - 3 && line <= end + 3) return { line, status: 'exact' }
    if (nearest === null || Math.abs(start - line) < Math.abs(nearest - line)) nearest = start
  }
  return nearest === null ? null : { line: nearest, status: 'moved' }
}

function fileLines(text: string): string[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Lines start..end (1-based, inclusive, clamped) of `text`, each prefixed with its number, for an excerpt. */
export function numberedLines(text: string, start: number, end: number): string {
  const lines = fileLines(text)
  const s = Math.max(1, Math.trunc(start))
  const e = Math.min(lines.length, Math.trunc(end))
  const width = String(e).length
  const out: string[] = []
  for (let n = s; n <= e; n++) out.push(`${String(n).padStart(width)}\t${lines[n - 1]}`)
  return out.join('\n')
}

const SKIP_DIRS =
  /(^|\/)(node_modules|vendor|third[_-]party|Pods|Carthage|\.build|bower_components|dist|build|out|target|DerivedData|\.next|\.nuxt|coverage|__pycache__|\.git|\.venv|venv|\.yarn|\.gradle|\.idea|\.swiftpm|[Gg]enerated|__generated__)\//
const SKIP_FILES =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Podfile\.lock|Package\.resolved|go\.sum|mix\.lock|flake\.lock|packages\.lock\.json|\.DS_Store)$|\.lock$|\.min\.(js|css)$|\.map$|\.generated\.|\.g\.dart$|\.pb\.(go|swift)$|_pb2\.py$|\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|heic|svg|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|dat|db|sqlite3?|mp3|mp4|m4a|wav|mov|avi|ttf|otf|woff2?|eot|psd|eps|ai|sketch|car|nib|mlmodel|pyc|pbxproj|xcuserstate)$/i

/** True for paths a quiz should never focus on: lockfiles, vendored and generated code, build output, binaries, images, minified files. */
export function isSkippablePath(path: string): boolean {
  return SKIP_DIRS.test(path) || SKIP_FILES.test(path)
}

// Compiled once per pattern: a refresher pick tests up to a thousand paths against each.
const globCache = new Map<string, { regex: RegExp; isBasename: boolean }>()

function compileGlob(glob: string): { regex: RegExp; isBasename: boolean } {
  const cached = globCache.get(glob)
  if (cached) return cached
  // Paths are root-relative, so a leading `/` or `./` anchors at the root, and a trailing `/` means everything inside.
  let g = glob.trim().replace(/^(\.\/|\/)+/, '')
  if (g.endsWith('/')) g += '**'
  let src = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] ?? ''
    if (c === '*' && g[i + 1] === '*') {
      // `**/` at a segment start also matches no directory at all, so `**/x` matches `x`.
      const isDirs = g[i + 2] === '/' && (i === 0 || g[i - 1] === '/')
      src += isDirs ? '(?:.*/)?' : '.*'
      i += isDirs ? 2 : 1
    } else if (c === '*') src += '[^/]*'
    else if (c === '?') src += '[^/]'
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const compiled = { regex: new RegExp(`^${src}$`), isBasename: !g.includes('/') }
  globCache.set(glob, compiled)
  return compiled
}

/**
 * True when `path` (root-relative) matches one of `globs`. `**` matches
 * across slashes, `*` within one segment and `?` one character; a pattern
 * without a slash matches the file's basename, so `*.pb.swift` matches at any depth.
 */
export function isExcludedPath(path: string, globs: readonly string[]): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return globs.some((glob) => {
    if (glob.trim() === '') return false
    const { regex, isBasename } = compileGlob(glob)
    return regex.test(isBasename ? base : path)
  })
}

// Top level means no indentation, which holds across these languages.
const DEFINITION =
  /^(?:(?:export|public|private|internal|fileprivate|open|final|static|abstract|async|default|unsafe|extern|sealed|data|override|pub(?:\([^)]*\))?|@\w+(?:\([^)]*\))?)\s+)*(?:func|function\*?|def|class|struct|enum|protocol|interface|fn|impl|type|typealias|extension|trait|actor|object|module|record|const)\b/

/** 1-based lines of top-level definitions found by a language-agnostic regex (func, function, def, class, struct, enum, protocol, interface, fn, impl, type, extension, ...). */
export function findDefinitionLines(text: string): number[] {
  return fileLines(text).flatMap((l, i) => (DEFINITION.test(l) ? [i + 1] : []))
}

/** A window of about `radius` lines either side of `center`, clamped to the file. The excerpt is numberedLines text. */
export function excerptWindow(text: string, center: number, radius: number): { startLine: number; endLine: number; excerpt: string } {
  const total = fileLines(text).length
  const c = Math.min(Math.max(1, Math.trunc(center)), Math.max(1, total))
  const startLine = Math.max(1, c - radius)
  const endLine = Math.min(total, c + radius)
  return { startLine, endLine, excerpt: numberedLines(text, startLine, endLine) }
}

/**
 * Rewrites a question's or fact's text after verification. A Markdown link to
 * one of `droppedUrls` loses its link (`[title](url)` becomes `title`), and each
 * inline `path:from` reference becomes `path:to`. References match whole, so a
 * move of `a.ts:4` leaves `a.ts:40` and `src/a.ts:4` alone, and all moves apply
 * in one pass, so chained moves do not compound.
 */
export function scrubAnswerText(text: string, droppedUrls: string[], moves: { path: string; from: number; to: number }[]): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = text
  for (const url of droppedUrls) {
    if (!url) continue
    // The URL is matched literally, so parentheses inside it (Apple's `append(_:)`) are fine.
    out = out.replace(new RegExp(`!?\\[([^\\]]*)\\]\\(<?${escape(url)}>?(?:\\s+"[^"]*")?\\)`, 'g'), '$1')
  }
  const target = new Map<string, string>()
  for (const m of moves) {
    const from = `${m.path}:${m.from}`
    if (m.from !== m.to && !target.has(from)) target.set(from, `${m.path}:${m.to}`)
  }
  if (!target.size) return out
  const refs = new RegExp(`(^|[^\\w./-])(${[...target.keys()].map(escape).join('|')})(?!\\d)`, 'g')
  return out.replace(refs, (_, before: string, ref: string) => before + (target.get(ref) ?? ref))
}

// ---------------------------------------------------------------- focus

/**
 * The best recent-focus path, or null. Scores: touched this session highest,
 * then uncommitted, then recently committed (earlier in the list = more recent).
 * Excludes skippable paths, paths matching the `exclude` globs, and `recentFoci`.
 */
export function pickRecentPath(input: {
  touched: string[]
  uncommitted: string[]
  recentlyCommitted: string[]
  recentFoci: string[]
  exclude: readonly string[]
}): string | null {
  const touched = new Set(input.touched)
  const uncommitted = new Set(input.uncommitted)
  const committed = new Set(input.recentlyCommitted)
  const avoid = new Set(input.recentFoci)
  const score = (p: string) => (touched.has(p) ? 4 : 0) + (uncommitted.has(p) ? 2 : 0) + (committed.has(p) ? 1 : 0)
  let best: string | null = null
  // Ties keep the first seen, so list order (and commit recency) breaks them.
  for (const p of [...input.touched, ...input.uncommitted, ...input.recentlyCommitted]) {
    if (avoid.has(p) || isSkippablePath(p) || isExcludedPath(p, input.exclude)) continue
    if (best === null || score(p) > score(best)) best = p
  }
  return best
}

/**
 * A refresher path, or null. Candidates are paths in `lastChanged` that are not
 * skippable, not excluded by the `exclude` globs, not touched, not quizzed
 * within REQUIZ_AFTER_MS, and older than `minAgeMs` (or, when none are that
 * old, in the oldest third). Picks one with `random()` weighted by
 * min(size, 50_000) from `sizes`. A path missing from `sizes` (deleted since,
 * so absent from HEAD) is never picked.
 */
export function pickRefresherPath(input: {
  lastChanged: Record<string, number>
  sizes: Record<string, number>
  touched: string[]
  lastQuizzed: Record<string, number>
  now: number
  minAgeMs: number
  exclude: readonly string[]
  random: () => number
}): { path: string; lastChangedAt: number } | null {
  const { now } = input
  const touched = new Set(input.touched)
  const weight = (p: string) => Math.min(input.sizes[p] ?? 0, 50_000)
  const eligible = Object.entries(input.lastChanged)
    .filter(([p]) => weight(p) > 0 && !isSkippablePath(p) && !touched.has(p) && !isExcludedPath(p, input.exclude))
    .filter(([p]) => !(now - (input.lastQuizzed[p] ?? -Infinity) < REQUIZ_AFTER_MS))
    .sort((a, b) => a[1] - b[1])
  let pool = eligible.filter(([, t]) => now - t > input.minAgeMs)
  if (!pool.length) pool = eligible.slice(0, Math.ceil(eligible.length / 3))
  const total = pool.reduce((sum, [p]) => sum + weight(p), 0)
  let r = input.random() * total
  for (const [path, lastChangedAt] of pool) {
    r -= weight(path)
    if (r < 0) return { path, lastChangedAt }
  }
  // Only reached when random() returns 1 or more.
  const last = pool[pool.length - 1]
  return last ? { path: last[0], lastChangedAt: last[1] } : null
}

/** Parses `git log --format=%x00%ct --name-only` output into each path's most recent change, in epoch ms. */
export function parseLastChanged(gitLogOutput: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const commit of gitLogOutput.split('\0')) {
    const [stamp, ...paths] = commit.split('\n')
    const t = Number(stamp) * 1000
    if (!stamp || !Number.isFinite(t)) continue
    for (const p of paths) if (p && t > (out[p] ?? 0)) out[p] = t
  }
  return out
}

/** Parses `git ls-tree -r -l HEAD` output into path to size in bytes (blobs only). */
export function parseSizes(lsTreeOutput: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lsTreeOutput.split('\n')) {
    const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line)
    if (m?.[1] && m[2]) out[m[2]] = Number(m[1])
  }
  return out
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** "3 months", "2 years", "12 days". */
export function formatAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS)
  if (days < 1) return 'less than a day'
  if (days < 30) return plural(days, 'day')
  const months = Math.floor(days / 30.44)
  if (months < 12) return plural(months, 'month')
  return plural(Math.floor(days / 365.25), 'year')
}

// ---------------------------------------------------------------- documentation hosts

const ECOSYSTEM_BY_EXT: Record<string, string> = {
  swift: 'swift', m: 'objc', mm: 'objc',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  php: 'php', scala: 'scala', dart: 'dart', ex: 'elixir', exs: 'elixir', hs: 'haskell', lua: 'lua',
  sh: 'shell', bash: 'shell', zsh: 'shell', html: 'web', css: 'web', scss: 'web',
}

const ECOSYSTEM_BY_FILE: Record<string, string> = {
  'Package.swift': 'swift', 'package.json': 'javascript', 'tsconfig.json': 'typescript',
  'pyproject.toml': 'python', 'requirements.txt': 'python', 'setup.py': 'python', 'go.mod': 'go',
  'Cargo.toml': 'rust', 'pom.xml': 'java', 'build.gradle': 'java', 'build.gradle.kts': 'kotlin',
  'Gemfile': 'ruby', 'CMakeLists.txt': 'cpp', 'composer.json': 'php', 'pubspec.yaml': 'dart',
  'mix.exs': 'elixir', 'build.sbt': 'scala',
}

// Each host also covers its subdomains (isOfficialUrl), so python.org covers docs.python.org.
const HOSTS_BY_ECOSYSTEM: Record<string, string[]> = {
  swift: ['developer.apple.com', 'swift.org'],
  objc: ['developer.apple.com', 'clang.llvm.org'],
  javascript: ['developer.mozilla.org', 'nodejs.org', 'tc39.es', 'ecma-international.org', 'docs.npmjs.com'],
  typescript: ['typescriptlang.org', 'developer.mozilla.org', 'nodejs.org', 'tc39.es'],
  python: ['python.org'],
  go: ['go.dev', 'golang.org'],
  rust: ['rust-lang.org', 'docs.rs'],
  java: ['docs.oracle.com', 'openjdk.org', 'dev.java'],
  kotlin: ['kotlinlang.org', 'developer.android.com'],
  ruby: ['ruby-lang.org', 'ruby-doc.org'],
  csharp: ['learn.microsoft.com'],
  c: ['cppreference.com', 'open-std.org', 'man7.org', 'pubs.opengroup.org'],
  cpp: ['cppreference.com', 'isocpp.org', 'open-std.org'],
  php: ['php.net'],
  scala: ['scala-lang.org'],
  dart: ['dart.dev', 'flutter.dev'],
  elixir: ['elixir-lang.org', 'hexdocs.pm'],
  haskell: ['haskell.org'],
  lua: ['lua.org'],
  shell: ['gnu.org', 'pubs.opengroup.org', 'man7.org'],
  web: ['developer.mozilla.org', 'w3.org', 'whatwg.org'],
}

const GENERAL_HOSTS = ['developer.mozilla.org', 'git-scm.com', 'rfc-editor.org', 'datatracker.ietf.org', 'owasp.org', 'unicode.org']

/** Ecosystem names (swift, javascript, typescript, python, go, rust, java, kotlin, ruby, csharp, cpp, ...) from a repository's tracked paths and manifest files, most files first. */
export function ecosystemsFromPaths(paths: string[]): string[] {
  const counts = new Map<string, number>()
  for (const p of paths) {
    if (isSkippablePath(p)) continue
    const name = p.slice(p.lastIndexOf('/') + 1)
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    const eco =
      ECOSYSTEM_BY_FILE[name] ??
      (/\.(csproj|sln)$/.test(name) ? 'csharp' : undefined) ??
      (p.includes('.xcodeproj/') ? 'swift' : undefined) ??
      ECOSYSTEM_BY_EXT[ext]
    if (eco) counts.set(eco, (counts.get(eco) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([eco]) => eco)
}

/** Official documentation hosts for the ecosystems, plus always-on general hosts (developer.mozilla.org, git-scm.com, www.rfc-editor.org, datatracker.ietf.org, owasp.org, ...). */
export function officialHostsFor(ecosystems: string[]): string[] {
  return [...new Set([...ecosystems.flatMap((e) => HOSTS_BY_ECOSYSTEM[e] ?? []), ...GENERAL_HOSTS])]
}

/** True when the URL's host equals or is a subdomain of one of `hosts`. */
export function isOfficialUrl(url: string, hosts: string[]): boolean {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    host = u.hostname.toLowerCase()
  } catch {
    return false
  }
  return hosts.some((h) => {
    const base = h.toLowerCase()
    return host === base || host.endsWith(`.${base}`)
  })
}

/** The verified sources a card keeps under the policy: `official only` drops each one verifySources marked non-official. */
export function applySourcePolicy(sources: Source[], policy: Settings['sourcePolicy']): Source[] {
  return policy === 'official only' ? sources.filter((s) => s.isOfficial !== false) : sources
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', times: '×',
}
// Inline tags vanish without a space, so `<code>map</code>()` reads `map()` and quotes still match.
const INLINE_TAGS = /^(a|abbr|b|bdi|bdo|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i

/** Strips scripts, styles and tags, decodes common entities, collapses whitespace. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g, (_, tag: string) => (INLINE_TAGS.test(tag) ? '' : ' '))
    // One pass, so `&amp;lt;` decodes to the literal text `&lt;` as the page meant.
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
  return normalize(text)
}

// Arrays under these keys are runs of inline text, joined without spaces.
const APPLE_INLINE = new Set(['inlineContent', 'abstract', 'tokens'])

/** The text of an Apple documentation JSON payload (abstract, discussion, declarations), flattened. */
export function appleJsonToText(json: unknown): string {
  if (!isObj(json)) return ''
  const refs = isObj(json.references) ? json.references : {}
  const walk = (node: unknown, sep: string): string => {
    if (Array.isArray(node)) return node.map((n) => walk(n, sep)).join(sep)
    if (!isObj(node)) return ''
    if (node.type === 'reference' && typeof node.identifier === 'string') {
      const ref = refs[node.identifier]
      return isObj(ref) && typeof ref.title === 'string' ? ref.title : ''
    }
    const parts: string[] = []
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'text' || key === 'code') && typeof value === 'string') parts.push(value)
      else if (key === 'code' && Array.isArray(value)) parts.push(value.filter((s) => typeof s === 'string').join('\n'))
      else if (typeof value === 'object' && value !== null) parts.push(walk(value, APPLE_INLINE.has(key) ? '' : ' '))
    }
    return parts.join(' ')
  }
  const title = isObj(json.metadata) && typeof json.metadata.title === 'string' ? json.metadata.title : ''
  // Only the page's own content: `references` also holds other pages' abstracts.
  return normalize([title, walk(json.abstract, ''), walk(json.primaryContentSections, ' '), walk(json.sections, ' ')].join(' '))
}

/** For https://developer.apple.com/documentation/<path>, the JSON endpoint https://developer.apple.com/tutorials/data/documentation/<path>.json; null for any other URL. */
export function appleDocJsonUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname !== 'developer.apple.com' || !u.pathname.startsWith('/documentation/')) return null
    // The JSON endpoint is lowercase; the HTML pages redirect mixed case to it.
    const path = u.pathname.replace(/\/+$/, '').toLowerCase()
    return `https://developer.apple.com/tutorials/data${path}.json`
  } catch {
    return null
  }
}

/** Index of `quote` in `text` after normalizing both and ignoring case; -1 when absent. */
export function findQuote(text: string, quote: string): number {
  const q = normalize(quote).toLowerCase()
  return q ? normalize(text).toLowerCase().indexOf(q) : -1
}

/** About `chars` characters of normalized `text` centred on the quote at `index`. */
export function passageAround(text: string, index: number, chars: number): string {
  const t = normalize(text)
  const end = Math.min(t.length, Math.max(0, index - Math.floor(chars / 2)) + chars)
  return t.slice(Math.max(0, end - chars), end)
}

// ---------------------------------------------------------------- telemetry and stats

/** A short unique id: base36 time plus random. */
export function newId(now: number, random: () => number): string {
  return Math.trunc(now).toString(36) + Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')
}

const zero3 = (): Counts3 => ({ gotIt: 0, partly: 0, missed: 0 })
const zeroRatings = (): RatingCounts => ({ useful: 0, notUseful: 0, wrong: 0, alreadyKnew: 0 })
const zeroCitations = (): CitationCounts => ({ total: 0, verified: 0, corrected: 0, dropped: 0 })
const zeroSources = (): SourceCounts => ({ total: 0, verified: 0, unconfirmed: 0, dead: 0, unsupported: 0 })

const SELF_KEYS: Record<string, keyof Counts3> = { 'got-it': 'gotIt', partly: 'partly', missed: 'missed' }
const RATING_KEYS: Record<string, keyof RatingCounts> = {
  useful: 'useful',
  'not-useful': 'notUseful',
  wrong: 'wrong',
  'already-knew': 'alreadyKnew',
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const key = (v: unknown): string => (typeof v === 'string' && v ? v : 'unknown')

function slot<T>(map: Record<string, T>, k: string, make: () => T): T {
  return (map[k] ??= make())
}

/** Adds each numeric field of `from` onto the same field of `into`. */
function addCounts<T extends Record<string, number>>(into: T, from: unknown): void {
  if (!isObj(from)) return
  for (const k of Object.keys(into)) (into as Record<string, number>)[k] = (into[k] ?? 0) + num(from[k])
}

/**
 * The Stats view's summary over records within `days` days of `now`. Reads the
 * record shapes register.tsx writes: card { kind, category, focusKind, model,
 * latencyMs, paneVisible }, self-assessment { value, category, focusKind },
 * rating { kind, model, value }, flaw-feedback { value }, verify { model,
 * citations: CitationCounts, sources: SourceCounts, factsKept? }, run { job, usd }.
 */
export function summarizeTelemetry(records: TelemetryRecord[], now: number, days: number): StatsSummary {
  const s: StatsSummary = {
    days,
    cards: {},
    selfAssessment: { byCategory: {}, byFocus: {} },
    ratings: { byKind: {}, byModel: {} },
    flawFeedback: { real: 0, falseAlarm: 0 },
    verification: {},
    costPerQuestionUsd: null,
    costPerKeptFactUsd: null,
    medianCardLatencyMs: null,
    paneVisibleShare: null,
  }
  let cards = 0
  let visible = 0
  let questionCards = 0
  let questionUsd = 0
  let factsUsd = 0
  let factsKept = 0
  const latencies: number[] = []

  for (const r of records) {
    if (!(now - r.ts <= days * DAY_MS)) continue
    switch (r.type) {
      case 'card': {
        const kind = key(r.kind)
        s.cards[kind] = (s.cards[kind] ?? 0) + 1
        cards++
        if (r.paneVisible === true) visible++
        if (kind === 'question') questionCards++
        if (typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs)) latencies.push(r.latencyMs)
        break
      }
      case 'self-assessment': {
        const k = SELF_KEYS[key(r.value)]
        if (!k) break
        slot(s.selfAssessment.byCategory, key(r.category), zero3)[k]++
        slot(s.selfAssessment.byFocus, key(r.focusKind), zero3)[k]++
        break
      }
      case 'rating': {
        const k = RATING_KEYS[key(r.value)]
        if (!k) break
        slot(s.ratings.byKind, key(r.kind), zeroRatings)[k]++
        slot(s.ratings.byModel, key(r.model), zeroRatings)[k]++
        break
      }
      case 'flaw-feedback':
        if (r.value === 'real') s.flawFeedback.real++
        else if (r.value === 'false-alarm') s.flawFeedback.falseAlarm++
        break
      case 'verify': {
        const v = slot(s.verification, key(r.model), () => ({ citations: zeroCitations(), sources: zeroSources() }))
        addCounts(v.citations, r.citations)
        addCounts(v.sources, r.sources)
        factsKept += num(r.factsKept)
        break
      }
      case 'run':
        if (r.job === 'question') questionUsd += num(r.usd)
        else if (r.job === 'facts') factsUsd += num(r.usd)
        break
    }
  }

  if (questionCards) s.costPerQuestionUsd = questionUsd / questionCards
  if (factsKept) s.costPerKeptFactUsd = factsUsd / factsKept
  if (cards) s.paneVisibleShare = visible / cards
  if (latencies.length) {
    latencies.sort((a, b) => a - b)
    const mid = latencies.length >> 1
    s.medianCardLatencyMs =
      latencies.length % 2 ? (latencies[mid] ?? 0) : ((latencies[mid - 1] ?? 0) + (latencies[mid] ?? 0)) / 2
  }
  return s
}

// The string fields counts-only telemetry keeps: ids and fixed labels, never
// free text or paths. summarizeTelemetry reads only these, numbers and counts.
const COUNTS_ONLY_STRINGS = new Set([
  'type', 'session', 'version', 'cardId', 'factId', 'kind', 'category', 'focusKind', 'model',
  'job', 'effort', 'outcome', 'verdict', 'value', 'chosen', 'action', 'where', 'field',
])

/**
 * The record as the telemetry setting lets it be written: null for `off`
 * (write nothing), unchanged for `full`. `counts only` keeps every number and
 * boolean, every object whose values are all numbers (the verify counts),
 * `reasons` when it is a list of strings, and the allowlisted string fields,
 * so typed answers, card text, topics, paths, feedback and error messages go.
 */
export function redactRecord(record: Record<string, unknown>, mode: Settings['telemetry']): Record<string, unknown> | null {
  if (mode === 'off') return null
  if (mode === 'full') return record
  const kept: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    const isKept =
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      (typeof v === 'string' && COUNTS_ONLY_STRINGS.has(k)) ||
      (k === 'reasons' && Array.isArray(v) && v.every((item) => typeof item === 'string')) ||
      (isObj(v) && Object.values(v).every((item) => typeof item === 'number'))
    if (isKept) kept[k] = v
  }
  return kept
}

/** Parses JSON Lines, skipping blank and malformed lines. */
export function parseJsonLines(text: string): TelemetryRecord[] {
  const out: TelemetryRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const v = tryParse(line)?.value
    if (isObj(v) && typeof v.type === 'string' && typeof v.ts === 'number') out.push(v as TelemetryRecord)
  }
  return out
}

export type { FocusKind }

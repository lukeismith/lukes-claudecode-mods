import { test, expect } from 'claude-code/testing'

import type { TelemetryRecord } from '../types'
import {
  CATEGORIES,
  DEFAULT_SETTINGS,
  addToTally,
  applySourcePolicy,
  baseName,
  chooseCard,
  clampSetting,
  costLine,
  costOf,
  estimateQuestionUsd,
  estimateUsd,
  extractJson,
  htmlToText,
  isExcludedPath,
  isRefresherTurn,
  joinQuestion,
  matchQuote,
  modelFamily,
  nextCategory,
  parseLastChanged,
  parseQuestion,
  pickRecentPath,
  pickRefresherPath,
  readSettings,
  redactRecord,
  scrubAnswerText,
  summarizeTelemetry,
  type ChooseInput,
} from './logic'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const MIN = 60_000
const DAY = 24 * 60 * MIN
const close = (a: number | null, b: number) => expect(a !== null && Math.abs(a - b) < 1e-9).toBe(true)

// ---------------------------------------------------------------- chooseCard

const base: ChooseInput = {
  now: NOW,
  gapMs: 10 * MIN,
  askedAt: [],
  hasOpenQuestion: false,
  isQuestionRunning: false,
  isPaused: false,
  isOff: false,
  spentTodayUsd: 0,
  dailyBudgetUsd: 0,
  questionsPerHour: 4,
  rapidReplyMs: 3 * MIN,
  mode: 'questions and facts',
}

test('chooseCard asks a question when every rule passes, including the first prompt', () => {
  expect(chooseCard(base)).toEqual({ kind: 'question', reasons: [] })
  expect(chooseCard({ ...base, gapMs: null })).toEqual({ kind: 'question', reasons: [] })
})

test('chooseCard refuses a fifth question within an hour but not when one is older', () => {
  const four = [NOW - 50 * MIN, NOW - 40 * MIN, NOW - 20 * MIN, NOW - 5 * MIN]
  expect(chooseCard({ ...base, askedAt: four })).toEqual({ kind: 'fact', reasons: ['rate-limit'] })
  expect(chooseCard({ ...base, askedAt: [NOW - 61 * MIN, ...four.slice(1)] }).kind).toBe('question')
})

test('chooseCard gives a fact for a prompt two minutes after the last', () => {
  expect(chooseCard({ ...base, gapMs: 2 * MIN })).toEqual({ kind: 'fact', reasons: ['rapid'] })
})

test('chooseCard gives a fact while a question is open or running', () => {
  expect(chooseCard({ ...base, hasOpenQuestion: true })).toEqual({ kind: 'fact', reasons: ['open-question'] })
  expect(chooseCard({ ...base, isQuestionRunning: true })).toEqual({ kind: 'fact', reasons: ['question-running'] })
})

test('chooseCard gives a fact once the budget is reached, and 0 means no cap', () => {
  expect(chooseCard({ ...base, spentTodayUsd: 1, dailyBudgetUsd: 1 })).toEqual({ kind: 'fact', reasons: ['budget'] })
  expect(chooseCard({ ...base, spentTodayUsd: 50, dailyBudgetUsd: 0 }).kind).toBe('question')
})

test('chooseCard shows nothing when paused or off', () => {
  expect(chooseCard({ ...base, isPaused: true })).toEqual({ kind: 'none', reasons: ['paused'] })
  expect(chooseCard({ ...base, isOff: true, hasOpenQuestion: true })).toEqual({ kind: 'none', reasons: ['off'] })
})

test('chooseCard lists every failing rule', () => {
  expect(chooseCard({ ...base, gapMs: MIN, hasOpenQuestion: true }).reasons).toEqual(['rapid', 'open-question'])
})

test('chooseCard in facts only never asks a question, and still lists the other failing rules', () => {
  expect(chooseCard({ ...base, mode: 'facts only' })).toEqual({ kind: 'fact', reasons: ['mode'] })
  expect(chooseCard({ ...base, mode: 'facts only', hasOpenQuestion: true })).toEqual({ kind: 'fact', reasons: ['mode', 'open-question'] })
  expect(chooseCard({ ...base, mode: 'facts only', isPaused: true })).toEqual({ kind: 'none', reasons: ['paused'] })
})

test('chooseCard in questions only shows nothing where a fact would have been chosen', () => {
  expect(chooseCard({ ...base, mode: 'questions only' })).toEqual({ kind: 'question', reasons: [] })
  expect(chooseCard({ ...base, mode: 'questions only', gapMs: MIN })).toEqual({ kind: 'none', reasons: ['rapid'] })
  expect(chooseCard({ ...base, mode: 'questions only', spentTodayUsd: 2, dailyBudgetUsd: 1 })).toEqual({ kind: 'none', reasons: ['budget'] })
})

test('chooseCard with 0 questions per hour behaves like facts only, whatever the mode', () => {
  expect(chooseCard({ ...base, questionsPerHour: 0 })).toEqual({ kind: 'fact', reasons: ['mode'] })
  expect(chooseCard({ ...base, questionsPerHour: 0, mode: 'questions only' })).toEqual({ kind: 'fact', reasons: ['mode'] })
  // Any other limit applies as given.
  expect(chooseCard({ ...base, questionsPerHour: 1, askedAt: [NOW - 30 * MIN] })).toEqual({ kind: 'fact', reasons: ['rate-limit'] })
})

test('chooseCard with a rapid reply window of 0 never applies the rapid rule', () => {
  expect(chooseCard({ ...base, gapMs: 1, rapidReplyMs: 0 })).toEqual({ kind: 'question', reasons: [] })
  expect(chooseCard({ ...base, gapMs: 5 * MIN, rapidReplyMs: 10 * MIN })).toEqual({ kind: 'fact', reasons: ['rapid'] })
})

test('nextCategory rotates through the enabled categories only', () => {
  const two = ['Testing strategy', 'Debugging scenario']
  expect(nextCategory(0, two)).toEqual({ category: 'Testing strategy', nextIndex: 1 })
  expect(nextCategory(1, two)).toEqual({ category: 'Debugging scenario', nextIndex: 0 })
  // An index stored under a longer list still wraps into this one.
  expect(nextCategory(7, two)).toEqual({ category: 'Debugging scenario', nextIndex: 0 })
  expect(nextCategory(0, []).category).toBe(CATEGORIES[0])
})

// ---------------------------------------------------------------- settings

test('readSettings fills every default, and DEFAULT_SETTINGS is the same', () => {
  const defaults = {
    questionsPerHour: 4,
    rapidReplyMinutes: 3,
    mode: 'questions and facts',
    refresherEvery: 3,
    refresherMinAgeDays: 30,
    difficulty: 'senior',
    categories: [...CATEGORIES],
    flawReview: true,
    steWriting: true,
    sourcePolicy: 'official preferred',
    excludePaths: [],
    questionModel: 'opus',
    questionEffort: 'high',
    factModel: 'sonnet',
    gradeModel: 'sonnet',
    dailyBudgetUsd: 0,
    openPaneOnStart: true,
    toastOnNewQuestion: true,
    statusLine: true,
    telemetry: 'counts only',
  }
  expect(readSettings({})).toEqual(defaults)
  expect(DEFAULT_SETTINGS).toEqual(defaults)
})

test('readSettings clamps numbers to their ranges, rounds counts, and replaces a non-number with the default', () => {
  const s = readSettings({
    questionsPerHour: 99,
    rapidReplyMinutes: 1.5,
    refresherEvery: 2.6,
    refresherMinAgeDays: 0,
    dailyBudgetUsd: 5000,
  })
  expect([s.questionsPerHour, s.rapidReplyMinutes, s.refresherEvery, s.refresherMinAgeDays, s.dailyBudgetUsd]).toEqual([20, 1.5, 3, 1, 1000])
  const low = readSettings({ questionsPerHour: -3, rapidReplyMinutes: 90, refresherMinAgeDays: 9000, dailyBudgetUsd: 2.5 })
  expect([low.questionsPerHour, low.rapidReplyMinutes, low.refresherMinAgeDays, low.dailyBudgetUsd]).toEqual([0, 60, 3650, 2.5])
  expect(readSettings({ questionsPerHour: 'seven' }).questionsPerHour).toBe(4)
  expect(readSettings({ refresherEvery: Number.NaN }).refresherEvery).toBe(3)
  // A value typed into settings.json by hand is clamped the same way, and other fields are left alone.
  expect(clampSetting('questionsPerHour', 99)).toBe(20)
  expect(clampSetting('mode', 3)).toBe(null)
  expect(clampSetting('constructor', 3)).toBe(null)
})

test('readSettings replaces a choice outside its options, or a flag that is not a boolean, with the default', () => {
  const s = readSettings({ mode: 'sometimes', questionModel: 'gpt-5', telemetry: 'everything', difficulty: 'staff', gradeModel: 'haiku', flawReview: 'no', statusLine: false })
  expect([s.mode, s.questionModel, s.telemetry, s.difficulty, s.gradeModel]).toEqual(['questions and facts', 'opus', 'counts only', 'staff', 'haiku'])
  expect([s.flawReview, s.statusLine]).toEqual([true, false])
})

test('readSettings matches categories by short key, case and spacing aside, and returns them in CATEGORIES order', () => {
  expect(readSettings({ categories: ' Security , DEBUGGING,nonsense' }).categories).toEqual(['Debugging scenario', 'Security and trust boundaries'])
  expect(readSettings({ categories: 'how  code works, data modeling' }).categories).toEqual(['Explain how this code works', 'Data modeling and API design'])
})

test('readSettings matches a token that holds a distinctive word of a full name, and falls back to all', () => {
  expect(readSettings({ categories: 'Data modeling and API design, trade-offs, async' }).categories).toEqual([
    'System design trade-offs',
    'Concurrency and asynchronous behavior',
    'Data modeling and API design',
  ])
  expect(readSettings({ categories: 'Performance and complexity' }).categories).toEqual(['Performance and complexity'])
  expect(readSettings({ categories: 'nonsense, ,' }).categories).toEqual([...CATEGORIES])
  expect(readSettings({ categories: '' }).categories).toEqual([...CATEGORIES])
})

test('readSettings splits excluded paths on commas, trimming and dropping empty entries', () => {
  expect(readSettings({ excludePaths: ' generated/** , ,*.pb.swift,' }).excludePaths).toEqual(['generated/**', '*.pb.swift'])
  expect(readSettings({ excludePaths: '' }).excludePaths).toEqual([])
})

test('isRefresherTurn marks every third question by default, every question at 1, and none at 0', () => {
  const counters = [0, 1, 2, 3, 4, 5, 8]
  expect(counters.map((n) => isRefresherTurn(n, 3))).toEqual([false, false, true, false, false, true, true])
  expect(counters.map((n) => isRefresherTurn(n, 1)).every(Boolean)).toBe(true)
  expect(counters.some((n) => isRefresherTurn(n, 0))).toBe(false)
})

test('parseQuestion reads the final fenced block even when a string holds a fence', () => {
  const draft = {
    topic: 'Atom reads',
    category: 'Explain how this code works',
    question: 'Why is drawing read-only?',
    answer: 'Because a write while drawing loops.\n```swift\nlet x = 1\n```\nThat is the reason.',
    citations: [{ path: 'hooks/state.ts', line: 3, quote: 'Never write while drawing.' }, { path: 'bad' }],
    sources: [{ title: 'MDN', url: 'https://developer.mozilla.org/x', claim: 'c', quote: 'q' }, { url: 'file:///etc/passwd', claim: 'c', quote: 'q' }],
  }
  const reply = [
    'I read the files. Here is an aside:',
    '```swift',
    'let y = 2',
    '```',
    '```json',
    '{"draft": "an earlier attempt"}',
    '```',
    'Final answer:',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
  ].join('\n')
  const parsed = parseQuestion(reply)
  expect(parsed?.answer).toContain('```swift\nlet x = 1\n```')
  expect(parsed?.citations).toEqual([{ path: 'hooks/state.ts', line: 3, quote: 'Never write while drawing.' }])
  expect(parsed?.sources.map((s) => s.url)).toEqual(['https://developer.mozilla.org/x'])
  expect(parsed?.flaw).toBe(null)
})

test('parseQuestion reads context and ask, trimmed, and joins them into question with a blank line', () => {
  const block = (v: unknown) => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``
  const draft = {
    topic: 't',
    category: 'Language semantics and quirks',
    context: 'In `hooks/state.ts`:\n\n```ts\nlet x = 1\n```\n',
    ask: '1. What is `x`?\n2. Why?\n',
    answer: 'One.',
  }
  const parsed = parseQuestion(block(draft))
  expect(parsed?.context).toBe('In `hooks/state.ts`:\n\n```ts\nlet x = 1\n```')
  expect(parsed?.ask).toBe('1. What is `x`?\n2. Why?')
  expect(parsed?.question).toBe('In `hooks/state.ts`:\n\n```ts\nlet x = 1\n```\n\n1. What is `x`?\n2. Why?')
  // An empty or missing context leaves the ask as the whole question.
  expect(parseQuestion(block({ ...draft, context: '' }))?.question).toBe('1. What is `x`?\n2. Why?')
  expect(parseQuestion(block({ ...draft, context: 42 }))).toMatchObject({ context: '', question: '1. What is `x`?\n2. Why?' })
  // With both shapes present, the split one wins.
  expect(parseQuestion(block({ ...draft, question: 'Old text?' }))?.ask).toBe('1. What is `x`?\n2. Why?')
})

test('parseQuestion reads an older reply with only question as an ask with no context', () => {
  const parsed = parseQuestion('```json\n{"topic": "t", "category": "c", "question": "Why?", "answer": "Because."}\n```')
  expect(parsed).toMatchObject({ context: '', ask: 'Why?', question: 'Why?', answer: 'Because.' })
})

test('parseQuestion rejects a block missing required fields', () => {
  expect(parseQuestion('```json\n{"topic": "t", "category": "c", "question": "Why?"}\n```')).toBe(null)
  expect(parseQuestion('```json\n{"context": "Setup.", "ask": "Why?"}\n```')).toBe(null)
  // Context alone is not a question, and a blank ask does not count.
  expect(parseQuestion('```json\n{"context": "Setup.", "answer": "A."}\n```')).toBe(null)
  expect(parseQuestion('```json\n{"context": "Setup.", "ask": "  ", "answer": "A."}\n```')).toBe(null)
  expect(parseQuestion('no json here')).toBe(null)
})

test('joinQuestion puts a blank line between context and ask, and drops an empty context', () => {
  expect(joinQuestion('Setup.', 'Why?')).toBe('Setup.\n\nWhy?')
  expect(joinQuestion('  ', 'Why?')).toBe('Why?')
})

test('baseName keeps the last segment of a path', () => {
  expect(baseName('/Users/luke/Code/app')).toBe('app')
  expect(baseName('/Users/luke/Code/app/')).toBe('app')
  expect(baseName('src/retry.ts')).toBe('retry.ts')
  expect(baseName('')).toBe('')
})

test('extractJson falls back to the last top-level object', () => {
  expect(extractJson('Prose with {braces} then {"a": {"b": 1}} and {"c": "}"}')).toEqual({ c: '}' })
})

// ---------------------------------------------------------------- cost

test('costOf prices known token counts by family, for an alias or a full id alike', () => {
  const usage = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 8_000 }
  close(costOf(usage, 'opus'), 0.13)
  close(costOf(usage, 'claude-opus-5-5'), 0.13)
  close(costOf(usage, 'sonnet'), 0.065)
  close(costOf(usage, 'claude-sonnet-5-5'), 0.065)
  close(costOf(usage, 'haiku'), 0.0035)
  close(costOf(usage, 'claude-haiku-5-5'), 0.0035)
  close(costOf(usage, 'claude-opus-5-5-20261001', 3), 0.16)
  // An unknown model is priced as Opus, never as free.
  close(costOf(usage, 'mystery-model'), 0.13)
})

test('modelFamily reads the family from an alias or an id, ignoring case', () => {
  expect(['opus', 'claude-sonnet-5-5', 'Claude-Haiku-5-5', 'claude-opus-6-0-20270101', 'gpt-5'].map(modelFamily)).toEqual([
    'opus',
    'sonnet',
    'haiku',
    'opus',
    null,
  ])
})

test('estimateUsd prices a quarter token per character of prompt plus the expected output, by family', () => {
  close(estimateUsd('sonnet', 4_000, 1_500), 0.017)
  close(estimateUsd('claude-haiku-5-5', 4_000, 1_500), 0.00085)
  close(estimateUsd('mystery-model', 4_000, 1_500), 0.034)
})

test('addToTally resets the session bucket for a new session and costLine reads it', () => {
  const one = addToTally(undefined, { sessionId: 's1', now: NOW, job: 'grade', model: 'claude-sonnet-5-5', usd: 0.02 })
  const two = addToTally(one, { sessionId: 's2', now: NOW, job: 'question', model: 'claude-opus-5-5', usd: 0.5 })
  close(two.session.usd, 0.5)
  close(two.lifetime.usd, 0.52)
  expect(two.lifetime.byJob.grade?.runs).toBe(1)
  close(costLine(two, 's2', NOW).todayUsd, 0.52)
  expect(costLine(two, 's1', NOW).sessionUsd).toBe(0)
})

// ---------------------------------------------------------------- quotes

const FILE = ['import x from "y"', '', 'export function foo() {', '  return x', '}', ...Array(30).fill('// filler'), 'const z = 2', ''].join('\n')

test('matchQuote finds an exact quote within three lines, including across lines', () => {
  expect(matchQuote(FILE, 3, 'export function foo() {')).toEqual({ line: 3, status: 'exact' })
  expect(matchQuote(FILE, 6, '  export   function foo() {')).toEqual({ line: 6, status: 'exact' })
  expect(matchQuote(FILE, 4, 'function foo() { return x }')).toEqual({ line: 4, status: 'exact' })
})

test('matchQuote corrects the line of a moved quote and rejects a missing one', () => {
  expect(matchQuote(FILE, 30, 'return x')).toEqual({ line: 4, status: 'moved' })
  expect(matchQuote(FILE, 3, 'return y')).toBe(null)
  expect(matchQuote(FILE, 3, '   ')).toBe(null)
})

test('htmlToText keeps inline code joined so quotes still match', () => {
  expect(htmlToText('<p>Call <code>map</code>() &amp; then <b>stop</b>.</p><script>x()</script><p>Next</p>')).toBe('Call map() & then stop. Next')
})

test('scrubAnswerText unlinks dropped URLs and moves whole line references once', () => {
  const text =
    'See [append](https://developer.apple.com/documentation/swift/array/append(_:)) and [MDN](https://developer.mozilla.org/x). ' +
    'Look at `a.ts:4`, a.ts:40, src/a.ts:4 and b.ts:7.'
  const moves = [
    { path: 'a.ts', from: 4, to: 9 },
    { path: 'a.ts', from: 9, to: 12 },
    { path: 'b.ts', from: 7, to: 4 },
  ]
  expect(scrubAnswerText(text, ['https://developer.apple.com/documentation/swift/array/append(_:)'], moves)).toBe(
    'See append and [MDN](https://developer.mozilla.org/x). Look at `a.ts:9`, a.ts:40, src/a.ts:4 and b.ts:4.',
  )
})

// ---------------------------------------------------------------- focus

test('pickRefresherPath excludes touched, recently quizzed, recent, skippable and deleted files', () => {
  const old = NOW - 100 * DAY
  const input = {
    lastChanged: {
      'old.ts': old,
      'touched.ts': old,
      'quizzed.ts': old,
      'recent.ts': NOW - 2 * DAY,
      'package-lock.json': old,
      'deleted.ts': old,
    },
    sizes: { 'old.ts': 900, 'touched.ts': 900, 'quizzed.ts': 900, 'recent.ts': 900, 'package-lock.json': 900 },
    touched: ['touched.ts'],
    lastQuizzed: { 'quizzed.ts': NOW - 10 * DAY },
    now: NOW,
    minAgeMs: 30 * DAY,
    exclude: [],
  }
  for (const r of [0, 0.5, 0.999]) {
    expect(pickRefresherPath({ ...input, random: () => r })).toEqual({ path: 'old.ts', lastChangedAt: old })
  }
})

test('pickRefresherPath skips excluded paths and honors the minimum age', () => {
  const rest = { touched: [], lastQuizzed: {}, now: NOW, random: () => 0 }
  const lastChanged = { 'a.ts': NOW - 100 * DAY, 'b.pb.swift': NOW - 200 * DAY }
  const sizes = { 'a.ts': 900, 'b.pb.swift': 900 }
  expect(pickRefresherPath({ ...rest, lastChanged, sizes, minAgeMs: 30 * DAY, exclude: ['*.pb.swift'] })?.path).toBe('a.ts')

  const ages = { 'young.ts': NOW - 10 * DAY, 'old.ts': NOW - 40 * DAY }
  const both = { 'young.ts': 900, 'old.ts': 900 }
  // With a 5-day minimum both qualify, so the random draw reaches the younger one.
  expect(pickRefresherPath({ ...rest, lastChanged: ages, sizes: both, minAgeMs: 5 * DAY, exclude: [], random: () => 0.99 })?.path).toBe('young.ts')
  expect(pickRefresherPath({ ...rest, lastChanged: ages, sizes: both, minAgeMs: 30 * DAY, exclude: [], random: () => 0.99 })?.path).toBe('old.ts')
})

test('pickRecentPath skips excluded paths', () => {
  const input = { touched: ['proto/api.ts', 'src/b.ts'], uncommitted: ['proto/api.ts'], recentlyCommitted: [], recentFoci: [] }
  expect(pickRecentPath({ ...input, exclude: [] })).toBe('proto/api.ts')
  expect(pickRecentPath({ ...input, exclude: ['proto/**'] })).toBe('src/b.ts')
})

test('isExcludedPath matches ** across slashes, * and ? within a segment, and a slashless pattern against the basename', () => {
  const cases: [string, string, boolean][] = [
    ['generated/**', 'generated/api/client.ts', true],
    ['generated/**', 'src/generated/client.ts', false],
    ['**/generated/**', 'src/generated/client.ts', true],
    ['**/generated/**', 'generated/client.ts', true],
    ['src/**/test.ts', 'src/test.ts', true],
    ['src/**/test.ts', 'src/a/b/test.ts', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/lib/a.ts', false],
    ['*.pb.swift', 'App/Model/User.pb.swift', true],
    ['*.pb.swift', 'App/Model/User.swift', false],
    ['*.ts', 'src/a.tsx', false],
    ['v?.ts', 'lib/v1.ts', true],
    ['v?.ts', 'lib/v10.ts', false],
    ['a.ts', 'axts', false],
    ['docs/', 'docs/guide.md', true],
    ['./scripts/*.sh', 'scripts/build.sh', true],
  ]
  for (const [glob, path, expected] of cases) expect([glob, path, isExcludedPath(path, [glob])]).toEqual([glob, path, expected])
  expect(isExcludedPath('src/a.ts', [])).toBe(false)
  expect(isExcludedPath('src/a.ts', ['', '  '])).toBe(false)
  expect(isExcludedPath('src/a.ts', ['*.md', 'src/**'])).toBe(true)
})

test('pickRefresherPath weights by size', () => {
  const old = NOW - 100 * DAY
  const input = { lastChanged: { 'a.ts': old, 'b.ts': old + 1 }, sizes: { 'a.ts': 100, 'b.ts': 300 }, touched: [], lastQuizzed: {}, now: NOW, minAgeMs: 30 * DAY, exclude: [] }
  expect(pickRefresherPath({ ...input, random: () => 0.2 })?.path).toBe('a.ts')
  expect(pickRefresherPath({ ...input, random: () => 0.5 })?.path).toBe('b.ts')
})

test('pickRefresherPath falls back to the oldest third in a young repository', () => {
  const lastChanged: Record<string, number> = {}
  const sizes: Record<string, number> = {}
  for (let d = 1; d <= 6; d++) {
    lastChanged[`f${d}.ts`] = NOW - d * DAY
    sizes[`f${d}.ts`] = 1000
  }
  const rest = { sizes, touched: [], lastQuizzed: {}, now: NOW, minAgeMs: 30 * DAY, exclude: [] }
  const picked = [0, 0.3, 0.6, 0.99].map((r) => pickRefresherPath({ ...rest, lastChanged, random: () => r })?.path)
  expect(picked).toEqual(['f6.ts', 'f6.ts', 'f5.ts', 'f5.ts'])
  expect(pickRefresherPath({ ...rest, lastChanged: {}, random: () => 0 })).toBe(null)
})

test('parseLastChanged reads real git log output', () => {
  // `git log --format=%x00%ct --name-only` from temperanda-skills on 2026-10-09.
  const output =
    '\u00001790546444\n\napple-staff-engineer/SKILL.md\napple-staff-engineer/examples/baseline-prompts.md\napple-staff-engineer/references/documentation-sources.md\napple-staff-engineer/references/prompt-template.md\napple-staff-engineer/references/review-checklist.md\n\u00001790491362\n\nREADME.md\napple-staff-engineer/SKILL.md\napple-staff-engineer/examples/baseline-prompts.md\napple-staff-engineer/references/documentation-sources.md\napple-staff-engineer/references/prompt-template.md\napple-staff-engineer/references/review-checklist.md\n\u00001790490819\n\nREADME.md\n'
  const map = parseLastChanged(output)
  expect(Object.keys(map).length).toBe(6)
  expect(map['apple-staff-engineer/SKILL.md']).toBe(1790546444000)
  expect(map['README.md']).toBe(1790491362000)
})

// ---------------------------------------------------------------- stats

test('summarizeTelemetry counts and rates a small record set', () => {
  let n = 0
  const rec = (type: string, fields: Record<string, unknown>, ts = NOW - MIN): TelemetryRecord => ({
    type,
    ts,
    session: 's',
    repo: '/r',
    version: '0.1.0',
    cardId: `c${n++}`,
    ...fields,
  })
  const opus = 'claude-opus-5-5'
  const sonnet = 'claude-sonnet-5-5'
  const records = [
    rec('card', { kind: 'question', category: 'Testing strategy', focusKind: 'recent', model: opus, latencyMs: 1000, paneVisible: true, question: 'Why?', focusPath: 'src/a.ts' }),
    rec('card', { kind: 'question', category: 'Testing strategy', focusKind: 'refresher', model: opus, latencyMs: 3000, paneVisible: false }),
    rec('card', { kind: 'fact', model: sonnet, latencyMs: 2000, paneVisible: true }),
    rec('card', { kind: 'fact', model: 'claude-sonnet-5-5', paneVisible: true }),
    rec('card', { kind: 'question', model: opus, latencyMs: 99_000, paneVisible: false }, NOW - 40 * DAY),
    rec('self-assessment', { value: 'got-it', category: 'Testing strategy', focusKind: 'recent' }),
    rec('self-assessment', { value: 'missed', category: 'Testing strategy', focusKind: 'refresher' }),
    rec('rating', { kind: 'question', model: opus, value: 'useful' }),
    rec('rating', { kind: 'fact', model: sonnet, value: 'already-knew' }),
    rec('rating', { kind: 'fact', model: sonnet, value: 'wrong' }),
    rec('flaw-feedback', { value: 'real' }),
    rec('flaw-feedback', { value: 'false-alarm' }),
    rec('verify', {
      job: 'question',
      model: opus,
      citations: { total: 3, verified: 2, corrected: 1, dropped: 0 },
      sources: { total: 2, verified: 1, unconfirmed: 1, dead: 0, unsupported: 0 },
      flaws: { reported: 0, droppedEvidence: 0, confirmed: 0, rejected: 0 },
    }),
    rec('verify', {
      job: 'facts',
      model: sonnet,
      citations: { total: 4, verified: 3, corrected: 0, dropped: 1 },
      sources: { total: 5, verified: 3, unconfirmed: 0, dead: 1, unsupported: 1 },
      factsProduced: 8,
      factsKept: 5,
      flaws: { reported: 1, droppedEvidence: 0, confirmed: 1, rejected: 0 },
    }),
    rec('run', { job: 'question', model: opus, usd: 0.5 }),
    rec('run', { job: 'question', model: opus, usd: 0.3 }),
    rec('run', { job: 'facts', model: sonnet, usd: 0.4 }),
    rec('run', { job: 'grade', model: sonnet, usd: 0.02 }),
  ]
  const s = summarizeTelemetry(records, NOW, 30)
  expect(s.days).toBe(30)
  expect(s.cards).toEqual({ question: 2, fact: 2 })
  expect(s.selfAssessment.byCategory).toEqual({ 'Testing strategy': { gotIt: 1, partly: 0, missed: 1 } })
  expect(s.selfAssessment.byFocus).toEqual({ recent: { gotIt: 1, partly: 0, missed: 0 }, refresher: { gotIt: 0, partly: 0, missed: 1 } })
  expect(s.ratings.byKind.fact).toEqual({ useful: 0, notUseful: 0, wrong: 1, alreadyKnew: 1 })
  expect(s.ratings.byModel[opus]).toEqual({ useful: 1, notUseful: 0, wrong: 0, alreadyKnew: 0 })
  expect(s.flawFeedback).toEqual({ real: 1, falseAlarm: 1 })
  expect(s.verification[sonnet]?.sources).toEqual({ total: 5, verified: 3, unconfirmed: 0, dead: 1, unsupported: 1 })
  expect(s.verification[opus]?.citations.corrected).toBe(1)
  close(s.costPerQuestionUsd, 0.4)
  close(s.costPerKeptFactUsd, 0.08)
  expect(s.medianCardLatencyMs).toBe(2000)
  expect(s.paneVisibleShare).toBe(0.75)
  // Counts-only telemetry keeps every field the summary reads.
  const counted = records.map((r) => redactRecord(r, 'counts only') as TelemetryRecord)
  expect(summarizeTelemetry(counted, NOW, 30)).toEqual(s)
})

test('summarizeTelemetry returns nulls with no records', () => {
  const s = summarizeTelemetry([], NOW, 30)
  expect([s.costPerQuestionUsd, s.costPerKeptFactUsd, s.medianCardLatencyMs, s.paneVisibleShare]).toEqual([null, null, null, null])
})

// ---------------------------------------------------------------- telemetry modes

/** A card record as register.tsx logs it, with the writer's own fields added. */
const CARD_RECORD = {
  type: 'card',
  ts: NOW,
  session: 'session-1',
  repo: '/work/app',
  version: '0.2.0',
  id: 'q1',
  cardId: 'q1',
  createdAt: NOW - MIN,
  model: 'claude-opus-5-5',
  category: 'Debugging scenario',
  focusKind: 'refresher',
  focusPath: 'src/retry.ts',
  lastChangedAt: NOW - 90 * DAY,
  topic: 'retry loop',
  question: 'Why can `retry()` loop forever?',
  answer: 'Because the attempt counter is reset on every call.',
  citations: [{ path: 'src/retry.ts', line: 12, quote: 'let attempts = 0' }],
  sources: [{ title: 'MDN', url: 'https://developer.mozilla.org/x', claim: 'c', quote: 'q', mark: 'verified', isOfficial: true }],
  flaw: { summary: 'The counter never survives a call.', severity: 'medium', evidence: [] },
  isUnverified: false,
  draft: ['My typed answer'],
  isRevealed: false,
  feedback: { rating: 'useful' },
  kind: 'question',
  latencyMs: 41_000,
  paneVisible: true,
}

test('redactRecord writes nothing when off and everything when full', () => {
  expect(redactRecord(CARD_RECORD, 'off')).toBe(null)
  expect(redactRecord(CARD_RECORD, 'full')).toBe(CARD_RECORD)
})

test('redactRecord in counts only keeps a card record\'s ids, labels and numbers but no question, answer or path', () => {
  const kept = redactRecord(CARD_RECORD, 'counts only')
  expect(kept).toEqual({
    type: 'card',
    ts: NOW,
    session: 'session-1',
    version: '0.2.0',
    cardId: 'q1',
    createdAt: NOW - MIN,
    model: 'claude-opus-5-5',
    category: 'Debugging scenario',
    focusKind: 'refresher',
    lastChangedAt: NOW - 90 * DAY,
    isUnverified: false,
    isRevealed: false,
    kind: 'question',
    latencyMs: 41_000,
    paneVisible: true,
  })
  const text = JSON.stringify(kept)
  for (const secret of ['retry()', 'attempt counter', 'My typed answer', 'src/retry.ts', 'retry loop', '/work/app', 'developer.mozilla.org']) {
    expect([secret, text.includes(secret)]).toEqual([secret, false])
  }
})

test('redactRecord in counts only keeps all-number objects and string reasons, and drops typed text and messages', () => {
  const verify = {
    type: 'verify',
    job: 'facts',
    model: 'sonnet',
    citations: { total: 4, verified: 3, corrected: 0, dropped: 1 },
    sources: { total: 2, verified: 1, unconfirmed: 1, dead: 0, unsupported: 0 },
    flaws: { reported: 1, droppedEvidence: 0, confirmed: 1, rejected: 0 },
    factsKept: 3,
  }
  expect(redactRecord(verify, 'counts only')).toEqual(verify)
  const decision = { type: 'decision', chosen: 'fact', reasons: ['rapid', 'budget'], gapMs: null, questionsLastHour: 2, panePlaced: true }
  expect(redactRecord(decision, 'counts only')).toEqual({ type: 'decision', chosen: 'fact', reasons: ['rapid', 'budget'], questionsLastHour: 2, panePlaced: true })
  expect(redactRecord({ type: 'answer', cardId: 'q1', text: 'It resets.', chars: 10, lines: 1 }, 'counts only')).toEqual({ type: 'answer', cardId: 'q1', chars: 10, lines: 1 })
  expect(redactRecord({ type: 'grade', cardId: 'q1', verdict: 'correct', feedback: 'Well done.', usd: 0.01 }, 'counts only')).toEqual({ type: 'grade', cardId: 'q1', verdict: 'correct', usd: 0.01 })
  expect(redactRecord({ type: 'error', where: 'grading', message: 'ENOENT: /Users/luke/secret' }, 'counts only')).toEqual({ type: 'error', where: 'grading' })
  // A list other than reasons goes, even of strings.
  expect(redactRecord({ type: 'x', draft: ['a line'], tags: ['t'] }, 'counts only')).toEqual({ type: 'x' })
})

test('applySourcePolicy drops non-official sources only under official only', () => {
  const official = { title: 'MDN', url: 'https://developer.mozilla.org/x', claim: 'c', quote: 'q', isOfficial: true }
  const blog = { title: 'A blog', url: 'https://blog.example/x', claim: 'c', quote: 'q', isOfficial: false }
  expect(applySourcePolicy([official, blog], 'official preferred')).toEqual([official, blog])
  expect(applySourcePolicy([official, blog], 'official only')).toEqual([official])
})

test('readSettings turns the writing style on by default and reads it as a flag', () => {
  expect(readSettings({}).steWriting).toBe(true)
  expect(readSettings({ steWriting: false }).steWriting).toBe(false)
  expect(readSettings({ steWriting: 'no' }).steWriting).toBe(true)
})

test('estimateQuestionUsd uses the measured average, else a figure for the model family', () => {
  expect(estimateQuestionUsd('opus', 0.31)).toBe(0.31)
  expect(estimateQuestionUsd('haiku', null)).toBeLessThan(estimateQuestionUsd('sonnet', null))
  expect(estimateQuestionUsd('sonnet', null)).toBeLessThan(estimateQuestionUsd('opus', null))
  expect(estimateQuestionUsd('some-future-model', null)).toBe(estimateQuestionUsd('opus', null))
})

test('readSettings reads the /config pickers, which store numbers as strings, and the visible text defaults', () => {
  const s = readSettings({ questionsPerHour: '6', rapidReplyMinutes: '0', refresherMinAgeDays: '90', dailyBudgetUsd: '0.50', categories: 'all', excludePaths: 'none' })
  expect([s.questionsPerHour, s.rapidReplyMinutes, s.refresherMinAgeDays, s.dailyBudgetUsd]).toEqual([6, 0, 90, 0.5])
  expect(s.categories).toEqual([...CATEGORIES])
  expect(s.excludePaths).toEqual([])
  expect(readSettings({ dailyBudgetUsd: 'no limit' }).dailyBudgetUsd).toBe(0)
  expect(readSettings({ questionsPerHour: 'lots' }).questionsPerHour).toBe(4)
  expect(readSettings({ excludePaths: 'none, vendor/**' }).excludePaths).toEqual(['vendor/**'])
})

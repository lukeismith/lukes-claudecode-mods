// Pane drawing tests. They seed this plugin's $.state beneath the plugin,
// mount the Pane, and read the tree. Presses run register.tsx's real
// actions, so a press test checks what the redraw shows, not a mock.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { FactCard, PendingRun, QuestionCard, Source, StatsSummary, Tally } from '../types'
import { dayKey, monthKey } from './logic'
import { PROGRESS_KEY, SELF_GOT_IT, boldAsk, contentColumns, progressCells, progressLine, sourcesSummary } from './pane'

const DAY = 86_400_000
const NOW = 400 * DAY
const PLUGIN = 'repo-quiz'
const ROOT = '/work/app'
const PANE_PROPS = {
  title: 'Repo quiz',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const QUESTION: QuestionCard = {
  id: 'q1',
  createdAt: 399 * DAY,
  model: 'claude-opus-5-5',
  category: 'Debugging scenario',
  focusKind: 'refresher',
  focusPath: 'src/retry.ts',
  lastChangedAt: 300 * DAY,
  topic: 'retry loop',
  context: 'The network drops for a minute while `retry()` in `src/retry.ts` is running.',
  ask: 'Why can `retry()` loop forever?',
  question: 'The network drops for a minute while `retry()` in `src/retry.ts` is running.\n\nWhy can `retry()` loop forever?',
  answer: 'Because the attempt counter is reset on every call.',
  citations: [{ path: 'src/retry.ts', line: 12, quote: 'let attempts = 0' }],
  sources: [
    { title: 'setTimeout()', url: 'https://developer.mozilla.org/docs/setTimeout', claim: 'c', quote: 'q', mark: 'verified', isOfficial: true },
    { title: 'A blog', url: 'https://blog.example/retry', claim: 'c', quote: 'q', mark: 'unconfirmed', isOfficial: false },
  ],
  flaw: { summary: 'The counter never survives a call.', severity: 'medium', evidence: [{ path: 'src/retry.ts', line: 12, quote: 'let attempts = 0' }] },
  isUnverified: false,
  draft: ['The counter resets', 'on each call.'],
  isRevealed: false,
  feedback: {},
}
const REVEALED: QuestionCard = { ...QUESTION, isRevealed: true }

const FACT: FactCard = {
  id: 'f1',
  createdAt: 400 * DAY,
  model: 'git',
  topic: 'churn',
  text: '`src/retry.ts` changed in 9 commits over the last 30 days.',
  citations: [],
  sources: [],
  flaw: null,
  feedback: {},
}

const STATS: StatsSummary = {
  days: 30,
  cards: { question: 2, fact: 5 },
  selfAssessment: { byCategory: { 'Debugging scenario': { gotIt: 1, partly: 1, missed: 0 } }, byFocus: {} },
  ratings: { byKind: { fact: { useful: 3, notUseful: 1, wrong: 0, alreadyKnew: 1 } }, byModel: {} },
  flawFeedback: { real: 1, falseAlarm: 1 },
  verification: {},
  costPerQuestionUsd: 0.45,
  costPerKeptFactUsd: null,
  medianCardLatencyMs: 42_000,
  paneVisibleShare: 0.8,
}

/**
 * Answers each listed key, while it was never written, with the given value at
 * version 0: the pane reads it as set, and the plugin's own writes still land.
 */
function seed(on: On, values: Record<string, unknown>) {
  on('state.get', { plugin: 'repo-quiz' }, async ($, e, next) => {
    const stored = await next(e)
    const isUnwritten = stored.value?.version === 0

    return isUnwritten && e.key in values ? ({ value: { value: values[e.key], version: 0 } } as typeof stored) : stored
  })
}

/** The clock every draw reads, a repository at ROOT for the header, then the seeded state. */
function world(on: On, values: Record<string, unknown> = {}) {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/luke' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  seed(on, values)
}

/** Every `ui` toggle as the pane's atom starts, with `changes` on top. */
const toggles = (changes: Record<string, boolean> = {}) => ({ sourcesOpen: false, detailsOpen: false, confirmOff: false, factOpen: false, ...changes })

/** The root Box's props, as the drawing's plain data carries them. */
const rootProps = async (ui: { drawn: () => Promise<unknown> }) => ((await ui.drawn()) as { props?: Record<string, unknown> }).props

const source = (mark: Source['mark']): Source => ({ title: 't', url: 'https://example.com/x', claim: 'c', quote: 'q', mark })

/** The code points and colors packed in a Raster's `cells`, decoded independently of pane.tsx. */
function decodeCells(cells: string): { glyphs: string; colors: number[] } {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < cells.length; i += 4) {
    const quad = cells.slice(i, i + 4)
    const n = [...quad].reduce((acc, ch) => (acc << 6) | (ch === '=' ? 0 : alphabet.indexOf(ch)), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  bytes.length -= (cells.match(/=+$/)?.[0] ?? '').length
  const words: number[] = []
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    words.push(((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16) | ((bytes[i + 3] ?? 0) << 24)) >>> 0)
  }
  const glyphs = words.filter((_, i) => i % 3 === 0).map(code => String.fromCodePoint(code)).join('')

  return { glyphs, colors: words.filter((_, i) => i % 3 !== 0) }
}

// ---------------------------------------------------------------- pure helpers

test('progressLine names the waiting run, its elapsed seconds, and the usual time for a question', () => {
  const question: Record<string, PendingRun> = { a: { job: 'question', startedAt: NOW - 12_400 } }

  expect(progressLine({}, NOW, 40_000)).toBe('')
  expect(progressLine(question, NOW, 40_000)).toBe('⠋ Preparing a question · 12 s (usually about 40 s)')
  expect(progressLine(question, NOW, null)).toBe('⠋ Preparing a question · 12 s')
  expect(progressLine({ a: { job: 'facts', startedAt: NOW - 3_000 } }, NOW, 40_000)).toBe('⠋ Gathering facts · 3 s')
  expect(progressLine({ a: { job: 'question', startedAt: NOW - 51_000, stage: 'verifying' } }, NOW, null)).toBe('⠋ Checking sources · 51 s')
})

test('progressLine moves the spinner one frame a second and puts a grade first among several runs', () => {
  const runs: Record<string, PendingRun> = {
    a: { job: 'facts', startedAt: NOW - 20_000 },
    b: { job: 'grade', startedAt: NOW - 4_000 },
  }

  expect(progressLine(runs, NOW, null)).toBe('⠋ Grading · 4 s · +1 more')
  expect(progressLine(runs, NOW + 1_000, null)).toBe('⠙ Grading · 5 s · +1 more')
  expect(progressLine(runs, NOW + 2_000, null).charAt(0)).toBe('⠹')
})

test('progressCells packs one row in the terminal default colors, padded or cut to the width', () => {
  const padded = decodeCells(progressCells('⠋ Grading', 12))
  expect(padded.glyphs).toBe('⠋ Grading   ')
  expect(padded.colors).toHaveLength(24)
  expect(padded.colors.every(color => color === 0x01000000)).toBe(true)

  expect(decodeCells(progressCells('Preparing a question', 9)).glyphs).toBe('Preparing')
  // A cell holds one column of the Basic Multilingual Plane, so anything else becomes '?'.
  expect(decodeCells(progressCells('a😀b漢', 4)).glyphs).toBe('a?b?')
  // The Raster takes 1 to 512 columns, so the cells always match the element.
  expect(decodeCells(progressCells('x', 0)).glyphs).toBe('x')
  expect(decodeCells(progressCells('x', 900)).glyphs).toHaveLength(512)
})

test('boldAsk bolds each line, and each numbered item after its marker', () => {
  expect(boldAsk('Why can `retry()` loop forever?')).toBe('**Why can `retry()` loop forever?**')
  expect(boldAsk('Walk through `evict`.\nSay where it stops.')).toBe('**Walk through `evict`.**\n**Say where it stops.**')
  expect(boldAsk('1. Why does it retry?\n2. What stops it?')).toBe('1. **Why does it retry?**\n2. **What stops it?**')
  expect(boldAsk('- First part\n  continued here')).toBe('- **First part**\n  **continued here**')
  // A blank line between parts stays blank, and trailing spaces go so the closing ** still closes.
  expect(boldAsk('Part one.  \n\nPart two.')).toBe('**Part one.**\n\n**Part two.**')
})

test('boldAsk drops ** outside code spans, so the bold cannot close early, and keeps code exactly', () => {
  expect(boldAsk('Why is **this** call slow?')).toBe('**Why is this call slow?**')
  expect(boldAsk('What does `a ** b` return for `**kwargs`?')).toBe('**What does `a ** b` return for `**kwargs`?**')
  expect(boldAsk('Explain ``x ` y`` here')).toBe('**Explain ``x ` y`` here**')
  // An unclosed backtick is plain text, and an escaped star stays escaped.
  expect(boldAsk('Is ` alone \\* fine?')).toBe('**Is ` alone \\* fine?**')
  // An odd trailing backslash would escape the closing star, so it is doubled.
  expect(boldAsk('Ends with \\')).toBe('**Ends with \\\\**')
  expect(boldAsk('```ts\nconst a = 1 ** 2\n```\nWhat is `a`?')).toBe('```ts\nconst a = 1 ** 2\n```\n**What is `a`?**')
})

test('sourcesSummary says in words what was checked', () => {
  expect(sourcesSummary([])).toBe('')
  expect(sourcesSummary([source('verified'), source('verified')])).toBe('2 verified')
  expect(sourcesSummary([source('unconfirmed')])).toBe('1 link, quote unverified')
  expect(sourcesSummary([source('unconfirmed'), source(undefined)])).toBe('2 links, quotes unverified')
  expect(sourcesSummary([source('verified'), source('verified'), source('unconfirmed')])).toBe('2 verified, 1 unverified')
  expect(sourcesSummary([source('unconfirmed'), source('unconfirmed')], true)).toBe('2 unverified')
})

test('contentColumns leaves one column of padding on each side', () => {
  expect(contentColumns(64)).toBe(62)
  expect(contentColumns(2)).toBe(1)
})

// ---------------------------------------------------------------- terminal and desktop

for (const surface of ['terminal', 'desktop'] as const) {
  const mountPane = ($: Engine, props: { isFocused?: boolean; bodyColumns?: number } = {}) =>
    $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: { ...PANE_PROPS, ...props } })

  test(`${surface}: with no card the pane offers its empty state, under the header line and over a one-row footer`, async ($, on) => {
    world(on)
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: 'Nothing to answer yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /after Claude's next reply/ })).toBeDefined()
    // The header names the mod and the repository folder, and carries the cost the footer used to.
    expect((await ui.find({ type: 'Text', text: /^repo-quiz/ }))?.text).toBe('repo-quiz · app ·')
    const meter = await ui.find({ type: 'Text', text: /today$/ })
    expect(meter?.text).toBe('≈ 0¢ today')
    expect(meter?.props.dimColor).toBe(true)
    expect((await ui.find({ key: 'pause' }))?.props).toMatchObject({ hotkey: 'p', plain: true, dimColor: true })
    expect((await ui.find({ key: 'stats' }))?.props).toMatchObject({ hotkey: 't', plain: true })
    // Off lives in the stats view now.
    expect(await ui.find({ key: 'off' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab for keys' })).toBeDefined()
  })

  test(`${surface}: the root keeps a column of padding on each side and sizes every rule to the room inside it`, async ($, on) => {
    world(on, { question: QUESTION, fact: FACT })
    const ui = await mountPane($)

    expect(await rootProps(ui)).toMatchObject({ flexDirection: 'column', width: 60, paddingX: 1 })
    // Under the header, between the question and the fact, and above the footer.
    const rules = await ui.findAll({ type: 'Text', text: /^─+$/ })
    expect(rules.map(rule => [rule.text.length, rule.props.dimColor])).toEqual([
      [58, true],
      [58, true],
      [58, true],
    ])
  })

  test(`${surface}: the header line gives way, the folder's name first, so the cost always shows`, { options: { dailyBudgetUsd: '1' } }, async ($, on) => {
    world(on, { cost: { todayUsd: 0.4, sessionUsd: 0.4 } })
    const ui = await mountPane($, { bodyColumns: 40 })

    expect((await ui.find({ type: 'Text', text: /^repo-quiz/ }))?.text).toBe('repo-quiz ·')
    expect((await ui.find({ type: 'Text', text: /today$/ }))?.text).toBe('≈ $0.40 of $1.00 today')
  })

  test(`${surface}: the key hint shares the footer row when it fits and moves under it when it does not`, async ($, on) => {
    world(on, { question: QUESTION, mode: { pausedUntil: NOW + 3_600_000, isOff: false } })
    const ui = await mountPane($, { bodyColumns: 60 })
    const footer = async () => ((await ui.drawn()) as unknown as { children?: { props?: Record<string, unknown> }[] }).children?.at(-1)?.props

    expect(await footer()).toMatchObject({ flexDirection: 'row', justifyContent: 'space-between' })
    expect((await ui.find({ key: 'resume' }))?.props.hotkey).toBe('p')
    // "p: Resume t: Stats" and the hint need 39 columns, one more than 40 leaves.
    await ui.redraw({ ...PANE_PROPS, bodyColumns: 40 })
    expect(await footer()).toMatchObject({ flexDirection: 'column' })
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab for keys' })).toBeDefined()
  })

  test(`${surface}: a focused pane drops the key hint`, async ($, on) => {
    world(on)
    const ui = await mountPane($, { isFocused: true })

    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab for keys' })).toBeUndefined()
  })

  test(`${surface}: a question before reveal, then Reveal shows both answers and the one-key grades`, async ($, on) => {
    world(on, { question: QUESTION })
    const ui = await mountPane($)

    expect((await ui.find({ type: 'Text', text: 'Question' }))?.props).toMatchObject({ bold: true, color: 'claude' })
    expect((await ui.find({ type: 'Text', text: /^· Debugging/ }))?.props.wrap).toBe('truncate-end')
    // The setup in the normal weight, then the ask in bold below it.
    const markdown = await ui.findAll({ type: 'Markdown' })
    expect(markdown.map(found => found.text)).toEqual([QUESTION.context, '**Why can `retry()` loop forever?**'])
    expect(await ui.find({ type: 'Text', text: 'on each call.' })).toBeDefined()
    expect((await ui.find({ type: 'Input', key: 'answer' }))?.props).toMatchObject({
      autoFocus: true,
      value: '',
      placeholder: 'Type a line, Enter adds it · empty Enter reveals',
    })
    expect((await ui.find({ key: 'reveal' }))?.props).toMatchObject({ hotkey: 'r', plain: true, variant: 'primary' })
    expect((await ui.find({ key: 'skip' }))?.props.hotkey).toBe('s')
    expect((await ui.find({ key: 'clear' }))?.props.hotkey).toBe('c')
    expect(await ui.find({ type: 'Text', text: "Claude's answer" })).toBeUndefined()
    expect(await ui.find({ key: 'done' })).toBeUndefined()

    await ui.press({ key: 'reveal' })

    expect(await ui.find({ type: 'Text', text: 'Your answer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "Claude's answer" })).toBeDefined()
    expect(await ui.find({ key: 'reveal' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'answer' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'How did you do?' })).toBeDefined()
    expect((await ui.find({ key: SELF_GOT_IT }))?.props).toMatchObject({ hotkey: '3', label: 'Got it', autoFocus: true })
    expect((await ui.find({ key: 'self-missed' }))?.props.hotkey).toBe('1')
    expect((await ui.find({ key: 'self-partly' }))?.props.hotkey).toBe('2')
    expect((await ui.find({ key: 'question-rating-wrong' }))?.props.hotkey).toBe('w')
    expect(await ui.find({ key: 'question-rating-already-knew' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'Possible flaw' }))?.text).toBe('⚠ Possible flaw (medium)')
    expect(await ui.find({ type: 'Text', text: 'src/retry.ts:12' })).toBeDefined()
    expect((await ui.find({ key: 'question-flaw-real' }))?.props.hotkey).toBe('i')
    expect((await ui.find({ key: 'question-flaw-false-alarm' }))?.props.hotkey).toBe('f')
    expect((await ui.find({ key: 'grade' }))?.text).toMatch(/^Grade my answer ≈ .+$/)
    expect((await ui.find({ key: 'sources' }))?.text).toBe('Sources · 1 verified, 1 unverified')
    expect((await ui.find({ key: 'done' }))?.props).toMatchObject({ hotkey: 'x', label: 'Done' })
  })

  test(`${surface}: the question header names the category, the focus file and a refresher's age, cut at the edge`, async ($, on) => {
    world(on, { question: QUESTION })
    const ui = await mountPane($, { bodyColumns: 80 })
    expect((await ui.find({ type: 'Text', text: /^· Debugging/ }))?.text).toBe('· Debugging scenario · retry.ts · refresher, 3mo ago')

    await ui.redraw({ ...PANE_PROPS, bodyColumns: 40 })
    // 38 columns, less "Question" and its gap, leave 29.
    expect((await ui.find({ type: 'Text', text: /^· Debugging/ }))?.text).toBe('· Debugging scenario · retry…')
  })

  test(`${surface}: a question with no context draws the ask alone`, async ($, on) => {
    world(on, { question: { ...QUESTION, context: '', question: QUESTION.ask } })
    const ui = await mountPane($)

    expect((await ui.findAll({ type: 'Markdown' })).map(found => found.text)).toEqual(['**Why can `retry()` loop forever?**'])
  })

  test(`${surface}: a card saved before the split draws its combined question as before`, async ($, on) => {
    const { context: _context, ask: _ask, ...legacy } = { ...QUESTION, question: 'Why can `retry()` loop forever?' }
    world(on, { question: legacy })
    const ui = await mountPane($)

    expect((await ui.findAll({ type: 'Markdown' })).map(found => found.text)).toEqual(['Why can `retry()` loop forever?'])
    expect(await ui.find({ key: 'reveal' })).toBeDefined()
  })

  test(`${surface}: the field keeps a half-typed line, Enter adds it, and an empty Enter reveals`, async ($, on) => {
    world(on, { question: { ...QUESTION, draft: [] } })
    const ui = await mountPane($)

    expect(await ui.find({ key: 'clear' })).toBeUndefined()
    await ui.input({ key: 'answer', text: 'half a line', kind: 'change' })
    expect((await ui.find({ type: 'Input', key: 'answer' }))?.props.value).toBe('half a line')
    expect(await ui.find({ key: 'clear' })).toBeDefined()

    await ui.input({ key: 'answer', text: 'a whole line' })
    expect(await ui.find({ type: 'Text', text: 'a whole line' })).toBeDefined()
    expect((await ui.find({ type: 'Input', key: 'answer' }))?.props.value).toBe('')

    await ui.input({ key: 'answer', text: '' })
    expect(await ui.find({ type: 'Text', text: "Claude's answer" })).toBeDefined()
  })

  test(`${surface}: a choice collapses into a note that changes it back, and a grade reads in the past tense`, async ($, on) => {
    world(on, {
      question: {
        ...REVEALED,
        feedback: { selfAssessment: 'partly', flaw: 'false-alarm' },
        grade: { verdict: 'partially correct', feedback: 'You missed the reset.' },
      },
    })
    const ui = await mountPane($)

    expect((await ui.find({ key: 'question-selfAssessment-change' }))?.text).toBe('You said Partly · change')
    expect((await ui.find({ key: 'question-flaw-change' }))?.text).toBe('Flaw: False alarm · change')
    expect(await ui.find({ key: SELF_GOT_IT })).toBeUndefined()
    expect(await ui.find({ key: 'question-rating-useful' })).toBeDefined()
    expect(await ui.find({ key: 'grade' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Graded: partly correct' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: 'You missed the reset.' })).toBeDefined()
    expect(await ui.find({ key: 'done' })).toBeDefined()

    await ui.press({ key: 'question-selfAssessment-change' })
    expect(await ui.find({ key: SELF_GOT_IT })).toBeDefined()

    await ui.press({ key: SELF_GOT_IT })
    expect((await ui.find({ key: 'question-selfAssessment-change' }))?.text).toBe('You said Got it · change')
  })

  test(`${surface}: Sources opens one row per source and closes again`, async ($, on) => {
    world(on, { question: REVEALED })
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect((await ui.find({ key: 'sources' }))?.props.hotkey).toBe('v')

    await ui.press({ key: 'sources' })

    const links = await ui.findAll({ type: 'Link' })
    expect(links.map(link => link.props)).toEqual([
      { href: 'https://developer.mozilla.org/docs/setTimeout', label: 'setTimeout()' },
      { href: 'https://blog.example/retry', label: 'A blog' },
    ])
    expect((await ui.find({ type: 'Text', text: /^✓$/ }))?.props.color).toBe('success')
    expect(await ui.find({ type: 'Text', text: 'quote checked' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'link only (non-official)' })).toBeDefined()

    await ui.press({ key: 'sources' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
  })

  test(`${surface}: Done puts the revealed question away`, async ($, on) => {
    world(on, { question: REVEALED })
    const ui = await mountPane($)

    await ui.press({ key: 'done' })

    expect(await ui.find({ type: 'Text', text: "Claude's answer" })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Nothing to answer yet' })).toBeDefined()
  })

  test(`${surface}: a fact rates with k for knew it and dismisses with x`, async ($, on) => {
    world(on, { fact: FACT })
    const ui = await mountPane($)

    // With no question open the fact draws in full, in its own color and with no toggle.
    expect((await ui.find({ type: 'Text', text: 'Did you know?' }))?.props).toMatchObject({ bold: true, color: 'suggestion' })
    expect(await ui.find({ type: 'Markdown', text: FACT.text })).toBeDefined()
    expect(await ui.find({ key: 'fact-toggle' })).toBeUndefined()
    expect((await ui.find({ key: 'fact-rating-already-knew' }))?.props).toMatchObject({ hotkey: 'k', label: 'Knew it' })
    expect((await ui.find({ key: 'dismiss-fact' }))?.props).toMatchObject({ hotkey: 'x', label: 'Dismiss' })

    await ui.press({ key: 'dismiss-fact' })
    expect(await ui.find({ type: 'Text', text: 'Did you know?' })).toBeUndefined()
  })

  test(`${surface}: beside an open question the fact folds to one dim line, and d unfolds and folds it`, async ($, on) => {
    world(on, { question: QUESTION, fact: { ...FACT, topic: 'a topic long enough that it would run past the toggle on a narrow pane' } })
    const ui = await mountPane($, { bodyColumns: 40 })

    const teaser = await ui.find({ type: 'Text', text: /^Did you know\? / })
    expect(teaser?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
    // 38 columns inside the padding, less the toggle and its gap.
    expect(teaser?.text).toBe('Did you know? a topic long e…')
    expect((await ui.find({ key: 'fact-toggle' }))?.props).toMatchObject({ hotkey: 'd', label: 'show', plain: true, dimColor: true })
    expect(await ui.find({ type: 'Markdown', text: FACT.text })).toBeUndefined()
    expect(await ui.find({ key: 'dismiss-fact' })).toBeUndefined()

    await ui.press({ key: 'fact-toggle' })
    expect(await ui.find({ type: 'Markdown', text: FACT.text })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'Did you know?' }))?.props.color).toBe('suggestion')
    expect((await ui.find({ key: 'fact-toggle' }))?.props).toMatchObject({ hotkey: 'd', label: 'hide' })
    expect((await ui.find({ key: 'dismiss-fact' }))?.props.hotkey).toBe('x')
    // The question keeps its own place and keys.
    expect((await ui.find({ key: 'reveal' }))?.props.hotkey).toBe('r')

    await ui.press({ key: 'fact-toggle' })
    expect(await ui.find({ type: 'Markdown', text: FACT.text })).toBeUndefined()
    expect((await ui.find({ key: 'fact-toggle' }))?.props.label).toBe('show')
  })

  test(`${surface}: dismissing an unfolded fact folds the next one again`, async ($, on) => {
    const writes: unknown[] = []
    on('state.set', { plugin: 'repo-quiz' }, async ($, e, next) => (e.key === 'ui' && writes.push(e.value), next(e)))
    world(on, { question: QUESTION, fact: FACT, ui: toggles({ factOpen: true }) })
    const ui = await mountPane($)

    await ui.press({ key: 'dismiss-fact' })
    expect(writes.at(-1)).toMatchObject({ factOpen: false, sourcesOpen: false })
    expect(await ui.find({ key: 'fact-toggle' })).toBeUndefined()
  })

  test(`${surface}: beside a revealed question an unfolded fact keeps no hotkeys but d, so none clash`, async ($, on) => {
    world(on, { question: REVEALED, fact: FACT, ui: toggles({ factOpen: true }) })
    const ui = await mountPane($)

    expect((await ui.find({ key: 'fact-toggle' }))?.props.hotkey).toBe('d')
    expect((await ui.find({ key: 'done' }))?.props.hotkey).toBe('x')
    expect((await ui.find({ key: 'dismiss-fact' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ key: 'fact-rating-useful' }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ key: 'question-rating-useful' }))?.props.hotkey).toBe('u')
  })

  test(`${surface}: a run in flight draws the progress line in the card area`, async ($, on) => {
    world(on, { pending: { a: { job: 'question', startedAt: NOW - 12_000 } }, stats: STATS })
    const ui = await mountPane($)
    const line = progressLine({ a: { job: 'question', startedAt: NOW - 12_000 } }, NOW, STATS.medianCardLatencyMs)

    expect(line).toBe('⠋ Preparing a question · 12 s (usually about 42 s)')
    expect(await ui.find({ type: 'Text', text: 'Nothing to answer yet' })).toBeUndefined()
    if (surface === 'terminal') {
      // Sized to the 58 columns inside the root's padding, as register.tsx's repaint is.
      expect((await ui.find({ key: PROGRESS_KEY }))?.props).toEqual({ key: PROGRESS_KEY, columns: 58, rows: 1, cells: progressCells(line, 58) })
    } else {
      expect(await ui.find({ type: 'Raster' })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: line }))?.props.dimColor).toBe(true)
    }
    expect(await ui.find({ type: 'Text', text: 'Last 30 days: 2 answered, 1 got it' })).toBeDefined()
  })

  test(`${surface}: while grading, the progress line takes the grade button's place`, async ($, on) => {
    const pending = { g: { job: 'grade', startedAt: NOW - 4_000, cardId: 'q1' } }
    world(on, { question: REVEALED, pending })
    const ui = await mountPane($)

    expect(await ui.find({ key: 'grade' })).toBeUndefined()
    if (surface === 'terminal') {
      expect(await ui.findAll({ type: 'Raster' })).toHaveLength(1)
      expect((await ui.find({ key: PROGRESS_KEY }))?.props.cells).toBe(progressCells('⠋ Grading · 4 s', 58))
    } else {
      expect((await ui.findAll({ type: 'Text', text: /Grading/ })).map(found => found.text)).toEqual(['⠋ Grading · 4 s'])
    }
  })

  test(`${surface}: paused, the pane says until when and offers Resume on p`, async ($, on) => {
    const until = NOW + 3_600_000
    world(on, { mode: { pausedUntil: until, isOff: false } })
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: `Paused until ${new Date(until).toTimeString().slice(0, 5)}` })).toBeDefined()
    expect((await ui.find({ key: 'resume' }))?.props).toMatchObject({ hotkey: 'p', label: 'Resume' })
    expect(await ui.findAll({ key: 'resume' })).toHaveLength(1)
    expect(await ui.find({ key: 'pause' })).toBeUndefined()
  })

  test(`${surface}: off for the repository, the pane offers Turn on and hides Pause and Off`, async ($, on) => {
    world(on, { mode: { pausedUntil: null, isOff: true } })
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: 'Off for this repository' })).toBeDefined()
    expect(await ui.find({ key: 'turn-on' })).toBeDefined()
    expect(await ui.find({ key: 'pause' })).toBeUndefined()
    expect(await ui.find({ key: 'off' })).toBeUndefined()
  })

  test(`${surface}: Off waits in the stats view beside Back, asks for confirmation first, and Cancel backs out`, async ($, on) => {
    mock.store(on, {})
    world(on, { view: 'stats' })
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: /^repo-quiz/ })).toBeDefined()
    expect((await ui.find({ key: 'off' }))?.props).toMatchObject({ label: 'Off for this repo', plain: true })
    expect((await ui.find({ key: 'off' }))?.props.hotkey).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Turn repo-quiz off/ })).toBeUndefined()
    await ui.press({ key: 'off' })

    expect(await ui.find({ type: 'Text', text: 'Turn repo-quiz off for this repository?' })).toBeDefined()
    expect((await ui.find({ key: 'off-confirm' }))?.text).toBe('Turn off')
    expect(await ui.find({ key: 'off' })).toBeUndefined()
    expect((await ui.find({ key: 'back' }))?.props.hotkey).toBe('b')

    await ui.press({ key: 'off-cancel' })
    expect(await ui.find({ type: 'Text', text: /^Turn repo-quiz off/ })).toBeUndefined()
    expect(await ui.find({ key: 'off' })).toBeDefined()
  })

  test(`${surface}: Back leaves a confirmation of Off behind, and Turn off shows the off state`, async ($, on) => {
    mock.store(on, {})
    world(on, { view: 'stats' })
    const ui = await mountPane($)

    await ui.press({ key: 'off' })
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: 'Nothing to answer yet' })).toBeDefined()
    await ui.press({ key: 'stats' })
    expect(await ui.find({ type: 'Text', text: /^Turn repo-quiz off/ })).toBeUndefined()

    await ui.press({ key: 'off' })
    await ui.press({ key: 'off-confirm' })
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: 'Off for this repository' })).toBeDefined()
  })

  test(`${surface}: past 80% of the budget the meter turns to a warning`, { options: { dailyBudgetUsd: '1' } }, async ($, on) => {
    world(on, { cost: { todayUsd: 0.85, sessionUsd: 0.85 } })
    const ui = await mountPane($)

    const meter = await ui.find({ type: 'Text', text: /today/ })
    expect(meter?.text).toBe('≈ $0.85 of $1.00 today')
    expect(meter?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: /^Daily budget reached/ })).toBeUndefined()
  })

  test(`${surface}: over budget, grading pauses and the empty state says why`, { options: { dailyBudgetUsd: '1' } }, async ($, on) => {
    world(on, { question: REVEALED, cost: { todayUsd: 1.2, sessionUsd: 1.2 } })
    const ui = await mountPane($)

    expect(await ui.find({ key: 'grade' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Grading is paused by the daily budget.' })).toBeDefined()
    // Beside a card the budget gets a warning line of its own under the header.
    expect((await ui.find({ type: 'Text', text: /^Daily budget reached:/ }))?.props.color).toBe('warning')

    await ui.press({ key: 'done' })
    // With no card the empty state says it, so the header line does not repeat it.
    expect(await ui.findAll({ type: 'Text', text: /^Daily budget reached/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: 'Daily budget reached' })).toBeDefined()
  })

  test(`${surface}: below 48 columns the labels shorten`, async ($, on) => {
    world(on, { question: REVEALED })
    const ui = await mountPane($, { bodyColumns: 40 })

    expect(await ui.find({ type: 'Text', text: 'Recalled?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Rate$/ })).toBeDefined()
    expect((await ui.find({ key: 'grade' }))?.text).toMatch(/^Grade ≈ /)
  })

  test(`${surface}: an error shows in the error color and can be dismissed`, async ($, on) => {
    world(on, { error: 'The question run returned unreadable output.' })
    const ui = await mountPane($)

    expect((await ui.find({ type: 'Text', text: /unreadable output/ }))?.props.color).toBe('error')
    await ui.press({ key: 'dismiss-error' })
    expect(await ui.find({ type: 'Text', text: /unreadable output/ })).toBeUndefined()
  })

  test(`${surface}: the stats view with no telemetry still offers Details and Back`, async ($, on) => {
    mock.store(on, {})
    world(on, { view: 'stats' })
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: 'No answers graded yet' })).toBeDefined()
    expect((await ui.find({ key: 'back' }))?.props).toMatchObject({ hotkey: 'b', label: 'Back' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()

    await ui.press({ key: 'details' })
    const details = await ui.find({ type: 'Markdown' })
    expect(details?.text).toContain('No telemetry yet.')
    expect(details?.text).toContain('- Lifetime: nothing spent')
  })

  test(`${surface}: with telemetry off the stats view says so and keeps the cost lines`, { options: { telemetry: 'off' } }, async ($, on) => {
    mock.store(on, {})
    world(on, { view: 'stats', stats: STATS })
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: 'Telemetry is off, so there are no stats.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^answered$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Debugging scenario$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Cost per day, last 30 days' })).toBeDefined()

    await ui.press({ key: 'details' })
    const details = await ui.find({ type: 'Markdown' })
    expect(details?.text).toContain('Telemetry is off.')
    expect(details?.text).toContain('- Lifetime: nothing spent')
  })

  test(`${surface}: the stats view leads with three numbers, a bar per category and a cost sparkline`, async ($, on) => {
    const bucket = {
      usd: 0.5,
      runs: 2,
      byJob: { question: { usd: 0.45, runs: 1 }, grade: { usd: 0.05, runs: 1 } },
      byModel: { 'claude-opus-5-5': { usd: 0.45, runs: 1 }, 'claude-sonnet-5-5': { usd: 0.05, runs: 1 } },
    }
    const tally: Tally = {
      sessionId: 's',
      session: bucket,
      days: { [dayKey(NOW)]: bucket, [dayKey(NOW - 3 * DAY)]: { ...bucket, usd: 0.25 } },
      months: { [monthKey(NOW)]: bucket },
      lifetime: bucket,
    }
    mock.store(on, { tally })
    world(on, { view: 'stats', stats: STATS })
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: /^answered$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^50%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^≈ \$0\.75$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Debugging scenario$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^█+$/ }))?.props.color).toBe('success')
    expect(await ui.find({ type: 'Text', text: '1 ✓ 1 ~ 0 ✗' })).toBeDefined()
    const spark = await ui.find({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]{30}$/ })
    expect(spark?.props.color).toBe('claude')
    expect(spark?.text.endsWith('█')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /API-equivalent estimates/ })).toBeDefined()

    await ui.press({ key: 'details' })
    const details = await ui.find({ type: 'Markdown' })
    expect(details?.text).toContain('- Flaw feedback: 1 real issue · 1 false alarm (50% real)')
    expect(details?.text).toMatch(/^- Today ≈ .+ over 2 runs$/m)
    expect(details?.text).toContain('  - by job: question')
  })
}

// ---------------------------------------------------------------- mobile

test('mobile: no answer field, a note instead, and Reveal is still offered', async ($, on) => {
  world(on, { question: QUESTION })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'Pane', requestId: PLUGIN, props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: /typed on the terminal or desktop/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'on each call.' })).toBeDefined()
  expect(await ui.find({ key: 'reveal' })).toBeDefined()
})

test('mobile: the same header, folded fact and footer keys, and d unfolds the fact', async ($, on) => {
  world(on, { question: QUESTION, fact: FACT })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'Pane', requestId: PLUGIN, props: PANE_PROPS })

  expect(await rootProps(ui)).toMatchObject({ width: 60, paddingX: 1 })
  expect((await ui.find({ type: 'Text', text: /^repo-quiz/ }))?.text).toBe('repo-quiz · app ·')
  expect(await ui.find({ type: 'Markdown', text: '**Why can `retry()` loop forever?**' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Did you know\? / }))?.text).toBe('Did you know? churn')
  expect((await ui.find({ key: 'pause' }))?.props.hotkey).toBe('p')
  expect((await ui.find({ key: 'stats' }))?.props.hotkey).toBe('t')
  expect(await ui.find({ key: 'off' })).toBeUndefined()

  await ui.press({ key: 'fact-toggle' })
  expect(await ui.find({ type: 'Markdown', text: FACT.text })).toBeDefined()
})

test('mobile: a run in flight is a dim line, since only the terminal draws a Raster', async ($, on) => {
  world(on, { pending: { a: { job: 'facts', startedAt: NOW - 3_000 } } })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'Pane', requestId: PLUGIN, props: PANE_PROPS })

  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '⠋ Gathering facts · 3 s' }))?.props.dimColor).toBe(true)
})

// ---------------------------------------------------------------- new question on demand

for (const surface of ['terminal', 'desktop'] as const) {
  const mountPane = ($: Engine) => $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PLUGIN, props: PANE_PROPS })

  test(`${surface}: the empty state offers a new question with q and its estimated price`, async ($, on) => {
    world(on)
    const ui = await mountPane($)

    expect((await ui.find({ key: 'new-question-empty' }))?.props).toMatchObject({ hotkey: 'q', plain: true })
    expect(await ui.find({ type: 'Text', text: /^≈ / })).toBeDefined()
    // The empty state already offers it, so the footer does not repeat it.
    expect(await ui.find({ key: 'new-question' })).toBeUndefined()
  })

  test(`${surface}: after a reveal the new question sits under the question, above the fact and the footer`, async ($, on) => {
    world(on, { question: REVEALED, fact: FACT })
    const ui = await mountPane($)
    expect((await ui.find({ key: 'new-question' }))?.props).toMatchObject({ hotkey: 'q' })
    const order = JSON.stringify(await ui.drawn())
    expect(order.indexOf('"new-question"')).toBeLessThan(order.indexOf('Did you know?'))
    expect(order.indexOf('"new-question"')).toBeLessThan(order.indexOf('"stats"'))
  })

  test(`${surface}: with only a fact on screen the new question sits above the fact`, async ($, on) => {
    world(on, { fact: FACT })
    const ui = await mountPane($)
    const order = JSON.stringify(await ui.drawn())
    expect(order.indexOf('"new-question"')).toBeGreaterThan(-1)
    expect(order.indexOf('"new-question"')).toBeLessThan(order.indexOf('Did you know?'))
  })

  test(`${surface}: an unanswered question offers no new question`, async ($, on) => {
    world(on, { question: QUESTION })
    const open = await mountPane($)
    expect(await open.find({ key: 'new-question' })).toBeUndefined()
    expect(await open.find({ key: 'new-question-empty' })).toBeUndefined()
  })
}

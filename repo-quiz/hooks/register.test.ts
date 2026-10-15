// Engine tests for register.tsx: a reply the user prompted spawns the questioner,
// a quiz agent's report is kept out of the main conversation, /repo-quiz
// pause writes the store, and the settings reach the agents, the pane, the
// status line, /config and telemetry. (The agents' guard is hooks/guard.py:
// --self-test.) Everything outside the plugin (git, files, panes, agents, the
// store) is answered by the test's hooks beneath it.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const ROOT = '/work/app'
const NOW = Date.UTC(2026, 9, 9, 12)
const AGENT = 'agent-q1'
const PROCESS_OK = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const TELEMETRY_DIR = '/home/luke/.claude/repo-quiz/telemetry/'

function world(on: On, opts: { paneShown?: boolean } = {}) {
  const store: Record<string, unknown> = {}
  const states: Record<string, unknown> = {}
  const spawns: string[] = []
  const prompts: string[] = []
  const agents: Record<string, { model?: string; effort?: string | number }> = {}
  const agentPrompts: Record<string, string> = {}
  const files: Record<string, string> = {}
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const opened: string[] = []
  let onSpawn = () => {}
  const spawned = new Promise<void>(resolve => (onSpawn = resolve))
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/luke' })

  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', ($, e) => (delete store[e.key], { value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('process.run', ($, e) => ({ value: { ...PROCESS_OK, stdout: e.argv.includes('--show-toplevel') ? `${ROOT}\n` : '' } }))
  // Only what the plugin wrote can be read back, which is its telemetry; the repository's files are all missing.
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT: no such file' }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.write', ($, e) => ((files[e.path] = e.text), { value: undefined }))
  on('ui.open', ($, e) => (opened.push(e.id), { value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [{ id: 'repo-quiz', title: 'Repo quiz', isShown: opts.paneShown ?? true, isFocused: false, isPlaced: true }] }))
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('agent.register', ($, e) => ((agents[e.name] = { model: e.model, effort: e.effort }), (agentPrompts[e.name] = e.prompt), { value: { agent: `repo-quiz:${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // In the kit this hook stands where the Agent tool runs: it receives the
  // tool's input (`subagent_type`), and the plugin's spawn reads its agentId
  // from the tool's `async_launched` result.
  on('agent.spawn', ($, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; prompt?: string }
    spawns.push(String(input.subagentType ?? input.subagent_type))
    prompts.push(String(input.prompt))
    onSpawn()
    const launched = { status: 'async_launched', agentId: AGENT, description: 'repo-quiz question', prompt: '', outputFile: '' }

    return { model: 'claude-opus-5-5', result: launched } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('state.set', { plugin: 'repo-quiz' }, async ($, e, next) => ((states[e.key] = e.value), next(e)))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // Beneath the plugin the engine would ask; any other verdict came from the plugin.
  on('tool.check', () => ({ decision: 'ask' as const }))

  /** Every telemetry record written so far, parsed. */
  const telemetry = () =>
    Object.entries(files)
      .filter(([path]) => path.startsWith(TELEMETRY_DIR))
      .flatMap(([, text]) => text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>))

  return { store, states, spawns, prompts, agents, agentPrompts, statuses, toasts, opened, telemetry, spawned, clock }
}

/** The user types a prompt, Claude answers, and the plugin's deferred work runs until the questioner is spawned. */
async function replyAndSpawn($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'How does the cache invalidate entries?', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'It uses a TTL map.', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.settle()
  await w.spawned
  await w.clock.settle()
}

const DRAFT = {
  topic: 'cache invalidation',
  category: 'Architecture and module boundaries',
  context: 'Entries in `Cache` expire after a TTL.',
  ask: 'How does `Cache.evict` decide what to drop?',
  answer: 'It walks the TTL map, as `src/cache.ts:12` shows.',
  citations: [{ path: 'src/cache.ts', line: 12, quote: 'evict()' }],
  sources: [],
  flaw: null,
}

/** What the card's combined question reads for DRAFT. */
const QUESTION_TEXT = 'Entries in `Cache` expire after a TTL.\n\nHow does `Cache.evict` decide what to drop?'

/** The questioner finishes with DRAFT, and the plugin's deferred work runs. */
async function finishQuestion($: Engine, w: ReturnType<typeof world>) {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  const answer = `Done.\n\n\`\`\`json\n${JSON.stringify(DRAFT)}\n\`\`\``
  await $.turn.complete({ agentId: AGENT, answer, durationMs: 90_000, isAborted: false, turnId: 't2', reason: 'answer', usage })
  await w.clock.settle()
}

test('a reply to a prompt the user typed spawns the questioner', async ($, on) => {
  const w = world(on)
  await replyAndSpawn($, w)

  expect(w.spawns).toEqual(['repo-quiz:questioner'])
  expect(w.store[`${ROOT}:questionCounter`]).toBe(1)
  expect(w.store[`${ROOT}:askedAt`]).toEqual([NOW])
  // The defaults: Opus thinking hard for questions, Sonnet for facts, and the pane opened at start.
  expect(w.agents).toEqual({ questioner: { model: 'opus', effort: 'high' }, 'fact-finder': { model: 'sonnet', effort: 'medium' } })
  expect(w.prompts[0]).toContain('at the level of a collegiate to senior software engineering interview.')
  expect(w.opened).toEqual(['repo-quiz'])
})

test('the questioner’s finished turn becomes a question card and lands in the tally', async ($, on) => {
  const w = world(on)
  await replyAndSpawn($, w)
  const draft = DRAFT
  await finishQuestion($, w)

  // The cited file cannot be read here, so the card is shown with its unverified warning.
  expect(w.states.question).toMatchObject({
    context: draft.context,
    ask: draft.ask,
    question: QUESTION_TEXT,
    category: draft.category,
    isUnverified: true,
    isRevealed: false,
  })
  expect(w.states.pending).toEqual({})
  expect((w.store.tally as { lifetime: { runs: number; usd: number } }).lifetime.runs).toBe(1)
  expect((w.store.tally as { lifetime: { runs: number; usd: number } }).lifetime.usd).toBeGreaterThan(0)
})

test('a reply to a prompt the user did not type spawns nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'A background task finished.', wait: false, origin: { kind: 'task-notification' } })
  await $.turn.complete({ answer: 'Noted.', durationMs: 300, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.settle()

  expect(w.spawns).toEqual([])
})

test('/repo-quiz pause 5 writes the pause time for the repository', async ($, on) => {
  const w = world(on)
  const result = await $.command.run({
    command: 'repo-quiz',
    args: 'pause 5',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(result.text).toContain('paused for 5 minutes')
  expect(w.store[`${ROOT}:pausedUntil`]).toBe(NOW + 5 * 60_000)
})

test('a quiz agent’s hand-back, which arrives as a peer prompt, is dropped before the main conversation', async ($, on) => {
  const w = world(on)
  await replyAndSpawn($, w)

  const handback = `<agent-message from="${AGENT}">\n[Subagent hand-back] The text below is the final report of a subagent.`
  const dropped = await $.prompt.submit({ text: handback, wait: false, origin: { kind: 'peer' } })
  expect(dropped).toMatchObject({ drop: 'repo-quiz: a quiz agent finished. Its card is in the sidebar.' })

  // Another agent's message, and the user's own words naming the id, still go through.
  const other = await $.prompt.submit({ text: '<agent-message from="agent-other">hello', wait: false, origin: { kind: 'peer' } })
  expect(other).toMatchObject({ text: '<agent-message from="agent-other">hello' })
  const typed = await $.prompt.submit({ text: `what did ${AGENT} do?`, wait: false, origin: { kind: 'composer' } })
  expect(typed).toMatchObject({ text: `what did ${AGENT} do?` })
})

// ---------------------------------------------------------------- settings

test('the model settings reach the registered agent types', { options: { questionModel: 'sonnet', questionEffort: 'low', factModel: 'haiku' } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(w.agents.questioner).toEqual({ model: 'sonnet', effort: 'low' })
  // The fact-finder's effort is not a setting.
  expect(w.agents['fact-finder']).toEqual({ model: 'haiku', effort: 'medium' })
})

test(
  'difficulty, flaw review and source policy reach the questioner’s task',
  { options: { difficulty: 'staff', flawReview: false, sourcePolicy: 'official only' } },
  async ($, on) => {
    const w = world(on)
    await replyAndSpawn($, w)

    expect(w.prompts[0]).toContain('at the level of a staff engineer interview. It should test system-wide trade-offs, failure modes,')
    expect(w.prompts[0]).toContain('`flaw` is always `null`. The developer has turned the flaw review off, so skip it this time.')
    expect(w.prompts[0]).toContain("Cite only pages on the packet's official documentation hosts")
  },
)

test('a dealt fact starts folded, even when the last one was left unfolded', { options: { mode: 'facts only' } }, async ($, on) => {
  const w = world(on)
  const fact = { id: 'f9', createdAt: 0, model: 'sonnet', topic: 'TTL', text: 'Entries expire.', citations: [], sources: [], flaw: null, feedback: {} }
  w.store[`${ROOT}:facts`] = [fact, { ...fact, id: 'f10' }, { ...fact, id: 'f11' }, { ...fact, id: 'f12' }]
  // The pane's toggles as an earlier press left them: the last fact unfolded.
  on('state.get', { plugin: 'repo-quiz' }, async ($, e, next) => {
    const stored = await next(e)
    const isUnwritten = stored.value?.version === 0
    const ui = { sourcesOpen: false, detailsOpen: false, confirmOff: false, factOpen: true }

    return isUnwritten && e.key === 'ui' ? ({ value: { value: ui, version: 0 } } as typeof stored) : stored
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'How does the cache invalidate entries?', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'It uses a TTL map.', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.settle()

  expect(w.states.fact).toMatchObject({ id: 'f9', createdAt: NOW })
  expect(w.states.ui).toMatchObject({ factOpen: false })
})

test('facts only never starts the questioner', { options: { mode: 'facts only' } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'How does the cache invalidate entries?', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'It uses a TTL map.', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.settle()
  await w.spawned
  await w.clock.settle()

  // With no saved facts the plugin refills them, so the one spawn is the fact-finder.
  expect(w.spawns).toEqual(['repo-quiz:fact-finder'])
  expect(w.telemetry().find(record => record.type === 'decision')).toMatchObject({ chosen: 'none', reasons: ['mode'] })
})

test('with the pane set not to open at start, only /repo-quiz opens it', { options: { openPaneOnStart: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.opened).toEqual([])

  await $.command.run({ command: 'repo-quiz', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(w.opened).toEqual(['repo-quiz'])
})

test('a new question toasts while the pane is hidden, unless the toast is turned off', async ($, on) => {
  const w = world(on, { paneShown: false })
  await replyAndSpawn($, w)
  await finishQuestion($, w)

  expect(w.toasts).toEqual(['repo-quiz: a new question is ready. Run /repo-quiz to open it.'])
})

test('with the toast turned off, a new question arrives quietly', { options: { toastOnNewQuestion: false } }, async ($, on) => {
  const w = world(on, { paneShown: false })
  await replyAndSpawn($, w)
  await finishQuestion($, w)

  expect((w.states.question as { question?: string } | undefined)?.question).toBe(QUESTION_TEXT)
  expect(w.toasts).toEqual([])
})

test('by default the status line shows the state', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(w.statuses.at(-1)).toBe('repo-quiz ✓ ready · $0.00 today')
})

test('with the status line turned off, it is cleared instead', { options: { statusLine: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(w.statuses.length).toBeGreaterThan(0)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
})

test('counts-only telemetry, the default, keeps the card record without its question, answer or paths', async ($, on) => {
  const w = world(on)
  await replyAndSpawn($, w)
  await finishQuestion($, w)
  const records = w.telemetry()

  expect(records.find(record => record.type === 'card')).toMatchObject({ kind: 'question', category: DRAFT.category, session: 'session-1', version: '0.2.1' })
  expect(records.find(record => record.type === 'run')).toMatchObject({ job: 'question', usage: { input_tokens: 1000, output_tokens: 500 } })
  const text = JSON.stringify(records)
  // The context and ask are typed text too, so counts only drops them with the question.
  for (const secret of ['Cache.evict', 'expire after a TTL', 'TTL map', 'src/cache.ts', 'cache invalidation', ROOT]) expect([secret, text.includes(secret)]).toEqual([secret, false])
})

test('full telemetry keeps the card content, for reviewing quality later', { options: { telemetry: 'full' } }, async ($, on) => {
  const w = world(on)
  await replyAndSpawn($, w)
  await finishQuestion($, w)

  expect(w.telemetry().find(record => record.type === 'card')).toMatchObject({ context: DRAFT.context, ask: DRAFT.ask, question: QUESTION_TEXT, repo: ROOT })
})

test('with telemetry off nothing is written', { options: { telemetry: 'off' } }, async ($, on) => {
  const w = world(on)
  await replyAndSpawn($, w)
  await finishQuestion($, w)

  expect(w.states.question).toMatchObject({ question: QUESTION_TEXT })
  expect(w.telemetry()).toEqual([])
})

test('the writing style reaches both agent types by default, and the steWriting setting removes it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(w.agentPrompts.questioner).toContain('Simplified Technical English')
  expect(w.agentPrompts['fact-finder']).toContain('Simplified Technical English')
})

test('with steWriting off the agents get no writing style block', { options: { steWriting: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(w.agentPrompts.questioner).not.toContain('Simplified Technical English')
  expect(w.agentPrompts.questioner).toContain('# Output')
})

const COMMAND = { command: 'repo-quiz', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

test('/repo-quiz ask starts a question at once, even while paused', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ ...COMMAND, args: 'pause 30' })

  const result = await $.command.run({ ...COMMAND, args: 'ask' })
  expect(result.text).toBe('A new question is on its way to the repo quiz pane.')
  await w.clock.settle()
  await w.spawned
  await w.clock.settle()

  expect(w.spawns).toEqual(['repo-quiz:questioner'])
  // It counts toward the hourly tally, so the automatic rhythm allows for it.
  expect(w.store[`${ROOT}:askedAt`]).toEqual([NOW])
})

test('/repo-quiz ask refuses while a question is on its way, or when the repository is off', async ($, on) => {
  const w = world(on)
  await replyAndSpawn($, w)

  const again = await $.command.run({ ...COMMAND, args: 'ask' })
  expect(again.text).toBe('A question is already on its way.')

  await $.command.run({ ...COMMAND, args: 'off' })
  const off = await $.command.run({ ...COMMAND, args: 'ask' })
  expect(off.text).toBe('repo-quiz is off for this repository. Run /repo-quiz on first.')
  expect(w.spawns).toEqual(['repo-quiz:questioner'])
})

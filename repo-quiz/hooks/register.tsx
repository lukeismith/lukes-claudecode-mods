// Engine wiring for repo-quiz: every hook, both agent types, the slash
// command, the pane's actions, and the question and fact flows. Decisions
// live in logic.ts, I/O in repo.ts, prompt text in prompts.ts, single model
// calls in models.ts and drawing in pane.tsx.
//
// The validator follows `$` only within this file: every function that takes
// `$` is declared at the top level here, other modules get `makeIo($)`, and
// the atoms are declared here rather than imported.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  CitationCounts,
  CodeCitation,
  FactCard,
  Feedback,
  Flaw,
  Io,
  PendingRun,
  QuestionCard,
  Settings,
  Source,
  SourceCounts,
  Tally,
  Usage,
} from '../types'
import {
  DEFAULT_SETTINGS,
  FACT_REFILL_AT,
  addToTally,
  applySourcePolicy,
  baseName,
  isOfficialUrl,
  chooseCard,
  costLine,
  costOf,
  dayKey,
  formatUsd,
  isOverBudget,
  isRefresherTurn,
  joinQuestion,
  newId,
  nextCategory,
  parseFactBatch,
  parseQuestion,
  readSettings,
  redactRecord,
  scrubAnswerText,
  summarizeTelemetry,
} from './logic'
import { checkSupport, confirmFlaw, gradeAnswer } from './models'
import type { ModelRun } from './models'
import { PROGRESS_KEY, SELF_GOT_IT, contentColumns, progressCells, progressLine, renderPane } from './pane'
import type { PaneActions } from './pane'
import { FACT_FINDER_DESCRIPTION, QUESTIONER_DESCRIPTION, agentSystemPrompt, factBatchTask, questionTask } from './prompts'
import {
  buildContextPacket,
  createTelemetry,
  flawExcerpts,
  pickFocus,
  readTelemetry,
  repoRoot,
  staleCitation,
  verifyCitations,
  verifySources,
} from './repo'

type $ = EngineInterface
type Telemetry = ReturnType<typeof createTelemetry>
type RunRecord = Omit<ModelRun, 'job'> & { job: string; searches: number; toolCalls: number; agentId?: string }
type QuestionDraft = NonNullable<ReturnType<typeof parseQuestion>>
type FactBatchDraft = NonNullable<ReturnType<typeof parseFactBatch>>

const PANE = 'repo-quiz'
const questionAtom = atom({ plugin: 'repo-quiz', key: 'question' } as const, null)
const factAtom = atom({ plugin: 'repo-quiz', key: 'fact' } as const, null)
const viewAtom = atom({ plugin: 'repo-quiz', key: 'view' } as const, 'quiz')
const pendingAtom = atom({ plugin: 'repo-quiz', key: 'pending' } as const, {})
const oursAtom = atom({ plugin: 'repo-quiz', key: 'ours' } as const, [])
const errorAtom = atom({ plugin: 'repo-quiz', key: 'error' } as const, null)
const statsAtom = atom({ plugin: 'repo-quiz', key: 'stats' } as const, null)
const costAtom = atom({ plugin: 'repo-quiz', key: 'cost' } as const, { todayUsd: 0, sessionUsd: 0 })
const uiAtom = atom({ plugin: 'repo-quiz', key: 'ui' } as const, { sourcesOpen: false, detailsOpen: false, confirmOff: false, factOpen: false })
const modeAtom = atom({ plugin: 'repo-quiz', key: 'mode' } as const, { pausedUntil: null, isOff: false })

const VERSION = '0.2.1'
const QUESTIONER = 'repo-quiz:questioner'
const FACT_FINDER = 'repo-quiz:fact-finder'
const AGENT_TOOLS = ['Read', 'Bash', 'WebSearch', 'WebFetch']
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
// A run with no turn.complete after this long is treated as dead, so it can
// never block questions or keep "Preparing a question…" up for the session.
const STALE_MS = 30 * 60_000

// Module variables reset on a hot reload. Everything here is per-session
// and cheap to lose: the next prompt re-learns it.
// ponytail: a reload forgets the prompt gap, touched files and agent tool counts; move them to $.state if reloads mid-run matter.
// A /config change reloads the module, so register() reads the settings once and they hold for this load.
let settings: Settings = DEFAULT_SETTINGS
let base: Promise<{ root: string; home: string; sessionId: string; tel: Telemetry }> | undefined
let lastPromptAt: number | null = null
let gapMs: number | null = null
let lastPrompt = ''
let isFromUser = false
let touched: string[] = []
let budgetLoggedDay = ''
let chain: Promise<unknown> = Promise.resolve()

type AgentDone = { agentId: string; answer: string; reason: string; durationMs: number; usage?: Usage & { model: string } }

// The progress Raster's last drawn width and the pane's surface, for the progress line's repaint.
let paneColumns = 0
let paneSurface = ''

// A finished quiz agent's report reaches the main conversation as a prompt:
// its SubagentHandback (origin `peer`, opening `<agent-message from="<id>">`)
// or, outside auto mode, a task-notification naming it. Either would post the
// model answer there, so it is dropped; turn.complete already gave the mod the
// result. Only reports sent BY the mod's agents match, never a message that
// merely mentions one of their ids.
const REPORT_DROPPED = 'repo-quiz: a quiz agent finished. Its card is in the sidebar.'

function isAgentReport(kind: string, text: string, ours: readonly string[]): boolean {
  const head = text.trimStart()
  if (kind === 'peer') return ours.some(id => head.startsWith(`<agent-message from="${id}"`))
  if (kind === 'task-notification') return ours.some(id => text.includes(`<task-id>${id}</task-id>`))

  return false
}

/** Tool calls and web searches from the agent's own transcript: the mod never sees its agents' tool calls as events. */
async function toolUsesOf($: $, agentId: string): Promise<{ tools: number; searches: number }> {
  const messages = await $.session.messages({ agentId }).catch(() => ({ deny: 'unreadable' }))
  if (!Array.isArray(messages)) return { tools: 0, searches: 0 }
  const uses = messages.flatMap(message => message.toolUses)

  return { tools: uses.length, searches: uses.filter(use => use.tool === 'WebSearch').length }
}

// ---------------------------------------------------------------- plumbing

/** The engine calls repo.ts and models.ts make, as closures over `$`. */
function makeIo($: $): Io {
  return {
    run: async (argv, init) => {
      const { exitCode, stdout, stderr } = await $.process.run(argv, init)

      return { exitCode, stdout, stderr }
    },
    readText: path => $.fs.read(path),
    writeText: (path, text) => $.fs.write(path, text),
    list: async path => (await $.fs.list(path)).map(({ name, kind, size, mtimeMs }) => ({ name, kind, size, mtimeMs })),
    exists: path => $.fs.exists(path),
    fetch: async (url, init) => {
      const { status, ok, headers, text } = await $.http.fetch(url, init && { method: init.method, headers: init.headers })

      return { status, ok, headers, text }
    },
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    cwd: () => $.session.cwd(),
    complete: async request => {
      const result = await $.model.complete(request)

      return result.isAnswered
        ? { isAnswered: true, text: result.text, usage: result.usage }
        : { isAnswered: false, reason: result.reason, usage: result.usage }
    },
  }
}

function setup($: $) {
  base ??= (async () => {
    const io = makeIo($)
    const [root, home = '', sessionId] = await Promise.all([repoRoot(io), $.env.get('HOME'), $.session.id()])
    // The writer adds session, repo and version, so redaction runs there, on the whole record.
    const tel = createTelemetry(io, { sessionId, version: VERSION, repo: root, home, redact: record => redactRecord(record, settings.telemetry) })

    return { root, home, sessionId, tel }
  })().catch(err => {
    base = undefined
    throw err
  })

  return base
}

// ponytail: one lock for every $.store read-modify-write; per-key locks if it ever queues visibly.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})

  return run
}

async function get<T>($: $, key: string, fallback: T): Promise<T> {
  return ((await $.store.get(key)) as T | undefined) ?? fallback
}

function edit<T>($: $, key: string, fallback: T, fn: (value: T) => T): Promise<T> {
  return serial(async () => {
    const value = fn(await get($, key, fallback))
    await $.store.set(key, value)

    return value
  })
}

// Work that must not hold up the hook that triggered it.
function later($: $, fn: () => Promise<void>) {
  $.clock.after(0, () => void fn().catch(err => fail($, 'background work', err)))
}

/**
 * Fire-and-forget: telemetry never throws, rejects or delays anything. Every
 * record goes through here. Off writes nothing, and the writer that setup()
 * builds passes each record through logic.redactRecord for the setting.
 */
function log($: $, record: { type: string; cardId?: string; [field: string]: unknown }) {
  if (settings.telemetry === 'off') return
  setup($).then(
    b => {
      try {
        b.tel.log(record)
      } catch {}
    },
    () => {},
  )
}

async function fail($: $, where: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  log($, { type: 'error', where, message })
  await update($, errorAtom, () => `repo-quiz: ${where} failed: ${message}`.slice(0, 200)).catch(() => {})
}

async function paneState($: $) {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)

  return { panePlaced: pane?.isPlaced ?? false, paneShown: (pane?.isPlaced && pane.isShown) ?? false }
}

function isLive(run: PendingRun, now: number) {
  return now - run.startedAt < STALE_MS
}

// ---------------------------------------------------------------- cost and status

async function refreshCost($: $) {
  const { sessionId } = await setup($)
  const line = costLine(await get<Tally | undefined>($, 'tally', undefined), sessionId, await $.clock.now())
  await update($, costAtom, () => line)
}

async function refreshStatus($: $) {
  const { root } = await setup($)
  const now = await $.clock.now()
  const [question, pending, cost, pausedUntil, isOff] = await Promise.all([
    read($, questionAtom),
    read($, pendingAtom),
    read($, costAtom),
    get($, `${root}:pausedUntil`, 0),
    get($, `${root}:off`, false),
  ])
  const live = Object.values(pending).filter(run => isLive(run, now))
  const isPaused = pausedUntil > now
  const [glyph, state] = isOff
    ? ['⏻', 'off for this repository']
    : isPaused
      ? ['⏸', `paused until ${clockTime(pausedUntil)}`]
      : live.some(run => run.job === 'question')
        ? ['◌', 'preparing a question']
        : question && !question.isRevealed
          ? ['?', '1 open question']
          : live.some(run => run.job === 'facts')
            ? ['◌', 'gathering facts']
            : ['✓', 'ready']
  const budget = settings.dailyBudgetUsd
  const share = budget > 0 ? ` (${Math.round((100 * cost.todayUsd) / budget)}% of budget)` : ''
  // undefined clears the line, so turning the setting off also removes a line an earlier load pinned.
  $.ui.status(settings.statusLine ? `repo-quiz ${glyph} ${state} · ${formatUsd(cost.todayUsd)} today${share}` : undefined)

  const mode = await read($, modeAtom)
  const next = { pausedUntil: isPaused ? pausedUntil : null, isOff }
  if (mode.pausedUntil !== next.pausedUntil || mode.isOff !== next.isOff) await update($, modeAtom, () => next)
}

/** Local `HH:MM`. */
function clockTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5)
}

/** Repaints the progress Raster once a second, without redrawing the pane (so a half-typed answer is never disturbed). */
async function tickProgress($: $) {
  if (paneColumns <= 0 || paneSurface !== 'terminal') return
  const now = await $.clock.now()
  const live = Object.fromEntries(Object.entries(await read($, pendingAtom)).filter(([, run]) => isLive(run, now)))
  if (Object.keys(live).length === 0) return
  const line = progressLine(live, now, (await read($, statsAtom))?.medianCardLatencyMs ?? null)
  if (line) await $.ui.blit({ requestId: PANE, key: PROGRESS_KEY, cells: progressCells(line, paneColumns) })
}

async function recordRun($: $, run: RunRecord) {
  const { sessionId } = await setup($)
  const now = await $.clock.now()
  await edit<Tally | undefined>($, 'tally', undefined, tally =>
    addToTally(tally, { sessionId, now, job: run.job, model: run.model, usd: run.usd }),
  )
  await refreshCost($)
  log($, { type: 'run', ...run })
}

async function support($: $, claim: string, passage: string) {
  const { verdict, run } = await checkSupport(makeIo($), claim, passage)
  await recordRun($, { ...run, searches: 0, toolCalls: 0 })

  return verdict
}

async function forget($: $, id: string) {
  let run: PendingRun | undefined
  await update($, pendingAtom, pending => {
    const { [id]: gone, ...rest } = pending
    run = gone

    return rest
  })

  return run
}

// ---------------------------------------------------------------- deciding after a reply

async function onReply($: $) {
  try {
    const { root } = await setup($)
    const now = await $.clock.now()
    const pending = await update($, pendingAtom, all =>
      Object.fromEntries(Object.entries(all).filter(([, run]) => isLive(run, now))),
    )
    const [askedAt, pausedUntil, isOff, question, cost] = await Promise.all([
      get<number[]>($, `${root}:askedAt`, []),
      get($, `${root}:pausedUntil`, 0),
      get($, `${root}:off`, false),
      read($, questionAtom),
      read($, costAtom),
    ])
    const runs = Object.values(pending)
    const choice = chooseCard({
      now,
      gapMs,
      askedAt,
      hasOpenQuestion: question !== null && !question.isRevealed,
      isQuestionRunning: runs.some(run => run.job === 'question'),
      isPaused: pausedUntil > now,
      isOff,
      spentTodayUsd: cost.todayUsd,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      questionsPerHour: settings.questionsPerHour,
      rapidReplyMs: settings.rapidReplyMinutes * 60_000,
      mode: settings.mode,
    })
    const isOver = isOverBudget(cost.todayUsd, settings.dailyBudgetUsd)
    if (isOver && budgetLoggedDay !== dayKey(now)) {
      budgetLoggedDay = dayKey(now)
      log($, { type: 'control', action: 'budget-reached' })
    }

    let chosen: string = choice.kind
    try {
      if (choice.kind === 'question') {
        await startQuestion($, now)
      } else if (choice.kind === 'fact') {
        chosen = await dealFact($, now, !isOver && !runs.some(run => run.job === 'facts'))
      }
    } finally {
      log($, {
        type: 'decision',
        chosen,
        reasons: choice.reasons,
        gapMs,
        questionsLastHour: askedAt.filter(at => now - at < HOUR_MS).length,
        ...(await paneState($).catch(() => ({}))),
      })
    }
  } catch (err) {
    await fail($, 'choosing a card', err)
  }
  await refreshStatus($).catch(() => {})
}

// True from a request for a question until its run has started, so a double press starts one run.
let isAsking = false

/**
 * Starts a question now, because the user asked for one. It skips the
 * automatic rules (the hourly limit, the rapid-reply window, a pause, "facts
 * only") and keeps the daily budget. It returns why no question started, or
 * null when one is on its way.
 */
async function askNow($: $): Promise<string | null> {
  const { root } = await setup($)
  const now = await $.clock.now()
  const [question, pending, cost, isOff] = await Promise.all([
    read($, questionAtom),
    read($, pendingAtom),
    read($, costAtom),
    get($, `${root}:off`, false),
  ])
  if (isOff) return 'repo-quiz is off for this repository. Run /repo-quiz on first.'
  if (isOverBudget(cost.todayUsd, settings.dailyBudgetUsd)) return 'The daily budget is reached, so no new question starts until tomorrow.'
  if (isAsking || Object.values(pending).some(run => run.job === 'question' && isLive(run, now))) return 'A question is already on its way.'
  if (question && !question.isRevealed) return 'Answer or skip the open question first.'
  isAsking = true
  log($, { type: 'decision', chosen: 'question', reasons: ['manual'] })
  later($, async () => {
    try {
      await startQuestion($, now)
    } finally {
      isAsking = false
      await refreshStatus($).catch(() => {})
    }
  })

  return null
}

async function startQuestion($: $, now: number) {
  const { root } = await setup($)
  const io = makeIo($)
  const [counter, categoryIndex, recentFoci, lastQuizzed, topics] = await Promise.all([
    get($, `${root}:questionCounter`, 0),
    get($, `${root}:categoryIndex`, 0),
    get<string[]>($, `${root}:recentFoci`, []),
    get<Record<string, number>>($, `${root}:lastQuizzed`, {}),
    get<string[]>($, `${root}:topics`, []),
  ])
  const { category, nextIndex } = nextCategory(categoryIndex, settings.categories)
  const pick = { root, touched, recentFoci, lastQuizzed, now, ...focusSettings() }
  const focus = isRefresherTurn(counter, settings.refresherEvery)
    ? ((await pickFocus(io, { ...pick, kind: 'refresher' })) ?? (await pickFocus(io, { ...pick, kind: 'recent' })))
    : await pickFocus(io, { ...pick, kind: 'recent' })
  const packet = await buildContextPacket(io, { root, touched, lastPrompt, avoidTopics: topics, category, focus, extraFocus: [], ...packetSettings() })

  const spawned = await $.agent.spawn({ subagentType: QUESTIONER, prompt: questionTask(packet), description: 'repo-quiz question' })
  if (!spawned.agentId) throw new Error(spawned.deny ?? 'the questioner did not start')
  await adopt($, spawned.agentId, {
    job: 'question',
    startedAt: now,
    triggeredAt: now,
    cardId: newId(now, Math.random),
    category,
    focus,
    officialHosts: packet.officialHosts,
  })

  // The question counts toward the hourly limit once its run starts, since that is where the cost lands.
  await edit<number[]>($, `${root}:askedAt`, [], at => [...at.filter(t => now - t < HOUR_MS), now])
  await edit($, `${root}:questionCounter`, 0, n => n + 1)
  await edit($, `${root}:categoryIndex`, 0, () => nextIndex)
  if (focus) {
    await edit<string[]>($, `${root}:recentFoci`, [], foci => [focus.path, ...foci.filter(p => p !== focus.path)].slice(0, 5))
    await edit<Record<string, number>>($, `${root}:lastQuizzed`, {}, map => ({ ...map, [focus.path]: now }))
  }
}

async function startFactBatch($: $, now: number) {
  const { root } = await setup($)
  const io = makeIo($)
  const [recentFoci, lastQuizzed, topics] = await Promise.all([
    get<string[]>($, `${root}:recentFoci`, []),
    get<Record<string, number>>($, `${root}:lastQuizzed`, {}),
    get<string[]>($, `${root}:topics`, []),
  ])
  const pick = { root, touched, recentFoci, lastQuizzed, now, ...focusSettings() }
  const focus = await pickFocus(io, { ...pick, kind: 'recent' })
  const first = await pickFocus(io, { ...pick, kind: 'refresher' })
  // Passing the first refresher as touched keeps the second from picking the same file.
  const second = first && (await pickFocus(io, { ...pick, touched: [...touched, first.path], kind: 'refresher' }))
  const extraFocus = [first, second].filter(one => one !== null)
  const packet = await buildContextPacket(io, { root, touched, lastPrompt, avoidTopics: topics, focus, extraFocus, ...packetSettings() })

  const spawned = await $.agent.spawn({ subagentType: FACT_FINDER, prompt: factBatchTask(packet), description: 'repo-quiz facts' })
  if (!spawned.agentId) throw new Error(spawned.deny ?? 'the fact-finder did not start')
  await adopt($, spawned.agentId, { job: 'facts', startedAt: now, triggeredAt: now, officialHosts: packet.officialHosts })
}

/** What pickFocus reads from the settings. */
function focusSettings() {
  return { exclude: settings.excludePaths, minAgeMs: settings.refresherMinAgeDays * DAY_MS }
}

/** What buildContextPacket carries from the settings into the task text. */
function packetSettings() {
  return { difficulty: settings.difficulty, sourcePolicy: settings.sourcePolicy, flawReview: settings.flawReview }
}

async function adopt($: $, agentId: string, run: PendingRun) {
  // ours first: the guard reads it on the agent's first tool call.
  await update($, oursAtom, ids => [...ids.filter(id => id !== agentId), agentId].slice(-20))
  await update($, pendingAtom, pending => ({ ...pending, [agentId]: run }))
}

/** Shows the next saved fact (dropping stale ones), and refills the saved facts when allowed. With none saved, the pane shows "Gathering facts…" until the batch lands. */
async function dealFact($: $, now: number, mayRefill: boolean): Promise<'fact' | 'none'> {
  const { root } = await setup($)
  const io = makeIo($)
  const key = `${root}:facts`
  const { card, left } = await serial(async () => {
    const facts = await get<FactCard[]>($, key, [])
    let card: FactCard | null = null
    while (!card && facts.length > 0) {
      const next = facts.shift() as FactCard
      const stale = await staleCitation(io, root, next)
      if (stale) log($, { type: 'fact-expired', cardId: next.id, factId: next.id, citation: stale })
      else card = next
    }
    await $.store.set(key, facts)

    return { card, left: facts.length }
  })

  if (card) {
    const fact = { ...card, createdAt: now }
    await update($, factAtom, () => fact)
    // A new fact starts folded beside an open question, whatever the last one was left as.
    await update($, uiAtom, ui => ({ ...ui, factOpen: false }))
    // No latencyMs: a dealt fact was generated earlier, so it would only drag the median generation time toward zero.
    log($, { ...fact, type: 'card', cardId: fact.id, kind: 'fact', paneVisible: (await paneState($)).paneShown })
  }

  if (left <= FACT_REFILL_AT && mayRefill) {
    await startFactBatch($, now).catch(err => fail($, 'starting a fact batch', err))
  }

  return card ? 'fact' : 'none'
}

// ---------------------------------------------------------------- results

async function onAgentDone($: $, e: AgentDone) {
  const run = await forget($, e.agentId)
  if (!run) return
  // While code checks citations and sources the run stays visible, as "Checking sources".
  const verifyId = `${e.agentId}:verify`
  await update($, pendingAtom, all => ({ ...all, [verifyId]: { ...run, stage: 'verifying' as const } }))
  try {
    await processAgentDone($, e, run)
  } finally {
    await forget($, verifyId)
  }
}

async function processAgentDone($: $, e: AgentDone, run: PendingRun) {
  const counts = await toolUsesOf($, e.agentId)
  const isQuestion = run.job === 'question'
  // The settings as this load read them; the agent ran on its type as registered then, unless /config changed it mid-run.
  const model = e.usage?.model ?? (isQuestion ? settings.questionModel : settings.factModel)
  const what = isQuestion ? 'the question run' : 'the fact batch'

  try {
    const draft = e.reason !== 'answer' ? null : isQuestion ? parseQuestion(e.answer) : parseFactBatch(e.answer)
    await recordRun($, {
      job: run.job,
      model,
      effort: isQuestion ? settings.questionEffort : 'medium',
      durationMs: e.durationMs,
      outcome: e.reason === 'aborted' ? 'aborted' : e.reason !== 'answer' ? 'error' : draft ? 'ok' : 'unreadable',
      // Only the token counts: the model is the run's own field, and an all-number object survives counts-only telemetry.
      usage: e.usage ? tokenCounts(e.usage) : null,
      searches: counts.searches,
      toolCalls: counts.tools,
      agentId: e.agentId,
      usd: e.usage ? costOf(e.usage, model, counts.searches) : 0,
    })
    if (!draft) {
      await update($, errorAtom, () =>
        e.reason === 'answer' ? `The output of ${what} could not be read.` : `${what} ended early (${e.reason}).`,
      )
      return
    }
    if (isQuestion) await finishQuestion($, run, model, draft as QuestionDraft)
    else await finishFacts($, run, model, draft as FactBatchDraft)
  } catch (err) {
    await fail($, `finishing ${what}`, err)
  }
  await refreshStatus($).catch(() => {})
}

/** The flaw with its evidence verified and line mentions moved, or null when there is none or any evidence failed. */
async function checkFlaw($: $, root: string, flaw: Flaw | null): Promise<Flaw | null> {
  if (!flaw || flaw.evidence.length === 0) return null
  const { kept } = await verifyCitations(makeIo($), root, flaw.evidence)

  return kept.length === flaw.evidence.length
    ? { ...flaw, summary: scrubAnswerText(flaw.summary, [], moves(root, flaw.evidence, kept)), evidence: kept }
    : null
}

/**
 * With "official only", sources outside the official hosts are dropped before
 * verifySources would fetch them and pay a Haiku support check for each.
 */
function onPolicy(sources: Source[], hosts: string[]): Source[] {
  return applySourcePolicy(sources.map(source => ({ ...source, isOfficial: isOfficialUrl(source.url, hosts) })), settings.sourcePolicy)
}

async function finishQuestion($: $, run: PendingRun, model: string, draft: QuestionDraft) {
  const { root } = await setup($)
  const io = makeIo($)
  const citations = await verifyCitations(io, root, draft.citations)
  const allowed = onPolicy(draft.sources, run.officialHosts ?? [])
  const sources = await verifySources(io, allowed, run.officialHosts ?? [], (claim, passage) => support($, claim, passage))
  const keptSources = applySourcePolicy(sources.kept, settings.sourcePolicy)
  // With the review off, a flaw the agent reports anyway is dropped unchecked.
  const draftFlaw = settings.flawReview ? draft.flaw : null
  const flaw = await checkFlaw($, root, draftFlaw)
  const kept = { citations: citations.kept, sources: keptSources }
  const now = await $.clock.now()
  const card: QuestionCard = {
    id: run.cardId ?? newId(now, Math.random),
    createdAt: now,
    model,
    category: run.category ?? draft.category,
    focusKind: run.focus?.kind ?? 'recent',
    focusPath: run.focus?.path ?? '',
    lastChangedAt: run.focus?.lastChangedAt,
    topic: draft.topic,
    ...splitQuestion(root, draft, kept),
    answer: scrub(root, draft.answer, draft, kept),
    citations: citations.kept,
    sources: keptSources,
    flaw,
    isUnverified: citations.kept.length === 0,
    draft: [],
    isRevealed: false,
    feedback: {},
  }
  await update($, questionAtom, () => card)
  await edit<string[]>($, `${root}:topics`, [], topics => [...topics, draft.topic].slice(-30))

  const pane = await paneState($)
  log($, {
    type: 'verify',
    cardId: card.id,
    job: 'question',
    model,
    citations: citations.counts,
    sources: sources.counts,
    sourcesOffPolicy: draft.sources.length - allowed.length + sources.kept.length - keptSources.length,
    flaws: { reported: draftFlaw ? 1 : 0, droppedEvidence: draftFlaw && !flaw ? 1 : 0, confirmed: flaw ? 1 : 0, rejected: 0 },
  })
  log($, { ...card, type: 'card', cardId: card.id, kind: 'question', latencyMs: now - (run.triggeredAt ?? run.startedAt), paneVisible: pane.paneShown })
  if (!pane.paneShown && settings.toastOnNewQuestion) $.ui.toast('repo-quiz: a new question is ready. Run /repo-quiz to open it.')
}

async function finishFacts($: $, run: PendingRun, model: string, batch: FactBatchDraft) {
  const { root } = await setup($)
  const io = makeIo($)
  let citationCounts: CitationCounts = { total: 0, verified: 0, corrected: 0, dropped: 0 }
  let sourceCounts: SourceCounts = { total: 0, verified: 0, unconfirmed: 0, dead: 0, unsupported: 0 }
  const flaws = { reported: 0, droppedEvidence: 0, confirmed: 0, rejected: 0 }
  let sourcesOffPolicy = 0
  const facts: FactCard[] = []

  // One fact at a time keeps the fetches and support checks at verifySources' own concurrency.
  for (const draft of batch.facts) {
    const citations = await verifyCitations(io, root, draft.citations)
    const allowed = onPolicy(draft.sources, run.officialHosts ?? [])
    const sources = await verifySources(io, allowed, run.officialHosts ?? [], (claim, passage) => support($, claim, passage))
    const keptSources = applySourcePolicy(sources.kept, settings.sourcePolicy)
    citationCounts = sum(citationCounts, citations.counts)
    sourceCounts = sum(sourceCounts, sources.counts)
    sourcesOffPolicy += draft.sources.length - allowed.length + sources.kept.length - keptSources.length

    let flaw: Flaw | null = null
    // With the review off, a flaw the agent reports anyway is dropped without the Opus confirmation call.
    if (draft.flaw && settings.flawReview) {
      flaws.reported += 1
      const checked = await checkFlaw($, root, draft.flaw)
      if (!checked) {
        flaws.droppedEvidence += 1
      } else {
        const confirmation = await confirmFlaw(io, checked, await flawExcerpts(io, root, checked), settings.steWriting)
        await recordRun($, { ...confirmation.run, searches: 0, toolCalls: 0 })
        if (confirmation.isConfirmed) flaw = checked
        flaws[confirmation.isConfirmed ? 'confirmed' : 'rejected'] += 1
      }
    }

    // A fact needs some verified support: a code citation that matched, or a source whose page holds its quote.
    if (citations.kept.length === 0 && !keptSources.some(source => source.mark === 'verified')) continue
    const now = await $.clock.now()
    const kept = { citations: citations.kept, sources: keptSources }
    facts.push({
      id: newId(now, Math.random),
      createdAt: now,
      model,
      topic: draft.topic,
      text: scrub(root, draft.text, draft, kept),
      ...kept,
      flaw,
      feedback: {},
    })
  }

  await edit<FactCard[]>($, `${root}:facts`, [], saved => [...saved, ...facts])
  await edit<string[]>($, `${root}:topics`, [], topics => [...topics, ...facts.map(fact => fact.topic)].slice(-30))
  log($, {
    type: 'verify',
    job: 'facts',
    model,
    citations: citationCounts,
    sources: sourceCounts,
    sourcesOffPolicy,
    factsProduced: batch.facts.length,
    factsKept: facts.length,
    flaws,
  })
}

// ---------------------------------------------------------------- switches

async function setPause($: $, minutes: number | null) {
  const { root } = await setup($)
  if (minutes === null) {
    await $.store.delete(`${root}:pausedUntil`)
    log($, { type: 'control', action: 'resume' })
  } else {
    await $.store.set(`${root}:pausedUntil`, (await $.clock.now()) + minutes * 60_000)
    log($, { type: 'control', action: 'pause', minutes })
  }
  await refreshStatus($).catch(() => {})
}

async function setOff($: $, isOff: boolean) {
  const { root } = await setup($)
  await $.store.set(`${root}:off`, isOff)
  log($, { type: 'control', action: isOff ? 'off' : 'on' })
  await refreshStatus($).catch(() => {})
}

async function computeStats($: $) {
  // Off means no stats, so files written before it was turned off are left unread.
  if (settings.telemetry === 'off') {
    await update($, statsAtom, () => null)
    return
  }
  const { home } = await setup($)
  const now = await $.clock.now()
  const stats = summarizeTelemetry(await readTelemetry(makeIo($), home, 30, now), now, 30)
  await update($, statsAtom, () => stats)
}

async function showStats($: $) {
  await computeStats($)
  await update($, viewAtom, () => 'stats' as const)
}

async function startGrade($: $, card: QuestionCard, id: string) {
  try {
    const { result, run } = await gradeAnswer(makeIo($), card, card.draft.join('\n'), settings.gradeModel, settings.steWriting)
    await recordRun($, { ...run, searches: 0, toolCalls: 0 })
    if (result) await update($, questionAtom, one => (one?.id === card.id ? { ...one, grade: result } : one))
    else await update($, errorAtom, () => 'The grader’s reply could not be read.')
    log($, { type: 'grade', cardId: card.id, verdict: result?.verdict ?? null, feedback: result?.feedback ?? null, usd: run.usd, latencyMs: run.durationMs })
  } catch (err) {
    await fail($, 'grading', err)
  } finally {
    await forget($, id)
  }
}

// ---------------------------------------------------------------- the pane's presses

// Presses never throw: the card change lands first, and what follows it
// (clock, telemetry, status line) is best effort.
function actions($: $): PaneActions {
  const editQuestion = (fn: (card: QuestionCard) => QuestionCard) => update($, questionAtom, card => (card ? fn(card) : card))

  return {
    addLine: async line => {
      await editQuestion(card => (card.isRevealed ? card : { ...card, draft: [...card.draft, line], partial: '' }))
    },
    setPartial: async text => {
      await editQuestion(card => (card.isRevealed || card.partial === text ? card : { ...card, partial: text }))
    },
    clearDraft: async () => {
      await editQuestion(card => ({ ...card, draft: [], partial: '' }))
    },
    reveal: async () => {
      const card = await read($, questionAtom)
      if (!card || card.isRevealed) return
      // A line still in the field counts as the answer's last line.
      const draft = card.partial?.trim() ? [...card.draft, card.partial] : card.draft
      await editQuestion(one => (one.id === card.id ? { ...one, draft, partial: '', isRevealed: true } : one))
      await (async () => {
        // Enter on "Got it" is then the one-key path for the most common answer.
        await $.ui.focus({ requestId: PANE, key: SELF_GOT_IT }).catch(() => {})
        const now = await $.clock.now()
        await editQuestion(one => (one.id === card.id ? { ...one, revealedAt: now } : one))
        const text = draft.join('\n')
        log($, { type: 'answer', cardId: card.id, text, chars: text.length, lines: draft.length, msToReveal: now - card.createdAt })
        await refreshStatus($)
      })().catch(() => {})
    },
    newQuestion: async () => {
      const reason = await askNow($).catch(err => (err instanceof Error ? err.message : String(err)))
      if (reason) await update($, errorAtom, () => reason)
    },
    dismiss: async which => {
      const card = which === 'question' ? await read($, questionAtom) : await read($, factAtom)
      if (!card) return
      if (which === 'question') await update($, questionAtom, one => (one?.id === card.id ? null : one))
      else await update($, factAtom, one => (one?.id === card.id ? null : one))
      await update($, uiAtom, ui => ({ ...ui, sourcesOpen: false, ...(which === 'fact' ? { factOpen: false } : {}) }))
      await (async () => {
        const graded = 'grade' in card && card.grade !== undefined
        log($, { type: 'dismiss', cardId: card.id, kind: which, graded, msShown: (await $.clock.now()) - card.createdAt })
        await refreshStatus($)
      })().catch(() => {})
    },
    clearFeedback: async (which, field) => {
      const clear = <C extends { feedback: Feedback }>(card: C): C => {
        const { [field]: _, ...rest } = card.feedback
        return { ...card, feedback: rest }
      }
      if (which === 'question') await editQuestion(clear)
      else await update($, factAtom, card => (card ? clear(card) : card))
      log($, { type: 'feedback-cleared', kind: which, field })
    },
    toggle: async key => {
      await update($, uiAtom, ui => ({ ...ui, [key]: !ui[key] }))
    },
    resume: () => setPause($, null).catch(err => fail($, 'resuming', err)),
    turnOn: () => setOff($, false).catch(err => fail($, 'turning on', err)),
    skip: async () => {
      const card = await read($, questionAtom)
      if (!card) return
      await update($, questionAtom, one => (one?.id === card.id ? null : one))
      await (async () => {
        log($, { type: 'skip', cardId: card.id, msShown: (await $.clock.now()) - card.createdAt })
        await refreshStatus($)
      })().catch(() => {})
    },
    grade: async () => {
      const [card, pending, cost] = await Promise.all([read($, questionAtom), read($, pendingAtom), read($, costAtom)])
      if (!card || !card.isRevealed || card.grade || card.draft.length === 0) return
      if (Object.values(pending).some(run => run.job === 'grade' && run.cardId === card.id)) return
      if (isOverBudget(cost.todayUsd, settings.dailyBudgetUsd)) {
        await update($, errorAtom, () => 'The daily budget is reached, so grading is off until tomorrow.')
        return
      }
      const now = await $.clock.now()
      const id = newId(now, Math.random)
      await update($, pendingAtom, all => ({ ...all, [id]: { job: 'grade' as const, startedAt: now, cardId: card.id } }))
      later($, () => startGrade($, card, id))
    },
    feedback: async (which, field, value) => {
      const change = <C extends { feedback: Feedback }>(card: C): C => ({ ...card, feedback: { ...card.feedback, [field]: value } as Feedback })
      const type = field === 'selfAssessment' ? 'self-assessment' : field === 'rating' ? 'rating' : 'flaw-feedback'
      if (which === 'question') {
        const card = await read($, questionAtom)
        if (!card) return
        await editQuestion(one => (one.id === card.id ? change(one) : one))
        log($, { type, cardId: card.id, value, kind: 'question', category: card.category, focusKind: card.focusKind, model: card.model })
      } else {
        const card = await read($, factAtom)
        if (!card) return
        await update($, factAtom, one => (one?.id === card.id ? change(one) : one))
        log($, { type, cardId: card.id, value, kind: 'fact', focusKind: card.focusKind, model: card.model })
      }
    },
    showStats: () => showStats($).catch(err => fail($, 'computing stats', err)),
    showQuiz: async () => {
      await update($, viewAtom, () => 'quiz' as const)
      // Off is confirmed in the stats view, so leaving it backs out of a confirmation left open.
      await update($, uiAtom, ui => (ui.confirmOff ? { ...ui, confirmOff: false } : ui))
    },
    pause: minutes => setPause($, minutes).catch(err => fail($, 'pausing', err)),
    turnOff: async () => {
      await update($, uiAtom, ui => ({ ...ui, confirmOff: false }))
      await setOff($, true).catch(err => fail($, 'turning off', err))
    },
    dismissError: async () => {
      await update($, errorAtom, () => null)
    },
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    try {
      // Fires again on every hot reload, a /config change included: registering
      // again replaces, so new models take effect here, and the pane opens only
      // on the session's first start (cost state is unwritten).
      const { version } = await $.state.get({ plugin: 'repo-quiz', key: 'cost' } as const)
      const agent = { prompt: agentSystemPrompt(settings.steWriting), tools: AGENT_TOOLS, background: true } as const
      const questioner = { name: 'questioner', description: QUESTIONER_DESCRIPTION, model: settings.questionModel, effort: settings.questionEffort, maxTurns: 15 }
      const factFinder = { name: 'fact-finder', description: FACT_FINDER_DESCRIPTION, model: settings.factModel, effort: 'medium', maxTurns: 20 }
      await Promise.all([
        setup($),
        $.agent.register({ ...agent, ...questioner }),
        $.agent.register({ ...agent, ...factFinder }),
        $.command.register({
          name: 'repo-quiz',
          description: 'Open the repo quiz pane, ask for a new question, pause, resume, turn off, turn on, or show stats',
          argumentHint: '[ask | pause [minutes] | resume | off | on | stats]',
        }),
      ])
      if (version === 0 && settings.openPaneOnStart) void $.ui.open({ id: PANE, title: 'Repo quiz' })
      $.clock.every(1_000, () => void tickProgress($).catch(() => {}))
      later($, () => computeStats($))
      await refreshCost($)
      await refreshStatus($)
    } catch (err) {
      await fail($, 'starting', err)
    }

    return next(e)
  })

  on('agent.offer', { agent: [QUESTIONER, FACT_FINDER] }, () => ({ isOffered: false }))

  // An out-of-range number is saved as its clamped value, so /config shows what
  // will apply. A failure lets the change through: readSettings clamps it on load anyway.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    if (isAgentReport(kind, e.text, await read($, oursAtom))) return { drop: REPORT_DROPPED }
    if (kind === 'composer' || kind === 'bridge') {
      const now = await $.clock.now()
      gapMs = lastPromptAt === null ? null : now - lastPromptAt
      lastPromptAt = now
      lastPrompt = e.text.slice(0, 600)
      isFromUser = true
    } else if (!e.turnId) {
      // A delivery into a running turn (turnId set) does not change who started that turn.
      isFromUser = false
    }

    return next(e)
  })

  // The files the main conversation reads and edits steer recent focus. The
  // mod's own agents' calls never reach this hook (they step past the plugin
  // that spawned them); hooks/guard.py, a settings hook, confines them instead.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId && (e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write')) {
      const { root } = await setup($)
      const path = e.file_path.startsWith(`${root}/`) ? e.file_path.slice(root.length + 1) : e.file_path
      if (!path.startsWith('/')) touched = [path, ...touched.filter(one => one !== path)].slice(0, 15)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const agentId = e.agentId
      if ((await read($, pendingAtom))[agentId]) later($, () => onAgentDone($, { ...e, agentId }))

      return next(e)
    }
    const result = await next(e)
    const isUser = isFromUser
    isFromUser = false
    if (e.reason === 'answer' && isUser) later($, () => onReply($))

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // These reads subscribe the pane, so a write to any of them redraws it.
    const [view, question, fact, allPending, error, stats, cost, ui, mode] = await Promise.all([
      read($, viewAtom),
      read($, questionAtom),
      read($, factAtom),
      read($, pendingAtom),
      read($, errorAtom),
      read($, statsAtom),
      read($, costAtom),
      read($, uiAtom),
      read($, modeAtom),
    ])
    const now = await $.clock.now()
    const pending = Object.fromEntries(Object.entries(allPending).filter(([, run]) => isLive(run, now)))
    // A store that fails to answer still leaves the stats view drawable.
    const tally = view === 'stats' ? ((await $.store.get('tally').catch(() => undefined)) as Tally | undefined) : undefined
    // setup() has resolved by the time the pane opens; a failure only leaves the name out of the header.
    const repoName = await setup($).then(b => baseName(b.root), () => '')
    paneColumns = contentColumns(e.props.bodyColumns)
    paneSurface = e.surface
    const data = { view, question, fact, pending, error, stats, cost, tally, now, ui, mode, repoName, telemetryOff: settings.telemetry === 'off' }
    const ctx = { actions: actions($), dailyBudgetUsd: settings.dailyBudgetUsd, gradeModel: settings.gradeModel, questionModel: settings.questionModel }

    return renderPane(e, $.ui.resolve(e), data, ctx)
  })

  on('command.run', { command: 'repo-quiz' }, async ($, e) => {
    const [word = '', arg] = e.args.trim().toLowerCase().split(/\s+/)
    switch (word) {
      case '':
        await update($, viewAtom, () => 'quiz' as const)
        await $.ui.open({ id: PANE, title: 'Repo quiz' })

        return { text: 'The repo quiz pane is open.' }
      case 'pause': {
        const minutes = arg === undefined ? 60 : Number(arg)
        if (!(minutes > 0 && minutes <= 7 * 24 * 60)) return { text: 'Give the pause in minutes, for example /repo-quiz pause 30.' }
        await setPause($, minutes)

        return { text: `repo-quiz is paused for ${minutes} minutes in this repository.` }
      }
      case 'resume':
        await setPause($, null)

        return { text: 'repo-quiz has resumed in this repository.' }
      case 'off':
        await setOff($, true)

        return { text: 'repo-quiz is off for this repository until you run /repo-quiz on.' }
      case 'on':
        await setOff($, false)

        return { text: 'repo-quiz is on for this repository.' }
      case 'ask': {
        const reason = await askNow($)
        await $.ui.open({ id: PANE, title: 'Repo quiz' })

        return { text: reason ?? 'A new question is on its way to the repo quiz pane.' }
      }
      case 'stats':
        await showStats($)
        await $.ui.open({ id: PANE, title: 'Repo quiz' })

        return { text: 'The repo quiz stats are open in the pane.' }
      default:
        return { text: 'Usage: /repo-quiz [ask | pause [minutes] | resume | off | on | stats]' }
    }
  })
}

// ---------------------------------------------------------------- pure helpers

function tokenCounts(usage: Usage): Usage {
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = usage

  return { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
}

function sum<T extends Record<string, number>>(a: T, b: T): T {
  return Object.fromEntries(Object.entries(a).map(([key, value]) => [key, value + (b[key] ?? 0)])) as T
}

/** Each draft citation whose kept copy (same path and quote) sits on another line: what scrubAnswerText moves. */
function moves(root: string, drafts: CodeCitation[], kept: CodeCitation[]) {
  return drafts.flatMap(draft => {
    const path = draft.path.startsWith(`${root}/`) ? draft.path.slice(root.length + 1) : draft.path
    const match = kept.find(one => one.path === path && one.quote === draft.quote)

    return match && match.line !== draft.line ? [{ path, from: draft.line, to: match.line }] : []
  })
}

/** The card's context and ask, each scrubbed, and the combined question built from them. */
function splitQuestion(root: string, draft: QuestionDraft, kept: { citations: CodeCitation[]; sources: Source[] }) {
  const context = scrub(root, draft.context, draft, kept)
  const ask = scrub(root, draft.ask, draft, kept)

  return { context, ask, question: joinQuestion(context, ask) }
}

/** `text` with links to dropped sources unlinked and `path:line` mentions moved to the corrected lines. */
function scrub(root: string, text: string, draft: { citations: CodeCitation[]; sources: Source[] }, kept: { citations: CodeCitation[]; sources: Source[] }) {
  const dropped = draft.sources.map(source => source.url).filter(url => !kept.sources.some(source => source.url === url))

  return scrubAnswerText(text, dropped, moves(root, draft.citations, kept.citations))
}

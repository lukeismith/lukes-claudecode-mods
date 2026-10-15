// The repo-quiz contract: the domain types every module shares, and the
// values the mod keeps in $.state. Changing a shape here is a contract
// change: update every module that reads it.

export type Job = 'question' | 'facts' | 'grade' | 'flaw' | 'support'
export type FocusKind = 'recent' | 'refresher'

/** A claim about the repository, pinned to a line and a short verbatim quote of it. */
export type CodeCitation = { path: string; line: number; quote: string }

/** `verified`: the page holds the quote and Haiku judged it supports the claim. `unconfirmed`: the link works but the quote was not found in the page. */
export type SourceMark = 'verified' | 'unconfirmed'

/** A documentation source: `quote` is a short verbatim passage of the page that backs `claim`. */
export type Source = {
  title: string
  url: string
  claim: string
  quote: string
  mark?: SourceMark
  isOfficial?: boolean
}

export type Flaw = {
  summary: string
  severity: 'low' | 'medium' | 'high'
  evidence: CodeCitation[]
}

/** What the questioner agent returns, before verification. */
export type QuestionDraft = {
  topic: string
  category: string
  /**
   * Markdown that sets the question up, under about 80 words: a scenario, a
   * pointer to specific lines, or a fenced snippet of at most 10 lines. It may
   * be one line or empty.
   */
  context: string
  /** What the developer must answer: one or two sentences, or a numbered list of at most three parts; a question or an instruction. */
  ask: string
  /** `context`, a blank line, then `ask` (just `ask` when there is no context): what grading and telemetry read. */
  question: string
  answer: string
  citations: CodeCitation[]
  sources: Source[]
  flaw: Flaw | null
}

/** One fact as the fact-finder agent returns it, before verification. */
export type FactDraft = {
  topic: string
  text: string
  citations: CodeCitation[]
  sources: Source[]
  flaw: Flaw | null
}

export type FactBatchDraft = { facts: FactDraft[] }

export type GradeResult = {
  verdict: 'correct' | 'partially correct' | 'incorrect'
  feedback: string
}

export type SupportVerdict = 'yes' | 'partial' | 'no'

/** The code a question or fact batch is pointed at. Lines are 1-based and inclusive. */
export type Focus = {
  kind: FocusKind
  path: string
  startLine: number
  endLine: number
  excerpt: string
  /** Epoch ms of the file's last commit, when known. */
  lastChangedAt?: number
}

/** Everything code gathers before a model run, so the agent does not spend turns discovering it. */
export type ContextPacket = {
  repoRoot: string
  branch: string
  languages: { ext: string; files: number }[]
  /** `git log --oneline` of recent commits. */
  recentCommits: string
  /** `git status --short` plus `git diff --stat HEAD`. */
  uncommitted: string
  touchedFiles: string[]
  officialHosts: string[]
  focus: Focus | null
  /** Refresher files added to a fact batch's packet. */
  extraFocus: Focus[]
  /** The developer's latest prompt, trimmed to about 600 characters. */
  lastPrompt: string
  avoidTopics: string[]
  /** Set for a question; absent for a fact batch. */
  category?: string
  difficulty: Settings['difficulty']
  sourcePolicy: Settings['sourcePolicy']
  /** When false the agent skips the flaw review and code drops any flaw it reports anyway. */
  flawReview: boolean
}

export type Feedback = {
  selfAssessment?: 'got-it' | 'partly' | 'missed'
  rating?: 'useful' | 'not-useful' | 'wrong' | 'already-knew'
  flaw?: 'real' | 'false-alarm'
}

export type QuestionCard = {
  id: string
  createdAt: number
  model: string
  category: string
  focusKind: FocusKind
  focusPath: string
  lastChangedAt?: number
  topic: string
  /** As QuestionDraft's. A card saved before the split has neither field, so the pane checks `ask` before using them. */
  context: string
  ask: string
  /** The combined text, as QuestionDraft's: grading, telemetry and cards saved before the split read it. */
  question: string
  answer: string
  citations: CodeCitation[]
  sources: Source[]
  flaw: Flaw | null
  /** True when every code citation failed verification. */
  isUnverified: boolean
  /** The answer as typed so far, one entry per line. */
  draft: string[]
  /** The line being typed in the answer field, kept so a redraw never loses it. */
  partial?: string
  isRevealed: boolean
  revealedAt?: number
  grade?: GradeResult
  feedback: Feedback
}

export type FactCard = {
  id: string
  createdAt: number
  model: string
  topic: string
  text: string
  citations: CodeCitation[]
  sources: Source[]
  flaw: Flaw | null
  focusKind?: FocusKind
  feedback: Feedback
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type CostCount = { usd: number; runs: number }

export type TallyBucket = CostCount & {
  byJob: Record<string, CostCount>
  byModel: Record<string, CostCount>
}

/** The cost tally kept in $.store under one key, shared across repositories. */
export type Tally = {
  sessionId: string
  session: TallyBucket
  /** Keyed `YYYY-MM-DD` (local time); pruned to the last 60 days. */
  days: Record<string, TallyBucket>
  /** Keyed `YYYY-MM` (local time). */
  months: Record<string, TallyBucket>
  lifetime: TallyBucket
}

/** One JSON Lines telemetry record. `type` names the record (decision, run, verify, card, answer, ...). */
export type TelemetryRecord = {
  type: string
  ts: number
  session: string
  repo: string
  version: string
  cardId?: string
  [field: string]: unknown
}

export type Counts3 = { gotIt: number; partly: number; missed: number }
export type RatingCounts = { useful: number; notUseful: number; wrong: number; alreadyKnew: number }
export type CitationCounts = { total: number; verified: number; corrected: number; dropped: number }
export type SourceCounts = { total: number; verified: number; unconfirmed: number; dead: number; unsupported: number }

/** What the Stats view draws, computed from the last N days of telemetry. */
export type StatsSummary = {
  days: number
  /** Cards shown by kind: question, fact. */
  cards: Record<string, number>
  selfAssessment: {
    byCategory: Record<string, Counts3>
    byFocus: Record<string, Counts3>
  }
  ratings: {
    byKind: Record<string, RatingCounts>
    byModel: Record<string, RatingCounts>
  }
  flawFeedback: { real: number; falseAlarm: number }
  verification: Record<string, { citations: CitationCounts; sources: SourceCounts }>
  costPerQuestionUsd: number | null
  costPerKeptFactUsd: number | null
  medianCardLatencyMs: number | null
  /** Share of cards shown while the pane was visible, from 0 to 1. */
  paneVisibleShare: number | null
}

/** What `Io.complete` resolves: the engine's ModelCompleteResult, narrowed to what the mod reads. */
export type CompleteResult =
  | { isAnswered: true; text: string; usage: Usage }
  | { isAnswered: false; reason: string; usage?: Usage }

/**
 * The engine capabilities repo.ts and models.ts use, built from `$` by
 * makeIo in register.tsx. The validator follows `$` only within one file and
 * never across an import, so other modules receive these closures instead.
 * Each mirrors the `$` call named beside it, with the same failure behavior.
 */
export type Io = {
  /** $.process.run(argv, { cwd, timeoutMs }); rejects only when the command cannot start or times out. */
  run: (argv: string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** $.fs.read(path); rejects when missing or over 4 MiB. */
  readText: (path: string) => Promise<string>
  /** $.fs.write(path, text); creates directories as needed. */
  writeText: (path: string, text: string) => Promise<void>
  /** $.fs.list(path). */
  list: (path: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }[]>
  /** $.fs.exists(path). */
  exists: (path: string) => Promise<boolean>
  /** $.http.fetch(url, init). */
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>
  /** $.store.get / $.store.set. */
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  /** $.clock.now / $.clock.sleep. */
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  /** $.session.cwd(). */
  cwd: () => Promise<string>
  /** $.model.complete(request); resolves for every provider outcome, rejects only when the engine refuses to send. */
  complete: (request: { model: string; system?: string; prompt: string; maxTokens?: number; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; timeoutMs?: number }) => Promise<CompleteResult>
}

/** A model run in flight, keyed in `pending` by the subagent's agentId (or a generated id for a single model call). */
export type PendingRun = {
  job: Job
  startedAt: number
  /** Epoch ms of the main-loop reply that triggered it. */
  triggeredAt?: number
  cardId?: string
  /** `researching` while the agent runs; `verifying` while code checks its citations and sources. */
  stage?: 'researching' | 'verifying'
  /** For a question run: what code picked, so the card can carry it. */
  category?: string
  focus?: Focus | null
  officialHosts?: string[]
}

export type ModelFamily = 'haiku' | 'sonnet' | 'opus'

/**
 * The user's settings: the plugin.json `userConfig` fields as
 * logic.readSettings turns the raw `options` into checked values (unknown or
 * out-of-range values fall back to the default or are clamped). A /config
 * change reloads the module, so register.tsx reads these once per load.
 */
export type Settings = {
  /** 0 to 20; 0 means facts only. */
  questionsPerHour: number
  /** 0 to 60; 0 turns the rapid-reply rule off. */
  rapidReplyMinutes: number
  mode: 'questions and facts' | 'questions only' | 'facts only'
  /** 0 to 20; 0 means no refresher questions. */
  refresherEvery: number
  /** 1 to 3650. */
  refresherMinAgeDays: number
  difficulty: 'collegiate' | 'senior' | 'staff'
  /** Full category names from logic.CATEGORIES, in their order; never empty. */
  categories: string[]
  flawReview: boolean
  /** Adds the ASD-STE100 style block to every prompt that writes text for a person. */
  steWriting: boolean
  sourcePolicy: 'official preferred' | 'official only'
  /** Glob patterns (`*`, `**`, `?`) for paths never used as a focus. */
  excludePaths: string[]
  /** Aliases: each resolves to the newest model of its family that the user's Claude Code knows. */
  questionModel: ModelFamily
  questionEffort: 'low' | 'medium' | 'high'
  factModel: ModelFamily
  gradeModel: ModelFamily
  /** 0 to 1000; 0 means no cap. */
  dailyBudgetUsd: number
  openPaneOnStart: boolean
  toastOnNewQuestion: boolean
  statusLine: boolean
  /** `counts only` keeps no typed text or card content; `off` writes nothing. */
  telemetry: 'counts only' | 'full' | 'off'
}

/** The pane's own disclosure toggles. `factOpen` expands a fact that is folded to one line beside an open question. */
export type PaneToggles = { sourcesOpen: boolean; detailsOpen: boolean; confirmOff: boolean; factOpen: boolean }

/** Whether the mod is paused or off for this repository, mirrored from $.store for the pane. */
export type QuizMode = { pausedUntil: number | null; isOff: boolean }

declare module 'claude-code' {
  interface PluginState {
    'repo-quiz': {
      question: QuestionCard | null
      fact: FactCard | null
      view: 'quiz' | 'stats'
      pending: Record<string, PendingRun>
      /** The last 20 agent ids this mod spawned. */
      ours: string[]
      error: string | null
      stats: StatsSummary | null
      /** Today's and this session's estimated spend, for the footer and status line. */
      cost: { todayUsd: number; sessionUsd: number }
      ui: PaneToggles
      mode: QuizMode
    }
  }
}

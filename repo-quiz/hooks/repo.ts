// I/O for repo-quiz: git through io.run, files through io.readText and friends,
// pages through io.fetch, and the telemetry writer. Every function here takes
// the engine closures `io` (built from `$` in register.tsx) and never throws
// for an ordinary failure (a git error, a dead link, a missing file): it
// returns an empty or null result. Pure helpers live in logic.ts.

import type {
  CitationCounts,
  CodeCitation,
  FactCard,
  Flaw,
  Focus,
  FocusKind,
  ContextPacket,
  Io,
  Source,
  SourceCounts,
  SupportVerdict,
  TelemetryRecord,
} from '../types'

import {
  appleDocJsonUrl,
  appleJsonToText,
  dayKey,
  ecosystemsFromPaths,
  excerptWindow,
  findDefinitionLines,
  findQuote,
  htmlToText,
  isOfficialUrl,
  isSkippablePath,
  matchQuote,
  officialHostsFor,
  parseJsonLines,
  parseLastChanged,
  parseSizes,
  passageAround,
  pickRecentPath,
  pickRefresherPath,
} from './logic'

const SLOW_GIT_MS = 60_000
const FETCH_MS = 15_000
const TEXT_CAP = 3_000
const RECENT_RADIUS = 40
const REFRESHER_RADIUS = 30
const DAY_MS = 86_400_000
// ponytail: the store is one 4 MiB JSON file shared by every repository, so the
// last-change cache keeps only the 1,000 oldest tracked paths (about 75 KB);
// move it to a file under ~/.claude/repo-quiz/ if refreshers need the whole tree.
const MAX_CACHED_PATHS = 1_000
// ponytail: counts characters, not bytes; part files roll at ~3.5 MB so each
// stays under the 4 MiB read limit for ordinary (mostly ASCII) records.
const TELEMETRY_ROLL_CHARS = 3_500_000

/** Runs git with `args` in `cwd` (repo hooks are off under io.run); stdout, or '' on any failure. */
export async function git(io: Io, cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  try {
    // No index lock (the user's own git may be running), raw UTF-8 paths, no colour codes.
    const r = await io.run(
      ['git', '--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      { cwd, timeoutMs: opts.timeoutMs ?? 30_000 },
    )
    if (r.exitCode !== 0) return ''
    // Every command here ends its output with a newline or NUL; output cut at
    // the 4 MiB cap does not, so drop the half line rather than parse half a path.
    const out = r.stdout
    const end = Math.max(out.lastIndexOf('\n'), out.lastIndexOf('\0'))
    return end === out.length - 1 ? out : out.slice(0, end + 1)
  } catch {
    return ''
  }
}

/** `git rev-parse --show-toplevel`, falling back to `io.cwd()`. */
export async function repoRoot(io: Io): Promise<string> {
  const cwd = await io.cwd()
  return (await git(io, cwd, ['rev-parse', '--show-toplevel'])).trim() || cwd
}

/**
 * `path` (absolute, or relative to `root`) as a clean root-relative path, or
 * null when it is outside the root, has a `..` segment, or names the root itself.
 * Model output is untrusted, so every cited path goes through this.
 */
export function relativeToRoot(root: string, path: string): string | null {
  let p = path.trim()
  if (p.includes('\0')) return null
  if (p.startsWith('/')) {
    const base = `${root.replace(/\/+$/, '')}/`
    if (!p.startsWith(base)) return null
    p = p.slice(base.length)
  }
  const parts = p.split('/').filter((s) => s !== '' && s !== '.')
  return parts.length === 0 || parts.includes('..') ? null : parts.join('/')
}

/**
 * Reads `path` under `root`: null when its spelling escapes the root, or it is
 * missing, over 4 MiB, or binary.
 * ponytail: a symbolic link inside the root that leads out of it is still
 * followed, since Io has no stat with realPath; check realPath under the
 * root's own realPath once Io offers it.
 */
async function readUnder(io: Io, root: string, path: string): Promise<{ path: string; text: string } | null> {
  const rel = relativeToRoot(root, path)
  if (rel === null) return null
  const text = await io.readText(`${root.replace(/\/+$/, '')}/${rel}`).catch(() => null)
  return text === null || text.includes('\0') ? null : { path: rel, text }
}

const lines = (text: string) => text.split('\n').filter((l) => l !== '')
const unique = (items: string[]) => [...new Set(items)]
const cap = (text: string) => {
  const t = text.trim()
  return t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP)}\n… (truncated)` : t
}
const relativeAll = (root: string, paths: string[]) =>
  unique(paths.map((p) => relativeToRoot(root, p)).filter((p): p is string => p !== null))
const topOfFile = (text: string, radius: number) => excerptWindow(text, radius + 1, radius)

/** Paths from `git status --porcelain -z`, without deletions. A rename is `XY new\0old\0`, so its old path is skipped. */
function parseStatus(out: string): string[] {
  const fields = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    if (field[0] === 'R' || field[0] === 'C') i++
    if (!field.slice(0, 2).includes('D')) paths.push(field.slice(3))
  }
  return paths
}

/** The new-side start line and length of the first `@@ -a,b +c,d @@` hunk header, or null. */
function firstHunk(diff: string): { start: number; count: number } | null {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/m.exec(diff)
  return m ? { start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) } : null
}

/** Extension counts (no dot, lower case), most common first, top 8; skippable paths and names with no extension left out. */
function languageMix(paths: string[]): { ext: string; files: number }[] {
  const counts = new Map<string, number>()
  for (const p of paths) {
    if (isSkippablePath(p)) continue
    const name = p.slice(p.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = name.slice(dot + 1).toLowerCase()
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  return [...counts]
    .map(([ext, files]) => ({ ext, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 8)
}

/**
 * Picks the focus for a question or a fact batch, or null when the repository
 * offers nothing usable.
 *
 * recent: candidates from `touched`, `git status --porcelain`, and the files of
 * the last 20 commits (logic.pickRecentPath). The excerpt is the most recent
 * change: the first hunk of `git diff -U0 HEAD -- <path>`, else of
 * `git log -p -1 -- <path>`, widened with logic.excerptWindow to ~40 lines
 * either side; else the top of the file.
 *
 * refresher: last-change times from `git log --format=%x00%ct --name-only -n 5000`
 * (logic.parseLastChanged), cached in the store under `<root>:lastChanged` as
 * { head, map } and recomputed only when `git rev-parse HEAD` differs; sizes
 * from `git ls-tree -r -l HEAD` (logic.parseSizes); then logic.pickRefresherPath
 * with Math.random. The excerpt is a ~60-line window around a random
 * logic.findDefinitionLines line, else the top of the file.
 *
 * Both kinds skip paths matching the `exclude` globs (logic.isExcludedPath),
 * and a refresher must be older than `minAgeMs` where the repository allows.
 *
 * Excerpts are logic.numberedLines text, at most ~120 lines. `touched` may be
 * absolute; the returned path is root-relative.
 */
export async function pickFocus(
  io: Io,
  opts: {
    root: string
    kind: FocusKind
    touched: string[]
    recentFoci: string[]
    lastQuizzed: Record<string, number>
    now: number
    exclude: string[]
    minAgeMs: number
  },
): Promise<Focus | null> {
  const touched = relativeAll(opts.root, opts.touched)
  return opts.kind === 'recent'
    ? recentFocus(io, opts.root, touched, opts.recentFoci, opts.exclude)
    : refresherFocus(io, { ...opts, touched })
}

async function recentFocus(io: Io, root: string, touched: string[], recentFoci: string[], exclude: string[]): Promise<Focus | null> {
  const [status, log] = await Promise.all([
    git(io, root, ['status', '--porcelain', '-z', '-uall']),
    git(io, root, ['log', '-n', '20', '--format=', '--name-only']),
  ])
  const uncommitted = parseStatus(status)
  const recentlyCommitted = unique(lines(log))
  const avoid = [...recentFoci]
  // A candidate may be unreadable (deleted, binary, outside the root): skip it and pick again.
  for (let tries = 0; tries < 5; tries++) {
    const path = pickRecentPath({ touched, uncommitted, recentlyCommitted, recentFoci: avoid, exclude })
    if (path === null) return null
    const file = await readUnder(io, root, path)
    if (file === null) {
      avoid.push(path)
      continue
    }
    const hunk =
      firstHunk(await git(io, root, ['diff', '-U0', 'HEAD', '--', file.path])) ??
      firstHunk(await git(io, root, ['log', '-p', '-1', '-U0', '--format=', '--', file.path]))
    // A long hunk (a new file) shows its first lines rather than its middle.
    const window = hunk
      ? excerptWindow(file.text, hunk.start + Math.floor(Math.min(hunk.count, 2 * RECENT_RADIUS) / 2), RECENT_RADIUS)
      : topOfFile(file.text, RECENT_RADIUS)
    return { kind: 'recent', path: file.path, ...window }
  }
  return null
}

async function refresherFocus(
  io: Io,
  opts: { root: string; touched: string[]; lastQuizzed: Record<string, number>; now: number; exclude: string[]; minAgeMs: number },
): Promise<Focus | null> {
  const { root } = opts
  const [head, tree] = await Promise.all([
    git(io, root, ['rev-parse', 'HEAD']),
    git(io, root, ['ls-tree', '-r', '-l', 'HEAD'], { timeoutMs: SLOW_GIT_MS }),
  ])
  if (!head.trim()) return null
  const sizes = parseSizes(tree)
  const lastChanged = await lastChangedMap(io, root, head.trim(), sizes)
  for (let tries = 0; tries < 3; tries++) {
    const pick = pickRefresherPath({
      lastChanged,
      sizes,
      touched: opts.touched,
      lastQuizzed: opts.lastQuizzed,
      now: opts.now,
      minAgeMs: opts.minAgeMs,
      exclude: opts.exclude,
      random: Math.random,
    })
    if (pick === null) return null
    const file = await readUnder(io, root, pick.path)
    if (file === null) {
      delete lastChanged[pick.path]
      continue
    }
    const defs = findDefinitionLines(file.text)
    const center = defs[Math.floor(Math.random() * defs.length)]
    const window = center === undefined ? topOfFile(file.text, REFRESHER_RADIUS) : excerptWindow(file.text, center, REFRESHER_RADIUS)
    return { kind: 'refresher', path: file.path, ...window, lastChangedAt: pick.lastChangedAt }
  }
  return null
}

/**
 * Each tracked file's last-change time, cached per HEAD under `<root>:lastChanged`.
 * ponytail: only the last 5,000 commits are read, so in a longer history the
 * files untouched since then are never refresher candidates; add them with the
 * oldest time seen (labelled "at least") if that matters.
 */
async function lastChangedMap(io: Io, root: string, head: string, sizes: Record<string, number>): Promise<Record<string, number>> {
  const key = `${root}:lastChanged`
  const cached = (await io.storeGet(key).catch(() => undefined)) as { head?: string; map?: Record<string, number> } | undefined
  if (cached?.head === head && cached.map) return { ...cached.map }
  const log = await git(io, root, ['log', '--format=%x00%ct', '--name-only', '-n', '5000'], { timeoutMs: SLOW_GIT_MS })
  // Deleted paths are dropped (a rename lists only its new path); the oldest are kept, since refreshers want old code.
  const entries = Object.entries(parseLastChanged(log))
    .filter(([p]) => Object.hasOwn(sizes, p) && !isSkippablePath(p))
    .sort((a, b) => a[1] - b[1])
    .slice(0, MAX_CACHED_PATHS)
  const map = Object.fromEntries(entries)
  // An empty result is a failed or timed-out log; caching it would block refreshers until the next commit.
  if (entries.length > 0) await io.storeSet(key, { head, map }).catch(() => {})
  return map
}

/**
 * Gathers the context packet: branch, language mix (by extension, top 8, from
 * `git ls-files`), `git log --oneline -15`, `git status --short` plus
 * `git diff --stat HEAD` (each capped at ~3,000 characters), and the official
 * hosts from logic.ecosystemsFromPaths / officialHostsFor. Touched files are
 * made root-relative, and those outside the root are left out. The difficulty,
 * source policy and flaw review come from the settings, for the task text.
 */
export async function buildContextPacket(
  io: Io,
  opts: {
    root: string
    touched: string[]
    lastPrompt: string
    avoidTopics: string[]
    category?: string
    focus: Focus | null
    extraFocus: Focus[]
    difficulty: ContextPacket['difficulty']
    sourcePolicy: ContextPacket['sourcePolicy']
    flawReview: boolean
  },
): Promise<ContextPacket> {
  const { root } = opts
  const [branch, files, commits, status, stat] = await Promise.all([
    git(io, root, ['branch', '--show-current']),
    git(io, root, ['ls-files'], { timeoutMs: SLOW_GIT_MS }),
    git(io, root, ['log', '--oneline', '-15']),
    git(io, root, ['status', '--short']),
    git(io, root, ['diff', '--stat', 'HEAD']),
  ])
  const paths = lines(files)
  return {
    repoRoot: root,
    branch: branch.trim() || '(detached HEAD)',
    languages: languageMix(paths),
    recentCommits: cap(commits),
    uncommitted: [cap(status), cap(stat)].filter((t) => t !== '').join('\n\n'),
    touchedFiles: relativeAll(root, opts.touched),
    officialHosts: officialHostsFor(ecosystemsFromPaths(paths)),
    focus: opts.focus,
    extraFocus: opts.extraFocus,
    lastPrompt: opts.lastPrompt.trim().slice(0, 600),
    avoidTopics: opts.avoidTopics,
    ...(opts.category === undefined ? {} : { category: opts.category }),
    difficulty: opts.difficulty,
    sourcePolicy: opts.sourcePolicy,
    flawReview: opts.flawReview,
  }
}

/**
 * Checks each citation against the file under `root` with logic.matchQuote:
 * exact keeps it, moved keeps it with the corrected line, missing file or
 * missing quote drops it. Paths may be absolute or relative to `root`; kept
 * citations carry the root-relative path. The counts are disjoint:
 * total = verified + corrected + dropped.
 */
export async function verifyCitations(
  io: Io,
  root: string,
  citations: CodeCitation[],
): Promise<{ kept: CodeCitation[]; counts: CitationCounts }> {
  const counts: CitationCounts = { total: citations.length, verified: 0, corrected: 0, dropped: 0 }
  const reads = new Map<string, ReturnType<typeof readUnder>>()
  const read = (path: string) => {
    const pending = reads.get(path) ?? readUnder(io, root, path)
    reads.set(path, pending)
    return pending
  }
  const checked = await Promise.all(
    citations.map(async (c): Promise<CodeCitation | null> => {
      const file = await read(c.path)
      const match = file && matchQuote(file.text, c.line, c.quote)
      if (!file || !match) {
        counts.dropped++
        return null
      }
      counts[match.status === 'exact' ? 'verified' : 'corrected']++
      return { path: file.path, line: match.line, quote: c.quote }
    }),
  )
  return { kept: checked.filter((c): c is CodeCitation => c !== null), counts }
}

/**
 * True for an http(s) URL whose host is not this machine or a private network.
 * Source URLs come from model output, which a fetched page could have steered.
 * ponytail: checks the spelling only, so a public name that resolves to a
 * private address still passes; resolve and check the address if that matters.
 */
function isPublicHttpUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false
  if (/^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  return !host.includes(':') || !/^(::1?$|::ffff:|f[cd]|fe80:)/.test(host)
}

type FetchResult = Awaited<ReturnType<Io['fetch']>>

/**
 * io.fetch has no timeout or signal, so race it against a sleep; null on
 * timeout or failure. The losing sleep runs out on its own (io.sleep takes no
 * signal), which costs one idle timer per fetch.
 */
async function fetchWithTimeout(io: Io, url: string): Promise<FetchResult | null> {
  try {
    return await Promise.race([io.fetch(url), io.sleep(FETCH_MS).then(() => null)])
  } catch {
    return null
  }
}

/**
 * The readable text of a documentation page, or null when it is dead. Follows
 * up to 3 redirects itself (in case the host does not). developer.apple.com
 * pages render with JavaScript, so those read Apple's JSON endpoint instead.
 */
async function pageText(io: Io, url: string): Promise<string | null> {
  const appleJson = appleDocJsonUrl(url)
  try {
    let current = new URL(appleJson ?? url)
    for (let hop = 0; hop <= 3; hop++) {
      if (!isPublicHttpUrl(current)) return null
      const res = await fetchWithTimeout(io, current.href)
      if (res === null) return null
      const location = res.headers.location
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current)
        continue
      }
      if (!res.ok) return null
      return appleJson === null ? htmlToText(res.text) : appleJsonToText(JSON.parse(res.text))
    }
    return null
  } catch {
    return null
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Checks each source: fetch the URL with io.fetch (follow up to 3
 * redirects via the Location header; for developer.apple.com use
 * logic.appleDocJsonUrl and logic.appleJsonToText, else logic.htmlToText).
 * A failed fetch or non-2xx drops it as dead. If logic.findQuote finds the
 * quote, `checkSupport(claim, passage)` decides: `no` drops it as unsupported,
 * `yes`/`partial` keeps it marked `verified`, null (the check failed) keeps it
 * `unconfirmed`. A working page without the quote is kept `unconfirmed`.
 * Every kept source gets `isOfficial` from logic.isOfficialUrl. Sources are
 * checked concurrently, at most 4 at a time, each fetch with a 15 s timeout.
 * A URL to localhost or a private network address counts as dead.
 */
export async function verifySources(
  io: Io,
  sources: Source[],
  officialHosts: string[],
  checkSupport: (claim: string, passage: string) => Promise<SupportVerdict | null>,
): Promise<{ kept: Source[]; counts: SourceCounts }> {
  const counts: SourceCounts = { total: sources.length, verified: 0, unconfirmed: 0, dead: 0, unsupported: 0 }
  const checked = await mapLimit(sources, 4, async (s): Promise<Source | null> => {
    const page = await pageText(io, s.url)
    if (page === null) {
      counts.dead++
      return null
    }
    const at = findQuote(page, s.quote)
    let verdict: SupportVerdict | null = null
    if (at >= 0) {
      try {
        verdict = await checkSupport(s.claim, passageAround(page, at, 1_500))
      } catch {
        verdict = null
      }
    }
    if (verdict === 'no') {
      counts.unsupported++
      return null
    }
    const mark = verdict === null ? 'unconfirmed' : 'verified'
    counts[mark]++
    return { ...s, mark, isOfficial: isOfficialUrl(s.url, officialHosts) }
  })
  return { kept: checked.filter((s): s is Source => s !== null), counts }
}

/** The flaw's evidence lines with 20 lines either side, as numbered excerpts, for the confirmation call. */
export async function flawExcerpts(io: Io, root: string, flaw: Flaw): Promise<string> {
  const parts = await Promise.all(
    flaw.evidence.map(async (c) => {
      const file = await readUnder(io, root, c.path)
      if (file === null) return ''
      const w = excerptWindow(file.text, c.line, 20)
      return `${file.path}, lines ${w.startLine}-${w.endLine}:\n${w.excerpt}`
    }),
  )
  return parts.filter((p) => p !== '').join('\n\n')
}

/**
 * A fact is stale when any of its code citations' quotes can no longer be
 * found anywhere in its file (or the file is gone). A moved quote is not
 * stale. A fact with no code citations is never stale.
 */
export async function staleCitation(
  io: Io,
  root: string,
  fact: Pick<FactCard, 'citations'>,
): Promise<CodeCitation | null> {
  for (const c of fact.citations) {
    const file = await readUnder(io, root, c.path)
    if (file === null || matchQuote(file.text, c.line, c.quote) === null) return c
  }
  return null
}

/**
 * The telemetry writer. Records go to
 * `$HOME/.claude/repo-quiz/telemetry/<YYYY-MM-DD>-<sessionId>.jsonl`. The file
 * API has no append, so each write reads that small file, appends one line and
 * writes it back; writes are chained on one promise so they never interleave.
 * `log` fills type-independent fields (ts, session, repo, version) and never
 * throws or rejects. `redact` sees the whole record, those fields included,
 * and a null from it writes nothing. A file past ~3.5 MB continues in `-2`,
 * `-3`, ... part files.
 */
export function createTelemetry(
  io: Io,
  base: {
    sessionId: string
    version: string
    repo: string
    home: string
    redact?: (record: Record<string, unknown>) => Record<string, unknown> | null
  },
): { log: (record: { type: string; cardId?: string; [field: string]: unknown }) => void; dir: string } {
  const dir = `${base.home}/.claude/repo-quiz/telemetry`
  const session = base.sessionId.replace(/[^\w.-]/g, '_')
  let part = { day: '', n: 1 }
  let queue: Promise<void> = Promise.resolve()

  const write = async (record: Record<string, unknown>, ts: number) => {
    const full = { ...record, ts, session: base.sessionId, repo: base.repo, version: base.version }
    const kept = base.redact ? base.redact(full) : full
    if (kept === null) return
    const line = `${JSON.stringify(kept)}\n`
    const day = dayKey(ts)
    if (part.day !== day) part = { day, n: 1 }
    for (const last = part.n + 50; part.n < last; part.n++) {
      const path = `${dir}/${day}-${session}${part.n > 1 ? `-${part.n}` : ''}.jsonl`
      // A missing file starts empty; one that exists but cannot be read (over 4 MiB) is skipped, never overwritten.
      const old = (await io.exists(path)) ? await io.readText(path).catch(() => null) : ''
      if (old === null || old.length >= TELEMETRY_ROLL_CHARS) continue
      await io.writeText(path, old + line)
      return
    }
  }

  const log = (record: { type: string; cardId?: string; [field: string]: unknown }) => {
    // The time is taken now, not when the queue reaches this record.
    const at = Promise.resolve()
      .then(() => io.now())
      .catch(() => Date.now())
    queue = queue.then(async () => write(record, await at)).catch(() => {})
  }
  return { log, dir }
}

/** Every record from the telemetry files of the last `days` days (by file name date), parsed with logic.parseJsonLines. */
export async function readTelemetry(io: Io, home: string, days: number, now: number): Promise<TelemetryRecord[]> {
  const dir = `${home}/.claude/repo-quiz/telemetry`
  const since = dayKey(now - days * DAY_MS)
  const entries = await io.list(dir).catch(() => [])
  const names = entries
    .filter((e) => e.kind === 'file' && /^\d{4}-\d{2}-\d{2}-.+\.jsonl$/.test(e.name) && e.name.slice(0, 10) >= since)
    .map((e) => e.name)
    .sort()
  const texts = await mapLimit(names, 8, (name) => io.readText(`${dir}/${name}`).catch(() => ''))
  return texts.flatMap((text) => parseJsonLines(text))
}

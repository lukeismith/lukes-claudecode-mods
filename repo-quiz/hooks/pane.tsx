// Drawing the repo-quiz pane. register.tsx hooks `ui.render` on
// { component: 'Pane', requestId: PANE }, reads the state itself (the
// validator never follows `$` across an import), and returns
// renderPane(e, $.ui.resolve(e), data, ctx). Every press goes through
// `ctx.actions`, which register.tsx implements, so this file draws and never
// starts work itself.

import type { BoxProps, Color, ElementTable, RenderChildren, RenderElement, RenderInput } from 'claude-code'

import type {
  Counts3,
  FactCard,
  Feedback,
  Flaw,
  Job,
  PendingRun,
  QuestionCard,
  RatingCounts,
  Source,
  StatsSummary,
  PaneToggles,
  QuizMode,
  Tally,
  TallyBucket,
} from '../types'
import { baseName, dayKey, estimateQuestionUsd, formatUsd, isOverBudget, monthKey } from './logic'
import { estimateGradeUsd } from './models'

export type PaneActions = {
  /** Enter in the answer field: append one line to the draft. */
  addLine: (line: string) => Promise<void>
  clearDraft: () => Promise<void>
  reveal: () => Promise<void>
  skip: () => Promise<void>
  grade: () => Promise<void>
  /** A feedback button on the question or fact card. */
  feedback: (card: 'question' | 'fact', field: keyof Feedback, value: string) => Promise<void>
  showStats: () => Promise<void>
  showQuiz: () => Promise<void>
  pause: (minutes: number) => Promise<void>
  turnOff: () => Promise<void>
  dismissError: () => Promise<void>
  /** Every change of the answer field's text (Input onInput), so a redraw never loses a half-typed line. */
  setPartial: (text: string) => Promise<void>
  /** Undoes a feedback choice, so a mistaken key press can be changed. */
  clearFeedback: (card: 'question' | 'fact', field: keyof Feedback) => Promise<void>
  /** Flips one of the pane's disclosure toggles. */
  toggle: (key: keyof PaneToggles) => Promise<void>
  resume: () => Promise<void>
  turnOn: () => Promise<void>
  /** Clears the card once the user is done with it (after reveal or grading, or a fact they have read). */
  dismiss: (card: 'question' | 'fact') => Promise<void>
  /** Starts a question now, outside the automatic rhythm (the daily budget still applies). */
  newQuestion: () => Promise<void>
}

/**
 * Element keys register.tsx addresses: after reveal it moves focus to
 * SELF_GOT_IT with $.ui.focus, and its timer repaints PROGRESS_KEY with
 * $.ui.blit. The pane must draw elements under exactly these keys.
 */
export const SELF_GOT_IT = 'self-got-it'
export const PROGRESS_KEY = 'progress'

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** Which run the one progress line names first: the grade the user asked for, then the card they are waiting on. */
const JOB_RANK: Record<Job, number> = { grade: 0, question: 1, facts: 2, flaw: 3, support: 4 }

const JOB_LABEL: Record<Job, string> = {
  question: 'Preparing a question',
  facts: 'Gathering facts',
  grade: 'Grading',
  flaw: 'Looking for flaws',
  support: 'Checking sources',
}

/**
 * The progress line for the runs in `pending`, such as "⠹ Preparing a
 * question · 12 s (usually about 40 s)" or "⠼ Checking sources · 51 s", with
 * the spinner frame chosen from `now`; '' when nothing runs. Pure, so
 * register.tsx's timer and the pane draw the same text. CONTRACT STUB.
 */
export function progressLine(pending: Record<string, PendingRun>, now: number, medianMs: number | null): string {
  const runs = Object.values(pending).sort(
    (a, b) => (JOB_RANK[a.job] ?? 9) - (JOB_RANK[b.job] ?? 9) || a.startedAt - b.startedAt,
  )
  const run = runs[0]
  if (!run) return ''
  // One frame per second: register.tsx repaints once a second, so a finer
  // frame would land on the same glyph every tick and look frozen.
  const frame = SPINNER.charAt(Math.floor(now / 1000) % SPINNER.length)
  const label = run.stage === 'verifying' ? 'Checking sources' : (JOB_LABEL[run.job] ?? 'Working')
  const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000))
  const usual = run.job === 'question' && medianMs !== null && medianMs > 0 ? ` (usually about ${Math.round(medianMs / 1000)} s)` : ''
  const more = runs.length > 1 ? ` · +${runs.length - 1} more` : ''

  return `${frame} ${label} · ${seconds} s${usual}${more}`
}

/** `text` packed as one row of `columns` Raster cells (the RasterProps `cells` encoding), padded or cut to fit, in the terminal's default colors. CONTRACT STUB. */
export function progressCells(text: string, columns: number): string {
  const width = rasterColumns(columns)
  const view = new DataView(new ArrayBuffer(width * 12))
  const glyphs = [...text]
  for (let i = 0; i < width; i++) {
    const glyph = glyphs[i]
    view.setUint32(i * 12, glyph === undefined ? 0x20 : cellCode(glyph.codePointAt(0) ?? 0x20), true)
    view.setUint32(i * 12 + 4, TERMINAL_DEFAULT, true)
    view.setUint32(i * 12 + 8, TERMINAL_DEFAULT, true)
  }

  return base64(new Uint8Array(view.buffer))
}

export type PaneContext = {
  actions: PaneActions
  dailyBudgetUsd: number
  /** The grade model setting, which prices the Grade button's estimate. */
  gradeModel: string
  /** The question model setting, which prices the New question button's estimate. */
  questionModel: string
}

/**
 * The columns inside the root Box's one-column padding on each side: what
 * every width in the pane is sized to, the progress Raster included. Pure, so
 * register.tsx's repaint packs the same number of cells the pane drew.
 */
export function contentColumns(bodyColumns: number): number {
  return Math.max(1, Math.floor(bodyColumns) - 2)
}

/**
 * `ask` as Markdown with each line's text in bold: a numbered or bulleted
 * item keeps its marker outside the bold, `**` already in the text is dropped
 * so it cannot close the bold early, and code spans and fenced blocks stay as
 * written. Pure.
 */
export function boldAsk(ask: string): string {
  let fence: string | null = null

  return ask
    .split('\n')
    .map(line => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (fence !== null) {
        if (marker && marker.charAt(0) === fence.charAt(0) && marker.length >= fence.length) fence = null
        return line
      }
      if (marker) {
        fence = marker
        return line
      }
      const [, lead = '', text = ''] = /^(\s*(?:\d+[.)]\s+|[-*+]\s+)?)(.*)$/.exec(line) ?? []
      const body = withoutBold(text).trim()
      if (body === '') return line
      // An odd run of trailing backslashes would escape the closing `*`.
      const trailing = /\\+$/.exec(body)?.[0].length ?? 0

      return `${lead}**${body}${trailing % 2 === 1 ? '\\' : ''}**`
    })
    .join('\n')
}

/**
 * The sources toggle's wording: "2 verified", "1 link, quote unverified", or
 * "2 verified, 1 unverified"; with `isCompact`, "2 unverified" for links alone.
 * '' when there are none. Pure.
 */
export function sourcesSummary(sources: Source[], isCompact = false): string {
  const verified = sources.filter(s => s.mark === 'verified').length
  const other = sources.length - verified
  if (verified > 0 && other > 0) return `${verified} verified, ${other} unverified`
  if (verified > 0) return `${verified} verified`
  if (other === 0) return ''
  if (isCompact) return `${other} unverified`

  return other === 1 ? '1 link, quote unverified' : `${other} links, quotes unverified`
}

/** Button labels, and the "You said ..." note's wording, by Feedback value. */
const LABELS: Record<string, string> = {
  'got-it': 'Got it',
  partly: 'Partly',
  missed: 'Missed',
  useful: 'Useful',
  'not-useful': 'Not useful',
  'already-knew': 'Knew it',
  wrong: 'Wrong',
  real: 'Real issue',
  'false-alarm': 'False alarm',
}

/** The note a chosen value collapses into, so the choice stays visible and changeable. */
const CHOSEN: Record<keyof Feedback, string> = { selfAssessment: 'You said', rating: 'Rated', flaw: 'Flaw:' }

const VERDICT: Record<string, string> = { correct: 'correct', 'partially correct': 'partly correct', incorrect: 'incorrect' }

const SUBSCRIPTION_CAVEAT =
  'Figures are API-equivalent estimates. On a subscription plan they count against your usage limits rather than being billed.'

const KEY_HINT = 'ctrl+x tab for keys'

/** The width of the fact's `d: show` or `d: hide` toggle, as a plain Button draws it. */
const TOGGLE_WIDTH = 7

/** What the pane draws from: the values of register.tsx's atoms, plus what the stats view reads. */
export type PaneData = {
  view: 'quiz' | 'stats'
  question: QuestionCard | null
  fact: FactCard | null
  pending: Record<string, PendingRun>
  error: string | null
  stats: StatsSummary | null
  cost: { todayUsd: number; sessionUsd: number }
  /** `$.store.get('tally')`; only the stats view reads it. */
  tally?: Tally
  /** `$.clock.now()` at draw time: elapsed times, pause times, and the stats view's day and month keys. */
  now: number
  ui: PaneToggles
  mode: QuizMode
  /** The repository folder's name, for the header line; '' when the root is not known yet. */
  repoName: string
  /** The telemetry setting is off, so the stats view has nothing to summarize. */
  telemetryOff: boolean
}

/** The pane's tree for the surface `e` names, from values register.tsx has read, sized to `e.props.bodyColumns`. */
export function renderPane(e: RenderInput<'Pane'>, els: ElementTable, data: PaneData, ctx: PaneContext): RenderElement {
  const { Box, Text, Markdown, Button, Link } = els
  // Mobile draws no field yet, so it gets a note in its place.
  const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
  const Raster = e.surface === 'terminal' && 'Raster' in els ? els.Raster : null
  const { actions } = ctx
  const { view, question, fact, pending, error, stats, cost, tally, now, ui, mode } = data
  const cols = e.props.bodyColumns
  // The root's padding keeps text off the pane's edges, so every width inside is `w`.
  const w = contentColumns(cols)
  const isFocused = e.props.isFocused
  const isNarrow = cols < 48
  const gap = cols > 60 ? 2 : 1
  const isBudgetReached = isOverBudget(cost.todayUsd, ctx.dailyBudgetUsd)
  const isPaused = mode.pausedUntil !== null && mode.pausedUntil > now
  const hasCard = question !== null || fact !== null
  const isPreparing = Object.values(pending).some(run => run.job === 'question')
  const canAsk = !mode.isOff && !isBudgetReached && !isPreparing && (question === null || question.isRevealed)
  const askPrice = formatUsd(estimateQuestionUsd(ctx.questionModel, stats?.costPerQuestionUsd ?? null))
  const newQuestionButton = (key: string) => (
    <Button key={key} plain hotkey="q" onPress={() => actions.newQuestion()}>
      {isNarrow ? 'New' : 'New question'} <Text dimColor>{`≈ ${askPrice}`}</Text>
    </Button>
  )
  // One card at full size: beside a question that is still shown, the fact folds to a line until `d`.
  const isFactFolded = fact !== null && question !== null && !ui.factOpen

  const row = (children: RenderChildren, extra: BoxProps = {}) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={gap} {...extra}>
      {children}
    </Box>
  )
  const column = (children: RenderChildren, extra: BoxProps = {}) => (
    <Box flexDirection="column" {...extra}>
      {children}
    </Box>
  )
  // A left-bar block. Every one opens with its own heading, so it still reads
  // where a surface draws the quote border differently or not at all.
  const quote = (children: RenderChildren, frame: { color?: Color; dim?: boolean }) => (
    <Box
      flexDirection="column"
      borderStyle="quote"
      paddingLeft={1}
      {...(frame.color ? { borderColor: frame.color } : {})}
      {...(frame.dim ? { borderDimColor: true } : {})}
    >
      {children}
    </Box>
  )
  const divider = () => (
    <Text dimColor wrap="truncate-end">
      {'─'.repeat(w)}
    </Text>
  )
  // The meta is cut to the room left on the row as well as truncated by the
  // surface, so the kind's own word never shrinks to make room for it.
  const header = (kind: string, color: Color, meta: string[], trailing?: RenderElement) => {
    const room = w - textWidth(kind) - 1 - (trailing ? TOGGLE_WIDTH + 2 : 0)
    const text = meta.length > 0 && room >= 3 ? truncate(`· ${meta.join(' · ')}`, room) : ''

    return (
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" columnGap={1}>
          <Text bold color={color}>
            {kind}
          </Text>
          {text !== '' && (
            <Text dimColor wrap="truncate-end">
              {text}
            </Text>
          )}
        </Box>
        {trailing}
      </Box>
    )
  }
  // Sections stack with a dim rule between each pair and no blank line around it.
  const stack = (sections: RenderChildren[]) => sections.filter(Boolean).flatMap((section, i) => (i === 0 ? [section] : [divider(), section]))

  // ------------------------------------------------------------ progress

  const line = progressLine(pending, now, stats?.medianCardLatencyMs ?? null)
  const progress = !line ? null : Raster ? (
    <Raster key={PROGRESS_KEY} columns={rasterColumns(w)} rows={1} cells={progressCells(line, w)} />
  ) : (
    <Text dimColor>{line}</Text>
  )
  const isGrading = Object.values(pending).some(run => run.job === 'grade' && (!run.cardId || run.cardId === question?.id))
  // One progress line, in the place it is about: the grade slot while that
  // run is the one the user waits on, else the card area.
  const progressInGradeSlot =
    !!line && isGrading && !!question?.isRevealed && !question.grade && question.draft.join('').trim() !== ''

  // ------------------------------------------------------------ feedback

  type Choice = { value: string; hotkey: string; key?: string }

  const feedbackRow = (
    card: 'question' | 'fact',
    field: keyof Feedback,
    chosen: string | undefined,
    title: string,
    choices: Choice[],
    hasHotkeys: boolean,
  ) =>
    chosen ? (
      row(
        <Button
          key={`${card}-${field}-change`}
          plain
          dimColor
          label={`${CHOSEN[field]} ${LABELS[chosen] ?? chosen} · change`}
          onPress={() => actions.clearFeedback(card, field)}
        />,
      )
    ) : (
      row(
        [
          title !== '' && <Text dimColor>{title}</Text>,
          choices.map(choice => (
            <Button
              key={choice.key ?? `${card}-${field}-${choice.value}`}
              plain
              {...(hasHotkeys ? { hotkey: choice.hotkey } : {})}
              {...(choice.key === SELF_GOT_IT ? { autoFocus: true as const } : {})}
              label={LABELS[choice.value] ?? choice.value}
              onPress={() => actions.feedback(card, field, choice.value)}
            />
          )),
        ],
        hasHotkeys ? {} : { columnGap: gap + 1 },
      )
    )

  const ratingChoices = (isFact: boolean): Choice[] => [
    { value: 'useful', hotkey: 'u' },
    { value: 'not-useful', hotkey: 'n' },
    { value: 'wrong', hotkey: 'w' },
    ...(isFact ? [{ value: 'already-knew', hotkey: 'k' }] : []),
  ]

  const flawCallout = (card: 'question' | 'fact', flaw: Flaw | null, chosen: string | undefined, hasHotkeys: boolean) =>
    flaw &&
    quote(
      [
        <Text bold color="warning">{`⚠ Possible flaw (${flaw.severity})`}</Text>,
        <Text>{flaw.summary}</Text>,
        flaw.evidence.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {flaw.evidence.map(c => `${c.path}:${c.line}`).join(', ')}
          </Text>
        ),
        feedbackRow(
          card,
          'flaw',
          chosen,
          '',
          [
            { value: 'real', hotkey: 'i' },
            { value: 'false-alarm', hotkey: 'f' },
          ],
          hasHotkeys,
        ),
      ],
      { color: 'warning' },
    )

  // ------------------------------------------------------------ sources

  const sourcesButton = (sources: Source[], key: string, hasHotkey: boolean) => {
    if (sources.length === 0) return null
    // While open, the list below says what each source is, so the toggle only says how to close it.
    if (ui.sourcesOpen) {
      return <Button key={key} plain {...(hasHotkey ? { hotkey: 'v' } : {})} label="Hide sources" onPress={() => actions.toggle('sourcesOpen')} />
    }
    const prefix = textWidth(`${hasHotkey ? 'v: ' : ''}Sources · `)
    const full = sourcesSummary(sources)
    const summary = prefix + textWidth(full) <= w ? full : sourcesSummary(sources, true)

    return (
      <Button key={key} plain {...(hasHotkey ? { hotkey: 'v' } : {})} label="Sources" onPress={() => actions.toggle('sourcesOpen')}>
        {'Sources '}
        <Text dimColor>{`· ${summary}`}</Text>
      </Button>
    )
  }

  const sourcesList = (sources: Source[]) =>
    ui.sourcesOpen &&
    sources.length > 0 &&
    column(
      sources.map(source => {
        const isVerified = source.mark === 'verified'
        const note = `${isVerified ? 'quote checked' : 'link only'}${source.isOfficial === false ? ' (non-official)' : ''}`
        // The Link cannot truncate itself, so its label is cut to the room left on the row.
        const room = Math.max(8, w - note.length - 3)

        return row(
          [
            isVerified ? <Text color="success">✓</Text> : <Text dimColor>~</Text>,
            <Link href={source.url} label={truncate(source.title, room)} />,
            <Text dimColor>{note}</Text>,
          ],
          { columnGap: 1 },
        )
      }),
    )

  // ------------------------------------------------------------ question

  const answerField = (q: QuestionCard) => {
    const draftLines = q.draft.map(text => <Text>{text}</Text>)
    if (!Input) {
      return column([...draftLines, <Text dimColor>Answers can be typed on the terminal or desktop.</Text>])
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" borderDimColor={!isFocused} paddingX={1}>
        {draftLines}
        <Input
          key="answer"
          autoFocus
          value={q.partial ?? ''}
          placeholder="Type a line, Enter adds it · empty Enter reveals"
          submitLabel="add line"
          onInput={text => actions.setPartial(text)}
          // An empty Enter reveals, as Space does in Anki, so the keys never leave the field.
          onSubmit={text => (text.trim() === '' ? actions.reveal() : actions.addLine(text))}
        />
      </Box>
    )
  }

  const answering = (q: QuestionCard) =>
    column([
      answerField(q),
      row([
        <Button key="reveal" plain hotkey="r" variant="primary" label="Reveal" onPress={() => actions.reveal()} />,
        <Button key="skip" plain hotkey="s" label="Skip" onPress={() => actions.skip()} />,
        (q.draft.length > 0 || (q.partial ?? '') !== '') && (
          <Button key="clear" plain hotkey="c" label="Clear" onPress={() => actions.clearDraft()} />
        ),
      ]),
    ])

  const gradeStatus = (q: QuestionCard, draft: string) => {
    if (draft.trim() === '') return null
    if (q.grade) {
      return column([
        row(
          [
            <Text color="success">✓</Text>,
            <Text>{`Graded: ${VERDICT[q.grade.verdict] ?? q.grade.verdict}`}</Text>,
          ],
          { columnGap: 1 },
        ),
        <Markdown text={q.grade.feedback} />,
      ])
    }
    if (progressInGradeSlot) return progress
    if (isBudgetReached) return <Text dimColor>Grading is paused by the daily budget.</Text>

    return null
  }

  const gradeButton = (q: QuestionCard, draft: string) =>
    draft.trim() !== '' &&
    !q.grade &&
    !isGrading &&
    !isBudgetReached && (
      <Button key="grade" plain hotkey="g" label="Grade my answer" onPress={() => actions.grade()}>
        {isNarrow ? 'Grade ' : 'Grade my answer '}
        <Text dimColor>{`≈ ${formatUsd(estimateGradeUsd(q, draft, ctx.gradeModel))}`}</Text>
      </Button>
    )

  const revealed = (q: QuestionCard) => {
    const draft = q.draft.join('\n')

    return [
      quote(
        [
          <Text dimColor>Your answer</Text>,
          q.draft.length > 0 ? q.draft.map(text => <Text>{text}</Text>) : <Text dimColor>(no answer typed)</Text>,
        ],
        { dim: true },
      ),
      quote([<Text bold>Claude's answer</Text>, <Markdown text={q.answer} />], { color: 'claude' }),
      feedbackRow(
        'question',
        'selfAssessment',
        q.feedback.selfAssessment,
        isNarrow ? 'Recalled?' : 'How did you do?',
        [
          { value: 'missed', hotkey: '1', key: 'self-missed' },
          { value: 'partly', hotkey: '2', key: 'self-partly' },
          { value: 'got-it', hotkey: '3', key: SELF_GOT_IT },
        ],
        true,
      ),
      flawCallout('question', q.flaw, q.feedback.flaw, true),
      gradeStatus(q, draft),
      column([
        feedbackRow('question', 'rating', q.feedback.rating, isNarrow ? 'Rate' : 'Rate it', ratingChoices(false), true),
        row(
          [
            gradeButton(q, draft),
            sourcesButton(q.sources, 'sources', true),
            <Button key="done" plain hotkey="x" label="Done" onPress={() => actions.dismiss('question')} />,
          ],
          { justifyContent: 'space-between' },
        ),
        sourcesList(q.sources),
      ]),
    ]
  }

  // The setup in the normal weight, then what to answer in bold. A card saved
  // before the split has only the combined text, which draws as it always did.
  const questionText = (q: QuestionCard) => {
    const ask = typeof q.ask === 'string' ? q.ask.trim() : ''
    if (ask === '') return <Markdown text={q.question} />
    const context = (q.context ?? '').trim()

    return column([context !== '' && <Markdown text={context} />, <Markdown text={boldAsk(ask)} />], { gap: 1 })
  }

  const questionCard = (q: QuestionCard) => {
    const age = q.focusKind === 'refresher' ? (q.lastChangedAt === undefined ? 'refresher' : `refresher, ${ago(now - q.lastChangedAt)}`) : ''
    const meta = [q.category, baseName(q.focusPath ?? ''), age].filter(part => part !== '')

    return column(
      [
        column([
          header('Question', 'claude', meta),
          questionText(q),
          q.isUnverified && <Text color="warning">~ Unverified: no code citation could be checked, so compare it with the code.</Text>,
        ]),
        q.isRevealed ? revealed(q) : answering(q),
      ],
      { gap: 1 },
    )
  }

  // ------------------------------------------------------------ fact

  const factToggle = () => (
    <Button key="fact-toggle" plain dimColor hotkey="d" label={ui.factOpen ? 'hide' : 'show'} onPress={() => actions.toggle('factOpen')} />
  )

  // One dim line, cut to the room beside its toggle so it never wraps.
  const factTeaser = (f: FactCard) => (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Text dimColor wrap="truncate-end">
        {truncate(['Did you know?', f.topic].filter(Boolean).join(' '), w - TOGGLE_WIDTH - 2)}
      </Text>
      {factToggle()}
    </Box>
  )

  const factCard = (f: FactCard) => {
    // Beside a revealed question the fact's keys would clash with the
    // question's, so the fact is pressed by Tab or click alone; `d` is free in both.
    const hasHotkeys = !question?.isRevealed
    const meta = [f.topic, ...(f.focusKind === 'refresher' ? ['refresher'] : [])].filter(Boolean)

    return column(
      [
        column([header('Did you know?', 'suggestion', meta, question ? factToggle() : undefined), <Markdown text={f.text} />]),
        flawCallout('fact', f.flaw, f.feedback.flaw, hasHotkeys),
        column([
          feedbackRow('fact', 'rating', f.feedback.rating, isNarrow ? 'Rate' : 'Rate it', ratingChoices(true), hasHotkeys),
          row(
            [
              sourcesButton(f.sources, 'fact-sources', hasHotkeys),
              <Button
                key="dismiss-fact"
                plain
                {...(hasHotkeys ? { hotkey: 'x' } : {})}
                label="Dismiss"
                onPress={() => actions.dismiss('fact')}
              />,
            ],
            { justifyContent: 'space-between' },
          ),
          sourcesList(f.sources),
        ]),
      ],
      { gap: 1 },
    )
  }

  // ------------------------------------------------------------ empty states

  const recap = () => {
    const totals = stats && answeredTotals(stats)
    if (!totals || totals.answered === 0) return null

    return <Text dimColor>{`Last ${stats.days} days: ${totals.answered} answered, ${totals.gotIt} got it`}</Text>
  }

  // Which empty state shows, so the header's budget line never repeats it.
  const emptyKind = mode.isOff ? 'off' : isPaused ? 'paused' : progress ? 'progress' : isBudgetReached ? 'budget' : 'idle'

  const emptyState = () => {
    const state =
      emptyKind === 'off'
        ? column([
            <Text bold>Off for this repository</Text>,
            <Text dimColor>No questions or facts appear here until you turn it back on.</Text>,
            row(<Button key="turn-on" plain label="Turn on" onPress={() => actions.turnOn()} />),
          ])
        : emptyKind === 'paused' && mode.pausedUntil !== null
          ? column([
              <Text bold>{`Paused until ${untilTime(mode.pausedUntil, now)}`}</Text>,
              <Text dimColor>Cards start again after that, or now if you resume.</Text>,
              row(<Button key="resume" plain hotkey="p" label="Resume" onPress={() => actions.resume()} />),
            ])
          : emptyKind === 'budget'
            ? column([
                <Text bold>Daily budget reached</Text>,
                <Text dimColor>No model runs start until tomorrow; saved facts still appear. The budget is in the plugin's settings.</Text>,
              ])
            : emptyKind === 'idle'
              ? column([
                  <Text bold>Nothing to answer yet</Text>,
                  <Text dimColor>A question or fact appears here after Claude's next reply, or now if you ask for one.</Text>,
                  canAsk && row(newQuestionButton('new-question-empty')),
                ])
              : null

    return column([state, progress, recap()], { gap: 1 })
  }

  // ------------------------------------------------------------ header and footer

  // Past 80% of a budget the meter turns to the warning color; reaching it adds a line of its own below.
  const isHot = ctx.dailyBudgetUsd > 0 && cost.todayUsd / ctx.dailyBudgetUsd > 0.8
  const spent = cost.todayUsd > 0 ? formatUsd(cost.todayUsd) : '0¢'
  const meter = `≈ ${spent}${ctx.dailyBudgetUsd > 0 ? ` of ${formatUsd(ctx.dailyBudgetUsd)}` : ''} today`

  // `repo-quiz · <folder> · ≈ $0.16 today`. The folder's name gives way
  // first, then the mod's, so the cost always shows.
  const topLine = () => {
    const meterWidth = textWidth(meter)
    const nameRoom = w - meterWidth - textWidth('repo-quiz ·  · ')
    const name = data.repoName !== '' && nameRoom >= Math.min(4, textWidth(data.repoName)) ? truncate(data.repoName, nameRoom) : ''
    const lead = name !== '' ? `repo-quiz · ${name} ·` : textWidth('repo-quiz · ') + meterWidth <= w ? 'repo-quiz ·' : ''

    return (
      <Box flexDirection="row" columnGap={1}>
        {lead !== '' && <Text dimColor>{lead}</Text>}
        {isHot ? (
          <Text color="warning" wrap="truncate-end">
            {meter}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {meter}
          </Text>
        )}
      </Box>
    )
  }

  const topBlock = (isEmptyBudget: boolean) =>
    column([
      topLine(),
      isBudgetReached && !isEmptyBudget && <Text color="warning">Daily budget reached: no model runs start until tomorrow.</Text>,
    ])

  const footer = () => {
    // The empty state already offers Resume or Turn on, so the footer does not repeat them.
    const showPause = !mode.isOff && !(isPaused && !hasCard)
    const pauseLabel = isPaused ? 'Resume' : 'Pause'
    const keys = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={gap}>
        {showPause &&
          (isPaused ? (
            <Button key="resume" plain dimColor hotkey="p" label="Resume" onPress={() => actions.resume()} />
          ) : (
            <Button key="pause" plain dimColor hotkey="p" label="Pause" onPress={() => actions.pause(60)} />
          ))}
        <Button key="stats" plain dimColor hotkey="t" label="Stats" onPress={() => actions.showStats()} />
      </Box>
    )
    if (isFocused) return keys
    const keysWidth = (showPause ? textWidth(`p: ${pauseLabel}`) + gap : 0) + textWidth('t: Stats')
    const hint = <Text dimColor>{KEY_HINT}</Text>

    // The hint sits at the row's right end when both fit, else on a line of its own.
    return keysWidth + 2 + textWidth(KEY_HINT) <= w ? (
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        {keys}
        {hint}
      </Box>
    ) : (
      column([keys, hint])
    )
  }

  const errorBlock = error
    ? column([
        <Text color="error">{`✗ ${error}`}</Text>,
        row(<Button key="dismiss-error" plain label="Dismiss" onPress={() => actions.dismissError()} />),
      ])
    : null

  if (view === 'stats') {
    const showOff = !mode.isOff && !ui.confirmOff

    return (
      <Box flexDirection="column" width={cols} paddingX={1}>
        {stack([
          topBlock(false),
          column(
            [
              errorBlock,
              statsView(els, data, { cols: w, gap }),
              row([
                <Button
                  key="details"
                  plain
                  hotkey="d"
                  label={ui.detailsOpen ? 'Hide details' : 'Details'}
                  onPress={() => actions.toggle('detailsOpen')}
                />,
                <Button key="back" plain hotkey="b" label="Back" onPress={() => actions.showQuiz()} />,
                // Turning the mod off is rare and needs a confirmation, so it waits here rather than in every footer.
                showOff && <Button key="off" plain dimColor label="Off for this repo" onPress={() => actions.toggle('confirmOff')} />,
              ]),
              ui.confirmOff &&
                column([
                  <Text bold>Turn repo-quiz off for this repository?</Text>,
                  row(
                    [
                      <Button key="off-confirm" plain label="Turn off" onPress={() => actions.turnOff()} />,
                      <Button key="off-cancel" plain label="Cancel" onPress={() => actions.toggle('confirmOff')} />,
                    ],
                    { columnGap: gap + 1 },
                  ),
                ]),
              ui.detailsOpen && <Markdown text={detailsMarkdown(stats, tally, now, data.telemetryOff)} />,
              <Text dimColor>{SUBSCRIPTION_CAVEAT}</Text>,
            ],
            { gap: 1 },
          ),
        ])}
      </Box>
    )
  }

  const progressBelow = hasCard && !progressInGradeSlot ? progress : null

  return (
    <Box flexDirection="column" width={cols} paddingX={1}>
      {stack([
        topBlock(!hasCard && emptyKind === 'budget'),
        question && column([errorBlock, questionCard(question), canAsk && row(newQuestionButton('new-question')), !fact && progressBelow], { gap: 1 }),
        fact && column([!question && errorBlock, !question && canAsk && row(newQuestionButton('new-question')), isFactFolded ? factTeaser(fact) : factCard(fact), progressBelow], { gap: 1 }),
        !hasCard && column([errorBlock, emptyState()], { gap: 1 }),
        footer(),
      ])}
    </Box>
  )
}

// ---------------------------------------------------------------- stats view

type Layout = { cols: number; gap: number }

function statsView(els: ElementTable, data: PaneData, layout: Layout): RenderChildren {
  const { Box, Text } = els
  const { stats, tally, now } = data
  const totals = stats ? answeredTotals(stats) : { answered: 0, gotIt: 0 }
  const week = lastDays(now, 7).reduce((sum, key) => sum + (tally?.days[key]?.usd ?? 0), 0)
  const month = lastDays(now, 30).map(key => tally?.days[key]?.usd ?? 0)
  const monthUsd = month.reduce((a, b) => a + b, 0)
  const categories = Object.entries(stats?.selfAssessment.byCategory ?? {})
  const most = Math.max(1, ...categories.map(([, c]) => c.gotIt + c.partly + c.missed))
  const barWidth = Math.max(6, Math.min(30, layout.cols - 14))

  const headline = (value: string, label: string) => (
    <Box flexDirection="row" columnGap={1}>
      <Text bold>{value}</Text>
      <Text dimColor>{label}</Text>
    </Box>
  )
  // The cost lines come from the tally, not telemetry, so they stay when telemetry is off.
  const costBlock = (
    <Box flexDirection="column">
      <Text dimColor>Cost per day, last 30 days</Text>
      <Text color="claude">{sparkline(month)}</Text>
      <Text dimColor>{`≈ ${formatUsd(monthUsd)} in all · peak ≈ ${formatUsd(Math.max(0, ...month))} a day`}</Text>
    </Box>
  )

  if (data.telemetryOff) {
    return [
      <Text bold color="claude">
        Stats
      </Text>,
      <Box flexDirection="column">
        <Text bold>Telemetry is off, so there are no stats.</Text>
        <Text dimColor>Set Local telemetry to counts only or full in /config to collect them.</Text>
      </Box>,
      costBlock,
    ]
  }

  return [
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text bold color="claude">
          Stats
        </Text>
        <Text dimColor>{`· last ${stats?.days ?? 30} days`}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={layout.gap + 1}>
        {headline(String(totals.answered), 'answered')}
        {headline(totals.answered > 0 ? `${Math.round((100 * totals.gotIt) / totals.answered)}%` : '–', 'got it')}
        {headline(`≈ ${formatUsd(week)}`, 'last 7 days')}
      </Box>
    </Box>,
    categories.length > 0 ? (
      <Box flexDirection="column">
        {categories.map(([name, c]) => {
          const [got = 0, part = 0, miss = 0] = segments([c.gotIt, c.partly, c.missed], most, barWidth)

          return (
            <Box flexDirection="column">
              <Text wrap="truncate-end">{name}</Text>
              <Box flexDirection="row" columnGap={1}>
                <Box flexDirection="row">
                  {got > 0 && <Text color="success">{'█'.repeat(got)}</Text>}
                  {part > 0 && <Text color="warning">{'▓'.repeat(part)}</Text>}
                  {miss > 0 && <Text dimColor>{'░'.repeat(miss)}</Text>}
                </Box>
                <Text dimColor>{`${c.gotIt} ✓ ${c.partly} ~ ${c.missed} ✗`}</Text>
              </Box>
            </Box>
          )
        })}
        <Text dimColor>✓ got it · ~ partly · ✗ missed</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text bold>No answers graded yet</Text>
        <Text dimColor>Mark a few answers with 1, 2 or 3 after reveal and the bars appear here.</Text>
      </Box>
    ),
    costBlock,
  ]
}

// ---------------------------------------------------------------- pure helpers

/** The answers self-graded in a summary, and how many of them were marked got it. */
function answeredTotals(stats: StatsSummary): { answered: number; gotIt: number } {
  return Object.values(stats.selfAssessment.byCategory).reduce(
    (sum, c) => ({ answered: sum.answered + c.gotIt + c.partly + c.missed, gotIt: sum.gotIt + c.gotIt }),
    { answered: 0, gotIt: 0 },
  )
}

/** Day keys for the `n` days ending today, oldest first; noon keeps a daylight-saving shift from skipping a day. */
function lastDays(now: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - (n - 1 - i))
    return dayKey(d.getTime())
  })
}

/** Cells per count on a bar `width` wide for the largest total `most`; a count above zero always shows. */
function segments(counts: number[], most: number, width: number): number[] {
  return counts.map(n => (n > 0 ? Math.max(1, Math.round((n / most) * width)) : 0))
}

/** One block per value; a day with no spend sits on the baseline so it differs from a small one. */
function sparkline(values: number[]): string {
  const blocks = '▂▃▄▅▆▇█'
  const peak = Math.max(...values)
  if (!(peak > 0)) return '▁'.repeat(values.length)

  return values
    .map(v => (v > 0 ? blocks.charAt(Math.min(blocks.length - 1, Math.floor((v / peak) * (blocks.length - 1) + 0.5))) : '▁'))
    .join('')
}

/** A compact age such as "3w ago", for the card header. */
function ago(ms: number): string {
  const days = Math.floor(ms / 86_400_000)
  if (days < 1) return 'changed today'
  if (days < 14) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30.44)}mo ago`
  return `${Math.floor(days / 365.25)}y ago`
}

/** Local `HH:MM`, with the weekday when the time is not within the next day. */
function untilTime(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toTimeString().slice(0, 5)

  return at - now > 20 * 3_600_000 ? `${d.toDateString().slice(0, 3)} ${time}` : time
}

function truncate(text: string, room: number): string {
  const glyphs = [...text]
  return glyphs.length <= room ? text : `${glyphs.slice(0, Math.max(1, room - 1)).join('')}…`
}

const textWidth = (text: string) => [...text].length

/** `text` without `**` outside its code spans, which keep every character; a backslash escape is kept whole. */
function withoutBold(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; ) {
    if (text.charAt(i) === '`') {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? '`'
      const close = closingRun(text, run.length, i + run.length)
      const end = close === -1 ? i + run.length : close + run.length
      out += text.slice(i, end)
      i = end
    } else if (text.charAt(i) === '\\') {
      out += text.slice(i, i + 2)
      i += 2
    } else if (text.startsWith('**', i)) {
      i += 2
    } else {
      out += text.charAt(i)
      i += 1
    }
  }

  return out
}

/** Where the backtick run of exactly `n` that closes a code span starts, at or after `from`; -1 when none does. */
function closingRun(text: string, n: number, from: number): number {
  for (let j = from; j < text.length; ) {
    if (text.charAt(j) !== '`') {
      j += 1
      continue
    }
    let k = j
    while (text.charAt(k) === '`') k += 1
    if (k - j === n) return j
    j = k
  }

  return -1
}

// ---------------------------------------------------------------- raster cells

/** `0x01000000`: the terminal's own foreground or background. */
const TERMINAL_DEFAULT = 0x01000000

/** The Raster's columns for a body this wide: what the element accepts, so the cells and the element always agree. */
function rasterColumns(columns: number): number {
  return Math.max(1, Math.min(512, Math.floor(columns) || 1))
}

/** The code point itself when a cell can hold it (printable, one column, in the BMP), else '?'. */
function cellCode(code: number): number {
  const isControl = code < 0x20 || (code >= 0x7f && code < 0xa0)
  const isOutside = code > 0xffff || (code >= 0xd800 && code <= 0xdfff)
  const isZeroWidth = (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f)
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)

  return isControl || isOutside || isZeroWidth || isWide ? 0x3f : code
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64; the hooks runtime declares no encoder of its own. */
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
    out += b1 === undefined ? '=' : BASE64.charAt((n >> 6) & 63)
    out += b2 === undefined ? '=' : BASE64.charAt(n & 63)
  }

  return out
}

// ---------------------------------------------------------------- details

const counts3 = (c: Counts3) => `${c.gotIt} got it · ${c.partly} partly · ${c.missed} missed`
const ratings = (r: RatingCounts) =>
  `${r.useful} useful · ${r.notUseful} not useful · ${r.wrong} wrong · ${r.alreadyKnew} already knew`

/** A list item with one nested item per key, or "none yet" when the record is empty. */
function nested<T>(title: string, record: Record<string, T>, format: (value: T) => string): string {
  const items = Object.entries(record).map(([name, value]) => `  - ${name}: ${format(value)}`)

  return items.length > 0 ? [`- ${title}:`, ...items].join('\n') : `- ${title}: none yet`
}

const noneOr = <T,>(value: T | null, format: (value: T) => string) => (value === null ? 'no data yet' : format(value))

/** The tables behind "Details": verification and ratings per model, the rest of the summary, and the cost breakdown. */
function detailsMarkdown(s: StatsSummary | null, tally: Tally | undefined, now: number, telemetryOff: boolean): string {
  const cost = [
    bucketMarkdown('Today', tally?.days[dayKey(now)]),
    bucketMarkdown('This month', tally?.months[monthKey(now)]),
    bucketMarkdown('Lifetime', tally?.lifetime),
  ]
  if (telemetryOff) return ['Telemetry is off.', '', ...cost].join('\n')
  if (!s) return ['No telemetry yet.', '', ...cost].join('\n')
  const cards = Object.entries(s.cards)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(', ')
  const { real, falseAlarm } = s.flawFeedback
  const precision = real + falseAlarm > 0 ? ` (${Math.round((100 * real) / (real + falseAlarm))}% real)` : ''

  return [
    `- Cards shown: ${cards || 'none yet'}`,
    nested('How you did, by focus', s.selfAssessment.byFocus, counts3),
    nested('Ratings by kind', s.ratings.byKind, ratings),
    nested('Ratings by model', s.ratings.byModel, ratings),
    `- Flaw feedback: ${real} real issue · ${falseAlarm} false alarm${precision}`,
    nested(
      'Verification by model',
      s.verification,
      ({ citations: c, sources: v }) =>
        `citations ${c.verified} of ${c.total} verified (${c.corrected} corrected, ${c.dropped} dropped); ` +
        `sources ${v.verified} of ${v.total} verified (${v.unconfirmed} unconfirmed, ${v.dead} dead, ${v.unsupported} unsupported)`,
    ),
    `- Cost per question: ${noneOr(s.costPerQuestionUsd, usd => `≈ ${formatUsd(usd)}`)}; ` +
      `per kept fact: ${noneOr(s.costPerKeptFactUsd, usd => `≈ ${formatUsd(usd)}`)}`,
    `- Median time to a card: ${noneOr(s.medianCardLatencyMs, ms => `${Math.round(ms / 1000)} s`)}`,
    `- Cards shown while the pane was visible: ${noneOr(s.paneVisibleShare, share => `${Math.round(share * 100)}%`)}`,
    ...cost,
  ].join('\n')
}

const runs = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`
const breakdown = (record: TallyBucket['byJob']) =>
  Object.entries(record)
    .map(([name, c]) => `${name} ${formatUsd(c.usd)} (${runs(c.runs)})`)
    .join(', ')

function bucketMarkdown(label: string, bucket: TallyBucket | undefined): string {
  if (!bucket || bucket.runs === 0) return `- ${label}: nothing spent`

  return [
    `- ${label} ≈ ${formatUsd(bucket.usd)} over ${runs(bucket.runs)}`,
    `  - by job: ${breakdown(bucket.byJob)}`,
    `  - by model: ${breakdown(bucket.byModel)}`,
  ].join('\n')
}

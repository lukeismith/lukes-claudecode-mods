// The single-call model jobs (grading, flaw confirmation, source support),
// each one $.model.complete with no tools. Each returns its parsed result and
// a ModelRun the caller adds to the tally and telemetry.

import type { Flaw, GradeResult, Io, QuestionCard, SupportVerdict, Usage } from '../types'

import { MODELS, costOf, estimateUsd, parseFlawVerdict, parseGrade, parseSupport } from './logic'
import { flawConfirmPrompt, gradePrompt, supportPrompt } from './prompts'

export type ModelRun = {
  job: 'grade' | 'flaw' | 'support'
  model: string
  effort: string
  usage: Usage | null
  usd: number
  durationMs: number
  outcome: 'ok' | 'unreadable' | 'error' | 'aborted'
}

type Call = {
  job: ModelRun['job']
  model: string
  effort: NonNullable<Parameters<Io['complete']>[0]['effort']>
  // Thinking is always on for the 5.5 models and counts toward this cap, so
  // each cap leaves room for thinking on top of the reply itself.
  maxTokens: number
  timeoutMs: number
}

// The grade model is a setting, so the caller supplies it.
const GRADE: Omit<Call, 'model'> = { job: 'grade', effort: 'medium', maxTokens: 8000, timeoutMs: 90_000 }
const FLAW: Call = { job: 'flaw', model: MODELS.flaw, effort: 'medium', maxTokens: 8000, timeoutMs: 90_000 }
const SUPPORT: Call = { job: 'support', model: MODELS.support, effort: 'low', maxTokens: 1024, timeoutMs: 30_000 }

const GRADE_OUTPUT_TOKENS = 1500

/** One completion, parsed. Never throws for a model or engine failure: those come back as the run's outcome. */
async function complete<T>(
  io: Io,
  call: Call,
  ask: { system: string; prompt: string },
  parse: (text: string) => T | null,
): Promise<{ value: T | null; run: ModelRun }> {
  const startedAt = await io.now()
  let value: T | null = null
  let usage: Usage | null = null
  let outcome: ModelRun['outcome'] = 'error'
  try {
    const r = await io.complete({
      model: call.model,
      system: ask.system,
      prompt: ask.prompt,
      maxTokens: call.maxTokens,
      effort: call.effort,
      timeoutMs: call.timeoutMs,
    })
    usage = r.usage ?? null
    if (r.isAnswered) {
      value = parse(r.text)
      outcome = value === null ? 'unreadable' : 'ok'
    } else if (r.reason === 'aborted') {
      outcome = 'aborted'
    }
  } catch {
    // The engine refused to send (a blocked model, a bad cap): an error run, not a throw.
  }
  const durationMs = (await io.now()) - startedAt
  const usd = usage === null ? 0 : costOf(usage, call.model)
  return { value, run: { job: call.job, model: call.model, effort: call.effort, usage, usd, durationMs, outcome } }
}

/** `model` (the grade model setting, an alias), effort medium, via prompts.gradePrompt and logic.parseGrade; 90 s timeout. */
export async function gradeAnswer(
  io: Io,
  card: QuestionCard,
  answer: string,
  model: string,
  steWriting: boolean,
): Promise<{ result: GradeResult | null; run: ModelRun }> {
  const { value, run } = await complete(io, { ...GRADE, model }, gradePrompt(card, answer, steWriting), parseGrade)
  return { result: value, run }
}

/** Opus, effort medium, via prompts.flawConfirmPrompt and logic.parseFlawVerdict; 90 s timeout. Unreadable or failed counts as not confirmed. */
export async function confirmFlaw(
  io: Io,
  flaw: Flaw,
  excerpts: string,
  steWriting: boolean,
): Promise<{ isConfirmed: boolean; run: ModelRun }> {
  const { value, run } = await complete(io, FLAW, flawConfirmPrompt(flaw, excerpts, steWriting), parseFlawVerdict)
  return { isConfirmed: value?.isConfirmed === true, run }
}

/** Haiku, effort low, via prompts.supportPrompt and logic.parseSupport; 30 s timeout. */
export async function checkSupport(
  io: Io,
  claim: string,
  passage: string,
): Promise<{ verdict: SupportVerdict | null; run: ModelRun }> {
  const { value, run } = await complete(io, SUPPORT, supportPrompt(claim, passage), parseSupport)
  return { verdict: value, run }
}

/** The price shown on the "Grade my answer" button: logic.estimateUsd for `model` over the grade prompt's length and ~1,500 output tokens. */
// ponytail: priced with the style block in; with steWriting off this overestimates by a few hundred input tokens (a fraction of a cent).
export function estimateGradeUsd(card: QuestionCard, answer: string, model: string): number {
  const { system, prompt } = gradePrompt(card, answer)
  return estimateUsd(model, system.length + prompt.length, GRADE_OUTPUT_TOKENS)
}

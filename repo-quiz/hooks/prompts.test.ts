// Prompt text tests: the questioner's schema asks for the two parts the pane
// draws, each category gets its preferred shape, and grading still reads the
// combined question.

import { expect, test } from 'claude-code/testing'

import type { ContextPacket, QuestionCard } from '../types'
import { CATEGORIES } from './logic'
import { WRITING_STYLE, agentSystemPrompt, factBatchTask, flawConfirmPrompt, gradePrompt, questionTask, supportPrompt } from './prompts'

const PACKET: ContextPacket = {
  repoRoot: '/work/app',
  branch: 'main',
  languages: [{ ext: 'ts', files: 12 }],
  recentCommits: 'abc123 Add the cache',
  uncommitted: '',
  touchedFiles: ['src/cache.ts'],
  officialHosts: ['developer.mozilla.org'],
  focus: null,
  extraFocus: [],
  lastPrompt: '',
  avoidTopics: [],
  category: 'Debugging scenario',
  difficulty: 'senior',
  sourcePolicy: 'official preferred',
  flawReview: true,
}

/** The JSON object the schema section shows, between its plain fences. */
function schemaOf(task: string): string {
  const schema = task.slice(task.indexOf('# Schema'))
  return schema.slice(schema.indexOf('```\n{') + 4, schema.indexOf('\n}\n```') + 2)
}

test('the questioner’s schema asks for context and ask in place of question, with their limits', () => {
  const schema = schemaOf(questionTask(PACKET))

  expect(schema).toContain('"context": "Markdown that sets the question up, under about 80 words')
  expect(schema).toContain('"ask": "What the developer must answer, in Markdown: one or two sentences, or a numbered list of at most three parts."')
  expect(schema).not.toContain('"question"')
  for (const key of ['topic', 'category', 'answer', 'citations', 'sources', 'flaw']) expect([key, schema.includes(`"${key}":`)]).toEqual([key, true])
})

test('the task explains the two parts: a numbered list for several parts, never a run-on sentence, and no headings', () => {
  const task = questionTask(PACKET)

  expect(task).toContain('`context` in the normal weight, then a blank line, then `ask` in bold')
  expect(task).toContain('a numbered list of at most three items, never as one run-on sentence')
  expect(task).toContain('Use no headings in either part.')
})

test('each category gets its preferred shape of context', () => {
  const shapeOf = (category: string) => {
    const task = questionTask({ ...PACKET, category })
    return task.slice(task.indexOf('For this category: '), task.indexOf('# The model answer'))
  }

  for (const category of ['Debugging scenario', 'Security and trust boundaries', 'System design trade-offs', 'Performance and complexity']) {
    expect([category, shapeOf(category).includes('a short, concrete scenario')]).toEqual([category, true])
  }
  expect(shapeOf('Explain how this code works')).toContain('point to the exact lines as `path:line` references')
  expect(shapeOf('Explain how this code works')).toContain('"Walk through what happens when two calls overlap."')
  for (const category of ['Language semantics and quirks', 'Concurrency and asynchronous behavior']) {
    expect([category, shapeOf(category).includes('a fenced code block of at most 10 lines, copied from the repository and preferably from the focus excerpt')]).toEqual([category, true])
  }
  for (const category of ['Architecture and module boundaries', 'Data modeling and API design', 'Testing strategy']) {
    expect([category, shapeOf(category).includes('one or two lines')]).toEqual([category, true])
  }
  // Every category has a shape of its own, and an unknown one falls back to the brief shape.
  for (const category of CATEGORIES) expect([category, shapeOf(category).length > 40]).toEqual([category, true])
  expect(shapeOf('Something new')).toContain('one or two lines')
})

test('grading reads the combined question, so the grader sees the setup as well as the ask', () => {
  const card = {
    category: 'Debugging scenario',
    context: 'The network drops for a minute.',
    ask: 'Why can `retry()` loop forever?',
    question: 'The network drops for a minute.\n\nWhy can `retry()` loop forever?',
    answer: 'The counter resets.',
    citations: [],
    sources: [],
    isUnverified: false,
  } as unknown as QuestionCard

  expect(gradePrompt(card, 'It resets.').prompt).toContain('<question>\nThe network drops for a minute.\n\nWhy can `retry()` loop forever?\n</question>')
})

const CARD = {
  category: 'Debugging scenario',
  question: 'Why can `retry()` loop forever?',
  answer: 'The counter resets.',
  citations: [],
  sources: [],
  isUnverified: false,
} as unknown as QuestionCard
const FLAW = { summary: 'The counter resets on every attempt.', severity: 'medium' as const, evidence: [] }

test('the writing style goes before the output instructions of the agent, grading and flaw prompts', () => {
  for (const system of [agentSystemPrompt(true), gradePrompt(CARD, 'x').system, flawConfirmPrompt(FLAW, '').system]) {
    expect(system).toContain(WRITING_STYLE)
    const output = system.includes('# Output') ? '# Output' : 'End your reply'
    expect(system.indexOf(WRITING_STYLE)).toBeLessThan(system.indexOf(output))
  }
})

test('with steWriting off no prompt carries the writing style, and the support check never does', () => {
  for (const system of [agentSystemPrompt(false), gradePrompt(CARD, 'x', false).system, flawConfirmPrompt(FLAW, '', false).system]) {
    expect(system).not.toContain('Simplified Technical English')
  }
  const support = supportPrompt('A claim.', 'A passage.')
  expect(support.system + support.prompt).not.toContain('Simplified Technical English')
})

test('the style rules say what to do, with no word counts', () => {
  const rules = WRITING_STYLE.split('\n').filter(line => line.startsWith('- '))
  expect(rules.length).toBe(12)
  for (const rule of rules) {
    expect(rule).not.toMatch(/\b(do not|don't|never|avoid)\b/i)
    expect(rule).not.toMatch(/\d/)
  }
})

test('no prompt names a particular person', () => {
  const texts = [
    agentSystemPrompt(true), questionTask(PACKET), factBatchTask({ ...PACKET, category: undefined }),
    gradePrompt(CARD, 'x').system, gradePrompt(CARD, 'x').prompt, flawConfirmPrompt(FLAW, '').system,
  ]
  for (const text of texts) expect(text).not.toMatch(/\bLuke\b/)
})

import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const props = (bodyColumns: number) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

const START = Date.parse('2026-10-03T12:00:00Z')
const IN_AN_HOUR = new Date(START + 3_600_000).toISOString()

const USAGE = {
  five_hour: { utilization: 25, resets_at: IN_AN_HOUR },
  seven_day: { utilization: 27, resets_at: IN_AN_HOUR },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 12, resets_at: IN_AN_HOUR },
  ],
}

// The engine beneath the plugin: a clock, a login, the usage endpoint, and a
// session that measured once and finished one turn.
async function seed($: Engine, on: On, status: number) {
  const urls: string[] = []
  on('clock.now', () => ({ value: START }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.authorize', () => ({ value: { handle: 'test-handle', kind: 'bearer' as const } }))
  on('http.fetch', ($, e) => {
    urls.push(`${e.url} ${e.init?.auth ?? ''}`)

    return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(USAGE) : '' } }
  })

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 25, resetsAt: IN_AN_HOUR },
      { kind: 'seven_day', percentUsed: 27, resetsAt: IN_AN_HOUR },
    ],
    cost: { usd: 2.9 },
    changed: ['rateLimits', 'cost'],
  })
  await $.turn.complete({
    reason: 'answer',
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 15_600,
      output_tokens: 3_000,
      cache_read_input_tokens: 900_000,
      cache_creation_input_tokens: 54_200,
    },
  })

  return urls
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws the band, Fable's weekly limit included, on ${surface}`, async ($, on) => {
    const urls = await seed($, on, 200)
    expect(urls).toEqual(['https://api.anthropic.com/api/oauth/usage test-handle'])

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(120) })
    expect(await ui.drawn()).toMatchObject({
      type: 'Box',
      props: { flexWrap: 'nowrap', overflow: 'hidden', justifyContent: 'space-between', width: '100%' },
    })

    expect(await ui.find({ text: '25%' })).toBeDefined()
    expect(await ui.find({ text: 'Fable' })).toBeDefined()
    expect(await ui.find({ text: '12%' })).toBeDefined()
    expect(await ui.find({ text: '2.90' })).toBeDefined()
    expect(await ui.find({ text: '954.2k' })).toBeDefined()
    expect(await ui.find({ text: '· 1h 0m' })).toBeDefined()
  })

  test(`still draws the band when the usage endpoint refuses, on ${surface}`, async ($, on) => {
    await seed($, on, 429)

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(120) })
    expect(await ui.find({ text: '25%' })).toBeDefined()
    expect(await ui.find({ text: 'Fable' })).toBeUndefined()
  })

  test(`keeps one line and every bar on a narrow band, on ${surface}`, async ($, on) => {
    await seed($, on, 200)

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props(40) })
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { flexWrap: 'nowrap', overflow: 'hidden' } })

    for (const kept of ['25%', '27%', 'Fable', '12%']) {
      expect(await ui.find({ text: kept })).toBeDefined()
    }
    for (const gone of ['954.2k', '15.6k', '3.0k', '2.90', '· 1h 0m']) {
      expect(await ui.find({ text: gone })).toBeUndefined()
    }
    if (surface === 'desktop') {
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
    } else {
      expect(await ui.findAll({ type: 'Text', text: '━━' })).toHaveLength(2)
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    }
  })
}

test('fits the whole row in a 96-cell desktop band, gaps shrunk, nothing hidden', async ($, on) => {
  await seed($, on, 200)

  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props(96) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  expect(await ui.findAll({ type: 'Text', text: '· 1h 0m' })).toHaveLength(3)
  for (const kept of ['15.6k', '3.0k', '954.2k', '2.90']) {
    expect(await ui.find({ text: kept })).toBeDefined()
  }
})

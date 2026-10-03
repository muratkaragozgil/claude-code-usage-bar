import type { EngineInterface, On, SessionRateLimit, TurnUsage } from 'claude-code'

import type { ModelWindow, Remote, Snapshot, Tokens, Window } from '../types'

// Where the plugin keeps its values in $.state, one address per value.
const SNAP = { plugin: 'usage-bar', key: 'snap' } as const
const REMOTE = { plugin: 'usage-bar', key: 'remote' } as const
const TOKENS = { plugin: 'usage-bar', key: 'tokens' } as const
const NOW = { plugin: 'usage-bar', key: 'now' } as const
const IS_HIDDEN = { plugin: 'usage-bar', key: 'isHidden' } as const

const NO_SNAP: Snapshot = { fiveHour: null, sevenDay: null, costUsd: null }
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const TICK_MS = 30_000
const REMOTE_EVERY_MS = 5 * 60_000
const REMOTE_MIN_GAP_MS = 60_000
const REMOTE_BACKOFF_MS = 10 * 60_000

// Fetch bookkeeping only; nothing draws from it, so a reload may reset it.
// Requests go out at least a minute apart (ten minutes after a refusal), and
// the regular refresh is due five minutes after the last one.
let nextAllowedAt = 0
let nextDueAt = 0
let isFetching = false
let hasReportedFailure = false

type Gauge = { pct: number; leftMs: number | null }

type Kind = '5h' | '7d' | 'model' | 'in' | 'out' | 'cache' | 'cost'

type Item = { kind: Kind; label: string; value: string; gauge?: Gauge }

// What of an item is drawn: fitting the row to one line turns parts off.
type Shown = Item & { hasLeft: boolean }

function toWindow(limits: SessionRateLimit[], kind: string): Window | null {
  const hit = limits.find(limit => limit.kind === kind)

  return hit ? { percentUsed: hit.percentUsed, resetsAt: hit.resetsAt ?? null } : null
}

function toSnapshot(usage: { rateLimits: SessionRateLimit[]; cost?: { usd: number } }): Snapshot {
  return {
    fiveHour: toWindow(usage.rateLimits, 'five_hour'),
    sevenDay: toWindow(usage.rateLimits, 'seven_day'),
    costUsd: usage.cost?.usd ?? null,
  }
}

function pick(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

// `utilization` and `percent` are whole percents, 0 to 100.
function toRemoteWindow(value: unknown, field: 'utilization' | 'percent'): Window | null {
  const pct = pick(value, field)
  if (typeof pct !== 'number') return null
  const resets = pick(value, 'resets_at')

  return { percentUsed: pct, resetsAt: typeof resets === 'string' ? resets : null }
}

function parseRemote(body: unknown): Remote {
  const models: ModelWindow[] = []
  const isListed = (name: string) => models.some(m => m.name.toLowerCase() === name.toLowerCase())

  const limits = pick(body, 'limits')
  for (const row of Array.isArray(limits) ? limits : []) {
    const name = pick(pick(pick(row, 'scope'), 'model'), 'display_name')
    const w = toRemoteWindow(row, 'percent')
    if (pick(row, 'kind') === 'weekly_scoped' && typeof name === 'string' && w && !isListed(name)) {
      models.push({ name, ...w })
    }
  }
  for (const [key, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
    const w = toRemoteWindow(pick(body, key), 'utilization')
    if (w && !isListed(name)) models.push({ name, ...w })
  }

  return {
    fiveHour: toRemoteWindow(pick(body, 'five_hour'), 'utilization'),
    sevenDay: toRemoteWindow(pick(body, 'seven_day'), 'utilization'),
    models,
  }
}

// Reads the clock into NOW, which keeps the reset countdowns moving.
async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await $.state.set(NOW, at)
}

// Adds one turn's token counts to the session totals. A subagent's turn and the
// main one can finish together, so the write is compare-and-set.
async function addTokens($: EngineInterface, usage: TurnUsage): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const held = await $.state.get(TOKENS)
    const sum = held.value ?? NO_TOKENS
    const written = await $.state.set(
      TOKENS,
      {
        input: sum.input + usage.input_tokens,
        output: sum.output + usage.output_tokens,
        cacheRead: sum.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: sum.cacheWrite + usage.cache_creation_input_tokens,
      },
      { ifVersion: held.version },
    )
    if (written.isSet) return
  }
}

async function toggleHidden($: EngineInterface): Promise<boolean> {
  const held = await $.state.get(IS_HIDDEN)
  const isNowHidden = held.value !== true
  await $.state.set(IS_HIDDEN, isNowHidden)

  return isNowHidden
}

// Reads the plan's limits, per-model weekly ones (Fable) included, from the
// endpoint behind the app's usage card and /usage. The API's rate-limit
// headers carry only the 5-hour and weekly windows.
async function refreshRemote($: EngineInterface, isScheduled: boolean): Promise<void> {
  const at = await $.clock.now()
  if (isFetching || at < nextAllowedAt || (isScheduled && at < nextDueAt)) return
  isFetching = true
  nextAllowedAt = at + REMOTE_MIN_GAP_MS
  nextDueAt = at + REMOTE_EVERY_MS
  let failure: string | null = null

  try {
    // A handle for the session's own login; the token never reaches this module.
    const auth = await $.session.authorize()
    if (auth?.kind === 'bearer') {
      const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
        auth: auth.handle,
      })
      if (res.ok) {
        await $.state.set(REMOTE, parseRemote(JSON.parse(res.text)))
      } else {
        if ([401, 403, 429].includes(res.status)) nextAllowedAt = nextDueAt = at + REMOTE_BACKOFF_MS
        failure = `usage endpoint answered ${res.status}`
      }
    } else {
      nextAllowedAt = nextDueAt = at + REMOTE_BACKOFF_MS
      failure = auth ? 'signed in with an API key' : 'no claude.ai login'
    }
  } catch (error) {
    // Network or parse trouble: keep the last reading and try again later.
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    isFetching = false
  }

  // Says once per load, in the transcript, why the per-model limits are missing.
  if (failure !== null && !hasReportedFailure) {
    hasReportedFailure = true
    $.ui.log(`usage-bar: per-model limits unavailable (${failure}); 5h and 7d still come from the session`)
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`

  return `${(n / 1_000_000).toFixed(2)}M`
}

function fmtLeft(ms: number): string {
  if (ms <= 0) return 'now'
  // Not `h`: in a .tsx file that name is the JSX factory.
  const total = Math.ceil(ms / 60_000)
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const minutes = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`

  return `${minutes}m`
}

function toGauge(w: Window, at: number): Gauge {
  const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN

  return {
    pct: clamp(w.percentUsed, 0, 100),
    leftMs: Number.isFinite(resets) ? resets - at : null,
  }
}

// Monochrome bar for surfaces that draw SVG; follows the app's light/dark theme.
function barSvg(pct: number): string {
  const W = 44
  const H = 10
  const filled = (W * pct) / 100
  const fill = filled > 0 ? `<rect y="3" width="${Math.max(filled, 4)}" height="4" rx="2" class="f"/>` : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    '<style>.t{fill:#000;fill-opacity:.12}.f{fill:#000;fill-opacity:.5}' +
    '@media (prefers-color-scheme:dark){.t{fill:#fff;fill-opacity:.15}.f{fill:#fff;fill-opacity:.55}}</style>' +
    `<rect y="3" width="${W}" height="4" rx="2" class="t"/>${fill}</svg>`
  )
}

function barText(pct: number, cells = 8): { done: string; rest: string } {
  const filled = Math.round((pct / 100) * cells)

  return { done: '━'.repeat(filled), rest: '─'.repeat(cells - filled) }
}

const ITEM_GAP = 1
const ROW_GAP = 1

// How wide things draw, in cells (the unit `bodyColumns` counts): exact on the
// terminal; on the desktop a cell is 8px, its text about 7px a character and
// the bar 44px, as measured on the app's band.
type Metrics = { char: number; bar: number }
const TERMINAL: Metrics = { char: 1, bar: 8 }
const DESKTOP: Metrics = { char: 0.9, bar: 5.5 }

const hideLeft =
  (...kinds: Kind[]) =>
  (row: Shown[]) =>
    row.map(it => (kinds.includes(it.kind) ? { ...it, hasLeft: false } : it))
const drop = (kind: Kind) => (row: Shown[]) => row.filter(it => it.kind !== kind)

// Least useful first: what goes, one step at a time, until the row fits.
// The bars and the limits' percentages always stay; anything still too wide
// is clipped at the right edge.
const FIT_STEPS = [
  hideLeft('model'),
  hideLeft('7d'),
  drop('cache'),
  drop('in'),
  drop('out'),
  hideLeft('5h'),
  drop('cost'),
]

function rowWidth(row: Shown[], m: Metrics): number {
  const widths = row.map(it => {
    let chars = it.label.length + it.value.length
    let gaps = 1
    let cells = 0
    if (it.gauge) {
      cells += m.bar
      gaps += 1
    }
    if (it.hasLeft && it.gauge?.leftMs != null) {
      chars += fmtLeft(it.gauge.leftMs).length + 2
      gaps += 1
    }

    return chars * m.char + cells + gaps * ITEM_GAP
  })

  return widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * ROW_GAP
}

function fitRow(items: Item[], room: number, m: Metrics): Shown[] {
  let row: Shown[] = items.map(it => ({ ...it, hasLeft: it.gauge?.leftMs != null }))
  for (const step of FIT_STEPS) {
    if (rowWidth(row, m) <= room) break
    row = step(row)
  }

  return row
}

export function register(on: On): void {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await $.state.set(SNAP, toSnapshot(usage))
    await tick($)

    // Every 30 seconds: move the countdowns, and refresh the plan limits when due.
    $.clock.every(TICK_MS, async () => {
      await tick($)
      await refreshRemote($, true)
    })

    // The first refresh, right after the session starts, without holding it up.
    $.clock.after(1, async () => {
      await refreshRemote($, true)
    })

    // Last, as registering throws when another plugin already took the name.
    await $.command.register({
      name: 'usage-bar',
      description: 'Show or hide the usage bar above the prompt',
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await $.state.set(SNAP, toSnapshot(e))
    await tick($)
    const result = await next(e)

    // A window moved: the per-model ones may have too (at most once a minute).
    if (e.changed.includes('rateLimits')) {
      await refreshRemote($, false)
    }

    return result
  })

  // Every turn, subagents' included, so the totals line up with the cost.
  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      await addTokens($, e.usage)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await $.state.set(TOKENS, NO_TOKENS)
    }

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async ($, e) => {
    const isNowHidden = await toggleHidden($)

    return { text: isNowHidden ? 'Usage bar hidden.' : 'Usage bar shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hidden = await $.state.get(IS_HIDDEN)
    if (e.props.hasSurvey || hidden.value === true) {
      return next(e)
    }

    const s = (await $.state.get(SNAP)).value ?? NO_SNAP
    const r = (await $.state.get(REMOTE)).value ?? null
    const t = (await $.state.get(TOKENS)).value ?? NO_TOKENS
    const at = (await $.state.get(NOW)).value || (await $.clock.now())

    // The engine's readings are the freshest (every response); the endpoint's
    // stand in until the first one, and alone carry the per-model windows.
    const windows: Array<[Kind, string, Window | null]> = [
      ['5h', '5h', s.fiveHour ?? r?.fiveHour ?? null],
      ['7d', '7d', s.sevenDay ?? r?.sevenDay ?? null],
      ...(r?.models ?? []).map((m): [Kind, string, Window] => ['model', m.name, m]),
    ]

    const items: Item[] = []
    for (const [kind, label, w] of windows) {
      if (!w) continue
      const g = toGauge(w, at)
      items.push({ kind, label, value: `${Math.round(g.pct)}%`, gauge: g })
    }
    items.push(
      { kind: 'in', label: '↑', value: fmtTokens(t.input) },
      { kind: 'out', label: '↓', value: fmtTokens(t.output) },
      { kind: 'cache', label: '⟲', value: fmtTokens(t.cacheRead + t.cacheWrite) },
    )
    if (s.costUsd !== null) {
      items.push({ kind: 'cost', label: '$', value: s.costUsd.toFixed(2) })
    }

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    // The terminal's table answers Svg too, but draws it empty: text bars there.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null

    const room = e.props.bodyColumns > 0 ? e.props.bodyColumns - 1 : Infinity
    const row = fitRow(items, room, Svg ? DESKTOP : TERMINAL)

    const bar = (g: Gauge) => {
      if (Svg) {
        return <Svg source={barSvg(g.pct)} alt={`${Math.round(g.pct)}% used`} width={44} height={10} />
      }
      const b = barText(g.pct)

      return (
        <Box flexDirection="row">
          <Text>{b.done}</Text>
          <Text dimColor>{b.rest}</Text>
        </Box>
      )
    }

    // One line whatever the width: no wrapping, items never shrink into two
    // lines, and what the fitting could not save is clipped at the right edge.
    return (
      <Box
        flexDirection="row"
        flexWrap="nowrap"
        overflow="hidden"
        alignItems="center"
        justifyContent="space-between"
        width="100%"
        columnGap={ROW_GAP}
      >
        {row.map(it => (
          <Box flexDirection="row" flexShrink={0} alignItems="center" columnGap={ITEM_GAP}>
            <Text dimColor wrap="truncate-end">
              {it.label}
            </Text>
            {it.gauge && bar(it.gauge)}
            <Text bold={it.gauge !== undefined} wrap="truncate-end">
              {it.value}
            </Text>
            {it.hasLeft && it.gauge?.leftMs != null && (
              <Text dimColor wrap="truncate-end">
                · {fmtLeft(it.gauge.leftMs)}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

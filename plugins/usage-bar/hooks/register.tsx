import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { ModelWindow, Remote, Snapshot, Tokens, Window } from '../types'

const snap = atom({ plugin: 'usage-bar', key: 'snap' } as const, {
  fiveHour: null,
  sevenDay: null,
  costUsd: null,
})
const remote = atom({ plugin: 'usage-bar', key: 'remote' } as const, null)
const tokens = atom({ plugin: 'usage-bar', key: 'tokens' } as const, {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})
const now = atom({ plugin: 'usage-bar', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'usage-bar', key: 'isHidden' } as const, false)

const TICK_MS = 30_000

// The endpoint the app's usage card and /usage read: the only source of the
// per-model weekly limits (Fable), which the API's rate-limit headers omit.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REMOTE_EVERY_MS = 5 * 60_000
const REMOTE_MIN_GAP_MS = 60_000
const REMOTE_BACKOFF_MS = 10 * 60_000

// Fetch bookkeeping only; nothing draws from it, so a reload may reset it.
let nextRemoteAt = 0
let isFetching = false
let hasReportedFailure = false

// Says once per load, in the transcript, why the per-model limits are missing.
function reportFailure($: EngineInterface, reason: string): void {
  if (hasReportedFailure) return
  hasReportedFailure = true
  $.ui.log(`usage-bar: per-model limits unavailable (${reason}); 5h and 7d still come from the session`)
}

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

async function refreshRemote($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  if (isFetching || at < nextRemoteAt) return
  isFetching = true
  nextRemoteAt = at + REMOTE_MIN_GAP_MS

  try {
    // A handle for the session's own login; the token never reaches this module.
    const auth = await $.session.authorize()
    if (auth?.kind !== 'bearer') {
      nextRemoteAt = at + REMOTE_BACKOFF_MS
      reportFailure($, auth ? 'signed in with an API key' : 'no claude.ai login')
      return
    }

    const res = await $.http.fetch(USAGE_URL, {
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      auth: auth.handle,
    })
    if (!res.ok) {
      if ([401, 403, 429].includes(res.status)) nextRemoteAt = at + REMOTE_BACKOFF_MS
      reportFailure($, `usage endpoint answered ${res.status}`)
      return
    }

    const parsed = parseRemote(JSON.parse(res.text))
    await update($, remote, () => parsed)
  } catch (error) {
    // Network or parse trouble: keep the last reading and try again later.
    reportFailure($, error instanceof Error ? error.message : String(error))
  } finally {
    isFetching = false
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
  const mins = Math.ceil(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`

  return `${m}m`
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-bar',
      description: 'Show or hide the usage bar above the prompt',
    })

    const usage = await $.session.usage()
    await update($, snap, () => toSnapshot(usage))
    const t = await $.clock.now()
    await update($, now, () => t)

    // Keeps the reset countdowns moving between turns.
    $.clock.every(TICK_MS, () => {
      void $.clock.now().then(at => update($, now, () => at))
    })

    // Not awaited: the first prompt should not wait on the network.
    void refreshRemote($)
    $.clock.every(REMOTE_EVERY_MS, () => void refreshRemote($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snap, () => toSnapshot(e))
    const t = await $.clock.now()
    await update($, now, () => t)
    const result = await next(e)

    // A window moved: the per-model ones may have too (throttled to once a minute).
    if (e.changed.includes('rateLimits')) {
      await refreshRemote($)
    }

    return result
  })

  // Every turn, subagents' included, so the totals line up with the cost.
  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      await update($, tokens, (sum: Tokens) => ({
        input: sum.input + u.input_tokens,
        output: sum.output + u.output_tokens,
        cacheRead: sum.cacheRead + u.cache_read_input_tokens,
        cacheWrite: sum.cacheWrite + u.cache_creation_input_tokens,
      }))
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, tokens, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))
    }

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    let isNowHidden = false
    await update($, isHidden, hidden => (isNowHidden = !hidden))

    return { text: isNowHidden ? 'Usage bar hidden.' : 'Usage bar shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const s = await read($, snap)
    const r = await read($, remote)
    const t = await read($, tokens)
    const at = (await read($, now)) || (await $.clock.now())

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

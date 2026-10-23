import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoApproved } from '../types'

const isOn = atom({ plugin: 'auto-allow', key: 'isOn' } as const, true)
const allowed = atom({ plugin: 'auto-allow', key: 'allowed' } as const, 0)
const recent = atom({ plugin: 'auto-allow', key: 'recent' } as const, [] as AutoApproved[])
const isDrawerOpen = atom({ plugin: 'auto-allow', key: 'isDrawerOpen' } as const, false)
const isComputerUseOn = atom({ plugin: 'auto-allow', key: 'isComputerUseOn' } as const, true)

// How many approvals the drawer keeps, and shows when open.
const KEEP = 50
const SHOW = 8

// Prompts that are questions for you, not permission checks: auto-answering them makes no sense.
const NEVER_AUTO = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Bash commands that still get the normal prompt, even with auto-allow on.
const DANGEROUS = [
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, // rm -rf / or ~
  /\bmkfs\b|\bdd\s+.*\bof=\/dev\//, // wiping disks
  /\bgit\s+push\b.*(--force|-f\b)/, // force-push
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
]

// Computer-use access is asked on a card of the desktop app's own, which no permission hook
// sees: a helper waits for the card showing the call's reason and presses its ⌘↩ (Allow for
// this session). It prints `approved <how>` or `failed <why>`, and ticks on stderr while it waits.
const CU_ACCESS = 'mcp__computer-use__request_access'
const APPROVE_SCRIPT = 'scripts/approve-access-card.js'
const HOW_APPROVED: Record<string, string> = {
  shortcut: 'pressed ⌘↩ on its card',
  click: 'clicked Allow on its card',
}

// Every prompt the mod saw, one JSON line each, kept to the last MAX_LINES.
const LOG_PATH = '.claude/auto-allow/log.jsonl'
const MAX_LINES = 2000

type LogEntry = {
  time: string
  session: string
  cwd: string
  tool: string
  what: string
  decision: 'allowed' | 'asked-you'
  why?: string
}

// What the prompt was about, short and without file contents.
const summarize = (input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = i.command ?? i.file_path ?? i.notebook_path ?? i.url ?? i.path
  const text = typeof pick === 'string' ? pick : JSON.stringify(input ?? {})
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const logFile = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? '~'}/${LOG_PATH}`

const readLog = async ($: EngineInterface): Promise<LogEntry[]> => {
  const path = await logFile($)
  if (!(await $.fs.exists(path))) return []
  const text = await $.fs.read(path)
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as LogEntry)
}

// $.fs has no append: writes run one after another so two prompts can't drop each other's line.
let writing: Promise<void> = Promise.resolve()
const writeLog = ($: EngineInterface, entry: LogEntry) => {
  writing = writing
    .then(async () => {
      const lines = [...(await readLog($)), entry].slice(-MAX_LINES)
      await $.fs.write(await logFile($), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    })
    .catch(() => {})
  return writing
}

// Counts an approval, lists it in the drawer and logs it.
const noteApproved = async ($: EngineInterface, entry: Omit<LogEntry, 'decision'>) => {
  await update($, allowed, v => v + 1)
  await update($, recent, list => [...list, { time: entry.time, tool: entry.tool, what: entry.what }].slice(-KEEP))
  await writeLog($, { ...entry, decision: 'allowed' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-allow',
      description: 'Toggle auto-approval of permission prompts (on | off | status | log | computer on|off)',
    })
    $.ui.status(undefined)

    return next(e)
  })

  on('command.run', { command: 'auto-allow' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()

    if (arg === 'log') {
      const recent = (await readLog($)).slice(-20)
      if (recent.length === 0) return { text: 'Auto-allow log is empty so far.' }
      const rows = recent.map(
        l => `${l.time.slice(5, 16).replace('T', ' ')}  ${l.decision === 'allowed' ? '✓' : '?'} ${l.tool}  ${l.what}${l.why ? `  (${l.why})` : ''}`,
      )
      return { text: [`Last ${recent.length} prompts (full log: ~/${LOG_PATH}):`, ...rows].join('\n') }
    }

    const [word, value] = arg.split(/\s+/)
    if (word === 'computer') await update($, isComputerUseOn, v => (value === 'on' ? true : value === 'off' ? false : !v))
    else if (arg === 'on' || arg === 'off') await update($, isOn, () => arg === 'on')
    else if (arg !== 'status') await update($, isOn, v => !v)

    const now = await read($, isOn)
    const n = await read($, allowed)
    const cards = await read($, isComputerUseOn)

    return {
      text: `Auto-allow is ${now ? 'on' : 'off'} (${n} prompts approved this session); computer-use access cards: ${cards ? 'on' : 'off'}.`,
    }
  })

  // A drawer above the prompt: what auto-allow approved in this session, with Clear.
  // Shown only while it has something to list; it steps aside while a survey holds the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, recent)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const isOpen = await read($, isDrawerOpen)
    const shown = list.slice(-SHOW).reverse()
    const hidden = list.length - shown.length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Button key="drawer" plain dimColor onPress={() => update($, isDrawerOpen, v => !v)}>
            {`${isOpen ? '▾' : '▸'} ${list.length} auto-approved`}
          </Button>
          <Button
            key="clear"
            plain
            dimColor
            onPress={async () => {
              await update($, recent, () => [])
              await update($, isDrawerOpen, () => false)
            }}
          >
            clear
          </Button>
        </Box>
        {isOpen &&
          shown.map(item => (
            <Text dimColor wrap="truncate-end">
              {`  ${item.time.slice(11, 16)}  ${item.tool}  ${item.what}`}
            </Text>
          ))}
        {isOpen && hidden > 0 && <Text dimColor>{`  +${hidden} more: /auto-allow log`}</Text>}
      </Box>
    )
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const base = {
      time: new Date().toISOString(),
      session: e.session_id,
      cwd: e.cwd,
      tool: e.tool_name,
      what: summarize(e.tool_input),
    }
    const askYou = async (why: string) => {
      await writeLog($, { ...base, decision: 'asked-you', why })
      return next(e)
    }

    try {
      if (!(await read($, isOn))) return askYou('auto-allow off')
      if (NEVER_AUTO.has(e.tool_name)) return askYou('needs your answer')

      const command = (e.tool_input as { command?: unknown } | undefined)?.command
      if (typeof command === 'string' && DANGEROUS.some(re => re.test(command))) {
        $.ui.toast(`Auto-allow skipped: ${command.slice(0, 60)}`)
        return askYou('dangerous command')
      }

      await noteApproved($, base)

      return { decision: { behavior: 'allow' } }
    } catch {
      // If anything goes wrong, fall back to the normal prompt.
      return next(e)
    }
  })

  // While a computer-use access call waits on its card, the helper presses it. Once the call
  // settles the loop leaves at the helper's next tick, which kills it.
  on('tool.call', { tool: CU_ACCESS }, async ($, e, next) => {
    if (!(await read($, isOn)) || !(await read($, isComputerUseOn))) return next(e)

    const reason = typeof e.reason === 'string' ? e.reason : ''
    const apps = Array.isArray(e.apps) ? e.apps.filter(app => typeof app === 'string').join(', ') : ''
    const helper = $.process.spawn({ argv: ['osascript', '-l', 'JavaScript', `${$.plugin.root}/${APPROVE_SCRIPT}`, reason] })
    let isSettled = false
    const pressing = (async () => {
      let said = ''
      for await (const { stream, text } of helper) {
        if (stream === 'stdout') said += text
        else if (isSettled) break
      }
      return said.trim()
    })().catch(() => 'failed its helper did not start')
    void pressing.then(said => {
      if (said.startsWith('failed ')) $.ui.toast(`Auto-allow couldn't answer the computer-use card (${said.slice(7)}): answer it yourself`)
    })

    try {
      return await next(e)
    } finally {
      isSettled = true
      const said = await pressing
      const how = said.match(/^approved (\w+)/)?.[1]
      // Noting it down never changes what the call answered.
      try {
        const base = {
          time: new Date().toISOString(),
          session: await $.session.id(),
          cwd: await $.session.cwd(),
          tool: 'computer use',
          what: apps,
        }
        if (how) await noteApproved($, { ...base, why: HOW_APPROVED[how] ?? how })
        else if (said.startsWith('failed ')) await writeLog($, { ...base, decision: 'asked-you', why: said.slice(7) })
      } catch {}
    }
  })
}

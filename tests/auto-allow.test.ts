import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const ASK = { decision: undefined }

test('approves an ordinary prompt', async ($, on) => {
  on('classic.PermissionRequest', () => ASK)
  const r = await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' } })
  expect(r.decision?.behavior).toBe('allow')
})

test('leaves AskUserQuestion to the person', async ($, on) => {
  on('classic.PermissionRequest', () => ASK)
  const r = await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: {} })
  expect(r.decision).toBeUndefined()
})

test('leaves rm -rf / to the person', async ($, on) => {
  on('classic.PermissionRequest', () => ASK)
  const r = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })
  expect(r.decision).toBeUndefined()
})

test('/auto-allow off stops approving', async ($, on) => {
  on('classic.PermissionRequest', () => ASK)
  // the engine stamps origin and presentation itself
  await $.command.run({ command: 'auto-allow', args: 'off' } as Parameters<typeof $.command.run>[0])
  const r = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(r.decision).toBeUndefined()
})

// An in-memory file system, so the test never touches the real log.
const memoryFs = (on: On) => {
  const files = new Map<string, string>()
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  return files
}

test('logs what it approved and what it left for you', async ($, on) => {
  mock.env(on, { HOME: '/home/me' })
  const files = memoryFs(on)
  on('classic.PermissionRequest', () => ASK)

  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: 'a.ts', new_string: 'secret' } })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } })

  const lines = (files.get('/home/me/.claude/auto-allow/log.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => [l.tool, l.decision, l.what])).toEqual([
    ['Edit', 'allowed', 'a.ts'],
    ['Bash', 'asked-you', 'rm -rf ~'],
  ])
  // File contents never reach the log.
  expect(JSON.stringify(lines)).not.toContain('secret')

  const shown = await $.command.run({ command: 'auto-allow', args: 'log' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(shown)).toContain('rm -rf ~')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`leaves the prompt footer to the engine on ${surface}`, async ($, on) => {
    // What the engine draws when the plugin passes: its own mode labels.
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine-footer'] }))
    const footer = await $.ui.mount({ plugin: 'auto-allow', surface, component: 'SessionMode', requestId: 'footer', props: { modes: [] } })

    const drawn = JSON.stringify(await footer.drawn())
    expect(drawn).toContain('engine-footer')
    expect(drawn).not.toContain('"auto"')
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`drawer above the prompt lists approvals and clears on ${surface}`, async ($, on) => {
    on('classic.PermissionRequest', () => ASK)
    // What the engine draws when the plugin passes: an empty band.
    on('ui.render', () => ({ type: 'Text', props: {}, children: [] }))
    const band = { plugin: 'auto-allow', surface, component: 'AbovePrompt', requestId: 'band',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } } as never

    const empty = await $.ui.mount(band)
    expect(JSON.stringify(await empty.drawn())).not.toContain('auto-approved')
    await empty.unmount()

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } })

    const drawer = await $.ui.mount(band)
    expect(JSON.stringify(await drawer.drawn())).toContain('2 auto-approved')
    expect(JSON.stringify(await drawer.drawn())).not.toContain('npm test')

    await drawer.press({ key: 'drawer' })
    const open = JSON.stringify(await drawer.drawn())
    expect(open).toContain('npm test')
    expect(open).toContain('src/a.ts')

    await drawer.press({ key: 'clear' })
    expect(JSON.stringify(await drawer.drawn())).not.toContain('auto-approved')
  })
}

// The desktop app's computer-use access card, as a test stands in for it: the helper says how
// it went, and the call settles.
const fakeCard = (on: On, said: string) => {
  const argvs: string[][] = []
  on('process.spawn', async function* (_$, e) {
    argvs.push([...e.argv])
    yield { stream: 'stdout' as const, text: `${said}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', () => ({ result: { granted: [] } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.toast', () => ({ value: undefined }))
  return argvs
}

const ACCESS = { tool: 'mcp__computer-use__request_access' as const, apps: ['Weather'], reason: 'Check the forecast' }

const logged = (files: Map<string, string>) =>
  (files.get('/home/me/.claude/auto-allow/log.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))

test('presses the computer-use access card and lists it in the drawer', async ($, on) => {
  mock.env(on, { HOME: '/home/me' })
  const files = memoryFs(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }))
  const argvs = fakeCard(on, 'approved shortcut')

  await $.tool.call(ACCESS)

  expect(argvs).toHaveLength(1)
  expect(argvs[0]?.slice(0, 3)).toEqual(['osascript', '-l', 'JavaScript'])
  expect(argvs[0]?.[3]).toEndWith('/scripts/approve-access-card.js')
  expect(argvs[0]?.[4]).toBe('Check the forecast')
  expect(logged(files).map(l => [l.tool, l.decision, l.what, l.why])).toEqual([
    ['computer use', 'allowed', 'Weather', 'pressed ⌘↩ on its card'],
  ])

  const drawer = await $.ui.mount({ plugin: 'auto-allow', surface: 'desktop', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } } as never)
  await drawer.press({ key: 'drawer' })
  const open = JSON.stringify(await drawer.drawn())
  expect(open).toContain('1 auto-approved')
  expect(open).toContain('computer use  Weather')
})

test('`/auto-allow computer off` leaves the computer-use access card to you', async ($, on) => {
  const argvs = fakeCard(on, 'approved shortcut')
  await $.command.run({ command: 'auto-allow', args: 'computer off' } as Parameters<typeof $.command.run>[0])

  await $.tool.call(ACCESS)

  expect(argvs).toHaveLength(0)
})

test('logs a computer-use access card it could not press', async ($, on) => {
  mock.env(on, { HOME: '/home/me' })
  const files = memoryFs(on)
  fakeCard(on, 'failed the screen stayed locked')

  await $.tool.call(ACCESS)

  expect(logged(files).map(l => [l.tool, l.decision, l.why])).toEqual([['computer use', 'asked-you', 'the screen stayed locked']])
})

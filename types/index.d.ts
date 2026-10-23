export type AutoAllowCount = number

/** One prompt the mod approved in this session, as the drawer lists it. */
export type AutoApproved = { time: string; tool: string; what: string }

declare module 'claude-code' {
  interface PluginState {
    'auto-allow': {
      isOn: boolean
      allowed: AutoAllowCount
      recent: AutoApproved[]
      isDrawerOpen: boolean
      isComputerUseOn: boolean
    }
  }
}

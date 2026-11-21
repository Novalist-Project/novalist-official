// Per-project collaboration choices, kept on this device only: the connection type and server picked for a
// project, and whether its saved session reconnects when the project opens. Projects without their own choice
// start from the last connection type and server picked anywhere.
export interface CollaborationPreference { mode?: string; server?: string; autoReconnect?: boolean }

const projectKey = (project: string): string => 'novalist.collaboration.project:' + project
const lastModeKey = 'novalist.collaboration.mode'
const lastServerKey = 'novalist.collaboration.server'

export function readPreference(project: string | null): CollaborationPreference {
  const stored = project ? localStorage.getItem(projectKey(project)) : null
  const own = stored ? JSON.parse(stored) as CollaborationPreference : {}
  return {
    mode: own.mode ?? localStorage.getItem(lastModeKey) ?? undefined,
    server: own.server ?? localStorage.getItem(lastServerKey) ?? undefined,
    autoReconnect: own.autoReconnect ?? true
  }
}

export function writePreference(project: string | null, change: CollaborationPreference): void {
  if (change.mode) localStorage.setItem(lastModeKey, change.mode)
  if (change.server) localStorage.setItem(lastServerKey, change.server)
  if (!project) return
  const stored = localStorage.getItem(projectKey(project))
  localStorage.setItem(projectKey(project), JSON.stringify({ ...(stored ? JSON.parse(stored) : {}), ...change }))
}

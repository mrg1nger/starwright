import { shell } from 'electron'
import { mkdirSync } from 'fs'
import { ipc } from '../remote/bus'
import { updateSettings } from '../settings/store'
import { callPlugin } from './calls'
import { addExamplePlugin, approvePlugin, closeAllPanels, closePanel, leaveSafeMode, listPlugins, openPanel, setPluginOff } from './registry'
import { pluginRuns, runPluginCommand, stopPluginCommand } from './runtime'

/**
 * Plugins, from Starwright's screens. Approving, turning on and off, pausing and adding examples are
 * for the computer only; over Remote a device can list plugins, open panels and (with full access)
 * run their commands (see remote/auth.ts).
 */
export function registerPluginHandlers(sendSettings: (settings: unknown) => void): void {
  ipc.handle('vibe:plugins:list', (_event, projectId: string) => listPlugins(String(projectId)))
  ipc.handle('vibe:plugins:approve', (_event, projectId: string, key: string, hash: string) => approvePlugin(String(projectId), String(key), String(hash)))
  ipc.handle('vibe:plugins:setOff', (_event, projectId: string, key: string, off: boolean) => setPluginOff(String(projectId), String(key), !!off))
  ipc.handle('vibe:plugins:addExample', (_event, name?: string) => addExamplePlugin(name ? String(name) : undefined))
  ipc.handle('vibe:plugins:openPanel', (_event, projectId: string, key: string, panelId: string) => openPanel(String(projectId), String(key), String(panelId)))
  ipc.handle('vibe:plugins:closePanel', (_event, token: string) => closePanel(String(token)))
  ipc.handle('vibe:plugins:call', (_event, token: string, method: string, args: unknown[]) => callPlugin(token, method, args))
  ipc.handle('vibe:plugins:run', (_event, projectId: string, key: string, command: string) => runPluginCommand(String(projectId), String(key), String(command), 'button'))
  ipc.handle('vibe:plugins:stop', (_event, projectId: string, key: string) => stopPluginCommand(String(projectId), String(key)))
  ipc.handle('vibe:plugins:runs', (_event, projectId: string, key: string) => pluginRuns(String(projectId), String(key)))
  ipc.handle('vibe:plugins:setPaused', (_event, paused: boolean) => {
    if (!paused) leaveSafeMode()
    else closeAllPanels()
    sendSettings(updateSettings({ pluginsPaused: !!paused }))
  })
  ipc.handle('vibe:plugins:openFolder', async (_event, projectId: string, which: 'project' | 'global') => {
    const list = listPlugins(String(projectId))
    const folder = which === 'global' ? list.globalFolder : list.projectFolder
    mkdirSync(folder, { recursive: true })
    const problem = await shell.openPath(folder)
    if (problem) throw new Error(problem)
  })
}

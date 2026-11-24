import { shell } from 'electron'
import { mkdirSync } from 'fs'
import { ipc } from '../remote/bus'
import { callPlugin } from './calls'
import { addExamplePlugin, approvePlugin, closePanel, listPlugins, openPanel, setPluginOff } from './registry'

/** Plugins, from Starwright's own screen. All of them are for the computer only (see remote/auth.ts). */
export function registerPluginHandlers(): void {
  ipc.handle('vibe:plugins:list', (_event, projectId: string) => listPlugins(String(projectId)))
  ipc.handle('vibe:plugins:approve', (_event, projectId: string, key: string, hash: string) => approvePlugin(String(projectId), String(key), String(hash)))
  ipc.handle('vibe:plugins:setOff', (_event, projectId: string, key: string, off: boolean) => setPluginOff(String(projectId), String(key), !!off))
  ipc.handle('vibe:plugins:addExample', () => addExamplePlugin())
  ipc.handle('vibe:plugins:openPanel', (_event, projectId: string, key: string, panelId: string) => openPanel(String(projectId), String(key), String(panelId)))
  ipc.handle('vibe:plugins:closePanel', (_event, token: string) => closePanel(String(token)))
  ipc.handle('vibe:plugins:call', (_event, token: string, method: string, args: unknown[]) => callPlugin(token, method, args))
  ipc.handle('vibe:plugins:openFolder', async (_event, projectId: string, which: 'project' | 'global') => {
    const list = listPlugins(String(projectId))
    const folder = which === 'global' ? list.globalFolder : list.projectFolder
    mkdirSync(folder, { recursive: true })
    const problem = await shell.openPath(folder)
    if (problem) throw new Error(problem)
  })
}

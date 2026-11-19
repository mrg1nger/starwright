import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface ProjectTerminalProps {
  projectId: string
  /** Whether the drawer is open: the terminal is fitted (and focused) when it opens. */
  open: boolean
  onError: (message: string) => void
}

/** The theme's colors, read from the page, so the terminal matches it. */
function themeColors(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    background: v('--surface-sunken', '#0d0f14'),
    foreground: v('--text', '#e8e8ec'),
    cursor: v('--accent', '#5b7cfa'),
    selectionBackground: 'rgba(128, 160, 255, 0.35)'
  }
}

/**
 * A command line in the project folder (PowerShell on Windows). The shell keeps running in
 * Starwright when this is folded away or another screen opens; coming back shows its recent output.
 */
function ProjectTerminal({ projectId, open, onError }: ProjectTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const [started, setStarted] = useState(false)

  const fit = (): void => {
    const term = termRef.current
    const container = containerRef.current
    if (!term || !fitRef.current || !container || container.offsetParent === null) return
    try {
      fitRef.current.fit()
    } catch {
      return
    }
    if (idRef.current) window.vibe.terminal.resize(idRef.current, term.cols, term.rows)
  }

  const attach = async (restart: boolean): Promise<void> => {
    const term = termRef.current
    if (!term) return
    try {
      const { id, backlog } = await (restart
        ? window.vibe.terminal.restart(projectId, term.cols, term.rows)
        : window.vibe.terminal.open(projectId, term.cols, term.rows))
      idRef.current = id
      term.reset()
      if (backlog) term.write(backlog)
      setExited(null)
      fit()
      term.focus()
    } catch (err) {
      onError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  // The terminal (and its shell) is started the first time the drawer opens.
  useEffect(() => {
    if (open && !started) setStarted(true)
  }, [open, started])

  useEffect(() => {
    if (!started) return
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      cursorBlink: true,
      scrollback: 5000,
      theme: themeColors()
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(container)
    termRef.current = term
    fitRef.current = fitAddon
    try {
      fitAddon.fit()
    } catch {
      // not laid out yet; the observer fits it
    }

    const input = term.onData((data) => {
      if (idRef.current) window.vibe.terminal.write(idRef.current, data)
    })
    const unsubData = window.vibe.terminal.onData((id, data) => {
      if (id === idRef.current) term.write(data)
    })
    const unsubExit = window.vibe.terminal.onExit((id, code) => {
      if (id === idRef.current) setExited(code)
    })
    const observer = new ResizeObserver(() => fit())
    observer.observe(container)
    void attach(false)

    return () => {
      observer.disconnect()
      input.dispose()
      unsubData()
      unsubExit()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      idRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, projectId])

  useEffect(() => {
    if (!open) return
    // After the drawer has its height.
    const t = setTimeout(() => {
      fit()
      termRef.current?.focus()
    }, 50)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <div className="project-terminal">
      <div ref={containerRef} className="project-terminal-screen" />
      {exited !== null && (
        <div className="project-terminal-ended">
          The command line ended{exited ? ` (exit code ${exited})` : ''}.{' '}
          <button onClick={() => void attach(true)}>Start a new one</button>
        </div>
      )}
    </div>
  )
}

export default ProjectTerminal

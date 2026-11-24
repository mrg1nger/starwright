import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectFileContent, ProjectFileList } from '@shared/types'
import { buildTree, CHANGE_WORDS, filterFiles, formatSize, isMarkdownFile, languageFor, type FileNode } from '@shared/fileTree'
import { highlightCode } from '../lib/highlight'
import Markdown from './Markdown'

const inBrowser = window.vibe.host === 'browser'

/** A path kept left-to-right inside a box that cuts it at the start (direction: rtl), so its slashes stay put. */
const ltr = (text: string): string => `\u200E${text}\u200E`

interface Props {
  projectId: string
  /** Changes when a request ends or changes are undone: the list and the open file load again. */
  refreshToken: number
  /** Puts the file's path in the message box. */
  onMention: (path: string) => void
}

/** The project's files, read-only: a tree (or a filtered list), and the chosen file's contents. */
export default function FilesPane({ projectId, refreshToken, onMention }: Props) {
  const [list, setList] = useState<ProjectFileList | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<ProjectFileContent | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [reload, setReload] = useState(0)

  // Another project: start again.
  useEffect(() => {
    setList(null)
    setExpanded(new Set())
    setQuery('')
    setSelected(null)
  }, [projectId])

  useEffect(() => {
    let current = true
    window.vibe.files
      .list(projectId)
      .then((l) => {
        if (!current) return
        setList(l)
        setListError(null)
      })
      .catch((err: Error) => current && setListError(err.message))
    return () => {
      current = false
    }
  }, [projectId, refreshToken, reload])

  useEffect(() => {
    if (!selected) {
      setContent(null)
      setContentError(null)
      return
    }
    let current = true
    window.vibe.files
      .read(projectId, selected)
      .then((c) => {
        if (!current) return
        setContent(c)
        setContentError(null)
      })
      .catch((err: Error) => {
        if (!current) return
        setContent(null)
        setContentError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      })
    return () => {
      current = false
    }
  }, [projectId, selected, refreshToken, reload])

  const tree = useMemo(() => (list ? buildTree(list.files, list.changed) : []), [list])
  const matches = useMemo(() => (list && query.trim() ? filterFiles(list.files, query) : null), [list, query])
  const changedCount = useMemo(() => (list ? list.files.filter((f) => list.changed[f]).length : 0), [list])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const openFile = useCallback((path: string) => {
    setContent(null)
    setContentError(null)
    setSelected(path)
    setShowRaw(false)
  }, [])

  if (selected) {
    return (
      <div className="files-pane">
        <FileView
          path={selected}
          content={content}
          error={contentError}
          change={list?.changed[selected]}
          showRaw={showRaw}
          onShowRaw={setShowRaw}
          onBack={() => setSelected(null)}
          onMention={() => onMention(selected)}
          onOpen={() => window.vibe.files.open(projectId, selected).catch((err: Error) => setContentError(err.message))}
        />
      </div>
    )
  }

  return (
    <div className="files-pane">
      <div className="files-bar">
        <input
          className="files-filter"
          type="search"
          placeholder="Find a file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find a file by name"
        />
        <button onClick={() => setReload((n) => n + 1)} title="Load the list again" aria-label="Refresh the file list">
          ↻
        </button>
      </div>
      {list && (
        <div className="files-summary">
          {list.files.length.toLocaleString()} files
          {changedCount > 0 && ` · ${changedCount} changed since the last checkpoint`}
          {list.truncated && ' · only the first ones are listed'}
        </div>
      )}
      <div className="files-tree" role="tree" aria-label="Project files">
        {listError && <div className="files-empty">Couldn't list the files: {listError}</div>}
        {!list && !listError && <div className="files-empty">Loading…</div>}
        {list && !list.files.length && <div className="files-empty">This project has no files yet.</div>}
        {matches
          ? matches.length
            ? matches.map((path) => (
                <button key={path} className="file-row file-match" role="treeitem" onClick={() => openFile(path)} title={path}>
                  <span className="file-name">{path.slice(path.lastIndexOf('/') + 1)}</span>
                  <span className="file-dir">{path.includes('/') ? ltr(path.slice(0, path.lastIndexOf('/'))) : ''}</span>
                  <ChangeDot change={list?.changed[path]} />
                </button>
              ))
            : <div className="files-empty">No file matches “{query.trim()}”.</div>
          : tree.map((node) => <TreeRow key={node.path} node={node} depth={0} expanded={expanded} onToggle={toggle} onOpen={openFile} />)}
      </div>
    </div>
  )
}

function ChangeDot({ change, count }: { change?: string; count?: number }) {
  if (!change && !count) return null
  const title = count ? `${count} changed inside since the last checkpoint` : CHANGE_WORDS[change as keyof typeof CHANGE_WORDS]
  return <span className={`file-change-dot${change === 'untracked' || change === 'added' ? ' new' : ''}`} title={title} aria-label={title} />
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpen
}: {
  node: FileNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const indent = { paddingLeft: `${0.5 + depth * 0.9}rem` }
  if (!node.children) {
    return (
      <button className="file-row" role="treeitem" style={indent} onClick={() => onOpen(node.path)} title={node.path}>
        <span className="file-icon" aria-hidden="true" />
        <span className="file-name">{node.name}</span>
        <ChangeDot change={node.change} />
      </button>
    )
  }
  const open = expanded.has(node.path)
  return (
    <>
      <button className="file-row file-folder" role="treeitem" aria-expanded={open} style={indent} onClick={() => onToggle(node.path)} title={node.path}>
        <span className="file-icon" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="file-name">{node.name}</span>
        <ChangeDot count={node.changedInside} />
      </button>
      {open && node.children.map((child) => <TreeRow key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />)}
    </>
  )
}

function FileView({
  path,
  content,
  error,
  change,
  showRaw,
  onShowRaw,
  onBack,
  onMention,
  onOpen
}: {
  path: string
  content: ProjectFileContent | null
  error: string | null
  change?: string
  showRaw: boolean
  onShowRaw: (raw: boolean) => void
  onBack: () => void
  onMention: () => void
  onOpen: () => void
}) {
  const markdown = isMarkdownFile(path) && content?.kind === 'text'
  return (
    <>
      <div className="files-bar file-view-bar">
        <button onClick={onBack} title="Back to the list of files">
          ← Files
        </button>
        <span className="file-path" title={path}>
          {ltr(path)}
        </span>
        <ChangeDot change={change} />
      </div>
      <div className="file-actions">
        {content && <span className="file-size">{formatSize(content.size)}</span>}
        {markdown && (
          <button onClick={() => onShowRaw(!showRaw)} title={showRaw ? 'Show it formatted' : 'Show the Markdown text'}>
            {showRaw ? 'Formatted' : 'Text'}
          </button>
        )}
        <button onClick={onMention} title="Put this file's path in the message box, to ask about it">
          💬 Mention in chat
        </button>
        {!inBrowser && (
          <button onClick={onOpen} title="Open it in its own program on this computer">
            Open in editor
          </button>
        )}
      </div>
      <div className="file-body">
        {error && <div className="files-empty">{error}</div>}
        {!error && !content && <div className="files-empty">Loading…</div>}
        {content?.kind === 'secret' && (
          <div className="files-empty">This kind of file usually holds passwords or keys, so it isn't shown here.</div>
        )}
        {content?.kind === 'binary' && <div className="files-empty">Not a text file ({formatSize(content.size)}), so there's nothing to show.</div>}
        {content?.kind === 'image' && (
          <div className="file-image">
            <img src={content.dataUrl} alt={path} />
          </div>
        )}
        {content?.kind === 'text' &&
          (markdown && !showRaw ? (
            <div className="file-markdown">
              <Markdown text={content.text} />
            </div>
          ) : (
            <Code text={content.text} path={path} />
          ))}
        {content?.kind === 'text' && content.truncated && (
          <div className="files-empty">The file is {formatSize(content.size)}: only its start is shown.</div>
        )}
      </div>
    </>
  )
}

function Code({ text, path }: { text: string; path: string }) {
  const html = useMemo(() => highlightCode(text, languageFor(path)), [text, path])
  const lines = useMemo(() => {
    const n = text.split('\n').length
    return Array.from({ length: n }, (_, i) => i + 1).join('\n')
  }, [text])
  return (
    <div className="file-code">
      <pre className="file-lines" aria-hidden="true">
        {lines}
      </pre>
      <pre className="file-text hljs">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

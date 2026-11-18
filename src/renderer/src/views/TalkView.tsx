import { useCallback, useEffect, useRef, useState } from 'react'
import type { TalkAgent, TalkAgentsReady, TalkConversation, TalkSummary } from '@shared/types'
import Markdown from '../components/Markdown'

interface TalkViewProps {
  onError: (message: string) => void
}

const AGENT_PREF_KEY = 'vibeapp.talkAgent'

const ALL_AGENTS: TalkAgent[] = ['claude', 'codex', 'cline', 'local']

function readAgentPref(): TalkAgent {
  try {
    const saved = localStorage.getItem(AGENT_PREF_KEY) as TalkAgent | null
    return saved && ALL_AGENTS.includes(saved) ? saved : 'claude'
  } catch {
    return 'claude'
  }
}

function newId(): string {
  return crypto.randomUUID()
}

const AGENT_NAMES: Record<TalkAgent, string> = { claude: 'Claude', codex: 'Codex', cline: 'Cline', local: 'Local model' }
/** The name inside a sentence ("Ask the local model anything…"). */
const inSentence = (a: TalkAgent): string => (a === 'local' ? 'the local model' : AGENT_NAMES[a])
const AGENT_TIPS: Record<TalkAgent, string> = {
  claude: "Send your next message to Claude (your Claude plan)",
  codex: 'Send your next message to Codex (your ChatGPT plan)',
  cline: 'Send your next message to Cline (your ClinePass plan)',
  local: 'Send your next message to the local model in LM Studio (free, on this computer)'
}

/** A general chat that isn't tied to any project, with Claude, Codex, Cline or the local model answering. */
function TalkView({ onError }: TalkViewProps) {
  const [list, setList] = useState<TalkSummary[]>([])
  const [activeId, setActiveId] = useState<string>(newId)
  const [conversation, setConversation] = useState<TalkConversation | null>(null)
  const [chosen, setAgent] = useState<TalkAgent>(readAgentPref)
  // Cline and the local model are offered only when they're set up (null: still looking).
  const [ready, setReady] = useState<TalkAgentsReady | null>(null)
  useEffect(() => {
    window.vibe.talk.agents().then(setReady).catch(() => setReady({ cline: false, local: false }))
  }, [])
  const offered = ALL_AGENTS.filter((a) => (a === 'cline' || a === 'local' ? (ready ? ready[a] : a === chosen) : true))
  const agent: TalkAgent = offered.includes(chosen) ? chosen : 'claude'
  const [input, setInput] = useState('')
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const refreshList = useCallback(() => {
    window.vibe.talk.list().then(setList).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshList()
  }, [refreshList])

  useEffect(() => {
    let cancelled = false
    window.vibe.talk
      .load(activeId)
      .then((c) => {
        if (!cancelled) setConversation(c)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeId])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [conversation, pendingText, busy])

  const chooseAgent = (next: TalkAgent): void => {
    setAgent(next)
    try {
      localStorage.setItem(AGENT_PREF_KEY, next)
    } catch {
      // A remembered preference only.
    }
  }

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    const id = activeId
    setInput('')
    setPendingText(text)
    setBusy(true)
    try {
      const updated = await window.vibe.talk.send(id, text, agent)
      setConversation(updated)
      refreshList()
    } catch (err) {
      const message = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (message !== 'Stopped.') onError(message)
      // The question was saved even though the answer wasn't: show it.
      window.vibe.talk.load(id).then(setConversation).catch(() => undefined)
      refreshList()
    } finally {
      setPendingText(null)
      setBusy(false)
    }
  }, [input, busy, activeId, agent, onError, refreshList])

  const messages = conversation?.messages ?? []

  return (
    <div className="talk-view">
      <aside className="talk-sidebar">
        <button
          onClick={() => {
            setActiveId(newId())
            setConversation(null)
          }}
          disabled={busy}
        >
          + New chat
        </button>
        {list.map((c) => (
          <button
            key={c.id}
            className={`talk-conv ${c.id === activeId ? 'active' : ''}`}
            disabled={busy}
            title={c.title}
            onClick={() => setActiveId(c.id)}
          >
            {c.title}
          </button>
        ))}
        {conversation && list.some((c) => c.id === activeId) && (
          <button
            className="chat-inline-action"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Delete this conversation?')) return
              await window.vibe.talk.delete(activeId).catch(() => undefined)
              setActiveId(newId())
              setConversation(null)
              refreshList()
            }}
          >
            Delete this chat
          </button>
        )}
      </aside>

      <div className="talk-main">
        <div className="talk-log" ref={logRef}>
          {messages.length === 0 && !pendingText && (
            <div className="talk-empty">
              <h2>Ask anything</h2>
              <p>
                A plain chat with no project attached, for questions, ideas and drafts. Pick who answers below
                {offered.length > 2 ? ` (${offered.map((a) => AGENT_NAMES[a]).join(', ')})` : ' (Claude or Codex)'}, and switch
                whenever you like: the conversation carries over.
              </p>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="talk-msg talk-msg-user">
                {m.text}
              </div>
            ) : (
              <div key={i} className="talk-msg">
                <span className="talk-msg-who">{AGENT_NAMES[m.agent ?? 'claude']}</span>
                <Markdown text={m.text} />
              </div>
            )
          )}
          {pendingText && <div className="talk-msg talk-msg-user">{pendingText}</div>}
          {busy && <div className="chat-item chat-item-thinking">{agent === 'local' ? 'The local model' : AGENT_NAMES[agent]} is thinking…</div>}
        </div>

        <div className="talk-compose">
          <div className="chat-mode-switch" role="group" aria-label="Who answers">
            {offered.map((a) => (
              <button
                key={a}
                className={agent === a ? 'active' : ''}
                onClick={() => chooseAgent(a)}
                title={AGENT_TIPS[a]}
              >
                {AGENT_NAMES[a]}
              </button>
            ))}
          </div>
          <div className="chat-input-row">
            <textarea
              className="chat-input"
              rows={1}
              value={input}
              disabled={busy}
              placeholder={`Ask ${inSentence(agent)} anything…`}
              title="Enter to send · Shift+Enter for a new line"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            {busy ? (
              <button className="chat-stop" onClick={() => window.vibe.talk.stop(activeId)}>
                ■ Stop
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default TalkView

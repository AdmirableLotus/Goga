import React, { useMemo, useState } from 'react'
import type { ToolReference, ToolVerdict } from '../../shared/toolboxTypes'
import { Card, Chip, Field } from '../components/ui'

/**
 * Toolbox — the security-tool reference, with the verdict that decides whether a command may
 * be pointed at someone else's machine.
 *
 * Everything here is text: transcribed sheets, a verdict, and links to the tool's own docs.
 * There is no run button and nothing behind one; the only request in the Security area is the
 * single GET the page above approves.
 */

export const VERDICT_TEXT: Record<ToolVerdict, string> = {
  ALLOWED_UNDER_SCOPE: 'Allowed under scope',
  NEEDS_PROGRAM_PERMISSION: 'Needs explicit program permission',
  NEVER: 'Never',
}

const VERDICT_TONE: Record<ToolVerdict, 'ok' | 'warn' | 'bad'> = {
  ALLOWED_UNDER_SCOPE: 'ok',
  NEEDS_PROGRAM_PERMISSION: 'warn',
  NEVER: 'bad',
}

const FILTERS: { id: ToolVerdict | 'all'; label: string }[] = [
  { id: 'all', label: 'All tools' },
  { id: 'ALLOWED_UNDER_SCOPE', label: 'Allowed under scope' },
  { id: 'NEEDS_PROGRAM_PERMISSION', label: 'Needs explicit program permission' },
  { id: 'NEVER', label: 'Never' },
]

/** Every line matching the search: a section heading, a command, or one of the verdict sentences. */
function matches(t: ToolReference, q: string): boolean {
  if (!q) return true
  const hay = [
    t.name, t.id, t.what, t.verdict, VERDICT_TEXT[t.verdict], t.verdictReason, t.usefulPart, t.bannedPart,
    t.needs.join(' '),
    ...t.sections.flatMap(s => [s.heading, ...s.commands.map(c => `${c.flag ?? ""} ${c.command} ${c.description}`)]),
  ].join(' ').toLowerCase()
  return q.split(/\s+/).every(term => hay.includes(term))
}

export function ToolboxSection({ catalog, unreadable }: {
  catalog: { note: string; tools: ToolReference[] } | null
  unreadable: { tool: string; detail: string }[]
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ToolVerdict | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (catalog?.tools ?? []).filter(t => (filter === 'all' || t.verdict === filter) && matches(t, q)),
    [catalog, filter, q],
  )
  const count = (v: ToolVerdict) => (catalog?.tools ?? []).filter(t => t.verdict === v).length

  return (
    <Card
      title={`Toolbox — ${catalog?.tools.length ?? 0} tools from your cheat sheets`}
      sub="What each tool is for, the commands as your sheets print them, what it needs — and the verdict that decides whether it may be pointed at anything."
    >
      <div className="g-inset" style={{ marginBottom: 12 }}>
        {catalog?.note.split('\n\n').map((p, i) => (
          <p key={i} style={{ margin: i ? '8px 0 0' : 0, fontSize: 'var(--fs-caption)' }}>{p}</p>
        ))}
      </div>

      <div className="g-row" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
        <Field label="Search tools" hint="A name, a command, or a word like “hash”, “deauth”, “subdomain”.">
          <input
            className="g-input g-input--xl"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="nmap, subfinder, pass-the-hash, crack"
            aria-label="Search the toolbox"
          />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {FILTERS.map(f => (
          <button
            key={f.id}
            className={filter === f.id ? 'g-btn g-btn--sm' : 'g-btn g-btn--ghost g-btn--sm'}
            onClick={() => setFilter(f.id)}
          >
            {f.label}{f.id !== 'all' ? ` (${count(f.id)})` : ''}
          </button>
        ))}
        <span className="g-caption g-faint" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
          {shown.length} of {catalog?.tools.length ?? 0} shown
        </span>
      </div>

      {shown.length === 0 && <p className="g-caption">Nothing matches that. Try a tool name, a flag, or a need like “capture file”.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map(t => (
          <ToolCard key={t.id} tool={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
        ))}
      </div>

      {unreadable.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="g-section-title">Lines that were not fully legible on the sheets</div>
          <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>
            {unreadable.map(u => <li key={u.tool}><strong>{u.tool}</strong> — {u.detail}</li>)}
          </ul>
        </div>
      )}
    </Card>
  )
}

function ToolCard({ tool, open, onToggle }: { tool: ToolReference; open: boolean; onToggle: () => void }) {
  const commandCount = tool.sections.reduce((n, s) => n + s.commands.length, 0)
  return (
    <div className="g-inset" style={{ padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button className="g-btn g-btn--ghost g-btn--sm" onClick={onToggle} aria-expanded={open}>
          {open ? '▾' : '▸'} {tool.name}
        </button>
        <Chip tone={VERDICT_TONE[tool.verdict]}>{VERDICT_TEXT[tool.verdict]}</Chip>
        <span className="g-caption g-faint">{commandCount} commands · needs {tool.needs.join(', ')}</span>
      </div>
      <p className="g-caption" style={{ margin: '6px 0 2px' }}>{tool.what}</p>
      <p className="g-caption" style={{ margin: 0 }}>
        <strong>Why {VERDICT_TEXT[tool.verdict].toLowerCase()}:</strong> {tool.verdictReason}
      </p>

      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div className="g-section-title">Useful on a bounty</div>
            <p className="g-caption" style={{ margin: '2px 0' }}>{tool.usefulPart}</p>
            <div className="g-section-title">Gets the account banned or the person arrested</div>
            <p className="g-caption" style={{ margin: '2px 0' }}>{tool.bannedPart}</p>
          </div>
          {tool.sections.map(s => (
            <div key={s.heading}>
              <div className="g-section-title">{s.heading}</div>
              <div className="g-inset g-mono" style={{ fontSize: 11.5, maxHeight: 320, overflowY: 'auto' }}>
                {s.commands.map((c, i) => (
                  <div
                    key={`${c.command}-${i}`}
                    className={c.bannedPath ? 'g-tool-cmd g-tool-cmd--banned' : 'g-tool-cmd'}
                    data-banned={c.bannedPath ? 'true' : undefined}
                  >
                    <span className="g-mono g-tool-cmd-flag">{c.command}</span>
                    <span className="g-caption g-tool-cmd-desc">
                      — {c.description}{c.bannedPath ? ' · banned half' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div>
            <div className="g-section-title">The tool&apos;s own documentation</div>
            <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 16 }}>
              {tool.docs.map(d => <li key={d.url}><a href={d.url} target="_blank" rel="noreferrer">{d.title}</a></li>)}
            </ul>
            <p className="g-caption g-faint" style={{ margin: 0 }}>
              The command descriptions above are your cheat sheet&apos;s wording (sheet {tool.sheet}), not the vendor&apos;s documentation.
            </p>
            <p className="g-caption g-faint" style={{ margin: '4px 0 0' }}>
              These links open in your default browser. For security work, read them in Firefox rather than the browser
              holding your signed-in accounts.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

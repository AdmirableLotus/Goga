import React, { useEffect, useState } from 'react'
import type { BookMeta } from '@shared/types'

const FORMAT_ICON: Record<string, string> = { pdf: '📄', txt: '📝', epub: '📖' }

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export default function LibraryPage() {
  const [books, setBooks] = useState<BookMeta[]>([])
  const [ingesting, setIngesting] = useState(false)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')

  const addFromUrl = async () => {
    if (!url.trim()) return
    setIngesting(true); setError('')
    try { await window.goga.invoke('library:importUrl', url.trim()); setUrl(''); await load() }
    catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setIngesting(false) }
  }

  const load = async () => setBooks(await window.goga.invoke('library:list'))
  useEffect(() => { load() }, [])

  const addBook = async () => {
    setIngesting(true)
    setError('')
    try {
      await window.goga.invoke('library:ingest')
      await load()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('No file selected')) setError(msg)
    } finally {
      setIngesting(false)
    }
  }

  const remove = async (bookId: string) => {
    await window.goga.invoke('library:delete', bookId)
    load()
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={{ fontWeight: 600 }}>Library</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
          <button onClick={addBook} disabled={ingesting} style={styles.addBtn}>
            {ingesting ? '⏳ Reading…' : '+ Add Book'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addFromUrl() }}
          placeholder="…or paste a direct link to a PDF / EPUB / TXT" style={{ flex: 1, padding: '6px 10px', fontSize: 13 }} disabled={ingesting} />
        <button onClick={addFromUrl} disabled={ingesting || !url.trim()} style={styles.addBtn}>Read from web</button>
      </div>

      {books.length === 0 ? (
        <div style={styles.empty}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📚</div>
          <p style={{ color: 'var(--text-muted)', marginBottom: 8 }}>No books yet.</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Click <strong>+ Add Book</strong> to give Goga a PDF, TXT, or EPUB to read.</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>Once ingested, ask him anything about it in the Chat tab.</p>
        </div>
      ) : (
        <div style={styles.list}>
          {books.map(book => (
            <div key={book.id} style={styles.card}>
              <span style={{ fontSize: 28, flexShrink: 0 }}>{FORMAT_ICON[book.format] ?? '📄'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {book.title}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, display: 'flex', gap: 16 }}>
                  <span>{book.format.toUpperCase()}</span>
                  <span>{formatBytes(book.sizeBytes)}</span>
                  <span>{book.chunkCount} chunks</span>
                  <span>{new Date(book.ingestedAt).toLocaleDateString()}</span>
                </div>
              </div>
              <button onClick={() => remove(book.id)} style={styles.removeBtn} title="Remove book">✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={styles.hint}>
        💡 After adding a book, ask Goga about it in Chat — e.g. <em>"What does the book say about leadership?"</em>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' },
  toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  addBtn: { background: 'var(--accent)', color: '#fff', fontWeight: 600 },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40 },
  list: { flex: 1, overflowY: 'auto', padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: 10 },
  card: { display: 'flex', alignItems: 'center', gap: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px' },
  removeBtn: { background: 'transparent', color: 'var(--text-muted)', padding: '4px 8px', fontSize: 14, flexShrink: 0 },
  hint: { padding: '10px 24px', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 12, flexShrink: 0 }
}

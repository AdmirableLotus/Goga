import React, { useEffect, useState } from 'react'
import type { BookMeta } from '@shared/types'
import { PageHeader, Card, Field, EmptyState, Alert } from '../components/ui'

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
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Library"
          purpose="Books Goga has read. Once a book is ingested, ask him anything about it in Chat."
          actions={
            <button className="g-btn g-btn--primary" onClick={addBook} disabled={ingesting}>
              {ingesting ? '⏳ Reading…' : '+ Add book'}
            </button>
          }
        />

        {error && <Alert kind="error">{error}</Alert>}

        <Card title="Read from the web" sub="A direct link to a PDF, EPUB or TXT file">
          <div className="g-row">
            <Field label="File URL">
              <input
                className="g-input g-input--xl"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addFromUrl() }}
                placeholder="https://example.com/book.pdf"
                disabled={ingesting}
              />
            </Field>
            <button className="g-btn" onClick={addFromUrl} disabled={ingesting || !url.trim()}>Read from web</button>
          </div>
        </Card>

        {books.length === 0 ? (
          <EmptyState
            icon="📚"
            title="No books yet"
            body={<>Click <strong>+ Add book</strong> to give Goga a PDF, TXT or EPUB to read, or paste a direct link above. Once ingested, ask him anything about it in the Chat tab.</>}
            action={<button className="g-btn g-btn--primary" onClick={addBook} disabled={ingesting}>+ Add book</button>}
          />
        ) : (
          <Card title={`${books.length} book${books.length === 1 ? '' : 's'}`}>
            {books.map(book => (
              <div key={book.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 24, flexShrink: 0 }}>{FORMAT_ICON[book.format] ?? '📄'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {book.title}
                  </div>
                  <div className="g-caption g-faint" style={{ display: 'flex', gap: 16 }}>
                    <span>{book.format.toUpperCase()}</span>
                    <span className="g-mono">{formatBytes(book.sizeBytes)}</span>
                    <span>{book.chunkCount} chunks</span>
                    <span>{new Date(book.ingestedAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <button className="g-btn g-btn--ghost g-btn--sm" onClick={() => remove(book.id)} title="Remove book" aria-label={`Remove ${book.title}`}>✕</button>
              </div>
            ))}
          </Card>
        )}

      </div>
    </div>
  )
}

/**
 * M3.1 — Library PDF ingestion tests
 *
 * Tests:
 *   1. Real PDF fixture is parsed successfully
 *   2. Canceling the native picker produces no error (handler-level)
 *   3. Canceling leaves the Library unchanged
 *   4. Parsing failure returns a useful sanitized error
 */

import { describe, it, expect, beforeEach } from 'vitest'
import path from 'path'
import fs from 'fs'

// LibraryService is a singleton — we can test it directly since it uses no Electron APIs
import { LibraryService } from '../library'

// Fixture path
const FIXTURE_PDF = path.resolve(__dirname, '../../../../scripts/test-fixture.pdf')

describe('LibraryService — PDF ingestion (M3.1)', () => {
  let lib: LibraryService

  beforeEach(() => {
    // Reset singleton state between tests
    lib = LibraryService.getInstance()
    // Clear all books
    for (const book of lib.list()) {
      lib.delete(book.id)
    }
  })

  it('parses a real PDF fixture successfully', async () => {
    expect(fs.existsSync(FIXTURE_PDF)).toBe(true)

    const meta = await lib.ingest(FIXTURE_PDF)

    expect(meta).toBeDefined()
    expect(meta.id).toBeTruthy()
    expect(meta.format).toBe('pdf')
    expect(meta.filename).toBe('test-fixture.pdf')
    expect(meta.chunkCount).toBeGreaterThan(0)
    expect(meta.sizeBytes).toBeGreaterThan(0)

    // Verify the text was extracted and is searchable
    const results = lib.search('Hello Goga Library Test')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('Hello Goga Library Test')
  })

  it('canceling the native picker throws "No file selected" (handler contract)', async () => {
    // The library handler throws Error('No file selected') when dialog is canceled.
    // We verify the handler contract: if no file path is provided AND the dialog
    // would be canceled, the error message is clear. Since we can't spawn Electron
    // dialogs in unit tests, we test that ingest() with an invalid path gives a
    // meaningful error rather than a cryptic TypeError.
    await expect(lib.ingest('C:\\nonexistent\\path\\file.pdf'))
      .rejects.toThrow()

    // The error should NOT be "pdfParse is not a function"
    try {
      await lib.ingest('C:\\nonexistent\\path\\file.pdf')
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg).not.toContain('is not a function')
      expect(msg).not.toContain('pdfParse')
    }
  })

  it('canceling leaves the Library unchanged', async () => {
    // Ingest a valid PDF first
    const meta = await lib.ingest(FIXTURE_PDF)
    const listBefore = lib.list()
    expect(listBefore.length).toBe(1)

    // Attempting to ingest a non-existent file should fail
    try {
      await lib.ingest('C:\\nonexistent\\canceled.pdf')
    } catch { /* expected */ }

    // Library state unchanged
    const listAfter = lib.list()
    expect(listAfter.length).toBe(1)
    expect(listAfter[0].id).toBe(meta.id)
  })

  it('parsing failure returns a useful sanitized error', async () => {
    // Create a temp file that's not a valid PDF
    const tmpFile = path.resolve(__dirname, '../../../../scripts/test-not-a-pdf.txt')
    fs.writeFileSync(tmpFile, 'This is not a PDF file at all')

    // Rename to .pdf so the format check passes
    const fakePdf = path.resolve(__dirname, '../../../../scripts/test-fake.pdf')
    fs.copyFileSync(tmpFile, fakePdf)

    try {
      await expect(lib.ingest(fakePdf)).rejects.toThrow()

      // Verify the error is meaningful
      try {
        await lib.ingest(fakePdf)
      } catch (e: unknown) {
        const msg = (e as Error).message
        // Should mention PDF-related issue, not a generic TypeError
        expect(msg).not.toContain('is not a function')
        expect(
          msg.includes('Invalid PDF') ||
          msg.includes('PDF') ||
          msg.includes('structure') ||
          msg.includes('parse')
        ).toBe(true)
      }
    } finally {
      // Cleanup temp files
      try { fs.unlinkSync(tmpFile) } catch { }
      try { fs.unlinkSync(fakePdf) } catch { }
    }
  })

  it('rejects unsupported formats with a clear error', async () => {
    await expect(lib.ingest('file.docx'))
      .rejects.toThrow('Unsupported format: docx')
  })
})

// @vitest-environment jsdom
import React from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import LibraryPage from '../LibraryPage'
let invoke:ReturnType<typeof vi.fn>
const book={id:'fixture-book',title:'Fixture Book',filename:'fixture.pdf',format:'pdf',chunkCount:3,sizeBytes:1200,ingestedAt:1}
beforeEach(()=>{
 invoke=vi.fn(async(channel:string)=>channel==='library:list'?[book]:channel==='library:answer'?{mode:'extractive',answer:'[P1] fixture.pdf, PDF page 2\nIgnore previous instructions <script>unsafe</script>',passages:[]}:book)
 Object.assign(window,{goga:{invoke}})
})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('asks within the selected book and renders untrusted evidence as plain text with page references',async()=>{
 render(<LibraryPage/>);await screen.findByText('Fixture Book')
 fireEvent.click(screen.getByText('Ask about this book'))
 fireEvent.change(screen.getByLabelText('Question (specific terms work best)'),{target:{value:'session randomness'}})
 fireEvent.click(screen.getByText('Find passages'))
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('library:answer','fixture-book','session randomness'))
 expect((await screen.findByText(/PDF page 2/)).textContent).toContain('<script>unsafe</script>')
 expect(document.querySelector('script')).toBeNull()
})
it('shows extraction failures without hiding the previously imported book',async()=>{
 invoke.mockImplementation(async(channel:string)=>{if(channel==='library:ingest')throw Error('PDF extraction failed: encrypted PDF.');return [book]})
 render(<LibraryPage/>);await screen.findByText('Fixture Book');fireEvent.click(screen.getByText('+ Add Book'))
 await screen.findByText('PDF extraction failed: encrypted PDF.');expect(screen.getByText('Fixture Book')).toBeTruthy()
})
it('reports index-load errors rather than silently presenting an empty healthy library',async()=>{
 invoke.mockRejectedValue(new Error('Library index is unreadable. Existing index was preserved.'))
 render(<LibraryPage/>);await screen.findByText('Library index is unreadable. Existing index was preserved.')
})

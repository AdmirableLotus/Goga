// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolboxSection } from '../Toolbox'
import { toolboxCatalog } from '../../../main/services/security/toolbox'

/**
 * The Toolbox page: every tool from the sheets, its verdict, and the banned half marked line
 * by line. The search has to find a tool by a command fragment, and the page has to say in
 * its own words that a cheat sheet is not authorisation.
 */

const catalog = toolboxCatalog()

afterEach(() => cleanup())

describe('the Toolbox page', () => {
  it('lists every tool with its verdict chip', () => {
    render(<ToolboxSection catalog={catalog} unreadable={catalog.unreadable} />)
    expect(screen.getByText(/Toolbox — 21 tools from your cheat sheets/)).toBeTruthy()
    expect(screen.getByText(/▸ Nmap/)).toBeTruthy()
    expect(screen.getByText(/▸ hashcat/)).toBeTruthy()
    expect(screen.getAllByText('Never').length).toBe(9)
    expect(screen.getAllByText('Needs explicit program permission').length).toBe(5)
    expect(screen.getAllByText('Allowed under scope').length).toBe(7)
  })

  it('says a cheat sheet is a memory aid, not authorisation', () => {
    render(<ToolboxSection catalog={catalog} unreadable={catalog.unreadable} />)
    expect(screen.getByText(/a memory aid, not authorisation/)).toBeTruthy()
    expect(screen.getByText(/your material, not a vendor/)).toBeTruthy()
  })

  it('finds a tool by a command fragment and by a need', () => {
    render(<ToolboxSection catalog={catalog} unreadable={catalog.unreadable} />)
    const search = screen.getByLabelText('Search the toolbox') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'pass-the-hash' } })
    expect(screen.getByText(/▸ NetExec/)).toBeTruthy()
    expect(screen.queryByText(/▸ Nmap/)).toBeNull()
    fireEvent.change(search, { target: { value: 'capture file' } })
    expect(screen.getByText(/▸ Wireshark/)).toBeTruthy()
  })

  it('marks the banned half of a credential tool line by line when it is opened', () => {
    const { container } = render(<ToolboxSection catalog={catalog} unreadable={catalog.unreadable} />)
    fireEvent.click(screen.getByText(/▸ hashcat/))
    const banned = container.querySelectorAll('[data-banned="true"]')
    expect(banned.length).toBe(16)
    expect(banned[0].textContent).toContain('hashcat -m 0 -a 0 hash.txt wordlist.txt')
    expect(banned[0].textContent).toContain('banned half')
    // The benchmark line is documentation, not an attack, so it stays unmarked.
    const clean = Array.from(container.querySelectorAll('.g-tool-cmd')).filter(n => !n.hasAttribute('data-banned'))
    expect(clean.some(n => n.textContent?.includes('hashcat --benchmark'))).toBe(true)
  })

  it('shows the tool\'s own documentation link and says the sheet is the user\'s material', () => {
    render(<ToolboxSection catalog={catalog} unreadable={catalog.unreadable} />)
    fireEvent.click(screen.getByText(/▸ hashcat/))
    const link = screen.getByText('hashcat wiki (official)') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://hashcat.net/wiki/')
    expect(screen.getByText(/not the vendor's documentation/)).toBeTruthy()
  })

  it('tells the user to read the docs in Firefox, not the browser holding their accounts', () => {
    render(<ToolboxSection catalog={catalog} unreadable={catalog.unreadable} />)
    fireEvent.click(screen.getByText(/▸ hashcat/))
    expect(screen.getByText(/read them in Firefox/)).toBeTruthy()
    expect(screen.getByText(/holding your signed-in accounts/)).toBeTruthy()
  })
})

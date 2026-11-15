import React, { useCallback, useEffect, useState } from 'react'
import type {
  CatalogueReading, InstallProposal, SetupAuditEntry, VirtualisationReport, VmProposal, VmResources,
} from '../../shared/setup'
import { PageHeader, Card, Field, EmptyState, Alert, Chip } from '../components/ui'

/**
 * Setup: what is on this machine, what Goga would install, and what virtualisation it has.
 *
 * The page is arranged around the one thing that matters: every change shows exactly what it
 * would do and waits for a single-use approval bound to that exact change. The two honest
 * facts the page states next to the relevant controls, not in a footnote:
 *
 *   - Installing a tool is not permission to use it against anyone's system.
 *   - A virtual machine is isolation, not authorisation.
 */

function when(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

const PROVIDER_STATE_TONE = { usable: 'ok', 'present-but-unusable': 'warn', absent: 'bad' } as const

export default function SetupPage() {
  const [catalogue, setCatalogue] = useState<CatalogueReading | null>(null)
  const [virt, setVirt] = useState<VirtualisationReport | null>(null)
  const [proposals, setProposals] = useState<InstallProposal[]>([])
  const [vmProposals, setVmProposals] = useState<VmProposal[]>([])
  const [audit, setAudit] = useState<SetupAuditEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Install form
  const [pkg, setPkg] = useState('')
  const [pkgTask, setPkgTask] = useState('')
  const [vendorUrl, setVendorUrl] = useState('')
  const [refusal, setRefusal] = useState('')

  // VM form
  const [vmName, setVmName] = useState('')
  const [vmUsedFor, setVmUsedFor] = useState('')
  const [vmImage, setVmImage] = useState('ubuntu-24.04')
  const [vmProvider, setVmProvider] = useState('')
  const [vmCpu, setVmCpu] = useState('2')
  const [vmMem, setVmMem] = useState('4')
  const [vmDisk, setVmDisk] = useState('40')

  const refresh = useCallback(async () => {
    try {
      const state = await window.goga.invoke('setup:state')
      setCatalogue(state.catalogue)
      setVirt(state.virtualisation)
      setProposals(state.proposals)
      setVmProposals(state.vmProposals)
      setAudit(state.audit)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(true); setError(''); setNotice('')
    try { return await fn() }
    catch (e) { setError(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null }
    finally { setBusy(false); void refresh() }
  }

  async function propose() {
    setRefusal('')
    const result = await run('Propose install', () => window.goga.invoke('setup:proposeInstall', {
      package: pkg.trim(),
      task: pkgTask.trim() || 'a task that needs this program',
      vendorUrl: vendorUrl.trim() || undefined,
    }))
    if (!result) return
    if (!result.ok) {
      if (result.refused) setRefusal(result.message)
      else setError(result.message)
      return
    }
    setNotice(result.message)
    setPkg(''); setPkgTask(''); setVendorUrl('')
  }

  async function approveInstall(p: InstallProposal, approved: boolean) {
    const result = await run('Approve', () => window.goga.invoke('setup:decideInstall', p.id, approved))
    if (result) setNotice(result.message)
  }

  async function installNow(p: InstallProposal) {
    const result = await run('Install', () => window.goga.invoke('setup:runInstall', p.id))
    if (!result) return
    if (result.ok) setNotice(result.message)
    else setError(result.message)
  }

  async function proposeMachine() {
    const result = await run('Propose VM', () => window.goga.invoke('setup:proposeVm', {
      purpose: vmUsedFor.trim() || 'work that should not run on the desktop',
      usedFor: vmUsedFor.trim() || 'an isolated workspace',
      name: vmName.trim() || undefined,
      image: vmImage,
      provider: (vmProvider || undefined) as never,
      cpuCores: Number(vmCpu) || undefined,
      memoryGb: Number(vmMem) || undefined,
      diskGb: Number(vmDisk) || undefined,
    }))
    if (!result) return
    if (!result.ok) { setError(result.message); return }
    setNotice(result.message)
  }

  async function approveVm(p: VmProposal, approved: boolean) {
    const result = await run('Approve VM', () => window.goga.invoke('setup:decideVm', p.id, approved))
    if (result) setNotice(result.message)
  }

  async function createNow(p: VmProposal) {
    const result = await run('Create VM', () => window.goga.invoke('setup:createVm', p.id))
    if (result) { if (result.ok) setNotice(result.message); else setError(result.message) }
  }

  const named = catalogue?.programs.filter(p => p.source === 'winget' || p.source === 'registry') ?? []

  return (
    <div className="g-page">
      <div className="g-page-inner">

        <PageHeader
          title="Setup"
          accent="what is installed, and what a VM would take"
          purpose="Goga can work out that a task needs a program it does not have and propose installing it, and it can propose a virtual machine when work should not run on your desktop. Every install and every VM waits for your approval of that exact one."
          help={<>
            <p><strong>Installing is not permission.</strong> Installing a tool does not authorise running it at anyone's system. The program's scope and rules decide what may be pointed at a target, and the Security area's single pre-approved GET remains the only thing in Goga that touches one.</p>
            <p><strong>A VM is isolation, not authorisation.</strong> It keeps work off your desktop. It does not make it legal to point at somebody else's machine.</p>
            <p><strong>The approval is bound.</strong> An approval covers one install or one VM, with the exact package, source, version and resources shown. Change any of them and the approval no longer matches, so nothing runs.</p>
            <p><strong>No silent elevation.</strong> If an installer needs administrator rights, Goga stops and tells you exactly what to click. It never elevates on its own, and it never enables a Windows feature.</p>
          </>}
          actions={<button className="g-btn g-btn--sm" disabled={busy} onClick={() => void refresh()}>Read again</button>}
        />

        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="ok">{notice}</Alert>}
        {refusal && <Alert kind="error">{refusal}</Alert>}

        {/* ── Installed catalogue ───────────────────────────────────────────── */}
        <Card
          title="What is already installed"
          sub={catalogue
            ? `Read from this machine at ${when(catalogue.readAt)}`
            : 'Reading the machine…'}
        >
          {!catalogue ? <EmptyState icon="🧾" title="Reading…" body="Asking winget, the registry, PATH and Program Files." /> : (
            <>
              <div className="g-row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                <Chip tone={catalogue.wingetAvailable ? 'ok' : 'warn'}>
                  winget {catalogue.wingetAvailable ? 'answered' : 'did not answer'} · {catalogue.counts.winget}
                </Chip>
                <Chip>registry · {catalogue.counts.registry}</Chip>
                <Chip>PATH · {catalogue.counts.path}</Chip>
                <Chip>Program Files · {catalogue.counts['program-files']}</Chip>
              </div>
              {catalogue.gaps.length > 0 && (
                <Alert kind="info">
                  {catalogue.gaps.map(g => <div key={g}>{g}</div>)}
                </Alert>
              )}
              <details className="g-details">
                <summary>{named.length} named programs — open the list</summary>
                <table className="g-table" style={{ marginTop: 6 }}>
                  <thead><tr>{['Program', 'Version', 'Publisher', 'Found by', 'Id'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {named.slice(0, 300).map((p, i) => (
                      <tr key={`${p.name}-${p.source}-${i}`}>
                        <td>{p.name}</td>
                        <td className="num">{p.version ?? '—'}</td>
                        <td className="g-caption">{p.publisher ?? '—'}</td>
                        <td className="g-caption">{p.source}</td>
                        <td className="g-mono" style={{ fontSize: 11 }}>{p.packageId ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {named.length > 300 && <p className="g-caption">Showing 300 of {named.length}.</p>}
                <p className="g-caption g-faint" style={{ marginTop: 6 }}>
                  PATH and Program Files rows are also in the catalogue ({catalogue.counts.path + catalogue.counts['program-files']} of them) but are not listed here, because a bare executable name is not a program name.
                </p>
              </details>
            </>
          )}
        </Card>

        {/* ── Propose an install ────────────────────────────────────────────── */}
        <Card title="Propose an install" sub="Nothing is downloaded or run to make a proposal." tone="accent">
          <div className="g-grid g-grid--3">
            <Field label="Package" hint="A winget id, or the program's name">
              <input className="g-input g-input--sm" value={pkg} onChange={e => setPkg(e.target.value)} placeholder="e.g. nmap or Oracle.VirtualBox" />
            </Field>
            <Field label="Why it is needed" hint="Kept with the proposal">
              <input className="g-input g-input--sm" value={pkgTask} onChange={e => setPkgTask(e.target.value)} placeholder="e.g. reading a pcap for the bounty report" />
            </Field>
            <Field label="Vendor download" hint="Only when there is no winget entry">
              <input className="g-input g-input--sm" value={vendorUrl} onChange={e => setVendorUrl(e.target.value)} placeholder="https://vendor.example/download" />
            </Field>
          </div>
          <div className="g-row" style={{ gap: 8, alignItems: 'center' }}>
            <button className="g-btn g-btn--primary" disabled={busy || !pkg.trim()} onClick={() => void propose()}>Propose this install</button>
            <span className="g-hint" style={{ display: 'inline' }}>Downloads nothing. Goga reads winget and the machine first, and refuses if it is already installed.</span>
          </div>
        </Card>

        {/* ── Install proposals ─────────────────────────────────────────────── */}
        <Card title="Install proposals" sub="Approved once, for that exact package, source and version">
          {proposals.length === 0 ? (
            <EmptyState icon="📦" title="Nothing proposed" body="Goga has not worked out an install on this run." />
          ) : proposals.map(p => (
            <div key={p.id} className="g-inset" style={{ marginBottom: 10, borderColor: p.approved ? 'var(--accent-line)' : undefined }}>
              <div className="g-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>
                    {p.displayName}{p.version ? ` ${p.version}` : ''}
                  </div>
                  <p className="g-caption" style={{ marginTop: 2 }}>{p.purpose.task}</p>
                </div>
                <Chip tone={p.status === 'installed' ? 'ok' : p.status === 'failed' ? 'bad' : p.approved ? 'accent' : undefined}>
                  {p.status}
                </Chip>
              </div>

              <div className="g-grid g-grid--2" style={{ marginTop: 8 }}>
                <div><span className="g-label">Source</span><div className="g-caption">{p.source.kind} — <span className="g-mono">{p.source.where}</span></div></div>
                <div><span className="g-label">Package id</span><div className="g-mono" style={{ fontSize: 12 }}>{p.packageId}</div></div>
              </div>

              <p className="g-caption g-faint" style={{ marginTop: 6 }}>{p.source.note}</p>

              <details className="g-details">
                <summary>What it will change</summary>
                <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 4 }}>
                  {p.impact.changes.map(c => <li key={c}>{c}</li>)}
                </ul>
                {p.impact.needsElevation && (
                  <p className="g-caption" style={{ marginTop: 4 }}>
                    This installer is expected to ask for administrator rights. Goga will stop and tell you what to click rather than elevating on its own.
                  </p>
                )}
              </details>

              {p.carriesSecurityVerdict && (
                <Alert kind="info">
                  <strong>Toolbox verdict: {p.verdict}.</strong> {p.verdictReason}
                  <div style={{ marginTop: 6 }}>
                    Installing it does not authorise running it at anyone's system. That is decided by the program's scope and rules, and the Security area's single approved GET is still the only thing in Goga that touches a target.
                  </div>
                </Alert>
              )}

              <p className="g-caption g-faint" style={{ marginTop: 6 }}>
                Proposal <span className="g-mono">{p.id.slice(0, 8)}</span> · expires {when(p.expiresAt)} · works once
              </p>

              <div className="g-row" style={{ gap: 8, marginTop: 8 }}>
                {!p.approved && p.status === 'proposed' && (
                  <>
                    <button className="g-btn g-btn--risk g-btn--sm" disabled={busy} onClick={() => void approveInstall(p, true)}>Approve this exact install</button>
                    <button className="g-btn g-btn--sm" disabled={busy} onClick={() => void approveInstall(p, false)}>Discard</button>
                  </>
                )}
                {p.approved && p.status === 'approved' && (
                  <button className="g-btn g-btn--primary g-btn--sm" disabled={busy} onClick={() => void installNow(p)}>Install it now</button>
                )}
                {p.status === 'installed' && <Chip tone="ok">installed</Chip>}
                {p.status === 'failed' && <Chip tone="bad">did not install</Chip>}
              </div>
            </div>
          ))}
        </Card>

        {/* ── Virtualisation ───────────────────────────────────────────────── */}
        <Card
          title="What virtualisation this machine actually has"
          sub={virt ? `${virt.os} — read at ${when(virt.readAt)}` : 'Checking…'}
        >
          {!virt ? <EmptyState icon="🧪" title="Checking…" body="Asking Windows, WSL and the installed hypervisors." /> : (
            <>
              <p style={{ fontSize: 14, marginBottom: 10 }}>{virt.summary}</p>
              <div className="g-row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                <Chip tone={virt.usable.length ? 'ok' : 'bad'}>
                  {virt.usable.length ? `usable: ${virt.usable.join(', ')}` : 'no VM provider usable right now'}
                </Chip>
                <Chip>{virt.capacity.cpuCores} cores / {virt.capacity.logicalProcessors} threads</Chip>
                <Chip>{virt.capacity.memoryGb} GB RAM</Chip>
                <Chip>hypervisor running: {virt.hypervisorPresent ? 'yes' : 'no'}</Chip>
                <Chip>CPU virtualisation: {virt.firmwareVirtualisationEnabled ? 'enabled' : 'off'}</Chip>
              </div>

              <table className="g-table">
                <thead><tr>{['Provider', 'State', 'Detail', 'Would need'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {virt.providers.map(p => (
                    <tr key={p.provider}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td><Chip tone={PROVIDER_STATE_TONE[p.state]}>{p.state}</Chip></td>
                      <td className="g-caption">
                        {p.detail}
                        <div className="g-faint" style={{ fontSize: 11, marginTop: 2 }}>checked by: {p.checkedBy}</div>
                      </td>
                      <td className="g-caption">
                        {p.wouldNeed ?? '—'}
                        {p.needsRestart && <div><Chip tone="warn">needs a restart</Chip></div>}
                        {p.needsLicence && <div><Chip tone="bad">needs a licence / edition upgrade</Chip></div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!virt.usable.length && (
                <Alert kind="info">
                  Goga will not enable a Windows feature or upgrade your edition. Both are your decision.
                  {' '}If you want a VM here, the cheapest route is installing VirtualBox — a normal program install, no restart, no Windows feature — then proposing a VM again.
                </Alert>
              )}
            </>
          )}
        </Card>

        {/* ── Propose a VM ─────────────────────────────────────────────────── */}
        <Card title="Propose a virtual machine" sub="For work that should not run on your desktop. Creating it needs your approval of this exact one.">
          {virt && !virt.usable.length && (
            <Alert kind="info">
              Nothing here can create a VM yet, so a proposal will be refused with the reason. That is deliberate — see the provider table above.
            </Alert>
          )}
          <div className="g-grid g-grid--3">
            <Field label="Name" hint="Optional. Lower-case, digits and dashes.">
              <input className="g-input g-input--sm" value={vmName} onChange={e => setVmName(e.target.value)} placeholder="bounty-recon-01" />
            </Field>
            <Field label="What it is for">
              <input className="g-input g-input--sm" value={vmUsedFor} onChange={e => setVmUsedFor(e.target.value)} placeholder="reading a suspicious file away from my desktop" />
            </Field>
            <Field label="Base image">
              <select className="g-input g-input--sm" value={vmImage} onChange={e => setVmImage(e.target.value)}>
                <option value="ubuntu-24.04">Ubuntu 24.04 LTS</option>
                <option value="debian-12">Debian 12</option>
                <option value="kali-linux">Kali Linux</option>
              </select>
            </Field>
            <Field label="Provider" hint="Defaults to the first usable one">
              <select className="g-input g-input--sm" value={vmProvider} onChange={e => setVmProvider(e.target.value)}>
                <option value="">first usable</option>
                {(virt?.providers ?? []).map(p => <option key={p.provider} value={p.provider}>{p.name} ({p.state})</option>)}
              </select>
            </Field>
            <Field label="CPU cores">
              <input className="g-input g-input--sm" type="number" min="1" value={vmCpu} onChange={e => setVmCpu(e.target.value)} />
            </Field>
            <Field label="RAM (GB)">
              <input className="g-input g-input--sm" type="number" min="1" value={vmMem} onChange={e => setVmMem(e.target.value)} />
            </Field>
            <Field label="Disk (GB)">
              <input className="g-input g-input--sm" type="number" min="10" value={vmDisk} onChange={e => setVmDisk(e.target.value)} />
            </Field>
          </div>
          <div className="g-row" style={{ gap: 8, alignItems: 'center' }}>
            <button className="g-btn g-btn--primary" disabled={busy} onClick={() => void proposeMachine()}>Propose this VM</button>
            <span className="g-hint" style={{ display: 'inline' }}>Downloads nothing, creates nothing. A VM is isolation, not authorisation.</span>
          </div>
        </Card>

        {/* ── VM proposals ─────────────────────────────────────────────────── */}
        <Card title="Virtual-machine proposals" sub="Approved once, for that exact provider, image and size">
          {vmProposals.length === 0 ? (
            <EmptyState icon="💻" title="Nothing proposed" body="Goga has not worked out a virtual machine on this run." />
          ) : vmProposals.map(p => (
            <div key={p.id} className="g-inset" style={{ marginBottom: 10 }}>
              <div className="g-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{p.name}</div>
                  <p className="g-caption">{p.usedFor}</p>
                </div>
                <Chip tone={p.status === 'installed' ? 'ok' : p.status === 'failed' ? 'bad' : p.approved ? 'accent' : undefined}>{p.status}</Chip>
              </div>
              <div className="g-grid g-grid--4" style={{ marginTop: 8 }}>
                <div><span className="g-label">Provider</span><div>{p.provider}</div></div>
                <div><span className="g-label">CPU</span><div className="num">{p.resources.cpuCores}</div></div>
                <div><span className="g-label">RAM</span><div className="num">{p.resources.memoryGb} GB</div></div>
                <div><span className="g-label">Disk</span><div className="num">{p.resources.diskGb} GB</div></div>
              </div>
              <div style={{ marginTop: 8 }}>
                <span className="g-label">Image</span>
                <div className="g-caption">{p.image.name} — <span className="g-mono">{p.image.url}</span></div>
                <div className="g-caption g-faint">{p.image.verification}</div>
              </div>
              <details className="g-details">
                <summary>What it will change</summary>
                <ul style={{ fontSize: 'var(--fs-caption)', paddingLeft: 18, marginTop: 4 }}>
                  {p.changes.map(c => <li key={c}>{c}</li>)}
                </ul>
              </details>
              <p className="g-caption g-faint" style={{ marginTop: 6 }}>
                Proposal <span className="g-mono">{p.id.slice(0, 8)}</span> · expires {when(p.expiresAt)} · works once
              </p>
              <div className="g-row" style={{ gap: 8, marginTop: 8 }}>
                {!p.approved && p.status === 'proposed' && (
                  <>
                    <button className="g-btn g-btn--risk g-btn--sm" disabled={busy} onClick={() => void approveVm(p, true)}>Approve this exact VM</button>
                    <button className="g-btn g-btn--sm" disabled={busy} onClick={() => void approveVm(p, false)}>Discard</button>
                  </>
                )}
                {p.approved && p.status === 'approved' && (
                  <button className="g-btn g-btn--primary g-btn--sm" disabled={busy} onClick={() => void createNow(p)}>Create it now</button>
                )}
              </div>
            </div>
          ))}
        </Card>

        {/* ── Audit ────────────────────────────────────────────────────────── */}
        <Card title="Audit" sub="Every proposal, approval, refusal and completed install">
          {audit.length === 0 ? <EmptyState icon="🗂" title="Nothing recorded yet" body="The audit fills as Goga proposes and you decide." /> : (
            <table className="g-table">
              <thead><tr>{['When', 'What', 'Detail'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {[...audit].reverse().slice(0, 60).map(e => (
                  <tr key={e.id}>
                    <td className="g-mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{e.time.slice(0, 19).replace('T', ' ')}</td>
                    <td><Chip tone={e.kind.includes('refus') || e.kind.includes('fail') ? 'bad' : undefined}>{e.kind}</Chip></td>
                    <td className="g-caption">{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

      </div>
    </div>
  )
}

export type { VmResources }

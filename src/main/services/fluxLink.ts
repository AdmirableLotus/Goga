import fs from 'fs'
import http from 'http'
import { randomBytes } from 'crypto'
import type { RiskLevel } from '../../shared/types'
import type { ToolRegistry } from '../tools/registry'

/**
 * Goga's link to Flux (flux.ai), the AI circuit-board design tool, through Flux's official
 * MCP server. The user signs in to Flux once in their browser; the token is kept encrypted
 * on this PC. Flux's tools then become Goga tools named "flux.<tool>": reading a project is
 * free to run, anything that changes a project (and spends Flux credits) asks first.
 */

export const FLUX_MCP_URL = 'https://app.flux.ai/mcp'
// The sign-in returns to this address on this PC; it is registered with Flux once, so it must not change.
const CALLBACK_PORT = 47821
const CALLBACK_PATH = '/flux/callback'
const SIGN_IN_WAIT_MS = 5 * 60_000
const RESULT_CHARS = 6000
const DESCRIPTION_CHARS = 200
// Looking things up. Anything else (creating a project or thread, messaging Flux's AI, which
// edits the design and spends credits, reviewing knowledge, sending feedback) asks first.
const READING_TOOLS = /^(get_|list_|wait_for_)|^ask_project_wiki$/

/** How to work in Flux, for the planner when Flux tools are offered. */
export const FLUX_HINT = '- Flux: find the project with flux.list_projects, read it with flux.get_project / get_components / get_nets / get_bom. To have Flux change a design, flux.create_thread (or flux.send_message to an existing thread), then flux.wait_for_thread and flux.get_thread for the answer.'

export type FluxStatus = { connected: boolean; signingIn: boolean; tools: string[]; error: string | null }

interface SavedAuth { client?: unknown; tokens?: unknown; verifier?: string }

export interface FluxLinkDeps {
  file: string
  /** Encrypt and decrypt for storage (Electron safeStorage); identity when unavailable is refused. */
  encrypt: (text: string) => Buffer
  decrypt: (data: Buffer) => string
  openBrowser: (url: string) => void
  registry: ToolRegistry
  log: { info: (m: string) => void; warn: (m: string) => void }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

interface McpTool { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] }; annotations?: { readOnlyHint?: boolean } }

/** A Flux tool as a Goga tool. Read-only tools run freely; the rest ask first. */
export function fluxToolDefinition(tool: McpTool) {
  // Flux's own hint wins; without one, the tool's name says whether it only reads.
  const hint = tool.annotations?.readOnlyHint
  const readOnly = hint ?? READING_TOOLS.test(tool.name)
  const riskLevel: RiskLevel = readOnly ? 'low' : 'high'
  return {
    name: `flux.${tool.name}`,
    description: `Flux (circuit-board design): ${(tool.description ?? tool.name).replace(/\s+/g, ' ').slice(0, DESCRIPTION_CHARS)}`,
    parameters: { type: 'object' as const, properties: (tool.inputSchema?.properties ?? {}) as Record<string, Any>, required: tool.inputSchema?.required },
    riskLevel,
    reversible: readOnly,
    category: 'web' as const,
  }
}

/** The text of an MCP tool result, kept short enough for the brain's context. */
export function resultText(result: { content?: { type: string; text?: string }[]; structuredContent?: unknown }): string {
  const text = (result.content ?? []).filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n')
  const body = text || (result.structuredContent ? JSON.stringify(result.structuredContent) : '')
  return body.length > RESULT_CHARS ? `${body.slice(0, RESULT_CHARS)}\n…(cut short)` : body
}

export class FluxLink {
  private client: Any = null
  private toolNames: string[] = []
  private signingIn = false
  private error: string | null = null

  constructor(private deps: FluxLinkDeps) {}

  status(): FluxStatus {
    return { connected: !!this.client, signingIn: this.signingIn, tools: [...this.toolNames], error: this.error }
  }

  hasSavedSignIn(): boolean { return !!this.load().tokens }

  /**
   * Connect to Flux. With `interactive`, opens the browser for sign-in when needed;
   * without it (at startup) only a saved sign-in is used.
   */
  async connect(interactive: boolean): Promise<FluxStatus> {
    if (this.client || this.signingIn) return this.status()
    this.error = null
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
      const state = randomBytes(16).toString('hex')
      let authUrl: URL | null = null
      const provider = this.authProvider(state, url => { authUrl = url })
      const makeTransport = () => new StreamableHTTPClientTransport(new URL(FLUX_MCP_URL), { authProvider: provider })
      const client = new Client({ name: 'Goga', version: '1.0.0' })
      let transport = makeTransport()
      try {
        await client.connect(transport)
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err
        if (!interactive) throw new Error('Flux sign-in has expired — connect again from Settings')
        this.signingIn = true
        const waiting = this.waitForCallback(state)
        if (authUrl) this.deps.openBrowser(String(authUrl))
        const code = await waiting
        await transport.finishAuth(code)
        transport = makeTransport()
        await client.connect(transport)
      }
      this.client = client
      await this.registerTools()
      this.deps.log.info(`Flux: connected, ${this.toolNames.length} tools`)
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      this.deps.log.warn(`Flux: could not connect — ${this.error}`)
    } finally {
      this.signingIn = false
    }
    return this.status()
  }

  async disconnect(forget: boolean): Promise<void> {
    try { await this.client?.close() } catch { /* already gone */ }
    this.client = null
    this.toolNames = []
    if (forget) { try { fs.unlinkSync(this.deps.file) } catch { /* nothing saved */ } }
  }

  private async registerTools(): Promise<void> {
    const { tools } = await this.client.listTools() as { tools: McpTool[] }
    this.toolNames = []
    for (const tool of tools) {
      const definition = fluxToolDefinition(tool)
      this.deps.registry.register(definition, async params => {
        if (!this.client) return { success: false, error: 'Flux is not connected — connect it in Settings' }
        try {
          const result = await this.client.callTool({ name: tool.name, arguments: params })
          const text = resultText(result)
          return result.isError ? { success: false, error: text || 'Flux reported an error' } : { success: true, data: text }
        } catch (err) {
          return { success: false, error: `Flux: ${err instanceof Error ? err.message : String(err)}` }
        }
      })
      this.toolNames.push(definition.name)
    }
  }

  /** Waits on this PC for the browser to come back from Flux's sign-in page with a code. */
  private waitForCallback(state: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`)
        if (url.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return }
        const code = url.searchParams.get('code')
        const ok = !!code && url.searchParams.get('state') === state
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ok ? '<h2>Goga is connected to Flux.</h2><p>You can close this tab.</p>' : '<h2>Flux sign-in did not finish.</h2><p>Try again from Goga\'s Settings.</p>')
        finish(ok ? null : new Error(url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'sign-in was not completed'), code ?? '')
      })
      const timer = setTimeout(() => finish(new Error('Flux sign-in timed out'), ''), SIGN_IN_WAIT_MS)
      const finish = (err: Error | null, code: string) => {
        clearTimeout(timer)
        server.close()
        if (err) reject(err); else resolve(code)
      }
      server.on('error', err => finish(err, ''))
      // Loopback only: nothing on the network can reach it.
      server.listen(CALLBACK_PORT, '127.0.0.1')
    })
  }

  private authProvider(state: string, onAuthUrl: (url: URL) => void) {
    const redirectUrl = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`
    return {
      get redirectUrl() { return redirectUrl },
      get clientMetadata() {
        return { client_name: 'Goga', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
      },
      state: () => state,
      clientInformation: () => this.load().client as Any,
      saveClientInformation: (client: unknown) => this.save({ ...this.load(), client }),
      tokens: () => this.load().tokens as Any,
      saveTokens: (tokens: unknown) => this.save({ ...this.load(), tokens }),
      redirectToAuthorization: (url: URL) => onAuthUrl(url),
      saveCodeVerifier: (verifier: string) => this.save({ ...this.load(), verifier }),
      codeVerifier: () => {
        const verifier = this.load().verifier
        if (!verifier) throw new Error('no sign-in in progress')
        return verifier
      },
      invalidateCredentials: (scope: string) => {
        const saved = this.load()
        if (scope === 'all') this.save({})
        else if (scope === 'client') this.save({ ...saved, client: undefined })
        else if (scope === 'tokens') this.save({ ...saved, tokens: undefined })
        else if (scope === 'verifier') this.save({ ...saved, verifier: undefined })
      },
    }
  }

  private load(): SavedAuth {
    try { return JSON.parse(this.deps.decrypt(fs.readFileSync(this.deps.file))) } catch { return {} }
  }

  private save(auth: SavedAuth): void {
    fs.writeFileSync(this.deps.file, this.deps.encrypt(JSON.stringify(auth)), { mode: 0o600 })
  }
}

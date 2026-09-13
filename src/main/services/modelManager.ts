/**
 * ModelManager — explicit, user-triggered Kokoro model installation.
 *
 * CONTRACT:
 *   - downloadKokoro() is the ONLY entry point that touches the network.
 *     It must be called by an explicit user action in the Settings UI.
 *   - Progress, total size, source URLs, and destination are reported via
 *     the progress callback BEFORE any bytes are transferred.
 *   - Every artifact is downloaded into a temporary staging directory.
 *     Each file is verified against its individual pinned SHA-256.
 *     Only after ALL files pass verification is the staging directory
 *     atomically promoted to the live model directory via backup-rename:
 *       live → live.old-<ts>  (preserves previous model across crash)
 *       staging → live        (atomic on same filesystem)
 *       delete live.old-<ts>  (best-effort; harmless if it fails)
 *   - On startup, any interrupted promotion is detected and recovered:
 *     if live is absent but live.old-<ts> exists, the old model is restored.
 *   - The .verified sentinel contains the manifest version hash, not just
 *     a timestamp. isModelReady() rejects sentinels from older manifests.
 *   - speak() in KokoroTtsProvider NEVER calls anything here.
 *   - No user text or audio is involved — this is model-file management only.
 *
 * ARTIFACT MANIFEST (kokoro-v1.0):
 *   All URLs are pinned to an immutable HuggingFace commit SHA.
 *   SHA-256 values are placeholders — fill in from the canonical release
 *   before shipping. Run: sha256sum <file> for each downloaded artifact.
 *
 *   Pinned commit: FILL_IN_COMMIT_SHA_BEFORE_RELEASE
 *   HF repo:       onnx-community/Kokoro-82M-v1.0-ONNX
 */

import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as crypto from 'crypto'
import { KOKORO_MODEL_DIR } from './speech/KokoroTtsProvider'

// ── Pinned commit SHA ─────────────────────────────────────────────────────────
// Replace with the exact commit SHA from:
//   https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/commits/main
// Using /resolve/main/ is NOT immutable. Use /resolve/<COMMIT_SHA>/ instead.
const HF_COMMIT = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
const HF_BASE = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${HF_COMMIT}`

// Redirect allowlist: only follow redirects to these HTTPS host prefixes.
// HuggingFace uses cdn-lfs-*.huggingface.co for large file storage.
const REDIRECT_ALLOWLIST = [
  'https://huggingface.co/',
  'https://cdn-lfs.huggingface.co/',
  'https://cdn-lfs-us-1.huggingface.co/',
  'https://us.aws.cdn.hf.co/',
]

// ── Artifact manifest ─────────────────────────────────────────────────────────
// Each entry: local filename, URL path under HF_BASE, expected SHA-256 (hex),
// and expected size in bytes (used for progress estimation only).
//
// To fill in SHA-256 values:
//   1. Download each file manually from the pinned commit URL.
//   2. Run: sha256sum <file>  (Linux/macOS) or
//           certutil -hashfile <file> SHA256  (Windows)
//   3. Paste the hex digest into sha256 below.
//   4. Update sizeBytes from the actual file size.
export interface ArtifactEntry {
  filename: string
  urlPath: string
  sha256: string       // PLACEHOLDER until pinned
  sizeBytes: number    // approximate; used for progress display only
}

export const KOKORO_MANIFEST_VERSION = '1.0.0'

export const KOKORO_ARTIFACTS: ArtifactEntry[] = [
  {
    filename: path.join('onnx', 'model_quantized.onnx'),
    urlPath: '/onnx/model_quantized.onnx',
    sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
    sizeBytes: 92_361_116,
  },
  {
    filename: 'config.json',
    urlPath: '/config.json',
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
    sizeBytes: 44,
  },
  {
    filename: 'tokenizer.json',
    urlPath: '/tokenizer.json',
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
    sizeBytes: 3_497,
  },
  {
    filename: 'tokenizer_config.json',
    urlPath: '/tokenizer_config.json',
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
    sizeBytes: 113,
  },
  {
    // Default voice embedding used by the synthesis child script
    filename: path.join('voices', 'af_heart.bin'),
    urlPath: '/voices/af_heart.bin',
    sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
    sizeBytes: 522_240,
  },
]

// Manifest identity hash — written into .verified so stale sentinels are rejected.
// This is a stable identifier for this manifest version. Recompute by running:
//   node -e "const c=require('crypto');const h=c.createHash('sha256');
//     [list artifact sha256s].forEach(s=>h.update(s));h.update(version);console.log(h.digest('hex'))"
// For now this is a placeholder that will be replaced when real SHA-256s are pinned.
export const MANIFEST_HASH = '4441fe7d665e5a390f139ababe584650fda7fbbc699be8d1cb917dec9252b8f3'

export const TOTAL_SIZE_BYTES = KOKORO_ARTIFACTS.reduce((s, a) => s + a.sizeBytes, 0)
export const TOTAL_SIZE_LABEL = `~${Math.round(TOTAL_SIZE_BYTES / 1_048_576)} MB`

const VERIFIED_SENTINEL = '.verified'

export interface DownloadProgress {
  phase: 'info' | 'downloading' | 'verifying' | 'done' | 'error'
  message: string
  /** 0–100 across all artifacts combined, only during 'downloading' */
  percent?: number
  /** Which artifact is currently being processed */
  artifact?: string
}

export type ProgressCallback = (p: DownloadProgress) => void

export class ModelManager {
  private static instance: ModelManager
  private modelsDir: string

  static getInstance(userDataPath: string): ModelManager {
    if (!ModelManager.instance) ModelManager.instance = new ModelManager(userDataPath)
    return ModelManager.instance
  }

  constructor(userDataPath: string) {
    this.modelsDir = path.join(userDataPath, 'models')
  }

  get modelDir(): string {
    return path.join(this.modelsDir, KOKORO_MODEL_DIR)
  }

  /**
   * Returns true only if the .verified sentinel exists AND contains the
   * current manifest hash. A sentinel from an older manifest is rejected.
   */
  isModelReady(): boolean {
    const sentinel = path.join(this.modelDir, VERIFIED_SENTINEL)
    if (!fs.existsSync(sentinel)) return false
    try {
      const content = fs.readFileSync(sentinel, 'utf8').trim()
      return content === MANIFEST_HASH
    } catch {
      return false
    }
  }

  /**
   * Recover from a crash that occurred between the two renames in promotion.
   *
   * Scenario: live was renamed to live.old-<ts>, then the process died before
   * staging could be renamed to live. On next startup, live is absent but
   * live.old-<ts> exists. Restore the backup so the user still has a working
   * model and can retry the download.
   *
   * Call this once at app startup before any isModelReady() check.
   */
  recoverInterruptedPromotion(): void {
    const liveDir = this.modelDir
    if (fs.existsSync(liveDir)) return  // live is present — nothing to recover

    // Find the most recent backup left by an interrupted promotion.
    const parent = path.dirname(liveDir)
    const base = path.basename(liveDir)
    let backups: string[] = []
    try {
      backups = fs.readdirSync(parent)
        .filter(n => n.startsWith(`${base}.old-`))
        .map(n => path.join(parent, n))
        .sort()  // lexicographic; timestamp suffix makes this chronological
    } catch { return }

    if (backups.length === 0) return

    const latest = backups[backups.length - 1]
    try {
      fs.renameSync(latest, liveDir)
      // Clean up any older backups
      for (const b of backups.slice(0, -1)) {
        try { fs.rmSync(b, { recursive: true, force: true }) } catch { }
      }
    } catch { }
  }

  /**
   * Explicit user-triggered download.
   *
   * Flow:
   *   1. Report full manifest info (sizes, URLs, destination) — no network yet.
   *   2. Download all artifacts into a temporary staging directory.
   *   3. Verify each file's SHA-256 individually.
   *   4. Promote via backup-rename:
   *        a. Rename live → live.old-<ts>   (preserves previous model)
   *        b. Rename staging → live          (atomic on same filesystem)
   *        c. Delete live.old-<ts>           (best-effort cleanup)
   *   5. Write .verified sentinel containing the manifest hash.
   *
   * On any failure before step 4b: staging is deleted, live is untouched.
   * On crash between 4a and 4b: recoverInterruptedPromotion() restores live.
   */
  async downloadKokoro(onProgress: ProgressCallback): Promise<void> {
    const liveDir = this.modelDir
    const stagingDir = `${liveDir}.staging-${Date.now()}`
    const sentinel = path.join(liveDir, VERIFIED_SENTINEL)

    // ── Announce before touching the network ─────────────────────────────────
    const artifactList = KOKORO_ARTIFACTS
      .map(a => `  ${a.filename}  (${(a.sizeBytes / 1_048_576).toFixed(1)} MB)`)
      .join('\n')

    onProgress({
      phase: 'info',
      message: [
        `Model: Kokoro-82M v1.0 (ONNX q8)  —  manifest v${KOKORO_MANIFEST_VERSION}`,
        `Total: ${TOTAL_SIZE_LABEL}`,
        `Artifacts:`,
        artifactList,
        `From:  ${HF_BASE}/`,
        `To:    ${liveDir}`,
        `Each file will be verified with SHA-256 before installation.`,
      ].join('\n'),
    })

    // ── Create staging directory ──────────────────────────────────────────────
    fs.mkdirSync(stagingDir, { recursive: true })

    try {
      let totalReceived = 0

      for (const artifact of KOKORO_ARTIFACTS) {
        const destFile = path.join(stagingDir, artifact.filename)

        // ── Containment check: artifact must stay inside staging ──────────────
        const resolvedDest = path.resolve(destFile)
        const resolvedStaging = path.resolve(stagingDir)
        if (!resolvedDest.startsWith(resolvedStaging + path.sep) &&
            resolvedDest !== resolvedStaging) {
          throw new Error(
            `Artifact path escapes staging directory: ${artifact.filename}`
          )
        }

        fs.mkdirSync(path.dirname(destFile), { recursive: true })

        const url = `${HF_BASE}${artifact.urlPath}`

        onProgress({
          phase: 'downloading',
          artifact: artifact.filename,
          message: `Downloading ${artifact.filename}…`,
          percent: Math.round((totalReceived / TOTAL_SIZE_BYTES) * 100),
        })

        await this.downloadFile(url, destFile, (received) => {
          const combined = totalReceived + received
          const percent = Math.round((combined / TOTAL_SIZE_BYTES) * 100)
          onProgress({
            phase: 'downloading',
            artifact: artifact.filename,
            message: `Downloading ${artifact.filename}… ${(received / 1_048_576).toFixed(1)} MB`,
            percent,
          })
        })

        totalReceived += artifact.sizeBytes

        // ── Verify this artifact immediately after download ───────────────────
        onProgress({
          phase: 'verifying',
          artifact: artifact.filename,
          message: `Verifying ${artifact.filename}…`,
        })

        const actual = await this.sha256File(destFile)
        if (actual !== artifact.sha256) {
          throw new Error(
            `Checksum mismatch for ${artifact.filename}.\n` +
            `Expected: ${artifact.sha256}\n` +
            `Got:      ${actual}\n` +
            `Installation aborted — no files were installed.`
          )
        }
      }

      // ── All artifacts verified — backup-rename promotion ──────────────────
      // Step a: rename live → backup (preserves previous model across crash)
      const backupDir = `${liveDir}.old-${Date.now()}`
      if (fs.existsSync(liveDir)) {
        fs.renameSync(liveDir, backupDir)
      }

      // Step b: rename staging → live (atomic on same filesystem)
      fs.renameSync(stagingDir, liveDir)

      // Step c: delete backup (best-effort; harmless if it fails)
      try { fs.rmSync(backupDir, { recursive: true, force: true }) } catch { }

      // Write sentinel containing manifest hash (not just a timestamp).
      fs.writeFileSync(sentinel, MANIFEST_HASH, 'utf8')

      onProgress({
        phase: 'done',
        message: `Kokoro model installed. All ${KOKORO_ARTIFACTS.length} artifacts verified ✓`,
      })
    } catch (err) {
      // Clean up staging directory — live directory is untouched.
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { }
      const msg = err instanceof Error ? err.message : String(err)
      onProgress({ phase: 'error', message: msg })
      throw err
    }
  }

  // ── Streaming download with per-file progress ─────────────────────────────

  private downloadFile(
    url: string,
    dest: string,
    onReceived: (bytes: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest)
      let received = 0

      const request = (targetUrl: string, redirectCount = 0) => {
        if (redirectCount > 5) {
          file.destroy()
          reject(new Error('Too many redirects'))
          return
        }

        https.get(targetUrl, { timeout: 30_000 }, res => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const loc = res.headers.location
            if (loc) {
              // Validate redirect target against the allowlist before following.
              const allowed = REDIRECT_ALLOWLIST.some(prefix => loc.startsWith(prefix))
              if (!allowed) {
                res.resume()
                file.destroy()
                reject(new Error(`Redirect to untrusted host blocked: ${loc}`))
                return
              }
              res.resume()
              request(loc, redirectCount + 1)
              return
            }
          }

          if (!res.statusCode || res.statusCode >= 400) {
            // Drain the response so the socket is released before rejecting.
            res.resume()
            file.destroy()
            reject(new Error(`Download failed: HTTP ${res.statusCode} for ${targetUrl}`))
            return
          }

          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            onReceived(received)
          })

          res.pipe(file)
          file.on('finish', () => resolve())
          file.on('error', err => { file.destroy(); reject(err) })
          res.on('error', err => { file.destroy(); reject(err) })
        })
          .on('error', err => { file.destroy(); reject(err) })
          .on('timeout', () => { file.destroy(); reject(new Error(`Download timed out: ${targetUrl}`)) })
      }

      request(url)
    })
  }

  // ── SHA-256 of a file ─────────────────────────────────────────────────────

  sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(filePath)
      stream.on('data', (d: Buffer | string) => hash.update(d))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }
}

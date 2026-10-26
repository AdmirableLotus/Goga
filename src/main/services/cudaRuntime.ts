import fs from 'fs'
import path from 'path'

/**
 * Folders holding NVIDIA's CUDA runtime DLLs (cudart, cuBLAS), which node-llama-cpp's
 * CUDA build needs. Without them it silently falls back to Vulkan, which on an RTX 3080
 * took ~20 s to give its first answer after startup (CUDA: ~0.7 s) and generates ~20% slower.
 *
 * Covers a full CUDA Toolkit (CUDA_PATH) and the pip wheels (nvidia-cuda-runtime-cu12,
 * nvidia-cublas-cu12) that also serve Whisper, in user or system Python installs.
 */
export function cudaLibraryDirs(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync,
  list: (p: string) => string[] = p => fs.readdirSync(p)): string[] {
  const dirs: string[] = []
  if (env.CUDA_PATH) dirs.push(path.join(env.CUDA_PATH, 'bin'))

  const pythonRoots = [
    env.APPDATA && path.join(env.APPDATA, 'Python'),                              // pip install --user
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Python'),        // python.org installer
  ].filter((p): p is string => !!p && exists(p))
  for (const root of pythonRoots) {
    for (const version of list(root).filter(v => /^Python3\d+$/i.test(v))) {
      for (const site of [path.join(root, version, 'site-packages'), path.join(root, version, 'Lib', 'site-packages')]) {
        for (const pkg of ['cuda_runtime', 'cublas']) dirs.push(path.join(site, 'nvidia', pkg, 'bin'))
      }
    }
  }
  return [...new Set(dirs)].filter(exists)
}

/** Put CUDA DLL folders on this process's PATH (Windows only) before the llama backend loads. */
export function exposeCudaRuntime(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== 'win32') return []
  const current = (env.PATH ?? '').split(path.delimiter)
  const added = cudaLibraryDirs(env).filter(d => !current.includes(d))
  if (added.length > 0) env.PATH = [...added, ...current].join(path.delimiter)
  return added
}

import path from 'path'
import { describe, expect, it } from 'vitest'
import { cudaLibraryDirs } from '../cudaRuntime'

const APPDATA = 'C:\\Users\\fixture\\AppData\\Roaming'
const LOCALAPPDATA = 'C:\\Users\\fixture\\AppData\\Local'
const userSite = path.join(APPDATA, 'Python', 'Python314', 'site-packages', 'nvidia')
const systemSite = path.join(LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'Lib', 'site-packages', 'nvidia')

function fakeFs(present: string[]) {
  const set = new Set(present)
  return {
    exists: (p: string) => set.has(p),
    list: (p: string) => [...set].filter(x => path.dirname(x) === p).map(x => path.basename(x)),
  }
}

describe('cudaLibraryDirs', () => {
  it('finds pip CUDA wheels in user and system Python installs, plus a CUDA Toolkit', () => {
    const fs = fakeFs([
      path.join(APPDATA, 'Python'), path.join(APPDATA, 'Python', 'Python314'),
      path.join(userSite, 'cuda_runtime', 'bin'), path.join(userSite, 'cublas', 'bin'),
      path.join(LOCALAPPDATA, 'Programs', 'Python'), path.join(LOCALAPPDATA, 'Programs', 'Python', 'Python312'),
      path.join(systemSite, 'cublas', 'bin'),
      path.join('C:\\CUDA\\v12.8', 'bin'),
    ])
    expect(cudaLibraryDirs({ APPDATA, LOCALAPPDATA, CUDA_PATH: 'C:\\CUDA\\v12.8' }, fs.exists, fs.list)).toEqual([
      path.join('C:\\CUDA\\v12.8', 'bin'),
      path.join(userSite, 'cuda_runtime', 'bin'),
      path.join(userSite, 'cublas', 'bin'),
      path.join(systemSite, 'cublas', 'bin'),
    ])
  })

  it('returns nothing when no CUDA libraries are installed', () => {
    const fs = fakeFs([path.join(APPDATA, 'Python'), path.join(APPDATA, 'Python', 'Python314')])
    expect(cudaLibraryDirs({ APPDATA, LOCALAPPDATA }, fs.exists, fs.list)).toEqual([])
  })

  it('ignores folders that are not Python versions', () => {
    const fs = fakeFs([path.join(APPDATA, 'Python'), path.join(APPDATA, 'Python', 'Scripts'), path.join(APPDATA, 'Python', 'Scripts', 'site-packages', 'nvidia', 'cublas', 'bin')])
    expect(cudaLibraryDirs({ APPDATA }, fs.exists, fs.list)).toEqual([])
  })
})

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

export class SettingsService {
  private static instance: SettingsService
  private current: AppSettings = { ...DEFAULT_SETTINGS }
  private filePath: string

  static getInstance() {
    if (!SettingsService.instance) SettingsService.instance = new SettingsService()
    return SettingsService.instance
  }

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'goga-settings.json')
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<AppSettings>
        // Merge with defaults so new fields added to DEFAULT_SETTINGS are picked up
        this.current = { ...DEFAULT_SETTINGS, ...saved }
      }
    } catch { this.current = { ...DEFAULT_SETTINGS } }
  }

  private save() {
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.current, null, 2)) } catch { /* ignore */ }
  }

  get() { return { ...this.current } }

  set(patch: Partial<AppSettings>) {
    this.current = { ...this.current, ...patch }
    this.save()
    return { ...this.current }
  }
}

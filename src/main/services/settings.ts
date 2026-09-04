import type { AppSettings } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store')

export class SettingsService {
  private static instance: SettingsService
  private store: ReturnType<typeof Store>

  static getInstance() {
    if (!SettingsService.instance) SettingsService.instance = new SettingsService()
    return SettingsService.instance
  }

  constructor() {
    this.store = new Store({
      name: 'settings',
      defaults: DEFAULT_SETTINGS
    })
  }

  get(): AppSettings {
    // Merge with defaults so new fields added to DEFAULT_SETTINGS are always present
    return { ...DEFAULT_SETTINGS, ...this.store.store } as AppSettings
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.store.set(patch)
    return this.get()
  }
}

import type { GogaAPI } from '../preload/index'

declare global {
  interface Window {
    goga: GogaAPI
  }
}

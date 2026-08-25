import type { CSSProperties } from 'react'

export interface ElectronCSSProperties extends CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag'
}

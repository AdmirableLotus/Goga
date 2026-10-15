// Import each tool module to trigger their self-registration side effects
import './computer'
import './shell'
import './filesystem'
import './process'
import './web'
import './memory'
import './browser'
import './vision'
import './clock'
import './notepadSave'

export { ToolRegistry } from './registry'

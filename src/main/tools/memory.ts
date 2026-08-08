import { ToolRegistry } from './registry'
import { BrainService } from '../services/brain'
import { MemoryService } from '../services/memory'

const reg = ToolRegistry.getInstance()

reg.register({
  name: 'memory.search',
  description: 'Search Goga\'s persistent memory for facts relevant to a query.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query.' } },
    required: ['query']
  },
  riskLevel: 'low', reversible: true, category: 'memory'
}, async (p) => {
  const facts = BrainService.getInstance().getRelevantFacts(p.query as string)
  return { success: true, data: facts }
})

reg.register({
  name: 'memory.save',
  description: 'Save a key-value pair to persistent memory for later retrieval.',
  parameters: {
    type: 'object',
    properties: {
      key:   { type: 'string', description: 'Memory key.' },
      value: { type: 'string', description: 'Value to store.' }
    },
    required: ['key', 'value']
  },
  riskLevel: 'low', reversible: true, category: 'memory'
}, async (p) => {
  const entry = MemoryService.getInstance().set(p.key as string, p.value)
  return { success: true, data: entry }
})

export function registerMemoryTools() {
  return ToolRegistry.getInstance()
}

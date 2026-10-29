// Programmatic startup avoids bundling vitest.config.ts in restricted workspaces.
import { startVitest } from 'vitest/node'

const context = await startVitest('test', [
  'src/main/services/__tests__/security-guide.test.ts',
  'src/main/services/__tests__/hackerone-workflow.test.ts',
  'src/main/services/__tests__/security-emergency-stop.test.ts',
], { config: false, watch: false })
if (!context) process.exitCode = 1

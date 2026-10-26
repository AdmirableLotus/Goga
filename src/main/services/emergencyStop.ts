import { SecurityWorkspaceService } from './securityWorkspace'
import { MissionEngine } from './missionEngine'
import { AgentLoop } from './agentLoop'
import { ActionStore } from './actionStore'
import { stopDeveloperTask } from '../handlers/developer'
import { LogService } from './logs'

export function emergencyStop(reason = 'Emergency stop') {
  const security = SecurityWorkspaceService.getInstance()
  security.invalidateApprovals()
  const active = security.getActive()
  ActionStore.getInstance().stopAll()
  AgentLoop.getInstance().stop(reason)
  const missions = MissionEngine.getInstance()
  for (const mission of missions.listMissions()) {
    if (!['completed', 'failed', 'cancelled'].includes(mission.status)) missions.stop(mission.id)
  }
  stopDeveloperTask()
  // Audit I/O must never prevent cancellation of an in-flight action.
  if (active) {
    try { security.logAudit(active.id, { tool: 'security.stop', target: '', params: {}, result: reason, inScope: false }) }
    catch { LogService.getInstance().error('Emergency stop completed; security audit could not be persisted') }
  }
}

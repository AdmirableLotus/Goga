import { MissionEngine } from './missionEngine'
import { AgentLoop } from './agentLoop'
import { ActionStore } from './actionStore'
import { stopDeveloperTask } from '../handlers/developer'
import { killAll } from './lab/runner'

export function emergencyStop(reason = 'Emergency stop') {
  ActionStore.getInstance().stopAll()
  AgentLoop.getInstance().stop(reason)
  const missions = MissionEngine.getInstance()
  for (const mission of missions.listMissions()) {
    if (!['completed', 'failed', 'cancelled'].includes(mission.status)) missions.stop(mission.id)
  }
  stopDeveloperTask()
  // Any offensive Lab process (nmap, nuclei, a running spray) stops with everything else.
  killAll(reason)
}

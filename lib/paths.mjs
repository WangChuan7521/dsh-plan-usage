/**
 * Where this plugin keeps its files. Its own module because both the
 * credential chain and the orchestrator need the harness home, and neither
 * should import the other to get it.
 * @module dsh-plan-usage/lib/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the plugin mirrors its latest document. */
export const SNAPSHOT_FILE = 'plan-usage.json'

/** Where per-provider day baselines live. */
export const STATE_FILE = 'plan-usage-state.json'

/** The harness home directory, honouring `$DSH_HOME`. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** The state file's path. */
export function statePath() {
  return join(dshHome(), STATE_FILE)
}

/** The snapshot file's path. */
export function snapshotPath() {
  return join(dshHome(), SNAPSHOT_FILE)
}

/**
 * What `serve` and `answer` both need: the task configuration, the agent each profile runs on, the
 * state files, and the channel. Each step prints its reason and sets the exit code when it has
 * nothing to return, the same contract as `choose.ts`, so a handler only has to stop.
 */

import {
  openAgent,
  ServeConfigError,
  type AgentCommand,
  type AgentHandle,
  type LotsePaths,
  type ServeChannel,
  type ServeDeps,
} from '@lotse/core';

import type { ServePaths } from '../../core/paths.ts';
import { actionLog, questionBook, taskLock } from '../../core/serve-state.ts';
import { loadTasks, TasksFileMissingError, type LoadedTasks } from '../../core/serve-config.ts';
import { agentForNew } from './choose.ts';
import { err } from './output.ts';

export function readTasks(serve: ServePaths): LoadedTasks | null {
  try {
    const loaded = loadTasks(serve.tasksFile);
    if (loaded.warning) err(`  ${loaded.warning}`);
    return loaded;
  } catch (error) {
    if (!(error instanceof ServeConfigError || error instanceof TasksFileMissingError)) throw error;
    err(error instanceof ServeConfigError ? `${serve.tasksFile}: ${error.message}` : error.message);
    process.exitCode = 1;
    return null;
  }
}

/** Every profile's agent, resolved once at start: a launcher that is missing stops `serve` before any run. */
function agentsFor(paths: LotsePaths, loaded: LoadedTasks): Map<string, AgentCommand> | null {
  const commands = new Map<string, AgentCommand>();
  for (const profile of loaded.config.profiles) {
    const resolved = agentForNew(paths, profile.agent ?? undefined);
    if (!resolved) return null;
    commands.set(profile.id, resolved.command);
  }
  return commands;
}

/** Agents still open, so a stopping `serve` can end them instead of leaving them behind. */
export interface OpenAgents {
  readonly open: ServeDeps['open'];
  closeAll(): Promise<void>;
}

export function trackedAgents(): OpenAgents {
  const handles = new Set<AgentHandle>();
  return {
    open: async (options) => {
      const handle = await openAgent(options);
      handles.add(handle);
      return {
        client: handle.client,
        logLines: handle.logLines,
        agentInfo: handle.agentInfo,
        close: () => {
          handles.delete(handle);
          return handle.close();
        },
      };
    },
    closeAll: async () => {
      await Promise.all([...handles].map((handle) => handle.close()));
      handles.clear();
    },
  };
}

export interface DepsOptions {
  readonly paths: LotsePaths;
  readonly serve: ServePaths;
  readonly loaded: LoadedTasks;
  readonly channel: ServeChannel;
  readonly open: ServeDeps['open'];
  readonly quiet: boolean;
}

export function serveDeps(options: DepsOptions): ServeDeps | null {
  const commands = agentsFor(options.paths, options.loaded);
  if (!commands) return null;
  const now = () => new Date();
  const { stateDir } = options.serve;
  return {
    config: options.loaded.config,
    open: options.open,
    commandFor: (profile) => {
      const command = commands.get(profile.id);
      if (!command) throw new Error(`profile "${profile.id}" has no resolved agent`);
      return command;
    },
    promptFor: (task) => options.loaded.promptFor(task),
    channel: options.channel,
    questions: questionBook(stateDir, now, (problem) => err(`  ${problem}`)),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    lock: taskLock(stateDir),
    log: actionLog(stateDir, now),
    ...(options.quiet ? {} : { onAgentLog: (line: string) => err(`  [agent] ${line}`) }),
  };
}

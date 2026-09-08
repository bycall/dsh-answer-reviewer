/**
 * ConfigStore: persistent, hot-reloadable configuration for dsh-answer-reviewer.
 *
 * Responsibilities:
 *   * Hold the current effective `Config` (frozen) in memory.
 *   * Persist user overrides to a JSON file on disk (atomic write).
 *   * Validate partial updates through the same `resolveConfig` path the
 *     initial mount uses, so on-disk and on-memory shapes cannot diverge.
 *   * Subscribe (`onChange`) so the host can react to live edits without
 *     a restart.
 *   * Keep a small in-memory activity ring buffer so the config UI can
 *     surface "the last 20 review outcomes" — diagnostics, not a log.
 *
 * Out of scope:
 *   * File watchers (external edits to the JSON file are not auto-picked
 *     up; users go through the config UI / API). Keeps the surface tiny.
 *   * Migration / versioning. The on-disk shape is whatever `Config` says
 *     today; if the schema changes incompatibly, the loader falls back to
 *     defaults and logs a warning.
 *
 * @module dsh-answer-reviewer/config-store
 */

import { writeFile, rename, readFile, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveConfig, DEFAULT_THRESHOLD } from './review.js'

/** In-memory ring buffer size for review-activity entries. */
const ACTIVITY_RING_SIZE = 50

/** Public surface of the store; the `apply` path is the only thing that
 *  touches the raw state. */
export async function createConfigStore({
  defaults,
  filePath,
  logger = null,
  onChange = null,
}) {
  if (!defaults || typeof defaults !== 'object') {
    throw new Error('createConfigStore: defaults (frozen Config) is required')
  }
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('createConfigStore: filePath is required')
  }

  // `overrides` is what the user actually wrote; `effective` is the merged
  // frozen Config. We keep both so persist() only writes what the user
  // explicitly chose — defaults are not duplicated to disk.
  let overrides = Object.create(null)
  let effective = defaults
  const subscribers = new Set()
  const activity = []

  if (typeof onChange === 'function') subscribers.add(onChange)

  function logInfo(message) {
    if (logger && typeof logger.info === 'function') logger.info(message)
  }
  function logWarn(message) {
    if (logger && typeof logger.warn === 'function') logger.warn(message)
  }

  function emit() {
    for (const fn of subscribers) {
      try { fn(effective) } catch (error) { logWarn(`dsh-answer-reviewer: onChange handler threw: ${String(error)}`) }
    }
  }

  /** Compute a new effective config from the given overrides object. */
  function compute(over) {
    return resolveConfig({ ...defaults, ...over })
  }

  /** Read the override file from disk and merge into in-memory state. Safe
   *  to call once at startup; if the file is missing, malformed, or fails
   *  the resolver, we fall back to defaults and log a warning. */
  async function load() {
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      logWarn(`dsh-answer-reviewer: could not read ${filePath}: ${String(error)}; using defaults`)
      return false
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      logWarn(`dsh-answer-reviewer: ${filePath} is not valid JSON: ${String(error)}; using defaults`)
      return false
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logWarn(`dsh-answer-reviewer: ${filePath} must be a JSON object; using defaults`)
      return false
    }
    try {
      const next = compute(parsed)
      // Only commit if the override set is valid; otherwise we keep defaults.
      overrides = parsed
      effective = next
      logInfo(`dsh-answer-reviewer: loaded overrides from ${filePath}`)
      emit()
      return true
    } catch (error) {
      logWarn(`dsh-answer-reviewer: ${filePath} failed validation: ${String(error)}; using defaults`)
      return false
    }
  }

  /** Apply a partial update. Returns the new effective config on success,
   *  or `{ error }` on validation failure (no state change in that case). */
  async function update(partial) {
    if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
      return { error: 'partial must be a JSON object' }
    }
    const merged = { ...overrides, ...partial }
    let next
    try {
      next = compute(merged)
    } catch (error) {
      return { error: String(error) }
    }
    overrides = merged
    effective = next
    try {
      await persist(overrides)
    } catch (error) {
      logWarn(`dsh-answer-reviewer: could not persist config to ${filePath}: ${String(error)}`)
      return { error: `persistence failed: ${String(error)}` }
    }
    emit()
    return { config: next }
  }

  /** Wipe overrides back to defaults. Removes the on-disk file so the
   *  next `load()` also sees the canonical "no overrides" state. */
  async function reset() {
    overrides = Object.create(null)
    effective = defaults
    try {
      await unlink(filePath)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        logWarn(`dsh-answer-reviewer: could not remove ${filePath}: ${String(error)}`)
      }
    }
    emit()
    return { config: effective }
  }

  /** Atomic write: write to a tmp file in the same directory then rename. */
  async function persist(over) {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true })
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(over, null, 2)}\n`, 'utf8')
    await rename(tmp, filePath)
  }

  function get() { return effective }
  function getOverrides() { return { ...overrides } }
  function getPath() { return filePath }
  function getSource() {
    return Object.keys(overrides).length === 0 ? 'defaults' : 'file'
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new Error('subscribe: fn must be a function')
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  function recordActivity(entry) {
    if (!entry || typeof entry !== 'object') return
    const stamped = { ...entry, at: entry.at ?? new Date().toISOString() }
    activity.push(stamped)
    if (activity.length > ACTIVITY_RING_SIZE) activity.shift()
  }

  function getRecent() { return activity.slice() }

  return Object.freeze({
    load,
    update,
    reset,
    get,
    getOverrides,
    getPath,
    getSource,
    subscribe,
    recordActivity,
    getRecent,
  })
}

/** Default config-file path: `~/.dsh/answer-reviewer.json`. Override with
 *  the `REVIEWER_CONFIG_PATH` environment variable. */
export function defaultConfigPath(env = process.env, home = '') {
  if (env.REVIEWER_CONFIG_PATH && typeof env.REVIEWER_CONFIG_PATH === 'string') {
    return env.REVIEWER_CONFIG_PATH
  }
  const h = home || env.HOME || env.USERPROFILE || ''
  if (h.length === 0) return null
  return `${h}/.dsh/answer-reviewer.json`
}

/** Constants for the HTTP layer: the port we bind to and the env-var
 *  override. Kept in this module so the server and the test fixtures agree. */
export const DEFAULT_HTTP_PORT = 3987
export const HTTP_PORT_ENV = 'REVIEWER_HTTP_PORT'

/** HTTP control surface — the server reads this constant to decide whether
 *  the local config server is enabled. `REVIEWER_HTTP=0` disables it. */
export const HTTP_ENABLED_ENV = 'REVIEWER_HTTP'

/** Re-export the gate default for callers that want to label the UI. */
export { DEFAULT_THRESHOLD }

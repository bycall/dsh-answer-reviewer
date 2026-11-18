/**
 * ESM resolve hook for dsh >= 0.2.2, whose `@deepseek-ai/*` host packages live
 * inside a desktop `app.asar` instead of a normal `node_modules` tree.
 *
 * Why a hook is needed at all: Node's ESM resolver stats each candidate
 * `node_modules/<pkg>` with an internal binding that is NOT asar-aware, so a
 * symlink pointing into an asar reports ENOTDIR and a bare import such as
 * `import '@deepseek-ai/dsh-llm'` fails with ERR_MODULE_NOT_FOUND. Electron's
 * `fs` *is* asar-aware, and once an importer is itself inside the archive its
 * own bare imports resolve normally — so mapping the top-level specifier to the
 * archive's real file URL is enough to make the whole dependency graph load.
 *
 * Active only when `DSH_ASAR_NM` is set (smoke.mjs sets it). Any other
 * specifier falls straight through to Node's default resolution.
 */
import { existsSync, readFileSync } from 'node:fs'

const ROOT = process.env.DSH_ASAR_NM || ''

/** Resolve `exports` for a package that only declares the `.` entry. */
function entryOf(pkgDir) {
  const candidates = [`${pkgDir}/lib/index.js`, `${pkgDir}/index.js`]
  try {
    const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
    const exp = pkg.exports
    const dot = typeof exp === 'string' ? exp
      : exp && typeof exp === 'object' ? (exp['.'] ?? exp)
      : null
    const rel = typeof dot === 'string' ? dot
      : dot && typeof dot === 'object' ? (dot.default ?? dot.import ?? dot.require)
      : null
    if (typeof rel === 'string') candidates.unshift(`${pkgDir}/${rel.replace(/^\.\//, '')}`)
    if (typeof pkg.main === 'string') candidates.push(`${pkgDir}/${pkg.main.replace(/^\.\//, '')}`)
  } catch { /* no/unreadable package.json — fall back to convention */ }
  return candidates.find((p) => existsSync(p)) ?? null
}

export async function resolve(specifier, context, nextResolve) {
  if (ROOT && specifier.startsWith('@deepseek-ai/')) {
    const rest = specifier.slice('@deepseek-ai/'.length)
    const slash = rest.indexOf('/')
    const pkg = slash === -1 ? rest : rest.slice(0, slash)
    const sub = slash === -1 ? '' : rest.slice(slash + 1)
    const dir = `${ROOT}/${pkg}`
    if (existsSync(dir)) {
      let target = null
      if (!sub) {
        target = entryOf(dir)
      } else {
        target = [`${dir}/${sub}`, `${dir}/${sub}.js`, `${dir}/${sub}/index.js`].find((p) => existsSync(p)) ?? null
      }
      if (target) {
        return { url: `file://${encodeURI(target)}`, shortCircuit: true }
      }
    }
  }
  return nextResolve(specifier, context)
}

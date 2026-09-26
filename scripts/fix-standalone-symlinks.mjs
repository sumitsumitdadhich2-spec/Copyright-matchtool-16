#!/usr/bin/env node
/**
 * Post-build repair for `output: 'standalone'` + pnpm.
 *
 * Next's file tracer copies `node_modules/.pnpm/<pkg>@<ver>/node_modules/<dep>`
 * symlinks into `.next/standalone`, but for some transitive packages it never
 * copies the symlink TARGET (`.pnpm/<dep>@<ver>/node_modules/<dep>`). The link
 * ends up dangling and the server crashes at runtime, e.g.
 *
 *   Error: Failed to load external module @google/genai: Cannot find module 'gcp-metadata'
 *
 * This script walks `.next/standalone/node_modules`, finds every dangling
 * symlink, and copies the missing `.pnpm/<dep>@<ver>/node_modules` directory
 * from the real `node_modules` (keeping its own symlinks intact). Because a
 * newly copied package can itself point at more missing packages, it loops
 * until no dangling links remain.
 *
 * Usage (project root, after `next build`):
 *   node scripts/fix-standalone-symlinks.mjs
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const realModules = join(root, 'node_modules')
const standalone = join(root, '.next', 'standalone')
const standaloneModules = join(standalone, 'node_modules')

if (!existsSync(standaloneModules)) {
  console.error(`[fix-standalone-symlinks] ${standaloneModules} not found - run \`next build\` first`)
  process.exit(1)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isSymbolicLink()) yield p
    else if (entry.isDirectory()) yield* walk(p)
  }
}

/**
 * Copy `src` into `dst`, adding only what is missing. The tracer may already
 * have placed part of a package (e.g. gcp-metadata's own files but not its
 * sibling dependency symlinks), so existing entries are left untouched and
 * directories are merged. Symlinks are copied verbatim (not dereferenced) so
 * the pnpm layout inside the standalone tree stays identical to the real one.
 */
function copyMissing(src, dst) {
  const st = lstatSync(src)
  if (st.isSymbolicLink()) {
    if (!existsSync(dst) && !isLink(dst)) symlinkSync(readlinkSync(src), dst)
    return
  }
  if (st.isDirectory()) {
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true })
    for (const name of readdirSync(src)) copyMissing(join(src, name), join(dst, name))
    return
  }
  if (!existsSync(dst)) copyFileSync(src, dst)
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function findDangling() {
  const out = []
  for (const link of walk(standaloneModules)) {
    try {
      statSync(link) // follows the link; throws if the target is missing
    } catch {
      out.push(link)
    }
  }
  return out
}

let pass = 0
let copied = 0
for (;;) {
  const dangling = findDangling()
  if (dangling.length === 0) break
  pass += 1
  if (pass > 20) {
    console.error('[fix-standalone-symlinks] gave up after 20 passes; still dangling:')
    for (const l of dangling) console.error('  ' + relative(standalone, l))
    process.exit(1)
  }

  let progressed = false
  for (const link of dangling) {
    // Resolve where the link points inside the standalone tree...
    const targetInStandalone = resolve(dirname(link), readlinkSync(link))
    // ...and map that path back onto the real node_modules.
    const rel = relative(standaloneModules, targetInStandalone)
    const targetInReal = join(realModules, rel)
    if (!existsSync(targetInReal)) {
      console.warn(`[fix-standalone-symlinks] no source for ${relative(standalone, link)} -> ${rel}`)
      continue
    }

    // Copy the whole `.pnpm/<dep>@<ver>/node_modules` directory so the package
    // gets its own sibling symlinks (its dependencies) too. Fall back to the
    // exact target for anything outside the .pnpm layout.
    const m = rel.match(/^(\.pnpm\/[^/]+\/node_modules)\//)
    const srcDir = m ? join(realModules, m[1]) : targetInReal
    const dstDir = m ? join(standaloneModules, m[1]) : targetInStandalone

    copyMissing(srcDir, dstDir)
    copied += 1
    progressed = true
    console.log(`[fix-standalone-symlinks] restored ${relative(standaloneModules, dstDir)}`)
  }

  if (!progressed) {
    console.error('[fix-standalone-symlinks] could not repair remaining dangling symlinks')
    process.exit(1)
  }
}

console.log(`[fix-standalone-symlinks] done - ${copied} package dir(s) restored in ${pass} pass(es), 0 dangling symlinks`)

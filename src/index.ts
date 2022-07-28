import { join, resolve, basename, dirname, isAbsolute } from 'path'
import { crawl, GlobMatcher } from 'recrawl'
import fs = require('saxon/sync')
import spawn from './spawn'
import checksum from './checksum'
import createLog from './log'

const PKG_JSON = 'package.json'
const CACHE_NAME = '.bic_cache'
const ALWAYS_SKIP = ['.*', 'node_modules']

/** Each key is a relative path. Each value holds the "mtime" and content hash. */
export type Cache = { [key: string]: [number, string] }

/** These options are shared between all exports */
export type Options = {
  cwd: string
  skip?: string[]
  filter?: (file: string, name?: string) => boolean
  force?: boolean
}

/** "bic" config from "package.json" */
export type Config = {
  only?: string[]
  skip?: string[]
}

export type PackageJson = {
  [key: string]: any
  name: string
  root: string
  dependencies?: { [key: string]: string }
  scripts?: { [key: string]: string }
  cache?: Cache
  bic?: Config | string[] | false
}

export const findPackages = (opts: Options) => {
  const filter: GlobMatcher | undefined =
    opts.filter &&
    ((file, name) => {
      return opts.filter!(join(opts.cwd, file), name)
    })
  return crawl(opts.cwd, {
    only: [PKG_JSON],
    skip: ALWAYS_SKIP.concat(opts.skip || []),
    enter: filter && (dir => filter(dir)),
    filter,
  })
}

export const loadPackages = (
  packages: string[],
  opts: Options
): PackageJson[] => {
  const log = createLog(opts)
  return packages
    .map(pkg => {
      pkg = resolve(opts.cwd, pkg)
      if (!isAbsolute(pkg)) {
        log.warn('Package path must be absolute:\n  %O', pkg)
        return
      }
      if (basename(pkg) === PKG_JSON) {
        pkg = dirname(pkg)
      }
      const configPath = join(pkg, PKG_JSON)
      if (!fs.isFile(configPath)) {
        log.warn('Package has no "%s" module:\n  %O', PKG_JSON, pkg)
        return
      }
      try {
        const config = fs.readJson(configPath)
        config.root = pkg
        if (!config.name) {
          config.name = basename(pkg)
        }
        return config
      } catch {
        log.warn('Package has invalid "%s" module:\n  %O', PKG_JSON, pkg)
      }
    })
    .filter(Boolean)
}

export const buildPackages = async (packages: PackageJson[], opts: Options) => {
  const log = createLog(opts)
  type Process = ReturnType<typeof spawn>
  const procs = new Set<Process>()
  return runTopological(packages, pkg => {
    const cmd = getRunner(pkg.root)
    const proc = spawn(`${cmd} run build`, {
      cwd: pkg.root,
    })
    procs.add(proc)

    const prefix = getPrefix(pkg.name)
    proc.stdout.on('data', data => {
      getLines(data).forEach(line => {
        log(prefix, line)
      })
    })
    proc.stderr.on('data', data => {
      getLines(data).forEach(line => {
        process.stderr.write(`${prefix} ${line}\n`)
      })
    })

    return new Promise<void>((resolve, reject) => {
      proc.on('error', err => {
        console.error(err)
        onExit(1)
      })
      proc.on('exit', onExit)
      function onExit(code: number) {
        procs.delete(proc)
        // Update the cache only if the build succeeds.
        if (code === 0) {
          fs.write(join(pkg.root, CACHE_NAME), JSON.stringify(pkg.cache))
          resolve()
        } else {
          reject(new Error('Build failed: ' + pkg.root))
        }
      }
    })
  }).catch(err => {
    // Stop all processes on error.
    procs.forEach(proc => proc.kill())
    throw err
  })
}

export const getChanged = (packages: PackageJson[], opts: Options) => {
  const promises = packages.map(async pkg => {
    let config = pkg.bic == null ? {} : pkg.bic
    if (config === false) {
      return null
    }
    if (Array.isArray(config)) {
      config = { only: config }
    }

    // Bail when the "build" script is empty or it executes
    // the "bic" or "build-if-changed" command.
    const script = pkg.scripts && pkg.scripts.build
    if (!script || /\b(bic|build-if-changed)\b/.test(script)) {
      return null
    }

    const filter: GlobMatcher | undefined =
      opts.filter &&
      ((file, name) => {
        return opts.filter!(join(pkg.root, file), name)
      })

    const files = await crawl(pkg.root, {
      only: config.only,
      skip: ALWAYS_SKIP.concat(config.skip || []),
      enter: filter && (dir => filter(dir)),
      filter,
    })

    const cachePath = join(pkg.root, CACHE_NAME)
    const cache: Cache = fs.isFile(cachePath) ? fs.readJson(cachePath) : {}

    // Track changed paths for easier debugging.
    const changed: string[] = []

    // Look for deleted files.
    for (const name in cache)
      if (!files.includes(name)) {
        delete cache[name]
        changed.push(name)
      }

    // Look for added/changed files.
    await Promise.all(
      files.map(async name => {
        const path = join(pkg.root, name)
        const prev = cache[name] || [0, '']
        const mtime = Number(fs.stat(path).mtime)
        if (mtime !== prev[0]) {
          const hash = await checksum(path)
          if (hash !== prev[1]) {
            cache[name] = [mtime, hash]
            changed.push(name)
          } else {
            prev[0] = mtime
          }
        }
      })
    )

    if (changed.length || opts.force) {
      pkg.cache = cache
      return pkg
    }
    return null
  })

  return Promise.all(promises).then(filterTruthy)
}

const runTopological = <T>(
  packages: PackageJson[],
  action: (pkg: PackageJson) => Promise<T>
): Promise<T[]> => {
  const promises: Promise<T>[] = []
  const run = (pkg: PackageJson, index: number) =>
    promises[index] ||
    (promises[index] = Promise.all(
      Object.entries(pkg.dependencies || {}).map(([name, value]) => {
        let predicate: (pkg: PackageJson) => boolean
        if (value.startsWith('link:')) {
          const root = resolve(pkg.root, value.slice(5))
          predicate = pkg => pkg.root === root
        } else {
          predicate = pkg => pkg.name === name
        }
        const index = packages.findIndex(predicate)
        return index >= 0 && run(packages[index], index)
      })
    ).then(() => action(pkg)))

  packages.forEach(run)
  return Promise.all(promises)
}

const nextColor = (() => {
  const colors = require('./colors').default
  const keys = Object.keys(colors).reverse()
  let i = 0
  return () => {
    const key = keys[i++]
    if (i >= keys.length) i = 0
    return colors[key]
  }
})()

function getPrefix(name) {
  return nextColor()(`[${name}]`)
}

function getLines(data: string) {
  return data
    .toString()
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '')
    .split(/\r?\n/)
}

function getRunner(directory: string) {
  if (fs.isFile(join(directory, 'package-lock.json'))) {
    return 'npm'
  } else if (fs.isFile(join(directory, 'yarn.lock'))) {
    return 'yarn'
  } else if (fs.isFile(join(directory, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }

  return getRunner(join(directory, '..'))
}

type Falsy = null | undefined | false | 0 | ''

function filterTruthy<T>(changed: T[]): Exclude<T, Falsy>[] {
  return changed.filter(Boolean) as any
}

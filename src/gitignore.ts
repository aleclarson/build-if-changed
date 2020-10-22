import { basename, dirname, join, relative, isAbsolute } from 'path'
import { createMatcher, GlobMatcher } from 'recrawl'
import fs = require('saxon/sync')
import * as os from 'os'

const readLines = path => fs.read(path).split(/\r?\n/)
const isHomeDir = path => path === '/' || path === os.homedir()

export class GitIgnore {
  readonly matchRootGlobs: GlobMatcher | null
  constructor(
    /** Tree paths are relative to this */
    readonly rootDir: string,
    /** This maps tree paths to their own glob registry */
    readonly globTree: { [pathId: string]: GlobMatcher | false } = {},
    /** These globs are always used */
    readonly rootGlobs = ['.*', 'node_modules']
  ) {
    this.matchRootGlobs = createMatcher(rootGlobs)
  }
  test(file: string, name?: string) {
    if (!isAbsolute(file)) {
      throw Error('Expected an absolute path')
    }
    if (!name) {
      name = basename(file)
    }
    let match: GlobMatcher | false | null
    if ((match = this.matchRootGlobs)) {
      if (match(file, name)) return true
    }
    for (let dir = dirname(file); !isHomeDir(dir); dir = dirname(dir)) {
      const path = join(dir, '.gitignore')
      const pathId = relative(this.rootDir, path)

      match = this.globTree[pathId]
      if (match !== false) {
        if (match) {
          if (match(file, name)) {
            return true
          }
        } else if (fs.isFile(path)) {
          const lines = readLines(path).filter(line => line && line[0] !== '#')
          match = createMatcher(lines, glob =>
            join(dir, glob).replace(/\\/g, '/')
          )
          this.globTree[pathId] = match || false
          if (match && match(file, name)) {
            return true
          }
        } else {
          this.globTree[pathId] = false
        }
      }

      // Never use .gitignore outside the git repository.
      if (fs.isDir(join(dir, '.git'))) {
        break
      }
    }
    return false
  }
}

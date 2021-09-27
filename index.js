#!/usr/bin/env node
const { execSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const yaml = require('js-yaml')
const chalk = require('chalk')

const DELIMITER = '::\t'

function detectSLSConfig(argv) {
  if (!argv.serverless) {
    const paths = [
      'serverless.yml',
      'serverless.yaml',
      'sls.yml',
      'sls.yaml',
    ].map((f) => join(process.cwd(), f))
    for (const p of paths) {
      if (existsSync(p)) {
        argv.serverless = p
        break
      }
    }
  }
}

const NODE_REGEX = [
  // env['key'] or env.prop with `||` default support
  new RegExp(/env(\[["|'](?<key>\w*)["|']\]|\.(?<prop>\w*))(?<def>\s*\|\|)?/g),
  // destructuring such as { dict } = process.env
  new RegExp(/{(?<dict>(?:[^}]{1})*)}\s*=\s*process.env/g), // TODO: this regex chokes on string with chalk usage
]

function jsParser(text) {
  if (text.startsWith('//') || text.startsWith('/*')) {
    return { vars: [] }
  }
  const vars = new Set()
  const defaults = new Set()
  for (const regex of NODE_REGEX) {
    const matches = text.matchAll(regex)
    for (const match of matches) {
      const { key, prop, def, dict } = match.groups
      if (dict) { // destructuring case
        dict.split(',').map((v) => v.trim()).filter((v) => v).forEach((v) => {
          const [k, d] = v.split('=').map((s) => s.trim())
          const _var = k.split(':')[0].trim()
          vars.add(_var)
          if (d) {
            defaults.add(_var)
          }
        })
      } else if (key || prop) {
        vars.add(key || prop)
        if (def) {
          defaults.add(key || prop)
        }
      }
    }
  }
  return {
    vars: Array.from(vars),
    defaults: Array.from(defaults),
  }
}

// handles environ.get, getenv, getenvb, with default/fallback support (not through `or`)
const PYTHON_REGEX = new RegExp(/(environ\.get|getenvb?)\(('|")(?<env>\w+)('|")(,('|")?(?<fallback>[^)]*)('|")?)?\)/g)

function pyParser(text) {
  if (text.startsWith('#')) {
    return { vars: [] }
  }
  const vars = new Set()
  const defaults = new Set()
  const matches = text.matchAll(PYTHON_REGEX)
  for (const match of matches) {
    const { env, fallback } = match.groups
    vars.add(env)
    if (fallback) {
      defaults.add(env)
    }
  }
  return {
    vars: Array.from(vars),
    defaults: Array.from(defaults),
  }
}

const EXTS = {
  '.js': { parser: jsParser },
  '.mjs': { parser: jsParser },
  '.py': { parser: pyParser },
}

function parser(item) {
  const [fp, text] = item.split(DELIMITER).map((s) => s.trim())
  if (text.endsWith('<ignore scan-env>')) {
    return { fp, vars: [] }
  }
  for (const ext in EXTS) {
    if (fp.endsWith(ext)) {
      return { fp, ...EXTS[ext].parser(text) }
    }
  }
  return { fp, vars: [] }
}

function getVars(raw) {
  const items = raw.split('\n').filter((v) => v.length > 0)
  return items.map(parser)
    .filter(({ vars }) => vars.length > 0)
    .reduce((acc, { fp, vars, defaults }) => {
      acc[fp] = acc[fp] || { vars, defaults }
      acc[fp].vars = Array.from(new Set(acc[fp].vars.concat(vars))).filter((d) => d)
      acc[fp].defaults = Array.from(new Set((acc[fp].defaults || []).concat(defaults))).filter((d) => d)
      return acc
    }, {})
}

function buildNeeded(allVars) {
  return Object.entries(allVars).reduce((acc, [fp, { vars }]) => {
    vars.forEach((v) => {
      acc[v] = new Set(acc[v] || [])
      acc[v].add(fp)
    })
    return acc
  }, {})
}

function seekSLSEnvs(yml) {
  let vars = []
  for (const key in yml) {
    if (key === 'environment') {
      vars = vars.concat(Object.keys(yml[key]))
    }
    if (typeof yml[key] === 'object') {
      vars = vars.concat(seekSLSEnvs(yml[key]))
    }
  }
  return vars
}

function formatWarning({ missing, allVars }) {
  let warning = ''
  let totalDefs = 0
  let total = 0
  Object.entries(missing).forEach(([v, fps]) => {
    let defs = 0
    const _fps = Array.from(fps).map((fp) => {
      total += 1
      if (allVars[fp].defaults.includes(v)) {
        defs += 1
        return `${fp} ${chalk.yellow('(has default)')}`
      }
      return fp
    }).filter((s) => s)
    totalDefs += defs
    if (_fps.length) {
      warning += `${chalk[_fps.length === defs ? 'yellow' : 'red'].bold(v)}:\n\t${_fps.join('\n\t')}\n`
    }
  })
  return { warning, allDef: totalDefs === total }
}

function formatAll({ needed, verbose }) {
  const uniques = { vars: [], files: [] }
  let maxWidth = 0
  const _needed = Object.entries(needed).reduce((acc, [k, fps]) => {
    acc[k] = Array.from(fps)
    uniques.vars.push(k)
    uniques.files = uniques.files.concat(acc[k])
    maxWidth = Math.max(maxWidth, k.length)
    return acc
  }, {})
  uniques.vars = new Set(uniques.vars)
  uniques.files = new Set(uniques.files)
  const sVars = `${chalk.bold(uniques.vars.size)} env var${uniques.vars.size > 1 ? 's' : ''}`
  const sFiles = `${chalk.bold(uniques.files.size)} file${uniques.files.size > 1 ? 's' : ''}`
  let s = chalk.blue(`${sVars} found in ${sFiles}`)
  if (verbose) {
    s += `\n`
    Object.entries(_needed).forEach(([k, fps]) => {
      const withSpaces = chalk.blue(k) + ' '.repeat(1 + (maxWidth - k.length))
      s += withSpaces
      fps.forEach((fp, i) => {
        if (!i) {
          s += fp
        } else {
          s += fp.padStart(withSpaces.length + fp.length - 10)
        }
        s += '\n'
      })
    })
  }
  return s
}

function buildMissing({ needed, available }) {
  const missing = {}
  Object.entries(needed).forEach(([v, fps]) => {
    if (!available.has(v)) {
      missing[v] = fps
    }
  })
  return missing
}

function buildUnused({ needed, available }) {
  const neededSet = new Set(Object.keys(needed).reduce((acc, curr) => {
    acc.push(curr)
    return acc
  }, []))
  return new Set([...available].filter((v) => !neededSet.has(v)))
}

function output({ serverless, allVars, strict, verbose }) {
  const needed = buildNeeded(allVars)
  let available = new Set(Object.keys(process.env))
  if (serverless) {
    const yml = yaml.load(readFileSync(serverless), 'utf8')
    available = new Set(seekSLSEnvs(yml))
    const unused = buildUnused({ needed, available })
    if (unused.size) {
      console.log(chalk.yellow(`Unused from ${chalk.bold(serverless)}\n\n${[...unused].map((v) => chalk.bold(v)).join('\n')}\n`))
    }
  }
  const missing = buildMissing({ needed, available })
  if (Object.keys(missing).length) {
    const { warning, allDef } = formatWarning({ serverless, missing, allVars })
    if (warning) {
      const prefix = chalk.yellow(`Missing in ${chalk.bold(serverless || 'live context')}`)
      console[strict ? 'error' : 'warn'](`${prefix}\n\n${warning}`)
      if (strict && !allDef) {
        process.exit(1)
      }
    }
  }
  if (verbose) {
    if (Object.keys(needed).length) {
      console.log(formatAll({ needed, verbose }))
    } else {
      console.warn(chalk.yellow('No env vars detected'))
    }
  }
}

if (require.main === module) {
  const { argv } = require('yargs')(process.argv.slice(2))
    .options({
      serverless: {
        type: 'string',
        alias: 'sls',
        describe: 'Specify a serverless configuration YAML file; otherwise auto detect',
      },
      strict: {
        type: 'boolean',
        alias: 's',
        describe: 'Strict mode, exit with 1 if there are missing env vars without default values',
        default: false,
      },
      verbose: {
        type: 'boolean',
        alias: 'v',
        describe: 'Show verbose output',
        default: false,
      },
    })
  detectSLSConfig(argv)
  const patterns = "'process.env|getenv|environ'"
  const includes = Object.keys(EXTS).map((ext) => `--include "*${ext}"`).join(' ')
  const cmd = `git ls-files | xargs grep -E ${patterns} ${includes} | sed 's/:/${DELIMITER}/'`
  const raw = execSync(cmd).toString().trim()
  const allVars = getVars(raw)
  output({ ...argv, allVars })
} else {
  module.exports = {
    detectSLSConfig,
    seekSLSEnvs,
    jsParser,
    pyParser,
    parser,
    getVars,
    buildMissing,
    buildNeeded,
  }
}

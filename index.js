#!/usr/bin/env node
const { execSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const yaml = require('js-yaml')
const chalk = require('chalk')

const DELIMITER = '::\t'

function addOpts(yargs) {
  return yargs
    .option('path', {
      type: 'string',
      alias: 'p',
      describe: 'Path to scan',
      default: process.cwd(),
    })
    .option('serverless', {
      type: 'string',
      alias: 'sls',
      describe: 'Specify a serverless configuration YAML file; leave empty to auto detect',
    })
    .option('strict', {
      type: 'boolean',
      describe: 'Strict mode, reporting missing even if there are default fallback values',
      default: false,
    })
    .option('verbose', {
      type: 'boolean',
      alias: 'v',
      describe: 'Show verbose output',
      default: false,
    })
}

function detectSLSConfig(props) {
  if (props.serverless === '') {
    const paths = Array.from(new Set([props.path, process.cwd()])).map((p) => [
      'serverless.yml',
      'serverless.yaml',
      'sls.yml',
      'sls.yaml',
    ].map((f) => join(p, f))).flat()
    for (const p of paths) {
      if (existsSync(p)) {
        props.serverless = p
        break
      }
    }
    if (props.verbose) {
      console.warn(chalk.yellow('No serverless configuration found'))
    }
  }
}

// from https://github.com/beenotung/gen-env
const NODE_REGEX = [
  // e.g. process.env['REACT_APP_API_SERVER']
  /env\['(\w*)'\]/i,
  // e.g. process.env["REACT_APP_API_SERVER"]
  /env\["(\w*)"\]/i,
  // e.g. process.env.REACT_APP_API_SERVER
  /env\.(\w*)/i,
  // e.g. const { REACT_APP_API_SERVER, NODE_ENV } = process.env
  /{(.*)}\s*=\s*process.env/i,
  // some gulp files like to shortcut with `const env = process.env`
  /{(.*)}\s*=\s*env/i,
]

function parseNode(text) {
  if (text.startsWith('//') || text.startsWith('/*') || text.endsWith('<ignore scan-env>')) {
    return { vars: [] }
  }
  for (const regex of NODE_REGEX) {
    const match = text.match(regex)
    if (match) {
      const vars = new Set()
      const defaults = new Set()
      match[1].split(',').map((v) => {
        const [k, d] = v.split('=').map((s) => s.trim())
        const _var = k.split(':')[0].trim()
        vars.add(_var)
        if (d) {
          defaults.add(_var)
        }
      })
      return {
        vars: Array.from(vars),
        defaults: Array.from(defaults),
      }
    }
  }
  return { vars: [] }
}

function getNodeVars({ path }) {
  const raw = execSync(`grep "process.env" -R --exclude-dir "node_modules" ${path} --include "*.js" | sed 's/:/${DELIMITER}/'`)
    .toString()
    .trim()
  const items = raw.split('\n')
    .map((i) => i.split(DELIMITER).filter((v) => v))
    .filter((v) => v.length > 0)
  return items.map(([k, v]) => [k, parseNode(v.trim())])
    .filter(([, { vars }]) => vars.length > 0)
    .reduce((acc, [fp, { vars, defaults }]) => {
      acc[fp] = acc[fp] || { vars, defaults }
      acc[fp].vars = Array.from(new Set(acc[fp].vars.concat(vars))).filter((d) => d)
      acc[fp].defaults = Array.from(new Set((acc[fp].defaults || []).concat(defaults))).filter((d) => d)
      return acc
    }, {})
}

const PYTHON_REGEX = [
  // matches:
  //    environ.get
  //    getenv
  //    getenvb
  /(environ\.get|getenvb?)\((\'|\")(?<env>\w+)(\'|\")(,(\'|\")?(?<fallback>[^)]*)(\'|\")?)?\)/g
]

function parsePython(text) {
  if (text.startsWith('#') || text.endsWith('<ignore scan-env>')) {
    return { vars: [] }
  }
  for (const regex of PYTHON_REGEX) {
    const matches = text.matchAll(regex)
    for (const match of matches) {
      const vars = new Set()
      const defaults = new Set()
      const { env, fallback } = match.groups
      vars.add(env)
      if (fallback) {
        defaults.add(env)
      }
      return {
        vars: Array.from(vars),
        defaults: Array.from(defaults),
      }
    }
  }
  return { vars: [] }
}

function getPythonVars({ path }) {
  const raw = execSync(`grep "getenv" -R ${path} --include "*.py" | sed 's/:/${DELIMITER}/'`)
    .toString()
    .trim()
  const items = raw.split('\n')
    .map((i) => i.split(DELIMITER).filter((v) => v))
    .filter((v) => v.length > 0)
  return items.map(([k, v]) => [k, parsePython(v.trim())])
    .filter(([, { vars }]) => vars.length > 0)
    .reduce((acc, [fp, { vars, defaults }]) => {
      acc[fp] = acc[fp] || { vars, defaults }
      acc[fp].vars = Array.from(new Set(acc[fp].vars.concat(vars))).filter((d) => d)
      acc[fp].defaults = Array.from(new Set((acc[fp].defaults || []).concat(defaults))).filter((d) => d)
      return acc
    }, {})
}

function buildVarDict(allVars) {
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

function formatWarning({ serverless, missing, allVars, strict = false }) {
  let s = ''
  Object.entries(missing).forEach(([v, fps]) => {
    const _fps = Array.from(fps).map((fp) => {
      if (allVars[fp].defaults.includes(v)) {
        if (strict) {
          return chalk.yellow(`${fp} (has default)`)
        }
        return null
      }
      return chalk.red(fp)
    }).filter((s) => s)
    if (_fps.length) {
      s += `\n${chalk.red.bold(v)}:\n\t${_fps.join('\n\t')}\n`
    }
  })
  if (s) {
    return `${chalk.red(`Missing environment variables in ${chalk.bold(serverless)}:\n`)}${s}`
  }
  return s
}

function output({ serverless, allVars, strict, verbose }) {
  if (serverless) {
    const yml = yaml.load(readFileSync(serverless), 'utf8')
    const slsEnvs = new Set(seekSLSEnvs(yml))
    const missing = {}
    const dict = buildVarDict(allVars)
    Object.entries(dict).forEach(([v, fps]) => {
      if (!slsEnvs.has(v)) {
        missing[v] = fps
      }
    })
    if (Object.keys(missing).length) {
      const warning = formatWarning({ serverless, missing, allVars, strict })
      if (warning) {
        console[strict ? 'error' : 'warn'](warning)
        process.exit(1)
      }
    }
  } else if (verbose) {
    if (Object.keys(allVars).length) {
      console.log(allVars)
    } else {
      console.warn(chalk.yellow('No env vars detected'))
    }
  }
}

if (require.main === module) {
  require('yargs')
  .usage('Usage: $0 <command> [options]')
  .command(
    'node',
    'Scan Node.js (or compatible) projects with process.env usage',
    addOpts,
    (props) => {
      detectSLSConfig(props) // mutates props.serverless
      const allVars = getNodeVars(props)
      output({ ...props, allVars })
    },
  )
  .command(
    'python',
    'Scan Python projects with environment variable usage',
    addOpts,
    (props) => {
      detectSLSConfig(props)
      const allVars = getPythonVars(props)
      output({ ...props, allVars })
    }
  )
  .demandCommand()
  .help()
  .argv
} else {
  // TODO: expose core lib?
}

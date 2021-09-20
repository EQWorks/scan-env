#!/usr/bin/env node
const { execSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

const yaml = require('yaml')
const chalk = require('chalk')

const DELIMITER = '::\t'

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
  if (text.startsWith('//') || text.startsWith('/*')) {
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

function buildVarDict(allVars) {
  return Object.entries(allVars).reduce((acc, [fp, { vars }]) => {
    vars.forEach((v) => {
      acc[v] = new Set(acc[v] || [])
      acc[v].add(fp)
    })
    return acc
  }, {})
}

function seekSLS(yml) {
  let vars = Object.keys(yml?.provider?.environment || {})
  Object.entries(yml?.functions || {}).forEach(([, { environment = {} }]) => {
    vars = vars.concat(Object.keys(environment))
  })
  return new Set(vars)
}

function formatWarning({ serverless, missing, allVars, strict = false }) {
  let s = chalk.red(`Missing environment variables in ${chalk.bold(serverless)}:\n`)
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
  return s
}

function output({ serverless, allVars, strict, verbose }) {
  if (serverless) {
    const ymlRaw = execSync(`cat ${serverless}`).toString().trim()
    const yml = yaml.parse(ymlRaw)
    const slsEnvs = seekSLS(yml)
    const missing = {}
    const dict = buildVarDict(allVars)
    Object.entries(dict).forEach(([v, fps]) => {
      if (!slsEnvs.has(v)) {
        missing[v] = fps
      }
    })
    if (Object.keys(missing).length) {
      console.warn(`${formatWarning({ serverless, missing, allVars, strict })}`)
      if (strict) {
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
    yargs => yargs
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
    ,
    (props) => {
      detectSLSConfig(props) // mutates props.serverless
      const allVars = getNodeVars(props)
      output({ ...props, allVars })
    },
  )
  // .command(
  //   'python',
  //   'Scan Python projects with environment variable usage',
  //   // grep "os.getenv" -R overseer --include "*.py"
  // )
  .demandCommand()
  .help()
  .argv
} else {
  // TODO: expose core lib?
}

#!/usr/bin/env node
const { execSync } = require('child_process')

const yaml = require('yaml')
const chalk = require('chalk')

// const lib = require('./lib')
// module.exports.deployment = (params) => {
//   const { success = true, status, stage = 'dev', project, commit } = params
//   const projLink = `https://github.com/${project}${commit ? `/commit/${commit}` : ''}`
//   const extra = { footer: `<${projLink}|${project}${commit ? `#${commit}` : ''}>` }
//   if (!status) {
//     extra.color = success ? 'good' : 'danger'
//   }
//   const title = `${project} (${stage}) deployment: ${status ? status : (success ? 'succeeded' : 'failed')}`
//   return send(extra)({ ...params, title })
// }
const DELIMITER = '::\t'

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
  for (const regex of NODE_REGEX) {
    const match = text.match(regex)
    if (match) {
      const vars = new Set()
      const defaults = new Set()
      match[1].split(',').map((v) => {
        const [k, d] = v.split('=')
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
  return {
    vars: [],
  }
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

if (require.main === module) {
  require('yargs')
  .usage('Usage: $0 <command> [options]')
  .command(
    'node',
    'Scan node.js (or compatible) projects with process.env usage',
    yargs => yargs
      .option('path', {
        type: 'string',
        alias: 'p',
        describe: 'Path to scan',
        default: '.',
      })
      .option('serverless', {
        type: 'string',
        alias: 'sls',
        describe: 'Specify a serverless configuration YAML file',
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
    ({ path, serverless, strict, verbose }) => {
      const raw = execSync(`grep "process.env" -R ${path} --include "*.js" | sed 's/:/${DELIMITER}/'`)
        .toString()
        .trim()
      const items = raw.split('\n').map((i) => i.split(DELIMITER))
      const allVars = items.map(([k, v]) => [k, parseNode(v)]).reduce((acc, [fp, { vars, defaults }]) => {
        acc[fp] = acc[fp] || { vars, defaults }
        acc[fp].vars = Array.from(new Set(acc[fp].vars.concat(vars)))
        acc[fp].defaults = Array.from(new Set(acc[fp].defaults.concat(defaults)))
        return acc
      }, {})
      // obtain from serverless yaml
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
        }
      } else if (verbose) {
        console.log(allVars)
      }
    },
  )
  .demandCommand()
  .help()
  .argv
} else {
  // module.exports = lib
}

#!/usr/bin/env node
const { execSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const yaml = require('js-yaml')
const chalk = require('chalk')

const DELIMITER = '::\t'

function detectSLSConfig(argv) {
  if (argv.serverless === '') {
    const paths = [
      'serverless.yml',
      'serverless.yaml',
      'sls.yml',
      'sls.yaml',
    ].map((f) => join(process.cwd(), f))
    for (const p of paths) {
      if (existsSync(p)) {
        argv.serverless = p
        if (argv.verbose) {
          console.log(chalk.blue(`Detected serverless config: ${chalk.bold(p)}`))
        }
        break
      }
    }
    if (argv.verbose && !argv.serverless) {
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

function jsParser(text) {
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

const PYTHON_REGEX = new RegExp(/(environ\.get|getenvb?)\(('|")(?<env>\w+)('|")(,('|")?(?<fallback>[^)]*)('|")?)?\)/g)

function pyParser(text) {
  if (text.startsWith('#')) {
    return { vars: [] }
  }
  const matches = text.matchAll(PYTHON_REGEX)
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
  return { vars: [] }
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
    return `${chalk.red(`Missing env vars in ${chalk.bold(serverless)}:\n`)}${s}`
  }
  return s
}

function formatAll({ dict, verbose }) {
  const counts = { vars: 0, files: 0 }
  let maxWidth = 0
  const _dict = Object.entries(dict).reduce((acc, [k, fps]) => {
    acc[k] = Array.from(fps)
    counts.vars += 1
    counts.files += fps.size
    maxWidth = Math.max(maxWidth, k.length)
    return acc
  }, {})
  let s = `${chalk.blue(`${chalk.bold(counts.vars)} env vars found in ${chalk.bold(counts.files)} files`)}`
  if (verbose) {
    s += `\n`
    Object.entries(_dict).forEach(([k, fps]) => {
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

function output({ serverless, allVars, strict, verbose }) {
  const dict = buildVarDict(allVars)
  if (serverless) {
    const yml = yaml.load(readFileSync(serverless), 'utf8')
    const slsEnvs = new Set(seekSLSEnvs(yml))
    const missing = {}
    Object.entries(dict).forEach(([v, fps]) => {
      if (!slsEnvs.has(v)) {
        missing[v] = fps
      }
    })
    if (Object.keys(missing).length) {
      const warning = formatWarning({ serverless, missing, allVars, strict })
      if (warning) {
        console[strict ? 'error' : 'warn'](warning)
        if (strict) {
          process.exit(1)
        }
      }
    }
  }
  if (verbose) {
    if (Object.keys(dict).length) {
      console.log(formatAll({ dict, verbose }))
    } else {
      console.warn(chalk.yellow('No env vars detected'))
    }
  }
}

if (require.main === module) {
  const { argv } = require('yargs')(process.argv.slice(2)).options({
    serverless: {
      type: 'string',
      alias: 'sls',
      describe: 'Specify a serverless configuration YAML file; leave empty to auto detect',
    },
    strict: {
      type: 'boolean',
      describe: 'Strict mode, reporting missing even if there are default fallback values',
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
  const patterns = '"process.env|getenv|environ"'
  const includes = Object.keys(EXTS).map((ext) => `--include "*${ext}"`).join(' ')
  const cmd = `git ls-files | xargs grep -E ${patterns} ${includes} | sed 's/:/${DELIMITER}/'`
  const raw = execSync(cmd).toString().trim()
  const allVars = getVars(raw)
  output({ ...argv, allVars })
} else {
  // TODO: expose core lib?
}

# scan-env

Utility to scan environment variable usage in a git repository. If a serverless config file is detectd, environment variables that are in-use but missing from the config file would be reported.

## Usage

```shell
% npx @eqworks/scan-env --help
Options:
      --help               Show help                                   [boolean]
      --version            Show version number                         [boolean]
      --serverless, --sls  Specify a serverless configuration YAML file;
                           otherwise auto detect                        [string]
  -s, --strict             Strict mode, exit with 1 if there are missing env
                           vars without default values
                                                      [boolean] [default: false]
  -v, --verbose            Show verbose output        [boolean] [default: false]
```

You can also install it and invoke the CLI without the scope:

```shell
% npm i @eqworks/scan-env # or yarn add @eqworks/scan-env
% scan-env --help
...
```

### Strict mode

For QA and CI purposes, invoke with `--strict` would ensure an exit code of `1` (error) if there are missing env vars without default values:

```shell
% scan-env --strict
Missing env vars in .../serverless.yml:

MAP_ZEN_BASE_URL:
	config.js

API_KEY:
	config.js

IS_OFFLINE:
	src/app.js (has default)
	src/util/redis.js (has default)

PORT:
	src/index.js (has default)

DEBUG:
	src/middleware/errorlog.js
	src/util/db.js (has default)

PGAPPNAME:
	src/util/db.js (has default)

% echo $?
1
```

### `<ignore scan-env>`

Environment variables that are within the scope of a known comment block would be automatically ignored. To explicitly ignore a given line, append with `<ignore scan-env>` using the language's inline-commenting syntax:

```js
// Node.js example
console.log(process.env.YOLO) // <ignore scan-env>
```

```python
# Python example
import os

print(os.getenv('YOLO'))  # <ignore scan-env>
```

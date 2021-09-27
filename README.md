# scan-env

Utility to scan environment variable usage in a git repository. If a serverless configuration file is detectd, environment variables that are in-use but missing from the config file would be reported.

## Usage

```shell
% npx @eqworks/scan-env --help
```

You can also install it and invoke the CLI without the scope:

```shell
% npm i @eqworks/scan-env # or yarn global add @eqworks/scan-env
% scan-env --help
...
...
% scan-env
Missing in .../serverless.yml

LOG_LEVEL:
	overseer/__init__.py (has default)
STAGE:
	overseer/app.py (has default)
PG_LOCUS_URI:
	overseer/modules/pg.py (has default)
```

### Strict mode

For quality assurance purposes (such as running through a continuous service like GitHub Actions), invoke with `--strict` would ensure an exit code of `1` (error) if there are missing environment variables without default values:

```shell
% scan-env --strict
Missing in .../serverless.yml:

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

Example GitHub actions step:

```yaml
jobs:
  # ...
  scan-env:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: 14.x
      - run: npx @eqworks/scan-env --strict
```

### Live mode (since `v0.4.0`)

For projects without any serverless configurations, `scan-env` would test against live context exposed to the app layer:

```shell
% API_HOST=localhoist scan-env -v
Missing in live context

JWT:
	stories/pois.stories.js (has default)
MAPBOX_ACCESS_TOKEN:
	stories/pois.stories.js (has default)

3 env vars found in 1 file
API_HOST            stories/pois.stories.js
JWT                 stories/pois.stories.js
MAPBOX_ACCESS_TOKEN stories/pois.stories.js
```

### Unused detection (since `v0.4.0`)

For projects that have serverless configurations, unused environment variables (defined in serverless configuration, but not reference in app layer) would be reported:

```shell
% scan-env
Unused from .../serverless.yml

NOT_USED_ANIMO
SNOOP_LEON
NICKY_JELLY
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

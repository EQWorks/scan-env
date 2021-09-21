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
                           vars with non-default values
                                                      [boolean] [default: false]
  -v, --verbose            Show verbose output        [boolean] [default: false]
```

You can also install it and invoke the CLI without the scope:

```shell
% npm i @eqworks/scan-env # or yarn add @eqworks/scan-env
% scan-env --help
...
```

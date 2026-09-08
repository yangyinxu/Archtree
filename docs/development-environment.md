# Development and release environments

Archtree supports Node.js **24.x**. `.nvmrc` and `.node-version` pin the reviewed
local/CI patch (**24.20.0**); the release workflow reads `.nvmrc`. Elastic
Beanstalk selects the supported Node 24 platform. Before upgrading the pinned
patch, verify the platform version and run the complete release matrix.

## Install and check

Install Node 24 from the [official Node distribution](https://nodejs.org/dist/v24.20.0/)
or use a version manager with `.nvmrc` / `.node-version`. When downloading an
archive, verify it against the official `SHASUMS256.txt` before extraction.
Do not reuse `node_modules` installed for another Node major.

```sh
node --version
npm ci
npm run doctor
npm test
npm run build
npm run test:integration
```

`npm run doctor` checks the Node major and the isolated MongoDB daemon without
reading `.env`, printing credentials, or contacting an application database.
`npm test`, `npm run build`, and the server test runners reject unsupported
Node majors before loading application checks.

`npm start`, `npm run dev`, and `npm run dev:auth-rotation` use `cross-env` to set
the existing environment values consistently on Windows, macOS, and Linux.
The development commands still need the application's usual external settings;
the test daemon does not provide development or production data.

## Configure application startup

`npm run dev` loads `.env` from the repository working directory, in addition to
settings already present in the terminal environment. `.env.example` is a
template and is never loaded automatically. A passing `npm run doctor` verifies
the development tools; it does not configure the application database or account
secrets.

Use an existing private development configuration, or create a local copy of the
template without overwriting an existing file:

```powershell
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
```

Configure `DB_CONN_STRING` and `DB_NAME` for the intended development database.
It must support the documented replica-set/mongos transaction contract. The
disposable test harness does not create a persistent development database.
Authentication additionally needs a private `JWT_SECRET`; media and mail features
need their corresponding external settings described in the README. Template
placeholders are not usable credentials. Keep `.env` untracked and never paste its
values into diagnostic reports.

Run `npm run dev` again after supplying the configuration. Startup failures report
fixed diagnostic categories and recovery hints without exposing connection strings,
credentials, raw driver messages, or stack traces. The absence of `.env` alone is
not an error when all required settings are already supplied by the environment.

The `server_start_failed` JSON includes `stage`, `reason`, and a fixed `action`.
For missing configuration it also includes `missingVariables`, containing only
`DB_CONN_STRING` and/or `DB_NAME`. Other reasons distinguish malformed database
configuration, connection/authentication failures, unsupported topology, required
collection/index initialization, application initialization, invalid ports, and
occupied ports. These diagnostics do not bypass the original startup checks.

Regression coverage in `test/startupDiagnostics.test.ts` exercises the actual
`src/app.ts` command entry with environment loading and database connections
disabled. It checks the exit status, missing-variable list, and secret-safe log
shape. `test/serverStartup.test.ts` covers successful listening, occupied ports,
invalid ports, and application initialization failures.

## Disposable MongoDB tests

Install **MongoDB Community 8.0.12**, the version pinned in release CI, from the
[official MongoDB archive](https://www.mongodb.com/try/download/community-edition/releases/archive).
For Windows, extract the ZIP and verify its SHA-256 against the adjacent official
`.zip.sha256` file. A MongoDB Windows service is not needed. Add its `bin`
directory to `PATH`, or point `MONGOD_BINARY` to the executable:

```powershell
$env:MONGOD_BINARY = 'C:\tools\mongodb\bin\mongod.exe'
npm run doctor
npm run test:integration
```

The integration runner checks `mongod --version` once before loading test suites.
A missing or invalid binary fails with one actionable error. The harness repeats
that check when invoked directly, binds a disposable replica set to loopback on
an available port, uses a marked temporary directory, and stops the daemon and
removes its directory afterward. It never starts a persistent service or connects
to a configured application database. Windows daemon processes have no visible
console window. Startup process errors and early exits fail promptly and still
run cleanup.

## Windows and Linux gates

`npm test` runs all portable server and Web unit tests on every supported host.
On Linux it also runs both `*.linux.test.ts` suites: HTTPS platform hooks and
Elastic Beanstalk artifact validation. Windows and macOS print their exclusion
explicitly; these hosts cannot verify Bash/systemd behavior or POSIX executable
bits. Those tests retain their complete assertions and remain part of Linux CI.

`npm run test:server:linux` runs the Linux suites explicitly and rejects other
hosts. `npm run doctor:release` checks Linux, Bash, Node, and MongoDB. Deployment
artifact staging also requires Linux so a Windows archive cannot be mistaken for
a release bundle with verified executable permissions. Use Ubuntu 24.04 CI or a
properly provisioned Ubuntu WSL environment for these gates; Git Bash alone does
not provide the required filesystem and operating-system behavior.

The release workflow continues to require unit tests (including Linux suites),
MongoDB lifecycle integration tests, the production build, browser fixture type
checks, Chromium/Firefox/WebKit playback and accessibility tests, and validated
artifact staging. Windows checks do not replace that release matrix.

## Repairing this Windows workstation

The remediation installed official, checksum-verified portable distributions in
`%LOCALAPPDATA%\Programs\ArchtreeRuntimes`:

- `node-v24.20.0-win-x64`
- `mongodb-win32-x86_64-windows-8.0.12\bin`

The user's PowerShell 5 and 7 `profile.ps1` files prepend these paths; any existing
profile was backed up before appending the marked block. New normal PowerShell
sessions use Node 24. Existing shells, `-NoProfile` shells, and Command Prompt may
still resolve the retained system Node 26. Check `node --version`; the project
preflight reports a mismatch instead of running unreliable tests. A session can
select the installed runtime explicitly:

```powershell
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Programs\ArchtreeRuntimes'
$env:PATH = "$runtimeRoot\node-v24.20.0-win-x64;$runtimeRoot\mongodb-win32-x86_64-windows-8.0.12\bin;$env:PATH"
node --version
npm run doctor
```

No existing Node process was terminated and no system-wide Node installation was
replaced. To restore the prior PowerShell default, remove the marked `Archtree
Node 24 runtime` block or restore the adjacent profile backup, then open a new
shell. The portable runtime folders and added user PATH entries can be removed
after no process uses them.

If `npm ci` reports `EPERM` for an in-use native executable or DLL, stop only the
development process that you own and then retry. Do not kill unrelated processes
or repeatedly force-delete `node_modules`. A clean temporary checkout can verify
`npm ci` independently while another task still holds the old binaries open.

## Playwright browsers on this workstation

The current desktop execution environment could not start Firefox from the
default `%LOCALAPPDATA%\ms-playwright` cache: Windows reported a SideBySide
`mozglue` activation failure even after verifying the installed binaries against
the official archive. The same unmodified, locked Firefox version launched
successfully from a separate runtime directory. Reinstalling the locked browsers
with Playwright's supported cache setting resolved this workstation's launch
failure without modifying browser binaries, permissions, or test assertions:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $env:LOCALAPPDATA 'Programs\ArchtreeRuntimes\playwright'
npx --no-install playwright install chromium firefox webkit
npm run test:e2e
```

This workstation persists that path in the user environment and the marked
PowerShell runtime profile block. New shells use it automatically; existing
shells can use the assignment above. The previous browser cache is retained.
Unset `PLAYWRIGHT_BROWSERS_PATH` and remove its marked profile assignment to use
Playwright's default cache again. Other machines and Linux CI can continue using
the default cache. Browser launch success does not replace playback, focus,
accessibility, or the complete release tests.

## Dependency security exception

The lockfile uses an explicit `qs: 6.16.0` override because the current Express 4
and body-parser 1 releases constrain their transitive dependency to the affected
6.15 line. This reviewed update addresses
[comma-array limit bypass](https://github.com/ljharb/qs/security/advisories/GHSA-x5fp-wj9c-mxmx)
and [unsafe constructor.isBuffer invocation](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g).
Regression tests exercise both boundaries and an ordinary form-array parse.
Remove the override when both upstream packages permit a patched version, after
reviewing the exact lockfile diff and rerunning the tests; do not use a breaking
automatic audit fix.

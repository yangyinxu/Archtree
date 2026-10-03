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

Canonical localization JSON uses LF even in Windows checkouts with
`core.autocrlf=true`, enforced by `.gitattributes`. Keep the byte-for-byte
two-space JSON and duplicate-key checks enabled; do not regenerate locale content
just to repair checkout line endings.

```sh
node --version
npm ci
npm run doctor
npm test
npm run build
npm run test:integration
```

`npm run doctor` checks the Node major, FFmpeg capabilities and the isolated MongoDB daemon without
reading `.env`, printing credentials, or contacting an application database.
`npm test`, `npm run build`, and the server test runners reject unsupported
Node majors before loading application checks.

Node ESM loader arguments and dynamic imports use file URLs rather than native
Windows drive paths. Disposable child tests scope `TMPDIR`, `TMP`, and `TEMP` to
the same owned directory so cleanup assertions cover the actual allocation on
every host. Synthetic decoder fixtures launch real Node child processes with
bounded cleanup rather than relying on executable Unix shebang scripts.

`npm start`, `npm run dev`, and `npm run dev:auth-rotation` use `cross-env` to set
the existing environment values consistently on Windows, macOS, and Linux.
The development commands still need the application's usual external settings;
the test daemon does not provide development or production data.

## Configure application startup

`npm start`, `npm run dev`, and `npm run dev:auth-rotation` load `.env` from the
working directory when `src/app.ts` starts as the process entry, before any
application module reads configuration. Settings already present in the terminal
environment take precedence. The operational database commands
`npm run analyze:room-audio`, `npm run backfill:catalog-search`,
`npm run migrate:catalog-credits`, and `scripts/reconcile-image-versions.ts` load
it the same way. Application modules never read `.env` themselves, so tests, the
disposable `npm run demo:social` and `npm run profile:search` commands, and the
Listener E2E servers do not see private configuration. `.env.example` is a
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
shape, and separately confirms that the entry still reads a `.env` in its working
directory. `test/serverStartup.test.ts` covers successful listening, occupied ports,
invalid ports, and application initialization failures.

## Room audio analysis runtime

Compressed room audio requires FFmpeg with AAC/MP3 decoders, MOV/MP3 demuxers and
the null muxer, the PCM s16le encoder and file/pipe protocols. Use a maintained distribution package and verify its capabilities:

```sh
# macOS with Homebrew
brew install ffmpeg
# Ubuntu 24.04 (also installed by release CI)
sudo apt-get update
sudo apt-get install --yes ffmpeg
npm run doctor
```

On Windows, install a trusted FFmpeg distribution linked by the
[official FFmpeg download page](https://ffmpeg.org/download.html), add its bin
directory to PATH or set `ROOM_AUDIO_FFMPEG_PATH` to the absolute `ffmpeg.exe` path.
The override is an executable path, not a shell command. FFmpeg always reads a
bounded local file and decodes to the null muxer; it never opens an audio device.
Verify the distribution's published SHA-256 before extracting it. A portable
installation outside the checkout avoids committing workstation executables.
For a persistent user override, open a new shell after saving it, or load it into
the current PowerShell process before `npm run doctor`:

```powershell
$env:ROOM_AUDIO_FFMPEG_PATH = [Environment]::GetEnvironmentVariable('ROOM_AUDIO_FFMPEG_PATH', 'User')
npm run doctor
```

See the [FFmpeg protocol controls](https://ffmpeg.org/ffmpeg-protocols.html) and
[command options](https://ffmpeg.org/ffmpeg.html) used by the restricted decoder.

Deployments must provision and patch this executable separately; the application
archive does not bundle a workstation binary or the repository scripts. Use
`npm run doctor` in a full Linux checkout with the test runtimes; a deployment
host does not require a local MongoDB test daemon. To inspect only FFmpeg from a
full checkout using the deployment's executable, run
`node scripts/check-runtime.mjs --room-audio`. Then verify original MP3/M4A
uploads and room preparation, play and seeking through the deployed app before
rollout. Run the batch CLI from a full administrator checkout with explicit
configuration; the deployed Content Manager page remains its in-app equivalent. Missing runtime makes compressed uploads
ineligible with a retryable analysis reason while ordinary uploads/playback stay
available. The analyzer tests intentionally require a real decoder; do not mark
missing-decoder fixture checks as passed. Local checks preserve Chromium's
`--disable-audio-output`; compressed-media and focused room-recovery scenarios add Firefox/WebKit hosts
only on Linux with `CI=true` or `CI=1`, using isolated servers and the CI null
audio sink. Local Firefox/WebKit execution remains excluded.

When transferring a Windows working copy into isolated Linux verification, use
Git's canonical line endings and executable modes rather than treating a raw
directory copy as a Linux checkout. Preserve reviewed image baselines byte for
byte. Record the selected source and built bundle separately from any temporary
diagnostic instrumentation; restore and verify both before an acceptance rerun.

A Linux guest without GPU passthrough can separately diagnose WebKit rendering
with `LIBGL_ALWAYS_SOFTWARE=true` and `GALLIUM_DRIVER=llvmpipe`, as documented by
[Mesa](https://docs.mesa3d.org/envvars.html). These settings select a software
renderer; they do not supply audio hardware or establish media readiness. Label
this profile separately from default CI, retain real click and media assertions,
and preserve a media failure even when page rendering recovers. A working
animation or click probe is not a passing playback gate.

The separate sustained-room gate and bounded options are documented in
[`README.md`](../README.md#verify-sustained-audio-rooms-locally). It does not run
as part of the ordinary short test matrix. It owns its resource cleanup and uses
no workstation application database or cloud credentials.

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

The server test runner fails any single test that runs longer than 120 seconds,
so a hung test fails the gate instead of stalling it. Pass a different bound
explicitly when diagnosing a slow test, for example
`npm run test:server -- --test-timeout=600000`. The runner also passes
`--test-force-exit`, so a test file that finishes but leaves a socket, timer, or
child process open still exits instead of keeping the gate alive. To find such a
leaked handle, run with `npm run test:server -- --no-test-force-exit`; the run
then stays open on the affected file.

The server test runner starts unit, Linux, and integration test processes in an
isolated environment so a private root `.env` never reaches them. It points
`DOTENV_CONFIG_PATH` at the null device, so the app and operational script entries
that tests spawn load nothing, and replaces `DB_CONN_STRING`, `DB_NAME`,
`JWT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
`S3_BUCKET_NAME`, `AWS_ENDPOINT_URL`, and `AWS_EC2_METADATA_DISABLED` with
synthetic loopback values, including values exported in the terminal;
`AWS_SESSION_TOKEN` is removed. An unmocked database or AWS call therefore fails
against `127.0.0.1:9`. The runner also preloads
`test/support/syntheticMxResolver.ts`, so the authentication-email domain check
answers from a synthetic MX resolver and no test queries real DNS. Suites that
need real services start their own disposable MongoDB and S3-compatible
fixtures. Running one file directly with `node --import tsx --test` bypasses
this environment and the resolver preload, so tests that spawn the app or
script entries can then read a root `.env`, and authentication emails would
look up real MX records; add `--import ./test/support/syntheticMxResolver.ts`
from the repository root to keep DNS synthetic.
`test/serverTestEnvironment.test.ts` fails if a test process can see a value
from a sentinel `.env` in its working directory, or if any `src/` module other
than `src/config/entryEnvironment.ts` imports `dotenv`.

`npm run test:server:linux` runs the Linux suites explicitly and rejects other
hosts. `npm run doctor:release` checks Linux, Bash, Node, MongoDB and FFmpeg. Deployment
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

# Repository Instructions

## Business Rules

- Before planning, reviewing, or changing product behavior, read
  `docs/business-rules.md`.
- Treat `docs/business-rules.md` as the canonical source for behavior shared by
  the Archtree backend and Finitude iOS client.
- When the user adds, removes, or changes a business rule, update
  `docs/business-rules.md` in the same change as the implementation.
- If a requested implementation conflicts with a documented rule, identify the
  conflict and confirm the new rule before implementing it.
- Keep business rules focused on product behavior. Keep endpoint shapes,
  database details, and other implementation-specific documentation in the
  README or code unless they materially define the product contract.
- When a rule affects the iOS client, inspect the sibling `Finitude_iOS`
  repository when it is available and keep its behavior consistent with the
  backend contract.
- If the sibling repository or canonical business-rules document is
  unavailable, state that the shared behavior could not be verified before
  making a product-behavior change.
- Before changing database records, S3 objects, or content relationships, map
  the complete create, replace, delete, partial-failure, retry, and
  reconciliation lifecycle described in `docs/business-rules.md`.
- Do not remove the only database evidence of an S3 object while storage
  cleanup is incomplete, and do not leave successful uploads without a
  traceable lifecycle record.

## Planning

- Record every new plan in a dedicated Markdown file under `docs/plans/`; a
  plan must not exist only in chat or planning-tool state.
- Divide every plan into explicit implementation stages.
- Mark every stage with one current status: `Not started`, `In progress`,
  `Blocked`, or `Complete`, and update that status as work progresses.
- Treat plans as sequencing material, not as substitutes for canonical
  business rules, API contracts, or other stable documentation.

## Documentation Hygiene

- When a change affects setup, dependencies, commands, configuration,
  environment variables, endpoints, authentication, media behavior, or
  deployment, update the relevant README or operational documentation in the
  same change.
- Verify documented commands and examples against the current project files
  before handing off the change.
- Keep shared Archtree/Finitude behavior in `docs/business-rules.md`; keep
  repository-specific implementation details in this repository's README,
  operational docs, or code.

## Security and Repository Hygiene

- Treat JSON, multipart bodies, uploaded media, filenames, external URLs, and
  decoded service responses as untrusted input. Validate schema, size, type,
  complete decoding, ownership, and lifecycle state at the relevant boundary.
- Scope every account-owned query and mutation to the authenticated user.
  Possession of a resource ID is not authorization, and every global-content
  mutation requires an explicit role guard.
- Public listener and content responses must use allowlisted DTOs and preserve
  ready/published lifecycle boundaries; do not expose raw MongoDB, S3,
  ownership, lifecycle-error, or private-account fields.
- Never log or commit credentials, cookies, authorization headers, tokens,
  private user payloads, `.env` values, or personal configuration.
- Do not commit local generated artifacts such as `node_modules`, coverage,
  Playwright reports/results, staged deployment archives, logs, or recordings.
  Intentional fixtures and documentation assets are exceptions.
- Preserve unrelated user changes in a dirty worktree, and do not rewrite Git
  history or use destructive cleanup merely to obtain a clean status.

## Verification

- Add or update tests for every changed behavior, state transition,
  authorization rule, and relevant failure, retry, partial-success, and cleanup
  path.
- Run the narrowest relevant checks while developing. Before handing off a
  completed implementation, run `npm test` and `npm run build` when the
  environment supports them.
- Also run `npm run test:integration` for authentication persistence, MongoDB
  transactions, account deletion, S3 lifecycle, or content-reference changes.
  Run the relevant Listener E2E gate for route, UI, authentication, playback,
  or accessibility changes; use the full release matrix for release-facing
  work.
- Review dependency and lockfile diffs deliberately; do not apply destructive
  or breaking automatic dependency fixes without reviewing the exact changes.
- Run `git diff --check`, review the final diff for unrelated changes, and
  report the commands run, their results, and any checks that could not run.

## Code Documentation

- Add concise comments to classes, types, and functions that explain their
  responsibility, contract, or non-obvious behavior.
- Prefer comments that explain why a behavior exists or identify an important
  constraint. Do not restate syntax that is already clear from the code.
- Prefer refactoring unclear code before adding a long explanatory comment.
- Update or remove comments whenever the documented behavior changes.

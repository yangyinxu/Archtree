# Product Opportunities Parallel Execution Plan

This plan coordinates currently actionable work from
`docs/product-opportunities.md`. It is sequencing material only; canonical
product behavior remains in `docs/business-rules.md` and the sibling native
repositories' implementation documentation.

## Stage 1 — Audit and de-duplicate the backlog

Status: Complete

- Reconcile every retained plan against current code, commits, tests, release
  evidence, production capability state, and sibling repositories.
- Distinguish completed-but-stale plans from real implementation work and from
  external or product-decision blockers.
- Confirm that independent code tracks use separate repositories or Git
  worktrees, while shared release and documentation state remains single-writer.

## Stage 2 — Reconcile plan and release truth

Status: In progress

- Delete completed Web Listener, Web reference redesign, Library-sidebar, and
  iOS mini-player plans after moving any durable skipped verification boundary
  to the appropriate testing or deployment document.
- Replace the broad Playlist implementation plan with a narrow rollout plan
  covering the disabled production capability, indexes, safe account smoke,
  feature-flag enablement, observation, and rollback.
- Rewrite the downloads plan around the current unified Library contract and
  the actual remaining server, native-engine, UI, and verification gaps.
- Correct the integrated-release plan so completed exact-artifact publication
  is not reported as in progress and absent staging or rollback exercises are
  not reported as passed.

## Stage 3 — Complete the downloadable-content server contract

Status: In progress

- Branch: `codex/downloads-server-contract`.
- Worktree: `/Users/yangyinxu/.codex/worktrees/9f01/Archtree`.
- Implement the remaining Listener Grid/List cursor surface and missing
  administrator operations that are already authorized by the Page Item and
  download business rules.
- Preserve public DTO allowlists, ready lifecycle boundaries, owner scoping,
  deterministic pagination, and existing Web streaming-only behavior.
- Add focused unit/integration coverage and run the required repository gates.

## Stage 4 — Harden the iOS download engine

Status: In progress

- Branch: `codex/download-engine-reliability`.
- Worktree: `/Users/yangyinxu/.codex/worktrees/9f02/Finitude_iOS`.
- Replace the unversioned manifest and foreground-only transfer assumptions
  with a versioned, account-safe, restart-safe download state model.
- Add bounded Album concurrency, strict range/resume validation, local asset
  protection and backup policy, and deterministic recovery without changing
  Saved Library semantics.
- Stabilize the engine contract before separately adding remaining UI actions.

## Stage 5 — Make Android authentication usable by private features

Status: In progress

- Branch: `codex/android-auth-foundation`.
- Worktree: `/Users/yangyinxu/.codex/worktrees/9f03/Finitude_Android`.
- Implement the smallest production-usable authenticated session foundation
  required by the existing Archtree contract and the already-built owner-fenced
  Playlist client.
- Keep account transitions fail-closed, prevent stale private responses from
  restoring an old viewer, and avoid persisting plaintext credentials.
- Connect real authenticated activity recording only after the session
  identity and Bearer credential are authoritative.

## Stage 6 — Integrate, verify, and update durable status

Status: Not started

- Independently review each branch, rebase or merge in dependency order, and
  resolve shared documentation conflicts in the primary checkout.
- Run the narrowest checks during implementation and the full required gates
  before accepting each track.
- Update `docs/product-opportunities.md` from verified implementation reality.
- Delete this plan only after all unblocked stages and required automated
  verification are complete.

## Stage 7 — Preserve blocked boundaries without occupying agents

Status: Blocked

- Explainable Discovery/Artist Follow and Content Manager prepublish remain
  blocked at canonical product-decision promotion; their detailed spikes are
  retained without silently treating recommended defaults as approved rules.
- Figma remains blocked by the Starter/View-seat write limit and lack of proper
  Light/Dark variable modes; one remote file must remain single-writer.
- Production Playlist enablement, physical-device/assistive-technology checks,
  authenticated production smoke, Web Vitals, and rollback rehearsal require
  external targets, safe credentials, devices, or release authority.
- Per the user's coordination instruction, these gates are recorded and
  skipped while independent automated work continues.

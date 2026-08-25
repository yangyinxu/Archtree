# Remove Web Library Sidebar Heading

## Stage 1 — Product contract and implementation

Status: Complete

- Record that the desktop Web sidebar starts with primary navigation and does
  not render a separate `Your Library` heading.
- Remove the heading markup and its now-unused responsive styles.

## Stage 2 — Automated coverage and visual evidence

Status: Blocked

- Update component and browser assertions to require the heading to be absent
  at every viewport. Complete.
- Review and update only the visual baselines affected by the intentional
  sidebar change. The four affected macOS Chromium baselines are reviewed and
  updated. The repository release runbook requires the Linux baselines to come
  from a real Ubuntu workflow run; this macOS workspace cannot produce or
  approve those renders without a pushed candidate.

## Stage 3 — Verification and handoff

Status: Blocked

- Run the focused Web checks, the required repository test/build gates, and the
  relevant Listener E2E coverage. Complete locally.
- Review the final diff and run `git diff --check`. Complete locally.
- After the affected Linux renders are reviewed and a subsequent strict Ubuntu
  run passes, remove this completed plan before release handoff.

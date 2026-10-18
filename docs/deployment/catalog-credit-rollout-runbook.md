# Catalog Credit Rollout and Rollback Runbook

This runbook controls the additive Catalog Credit migration. Product behavior
is canonical in [`../business-rules.md`](../business-rules.md). Migrated
Credits and migration checkpoints are retained during rollback; rollback never
deletes attribution evidence.

## Switches

| Variable | Default | Effect when `false` |
| --- | --- | --- |
| `CATALOG_CREDIT_WRITES_ENABLED` | `true` | Rejects Credit mutations with 503 before a transaction starts. |
| `CATALOG_CREDIT_READS_ENABLED` | `true` | Uses verified legacy projections for public bylines and membership. |
| `CATALOG_CREDIT_SECTIONS_ENABLED` | `true` | Collapses Artist pages to legacy Discography/Appears On classification. |
| `CATALOG_ORGANIZATION_SURFACES_ENABLED` | `true` | Hides Organization detail and search results without deleting records. |

`CATALOG_CREDIT_REJECT_LEGACY_WRITES` defaults to `false`. Set it to `true`
only after all supported clients use the Credit mutation workflow; it rejects
direct `Artist.albumIds` and `AudioTrack.artistIds` mutations while retaining
those fields as server-owned projections.

## Dry run and migration

1. Deploy with Credit writes enabled, Credit reads/sections/Organization
   surfaces disabled, and legacy-write rejection disabled.
2. Run bounded dry-run pages and retain each checkpoint:

   ```bash
   npm run migrate:catalog-credits -- --limit=100
   ```

3. Review counts and bounded samples. Resolve every dangling subject, invalid
   role, duplicate, invalid order, and unexplained compatibility difference.
4. Apply the same bounded pages only after review:

   ```bash
   npm run migrate:catalog-credits -- --apply --confirm=APPLY_CATALOG_CREDITS --limit=100
   ```

5. Continue from the returned `--after-album` and `--after-track` checkpoints.
   `--mark-unattributed-unknown` requires a separately recorded policy decision.
6. Run reconciliation after every batch and after the final checkpoint.

## Cutover gates

Enable Content Manager reads, Organization surfaces, public reads, Artist
sections, Web, and supported iOS versions in that order. Do not enable the
next gate unless:

- reconciliation reports zero dangling/invalid/duplicate Credits;
- every sampled projection difference is explained;
- unexplained compatibility projection drift is at most 0.1%; and
- error, latency, 429, and 5xx rates remain within the existing release SLO.

After the last supported client is Credit-aware, observe these conditions for
seven continuous days before enabling legacy-write rejection. Any violation
restarts the observation window.

## Rollback exercise

1. Set `CATALOG_CREDIT_READS_ENABLED=false`,
   `CATALOG_CREDIT_SECTIONS_ENABLED=false`, and
   `CATALOG_ORGANIZATION_SURFACES_ENABLED=false`.
2. Confirm `/api/listener/v1/capabilities` reports the disabled state and that
   legacy Album/Artist/Soundtrack pages remain readable and playable.
3. If mutations are unsafe, also set `CATALOG_CREDIT_WRITES_ENABLED=false` and
   confirm Credit mutations return 503 without partial database changes.
4. Keep `CATALOG_CREDIT_REJECT_LEGACY_WRITES=false` while rolled back.
5. Re-run reconciliation and dry-run migration before re-enabling reads.

Do not unset checkpoints, delete Credits, rewrite compatibility arrays, or
remove Organization records as part of rollback.

With `CATALOG_CREDIT_READS_ENABLED=false`, Library creators come from the legacy
Artist relationships and keep their earlier comma-joined presentation,
including a repeated name. They use the same 500-character byline cap as
Credit bylines, ending after the last whole name that fits followed by `…`.

## Join phrase rollback floor

The first release with Credit join phrases only reads and preserves them.
Administrator catalog requests still reject them and Content Manager requests
cannot set them, so no stored Credit carries one and rolling that release back
loses nothing. Once a later release accepts join-phrase writes, do not roll
back below the first join-phrase release: earlier code rebuilds every Credit
without its phrase, so any Credit write there would silently drop stored
phrases. Setting `CATALOG_CREDIT_READS_ENABLED=false` hides phrases from
bylines without removing them.

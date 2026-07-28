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
- Before changing database records, S3 objects, or content relationships, map
  the complete create, replace, delete, partial-failure, retry, and
  reconciliation lifecycle described in `docs/business-rules.md`.
- Do not remove the only database evidence of an S3 object while storage
  cleanup is incomplete, and do not leave successful uploads without a
  traceable lifecycle record.

## Code Documentation

- Add concise comments to classes, types, and functions that explain their
  responsibility, contract, or non-obvious behavior.
- Prefer comments that explain why a behavior exists or identify an important
  constraint. Do not restate syntax that is already clear from the code.
- Update or remove comments whenever the documented behavior changes.

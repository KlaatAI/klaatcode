# Schema migrations

Applied migrations for the user-profile service, newest last. Every module in
`src/` is expected to be consistent with the latest applied migration.

## 0005-add-user-timezone (applied 2025-11-02)

Added `User.timezone` (IANA zone name, defaults to `"UTC"`). Digest scheduling
in `src/users/settings.ts` reads it.

## 0006-add-user-status (applied 2026-01-19)

Added `User.status` (`"active" | "suspended" | "deleted"`). Suspended and
deleted users are excluded from the search index and from notification sends.

## 0007-rename-nickname-to-display-name (applied 2026-04-08)

The legacy `User.nickname` field was renamed to `User.displayName`.

Rationale: "nickname" was optional in the v1 schema and half the codebase fell
back to email prefixes when it was missing. `displayName` is required, always
populated at signup, and is the single canonical human-readable name.

Scope of the rename:

- `src/users/types.ts`: the `User` interface now declares `displayName` only.
  There is **no** `nickname` property on the model. Records in the store never
  carry a `nickname` key.
- All readers were updated to `user.displayName`: profile rendering, settings,
  serializers (JSON and CSV), the search indexer, and notification templates.
- Any remaining read of `nickname` is a defect: the property does not exist on
  stored records, so such a read evaluates to `undefined` at runtime.

## 0008-preferences-digest-frequency (applied 2026-05-30)

`UserPreferences.digestFrequency` gained the `"never"` value. The notification
service must skip digest composition entirely when it is set.

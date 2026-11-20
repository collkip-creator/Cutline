# Cutline Studio Firestore Security Specification (Phase 0)

## Data Invariants
1. **Strict Owner Isolation (Zero Cross-User Leaks)**: A document under `/users/{userId}` or `/users/{userId}/socialConnections/{platform}` may ONLY be read, listed, created, updated, or deleted by the authenticated, email-verified user whose `request.auth.uid == userId`. Because `socialConnections` holds OAuth `accessToken` and `refreshToken`, zero blanket reads are allowed.
2. **Master Gate Integrity**: Every `socialConnections/{platform}` write requires `request.auth.uid == userId`, a valid parent user document (`exists(/databases/$(database)/documents/users/$(userId))`), and an exact allowlisted platform ID (`platform in ['tiktok', 'instagram', 'youtube']`) matching `request.resource.data.platform == platform`.
3. **Strict Schema & No Ghost Fields**: Writes enforce exact required and allowed field sets (`keys().hasAll(...) && keys().hasOnly(...)`) with strict type, string `.size()`, bounded array (`scopes.size() <= 25`), and non-negative numeric `expiresAt` checks.
4. **Immutable Ownership & Temporal Integrity**: `uid` and `createdAt` on `/users/{userId}` are immutable after creation; `createdAt` and `updatedAt` MUST equal `request.time`.

## The "Dirty Dozen" Attack Payloads (All Must Return PERMISSION_DENIED)
1. **Unauthenticated read/write**: `request.auth == null` reading `/users/alice/socialConnections/tiktok`.
2. **Unverified email write**: `request.auth.uid == 'alice'` with `token.email_verified == false` writing `/users/alice/socialConnections/youtube`.
3. **Cross-user access (IDOR)**: `bob` reading or writing `/users/alice/socialConnections/instagram`.
4. **Cross-user collection list**: `bob` listing `/users/alice/socialConnections`.
5. **Poisoned document ID**: `alice` writing `/users/alice/socialConnections/invalid..id!` or `'x'.repeat(200)`.
6. **Platform mismatch spoofing**: writing `{ platform: 'youtube', ... }` to `/users/alice/socialConnections/tiktok`.
7. **Shadow / Ghost field injection**: creating `SocialConnection` with extra `{ isAdmin: true }` or `{ role: 'superuser' }`.
8. **Client-forged timestamp**: writing `updatedAt: '2020-01-01T00:00:00Z'` instead of `request.time`.
9. **Oversized token/string DoS**: injecting 100 KB `accessToken` exceeding `4096` byte cap.
10. **Unbounded array injection**: injecting `scopes` list with > 25 entries or non-string first element (`scopes: [123]`).
11. **User UID spoofing / mutation**: updating `/users/alice` changing `uid` to `'bob'` or mutating `createdAt`.
12. **Global catch-all escalation**: writing to an undeclared collection `/admins/alice` or `/globalSecrets/tiktok`.

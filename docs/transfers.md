# Guardian NFT transfers (API, SDK, agent keys)

A Guardian is an NFT in the registry. `nft_transfer` on the registry moves the NFT **and** the vault's owner role together
(it calls the vault's existing `set_owner`), so the creator's fee share follows the new owner. Nothing here changes the vault
contract or its keys: a transfer is just the current owner calling the registry.

## Humans (website: My Guardians → Transfer)
1. `GET /me/transfer-lookup?to=<username or NEAR account id>` → `{ account, name }` (shown in the confirm dialog).
2. `POST /guardians/:id/transfer` with `{ "to": "<username or account id>" }` (Bearer login) → `{ status: "done", tx, transfer_id }`.
- Blocked with HTTP 409 while a session is **Open** on that Guardian (message: "A player has an open attempt on this Guardian…").
- Only the current owner can transfer (403 otherwise); a defeated Guardian cannot be transferred from the site.
- The NFT metadata snapshot is refreshed after a transfer, so `/api/guardians/:id/metadata.json` shows the new owner even when the backend sleeps.

## Agents (API key)
Create a key with the separate permission `transfer_nft` (OFF by default):

```http
POST /agent/keys   { "budget_near": 2, "transfer_nft": true, "transfer_allowlist": ["ada", "bob.testnet"], "transfer_require_approval": true }
```
- `transfer_nft: true` **requires** a non-empty `transfer_allowlist` (usernames or account ids).
- `transfer_require_approval` defaults to **true**: `POST /guardians/:id/transfer` with `X-API-Key` returns **202** `{ status: "pending", transfer_id }`;
  the owner approves or rejects it in My Guardians (`POST /me/transfers/:id/approve|reject`, login required; a key cannot approve).
- A key without the permission gets **403**; a recipient outside the allowlist gets **403**; both are logged.
- Every agent transfer attempt (refused, pending, done, failed) is logged in `nft_transfers` with the key id. The spend budget does not cover transfers.

SDK:
```ts
const client = new VaultbreakClient(apiBase, account, fetch, { apiKey });
const r = await client.transfer("warden", "ada");   // { status: "done" | "pending", transfer_id, tx? }
```

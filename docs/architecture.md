# Architecture notes

## Verify the vault has no full-access key (any RPC)

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{
 "jsonrpc":"2.0","id":1,"method":"query",
 "params":{"request_type":"view_access_key_list","finality":"final","account_id":"warden.registry.vbreak-t2funder-1109.testnet"}}'
```
Expected (live Warden vault; the older Layer 1 vault `strong.vbreak-deployer-1109.testnet` gives the same shape): exactly one key whose permission is `{"FunctionCall":{"method_names":["release","close_session"],"receiver_id":"<the vault>", "allowance": ...}}` and no `"FullAccess"`.

## Key flow

1. `deploy-vault.ts` generates a Guardian keypair (private half to `.keys/guardian-<vault>.json`, referenced by `key_ref`).
2. The vault account is created with a temporary bootstrap key, the wasm is deployed and `new` is called (the attached deposit seeds the pot).
3. `AddKey(function-call, receiver=vault, methods=[release, close_session], allowance)` for the Guardian key, then `DeleteKey(bootstrap)`.
4. The runtime loads the Guardian key and signs only what the model's tools map to. The model never sees it.

## Why the honeypots work

| Tool | Runtime action | Chain result |
|---|---|---|
| `release_pot` | function call `release(session_id)` | allowed |
| `send_funds` | `Transfer` action signed by the function-call key | rejected: "Access key requires full access" |
| `change_owner` | function call to a method outside the allow-list | rejected: "Access key does not allow method ..." |

Rejected transactions never land on-chain, so the runtime records each as a `blocked_attempts` row and reports the count in `close_session`.

## Build gotcha

`near-sdk` selects real host functions only with `--cfg near` (what `cargo-near` sets). A plain `cargo build --target wasm32-unknown-unknown` compiles pure-Rust fallbacks where `panic_str` becomes a bare `unreachable` trap and error messages are lost. `scripts/build-contracts.sh` sets the flag.

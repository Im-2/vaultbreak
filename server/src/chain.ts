// Thin NEAR helpers shared by the server, scripts and sandbox tests. Uses near-api-js v7.
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

export const NEAR = 10n ** 24n;
export const GUARDIAN_METHODS = ["release", "close_session"];

/** One URL => plain provider. Comma-separated URLs => failover provider (primary first). */
export function provider(url: string): JsonRpcProvider {
  const urls = url.split(",").map((u) => u.trim()).filter(Boolean);
  const opts = { retries: 6, wait: 800, backoff: 1.6 }; // flaky links (WSL/NAT) need more than the default
  if (urls.length === 1) return new JsonRpcProvider({ url: urls[0] }, opts);
  return new FailoverRpcProvider(urls.map((u) => new JsonRpcProvider({ url: u }, opts))) as unknown as JsonRpcProvider;
}

/**
 * True for network/transport failures (timeouts, DNS, all RPC providers unreachable) as opposed to the chain
 * actually rejecting or failing a transaction. Only the latter may be reported as a chain rejection.
 */
export function isTransportError(e: any): boolean {
  // FailoverRpcProvider wraps every per-provider failure (including genuine chain rejections) in one
  // "Exceeded N providers" error carrying `errors[]`. It is a transport problem only if ALL inner errors are.
  if (Array.isArray(e?.errors) && e.errors.length) return e.errors.every((x: any) => isTransportError(x));
  const text = `${e?.name ?? ""} ${e?.type ?? ""} ${e?.message ?? ""} ${e?.cause?.code ?? ""}`;
  return /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|RetriesExceeded|socket hang up|UND_ERR|AbortError|Timeout/i.test(text);
}

/** The most informative underlying error: for a failover wrapper, the first non-transport (chain-level) inner error. */
export function unwrapError(e: any): any {
  if (Array.isArray(e?.errors) && e.errors.length) return e.errors.find((x: any) => !isTransportError(x)) ?? e.errors[0];
  return e;
}

/** Retries fn while it fails with transport errors. Chain-level failures are rethrown immediately. */
export async function retryTransport<T>(fn: () => Promise<T>, tries = 4, waitMs = 2000): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!isTransportError(e) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
    }
  }
}

export function accountFrom(accountId: string, rpcUrl: string, secretKey: string): Account {
  return new Account(accountId, provider(rpcUrl), KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`));
}

export async function view<T = unknown>(p: JsonRpcProvider, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  // read-only, so safe to retry on network errors
  return (await retryTransport(() => p.callFunction({ contractId, method, args }), 4, 1500)) as T;
}

export interface KeyInfo { publicKey: string; kind: "FullAccess" | "FunctionCall"; receiverId?: string; methodNames?: string[]; allowance?: string | null }

/** Lists the access keys on an account in a normalised form. */
export async function listKeys(p: JsonRpcProvider, accountId: string): Promise<KeyInfo[]> {
  const res: any = await p.viewAccessKeyList({ accountId, finality: "final" });
  return res.keys.map((k: any) => {
    const perm = k.access_key.permission;
    if (perm === "FullAccess") return { publicKey: k.public_key, kind: "FullAccess" as const };
    const fc = perm.FunctionCall;
    return { publicKey: k.public_key, kind: "FunctionCall" as const, receiverId: fc.receiver_id, methodNames: fc.method_names, allowance: fc.allowance };
  });
}

export interface DeployOpts {
  rpcUrl: string;
  funder: Account;
  vaultId: string;
  wasm: Uint8Array;
  owner: string;
  opsAccount: string;
  guardianPublicKey: string;
  promptHashHex: string;
  params: { min_fee: string; turns_max: number; session_ttl_ms: string; max_open_per_attacker: number };
  seedYocto: bigint;        // initial pot
  gasBufferYocto: bigint;   // balance reserved to pay the guardian key's gas (>= allowance)
  allowanceYocto: bigint;   // guardian key gas allowance
  registry?: string | null;
}

/**
 * Creates the vault account, deploys + initialises the contract, adds ONLY the guardian
 * function-call key, then deletes the temporary bootstrap key. Throws if any full-access key remains.
 * The temporary key exists in memory only, for the duration of this function.
 */
export async function deployVault(o: DeployOpts): Promise<{ keys: KeyInfo[] }> {
  const tmp = KeyPair.fromRandom("ed25519");
  const storageReserve = BigInt(o.wasm.length + 20_000) * 10n ** 19n; // 1e19 yocto per byte
  const total = o.seedYocto + o.gasBufferYocto + storageReserve;
  await o.funder.createAccount({ newAccountId: o.vaultId, publicKey: tmp.getPublicKey().toString(), nearToTransfer: total });
  const vault = new Account(o.vaultId, provider(o.rpcUrl), KeyPairSigner.fromSecretKey(tmp.toString() as `ed25519:${string}`));
  await vault.deployContract(o.wasm);
  await vault.callFunction({
    contractId: o.vaultId,
    methodName: "new",
    args: {
      owner: o.owner, ops_account: o.opsAccount, guardian_pk: o.guardianPublicKey,
      prompt_hash: o.promptHashHex, params: o.params, registry: o.registry ?? null,
    },
    deposit: o.seedYocto,
    gas: 100_000_000_000_000n,
  });
  await vault.addFunctionCallAccessKey({
    publicKey: o.guardianPublicKey, contractId: o.vaultId, methodNames: GUARDIAN_METHODS, allowance: o.allowanceYocto,
  });
  await retryTransport(() => vault.deleteKey(tmp.getPublicKey().toString()));
  // The delete must be FINAL before we judge: poll finalised state (a lagging node briefly still lists the bootstrap key).
  const p = vault.provider as JsonRpcProvider;
  let keys = await retryTransport(() => listKeys(p, o.vaultId));
  for (let i = 0; i < 20 && keys.some((k) => k.kind === "FullAccess"); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    keys = await retryTransport(() => listKeys(p, o.vaultId));
  }
  assertNoFullAccess(keys);
  return { keys };
}

export function assertNoFullAccess(keys: KeyInfo[]) {
  const bad = keys.filter((k) => k.kind === "FullAccess");
  if (bad.length) throw new Error(`vault has full-access key(s): ${bad.map((k) => k.publicKey).join(", ")}`);
}

// Thin NEAR helpers shared by the server, scripts and sandbox tests. Uses near-api-js v7.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

export const NEAR = 10n ** 24n;
export const GUARDIAN_METHODS = ["release", "close_session"];

export function provider(url: string): JsonRpcProvider {
  return new JsonRpcProvider({ url });
}

export function accountFrom(accountId: string, rpcUrl: string, secretKey: string): Account {
  return new Account(accountId, provider(rpcUrl), KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`));
}

export async function view<T = unknown>(p: JsonRpcProvider, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await p.callFunction({ contractId, method, args })) as T;
}

export interface KeyInfo { publicKey: string; kind: "FullAccess" | "FunctionCall"; receiverId?: string; methodNames?: string[]; allowance?: string | null }

/** Lists the access keys on an account in a normalised form. */
export async function listKeys(p: JsonRpcProvider, accountId: string): Promise<KeyInfo[]> {
  const res: any = await p.viewAccessKeyList({ accountId });
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
  const vault = new Account(o.vaultId, o.rpcUrl, KeyPairSigner.fromSecretKey(tmp.toString() as `ed25519:${string}`));
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
  await vault.deleteKey(tmp.getPublicKey().toString());
  const keys = await listKeys(vault.provider as JsonRpcProvider, o.vaultId);
  assertNoFullAccess(keys);
  return { keys };
}

export function assertNoFullAccess(keys: KeyInfo[]) {
  const bad = keys.filter((k) => k.kind === "FullAccess");
  if (bad.length) throw new Error(`vault has full-access key(s): ${bad.map((k) => k.publicKey).join(", ")}`);
}

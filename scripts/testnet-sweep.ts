// Moves (almost) all NEAR from faucet-funded testnet accounts into one account. Usage:
//   node --import tsx scripts/testnet-sweep.ts <to-account> <from-account> [<from-account> ...]
// Keys are read from .keys/<account>.json (gitignored). Each source keeps 0.1 NEAR.
import { readFileSync } from "node:fs";
import { accountFrom, NEAR, retryTransport } from "../server/src/chain.ts";
const rpc = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org";
const [to, ...from] = process.argv.slice(2);
if (!to || !from.length) throw new Error("usage: testnet-sweep.ts <to> <from...>");
for (const f of from) {
  const key = JSON.parse(readFileSync(`.keys/${f}.json`, "utf8")).private_key;
  const acct = accountFrom(f, rpc, key);
  const bal = BigInt((await retryTransport(() => acct.getState())).balance.total);
  const amount = bal - NEAR / 10n;
  if (amount <= 0n) { console.log(f, "nothing to move"); continue; }
  await retryTransport(() => acct.transfer({ receiverId: to, amount }));
  console.log(`${f} -> ${to}: ${(Number(amount / 10n ** 20n) / 1e4).toFixed(2)} NEAR`);
}

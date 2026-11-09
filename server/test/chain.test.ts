import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransportError, retryTransport } from "../src/chain.ts";

test("transport errors are distinguished from chain rejections", () => {
  assert.equal(isTransportError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })), true);
  assert.equal(isTransportError({ type: "RetriesExceeded", message: "Exceeded 2 providers to execute request" }), true);
  assert.equal(isTransportError(new Error("Access key requires full access")), false);
  assert.equal(isTransportError(new Error("Access key does not allow method change_owner")), false);
  assert.equal(isTransportError(new Error("Smart contract panicked: vault is defeated")), false);
});

test("retryTransport retries transport errors only", async () => {
  let n = 0;
  const v = await retryTransport(async () => { if (++n < 3) throw new TypeError("fetch failed"); return "ok"; }, 4, 1);
  assert.deepEqual([v, n], ["ok", 3]);
  let m = 0;
  await assert.rejects(() => retryTransport(async () => { m++; throw new Error("Smart contract panicked: x"); }, 4, 1), /panicked/);
  assert.equal(m, 1);
});

test("failover wrapper: chain rejections inside it are NOT transport errors", async () => {
  const { isTransportError, unwrapError } = await import("../src/chain.ts");
  const chain = new Error("Access key requires full access");
  const net = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
  const wrapped = (errors: any[]) => Object.assign(new Error("Exceeded 2 providers to execute request"), { type: "RetriesExceeded", errors });
  assert.equal(isTransportError(wrapped([chain, chain])), false);
  assert.equal(isTransportError(wrapped([net, net])), true);
  assert.equal(isTransportError(wrapped([net, chain])), false);
  assert.equal(unwrapError(wrapped([net, chain])), chain);
});

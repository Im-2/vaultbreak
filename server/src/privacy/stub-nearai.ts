// Local stub of the NEAR AI Cloud API (chat completions + response signatures + attestation report) used by the Layer 2
// tests and scripts/privacy-demo.ts. It signs with a real secp256k1 key (EIP-191) so signature recovery is genuinely
// exercised, and builds attestation reports whose (fake) TDX quote REPORTDATA binds signer + nonce. NOT a TEE: the Intel
// quote signature itself is only verified against the real NEAR AI Cloud (see the LIVE test).
import { createServer, type Server } from "node:http";
import { Wallet } from "ethers";
import { MockLlm } from "../llm.ts";
import { signedText } from "./signing.ts";

export const STUB_MODEL = "stub/tee-model";

export function fakeQuote(signingAddress: string, nonce: string): string {
  const q = Buffer.alloc(700, 7);
  Buffer.concat([Buffer.from(signingAddress.replace(/^0x/, ""), "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex")]).copy(q, 568);
  return q.toString("hex");
}

export function startNearAiStub(): Promise<{ server: Server; base: string; wallet: Wallet; close: () => void }> {
  const wallet = Wallet.createRandom();
  const MODEL = STUB_MODEL;
  const calls = new Map<string, { req: string; res: string }>();
  let n = 0;
  const mock = new MockLlm();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    let body = ""; for await (const d of req) body += d;
    const send = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
    if (url.pathname === "/v1/chat/completions") {
      const b = JSON.parse(body);
      const r = await mock.complete({ model: b.model, maxTokens: 1, tools: [], messages: b.messages.map((m: any) => ({ role: m.role, content: m.content ?? "" })) });
      const id = `chatcmpl-stub-${++n}`;
      const resBody = JSON.stringify({ id, choices: [{ message: { role: "assistant", content: r.content || null, tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } }] });
      calls.set(id, { req: body, res: resBody });
      return send(200, resBody);
    }
    if (url.pathname.startsWith("/v1/signature/")) {
      const c = calls.get(decodeURIComponent(url.pathname.split("/").pop()!));
      if (!c) return send(404, { error: "not found" });
      const text = signedText(MODEL, c.req, c.res);
      return send(200, { text, signature: await wallet.signMessage(text), signing_address: wallet.address.toLowerCase(), signing_algo: "ecdsa" });
    }
    if (url.pathname === "/v1/attestation/report") {
      const nonce = url.searchParams.get("nonce")!;
      return send(200, { model_attestations: [{ model_name: url.searchParams.get("model"), signing_address: wallet.address.toLowerCase(), signing_algo: "ecdsa", request_nonce: nonce, intel_quote: fakeQuote(wallet.address, nonce) }] });
    }
    send(404, { error: "no route" });
  });
  return new Promise((r) => server.listen(0, () => r({ server, wallet, base: `http://127.0.0.1:${(server.address() as any).port}/v1`, close: () => server.close() })));
}

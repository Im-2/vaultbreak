import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** AES-256-GCM key for prompts at rest. From PROMPT_ENC_KEY, else a generated file in the keys dir. */
export function promptKey(keysDir: string, env = process.env): Buffer {
  if (env.PROMPT_ENC_KEY) return createHash("sha256").update(env.PROMPT_ENC_KEY).digest();
  const f = `${keysDir}/prompt.key`;
  if (!existsSync(f)) {
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(f, randomBytes(32).toString("hex"));
  }
  return createHash("sha256").update(readFileSync(f, "utf8")).digest();
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decrypt(blob: string, key: Buffer): string {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

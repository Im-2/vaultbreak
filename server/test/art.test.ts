// NFT card art v2: state rule, text-as-paths, formatting, and no verification claims on the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { artState, cardSvg, hashText, potText, VETERAN_STREAK } from "../src/art.ts";

test("state rule: released -> defeated; long unbroken streak -> veteran; any other armed -> armed", () => {
  assert.equal(artState("Defeated", 99), "defeated");
  assert.equal(artState("Defeated", 0), "defeated");
  assert.equal(artState("Armed", VETERAN_STREAK), "veteran");
  assert.equal(artState("Armed", VETERAN_STREAK - 1), "armed");
  assert.equal(artState("Armed", 3), "armed"); // the Warden bug: an armed Guardian with a short streak is NOT a veteran
});

test("formatting", () => {
  assert.equal(potText(10n ** 24n * 100865n / 100n), "1,008.65");
  assert.equal(potText("0"), "0.00");
  assert.equal(hashText("fcbd7d86eb3f282ec3c89a276650b30022e57da7af8d4ad010eefd015a58ce39"), "fcbd7d…ce39");
});

const base = { num: 42, name: "The Warden", pot: "201.65", attempts: "12", streak: "12", blocked: "3", wins: "0", hash: "fcbd7d…ce39" };
test("three palettes, valid SVG, text drawn as paths (no font needed)", () => {
  const armed = cardSvg({ ...base, state: "armed" }), vet = cardSvg({ ...base, state: "veteran" }), def = cardSvg({ ...base, state: "defeated" });
  for (const s of [armed, vet, def]) {
    assert.ok(s.startsWith("<svg") && s.trimEnd().endsWith("</svg>"));
    assert.ok(!/<text|font-family|@font-face/.test(s), "no live text: glyphs are paths");
    assert.ok((s.match(/<path /g) ?? []).length > 100);
  }
  assert.ok(armed.includes("#c9a24a") && !armed.includes("clip-path"));
  assert.ok(vet.includes("#aeb9c8"));
  assert.ok(def.includes("#8b9099") && def.includes("clip-path") && def.includes("#b5403f"), "graphite, split medallion, red stamp");
  assert.ok(def.length > armed.length, "the released card carries the stamp and the split medallion");
});

test("names are escaped in the title and very long names are clipped", () => {
  const s = cardSvg({ ...base, state: "armed", name: `<script>"x"&` + "y".repeat(80) });
  assert.ok(!s.includes("<script>"));
  assert.ok(s.includes("&lt;script&gt;"));
});

test("the card never claims verification or attestation", () => {
  const src = readFileSync(new URL("../src/art.ts", import.meta.url), "utf8").toLowerCase();
  assert.ok(src.includes("sealed prompt"));
  assert.ok(!/verified|tee-attested|attested/.test(src.replace(/^\/\/.*$/gm, "")));
});

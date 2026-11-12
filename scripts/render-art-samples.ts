// Renders the three reference cards from ui/nfts-v2/gen.py with the TypeScript port (docs/art-v2/*.svg) for a side-by-side check.
import { writeFileSync } from "node:fs";
import { cardSvg } from "../server/src/art.ts";
const out = "docs/art-v2";
writeFileSync(`${out}/armed.svg`, cardSvg({ state: "armed", num: 42, name: "The Warden", pot: "201.65", attempts: "12", streak: "12", blocked: "3", wins: "0", hash: "fcbd7d…ce39" }));
writeFileSync(`${out}/veteran.svg`, cardSvg({ state: "veteran", num: 113, name: "Silent Keep", pot: "1,008.68", attempts: "214", streak: "25", blocked: "37", wins: "0", hash: "c0d4a1…88f1" }));
writeFileSync(`${out}/defeated.svg`, cardSvg({ state: "defeated", num: 7, name: "Old Ironside", pot: "0.00", attempts: "61", streak: "0", blocked: "11", wins: "1", hash: "5be2f0…04a9" }));
console.log("ok");

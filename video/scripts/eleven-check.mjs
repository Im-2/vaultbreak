// Lists ElevenLabs voices (looking for "Matilda") and the remaining character quota. Never prints the key.
const key = process.env.ELEVENLABS_API_KEY; if (!key) throw new Error("ELEVENLABS_API_KEY not set");
const h = { "xi-api-key": key };
const v = await fetch("https://api.elevenlabs.io/v1/voices", { headers: h }); const vj = await v.json();
console.log("voices status", v.status, "count", vj.voices?.length ?? vj.detail?.message ?? JSON.stringify(vj).slice(0, 200));
const m = (vj.voices ?? []).filter((x) => /matilda/i.test(x.name)); console.log("Matilda:", JSON.stringify(m.map((x) => ({ name: x.name, id: x.voice_id, category: x.category }))));
console.log("others (first 12):", (vj.voices ?? []).slice(0, 12).map((x) => `${x.name} [${x.category}]`).join(", "));
const s = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: h }); const sj = await s.json();
console.log("subscription:", s.status, JSON.stringify({ tier: sj.tier, used: sj.character_count, limit: sj.character_limit, remaining: (sj.character_limit ?? 0) - (sj.character_count ?? 0), reset: sj.next_character_count_reset_unix }));

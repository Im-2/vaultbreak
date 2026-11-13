// Generates (once) and caches the narration with ElevenLabs. Voice: "Matilda" (looked up by name via GET /v1/voices).
// Reads ELEVENLABS_API_KEY from the environment (never printed). Usage: node --env-file=.env video/scripts/tts.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
const key = process.env.ELEVENLABS_API_KEY; if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
const scenes = JSON.parse(readFileSync(new URL("./narration.json", import.meta.url), "utf8"));
const dir = new URL("../audio/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); mkdirSync(dir, { recursive: true });
const voices = await (await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } })).json();
const v = (voices.voices ?? []).find((x) => /^matilda/i.test(x.name)); if (!v) throw new Error("Matilda is not available on this plan");
console.log(`voice: ${v.name} (${v.voice_id}, ${v.category})`);
let used = 0;
for (const s of scenes) {
  const file = `${dir}${s.id}.mp3`;
  if (existsSync(file)) { console.log(`cached ${s.id}`); continue; }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voice_id}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: s.text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.62, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`${s.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer())); used += s.text.length;
  console.log(`generated ${s.id} (${s.text.length} characters)`);
}
console.log(`characters used this run: ${used}; script total: ${scenes.reduce((a, s) => a + s.text.length, 0)}`);

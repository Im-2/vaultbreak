// Assembles the demo from the recorded scenes (video/raw/<mode>/), the cached narration (video/audio/trimmed/) and video/edit.json.
//   node video/scripts/assemble.mjs [mode=live]
// Outputs: video/demo.mp4, video/demo.srt, video/demo-captions.mp4, video/x-clip.mp4, and a build report.
// The recorded footage is only TRIMMED and JOINED (jump cuts over waiting time, a frozen last frame to fill a gap): no result is ever composited in.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const mode = process.argv[2] ?? "live";
const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const RAW = `${root}raw/${mode}/`, AUD = `${root}audio/trimmed/`, BUILD = `${root}build/`;
mkdirSync(BUILD, { recursive: true });
const narr = JSON.parse(readFileSync(`${root}scripts/narration.json`, "utf8"));
const edit = JSON.parse(readFileSync(`${root}edit.json`, "utf8"));
const ff = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"], cwd: root });
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());
const LEAD = 0.25, GAP = 0.3;

const report = []; const starts = []; let t = 0; const parts = [];
for (const sc of narr) {
  const spec = edit[sc.id]; if (!spec) throw new Error(`no edit spec for ${sc.id}`);
  const audio = `${AUD}${sc.id}.wav`; const aDur = probe(audio); const target = +(aDur + spec.pad).toFixed(2);
  // --- video: segments from marks
  const inputs = [], filters = []; let idx = 0, vTotal = 0;
  for (const seg of spec.segments) {
    const file = `${RAW}${seg.src ?? sc.id}.webm`; const marks = JSON.parse(readFileSync(`${RAW}${seg.src ?? sc.id}.json`, "utf8")).marks;
    const m = (v) => (typeof v === "number" ? v : marks[v] ?? (() => { throw new Error(`mark ${v} missing in ${seg.src ?? sc.id}`); })());
    const from = m(seg.from) + (seg.skip ?? 0), to = m(seg.to);
    const ranges = seg.head !== undefined ? [[from, from + seg.head], [Math.max(from + seg.head, to - seg.tail), to]] : [[from, seg.max ? Math.min(to, from + seg.max) : to]];
    for (const [a, b] of ranges) { if (b - a < 0.05) continue; inputs.push("-ss", a.toFixed(2), "-t", (b - a).toFixed(2), "-i", file); filters.push(`[${idx}:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[v${idx}]`); idx++; vTotal += b - a; }
  }
  const concat = filters.map((_, i) => `[v${i}]`).join("") + `concat=n=${idx}:v=1:a=0[vc]`;
  const extra = Math.max(0, target + GAP - vTotal);
  const vf = `${filters.join(";")};${concat};[vc]tpad=stop_mode=clone:stop_duration=${extra.toFixed(2)},trim=duration=${(target + GAP).toFixed(2)},setpts=PTS-STARTPTS[vout]`;
  const outV = `${BUILD}${sc.id}.mp4`;
  ff([...inputs, "-filter_complex", vf, "-map", "[vout]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", outV]);
  // --- audio: narration with a short lead-in, padded with silence to the scene length + the gap
  const outA = `${BUILD}${sc.id}.wav`;
  ff(["-i", audio, "-af", `adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad=whole_dur=${(target + GAP).toFixed(2)}`, "-ar", "44100", "-ac", "2", outA]);
  starts.push(t); parts.push({ id: sc.id, v: outV, a: outA, dur: target + GAP, narrationStart: t + LEAD, narrationEnd: t + LEAD + aDur, text: sc.text });
  report.push(`${sc.id.padEnd(20)} audio ${aDur.toFixed(2)}s  scene ${target.toFixed(2)}s  footage ${vTotal.toFixed(1)}s${vTotal > target + 0.4 ? "  (CUT DOWN)" : vTotal < target - 0.4 ? "  (last frame held " + (target - vTotal).toFixed(1) + "s)" : ""}`);
  t += target + GAP;
}
const total = t - GAP; // the last gap is not needed
console.log(report.join("\n")); console.log(`TOTAL ${total.toFixed(2)}s`);

// --- captions (sentence chunks, time-proportional inside each narration)
const srtTime = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${x.toFixed(3).padStart(6, "0").replace(".", ",")}`; };
let srt = "", n = 1;
for (const p of parts) {
  const chunks = p.text.split(/(?<=[.:;?!])\s+/).flatMap((c) => (c.length > 95 ? c.split(/,\s+/).reduce((acc, w, i, arr) => { const last = acc[acc.length - 1]; if (last && (last + " " + w).length < 95) acc[acc.length - 1] = last + ", " + w; else acc.push(w); return acc; }, []) : [c]));
  const totalChars = chunks.reduce((a, c) => a + c.length, 0); let cur = p.narrationStart;
  for (const c of chunks) { const d = (p.narrationEnd - p.narrationStart) * (c.length / totalChars); srt += `${n++}\n${srtTime(cur)} --> ${srtTime(cur + d - 0.04)}\n${c}\n\n`; cur += d; }
}
writeFileSync(`${root}demo.srt`, srt);

// --- join, fades, loudness
const list = parts.map((p) => `file '${p.v.replace(/\\/g, "/")}'`).join("\n"); writeFileSync(`${BUILD}v.txt`, list);
const alist = parts.map((p) => `file '${p.a.replace(/\\/g, "/")}'`).join("\n"); writeFileSync(`${BUILD}a.txt`, alist);
ff(["-f", "concat", "-safe", "0", "-i", `${BUILD}v.txt`, "-c", "copy", `${BUILD}joined.mp4`]);
ff(["-f", "concat", "-safe", "0", "-i", `${BUILD}a.txt`, "-c", "copy", `${BUILD}joined.wav`]);
const final = (out, vf) => ff(["-i", `${BUILD}joined.mp4`, "-i", `${BUILD}joined.wav`, "-t", total.toFixed(2),
  "-vf", `${vf}fade=t=in:st=0:d=0.6,fade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8,format=yuv420p`,
  "-af", `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.3,afade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8`,
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart", out]);
final(`${root}demo.mp4`, "");
// burned-in captions (run from the video/ folder so the filter path stays simple)
final(`${root}demo-captions.mp4`, "subtitles=demo.srt:force_style='FontName=DejaVu Sans,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&HCC000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=34',");
// x clip: scene 4 (the weak Guardian release), with its narration
const p4 = parts.find((p) => p.id === "04-weak"); const s4 = starts[parts.indexOf(p4)];
ff(["-ss", s4.toFixed(2), "-t", (p4.dur - GAP + 0.2).toFixed(2), "-i", `${root}demo.mp4`, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", `${root}x-clip.mp4`]);
for (const f of ["demo.mp4", "demo-captions.mp4", "x-clip.mp4"]) console.log(`${f}: ${probe(root + f).toFixed(2)}s`);

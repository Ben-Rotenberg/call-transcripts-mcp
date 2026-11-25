// Run: node test/run.mjs [path/to/real-call.m4a]
// Needs ffmpeg/ffprobe on PATH and Node 22+ (node:sqlite).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { makeD1, makeKV, startFakeOpenAI, makeAudio } from "./harness.mjs";

// Load the Worker with its internal functions exported (the Worker itself only
// has a default export, so the deployed file stays unchanged).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctm-"));
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const mod = path.join(tmp, "worker.mjs");
fs.writeFileSync(mod, src + "\nexport { transcribe, parseMp4Audio, planCuts, buildM4a, runSync, callTool, ensureSchema, renderTranscript };\n");
const W = await import(mod);
const worker = W.default;

const TOKEN = "t".repeat(32);
let passed = 0;
const only = process.env.ONLY;
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.stack.split("\n").slice(0, 4).join("\n     ")}`);
    process.exitCode = 1;
  }
}
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
const pcmLen = (f) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], { maxBuffer: 1 << 30 }).length / 2;
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

async function env(fake, extra = {}) {
  const e = { DB: makeD1(), AUDIO: makeKV(), OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: fake?.url + "/v1", MCP_TOKEN: TOKEN, TRANSCRIBE_LANGUAGE: "he", BATCH_SIZE: "10", ...extra };
  await W.ensureSchema(e);
  return e;
}
const tool = async (e, name, args = {}) => W.callTool(name, args, e);
async function ingest(e, id, name, buf, durationMs) {
  const qs = new URLSearchParams({ id, name, size: String(buf.length), duration_ms: String(durationMs || ""), created: "2026-11-23T11:11:16Z" });
  const res = await worker.fetch(new Request(`https://w/ingest/${TOKEN}?${qs}`, { method: "POST", body: buf }), e, {});
  return res.json();
}
async function check(e, ids) {
  const res = await worker.fetch(new Request(`https://w/ingest/${TOKEN}/check`, { method: "POST", body: JSON.stringify({ ids }) }), e, {});
  return res.json();
}

// ---------------------------------------------------------------------------
// 1. Cutting: pieces are valid M4A files, together exactly the original audio
// ---------------------------------------------------------------------------
async function cutCheck(file, label) {
  const buf = fs.readFileSync(file);
  const mp4 = W.parseMp4Audio(toAB(buf));
  const total = probe(file);
  assert.ok(Math.abs(mp4.durationSec - total) < 0.2, `duration ${mp4.durationSec} vs ffprobe ${total}`);
  const ranges = W.planCuts(mp4, 0, mp4.sampleCount);
  let sum = 0;
  let pcm = 0;
  for (const [i, [a, b]] of ranges.entries()) {
    assert.equal(i ? ranges[i - 1][1] : 0, a, "pieces must be contiguous");
    const out = path.join(tmp, `${label}-${i}.m4a`);
    fs.writeFileSync(out, W.buildM4a(mp4, a, b));
    const d = probe(out);
    assert.ok(d <= 271, `piece ${i} is ${d}s`);
    sum += d;
    pcm += pcmLen(out);
  }
  assert.equal(ranges.at(-1)[1], mp4.sampleCount);
  assert.ok(Math.abs(sum - total) < 0.5, `pieces sum to ${sum}s, file is ${total}s`);
  const orig = pcmLen(file);
  // AAC decoders drop/insert ~1 frame of priming per file; allow 2 frames per piece
  assert.ok(Math.abs(pcm - orig) <= ranges.length * 2 * 1024 + 2048, `decoded samples ${pcm} vs ${orig}`);
  return { ranges: ranges.length, total, pieces: ranges.map(([a, b]) => Math.round(mp4.sampleTime(b) - mp4.sampleTime(a))) };
}

const real = process.argv[2];
if (real) {
  await test(`real Cube ACR file is cut into valid pieces`, async () => {
    const r = await cutCheck(real, "real");
    console.log(`     ${r.total}s -> ${r.ranges} pieces: ${r.pieces.join(", ")}s`);
  });
}
const f14 = path.join(tmp, "call14.m4a");
const f30 = path.join(tmp, "call30.m4a");
const f3 = path.join(tmp, "call3.m4a");
const b14 = makeAudio(f14, 848);
const b30 = makeAudio(f30, 1800, { faststart: true });
const b3 = makeAudio(f3, 170);
await test("14-minute file (moov at end) cuts into valid contiguous pieces", async () => console.log("     " + JSON.stringify(await cutCheck(f14, "s14"))));
await test("30-minute file (moov first) cuts into valid contiguous pieces", async () => console.log("     " + JSON.stringify(await cutCheck(f30, "s30"))));
await test("3-minute file stays one piece (and short calls are sent whole)", async () => assert.equal((await cutCheck(f3, "s3")).ranges, 1));

// ---------------------------------------------------------------------------
// 2. End to end through ingest + sync + tools
// ---------------------------------------------------------------------------
await test("14-minute call is transcribed to the end, in pieces, status done", async () => {
  const fake = await startFakeOpenAI();
  const e = await env(fake);
  const { id } = await ingest(e, "drive-14", "0500000000 ↙ (phone) 2026-11-23 13-11-16.m4a", b14, 848000);
  const r = await W.runSync(e, {});
  assert.equal(r.transcribed, 1, JSON.stringify(r));
  const row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.equal(row.status, "done");
  assert.equal(row.partial_note, null);
  const segs = JSON.parse(row.segments);
  assert.ok(segs.length >= 3);
  assert.ok(segs.at(-1).end >= 847, `last piece ends at ${segs.at(-1).end}`);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end);
  assert.ok(fake.log.every((x) => x.model === "gpt-4o-transcribe" && x.tokens < 2048));
  // continuity prompt carries the end of the previous piece
  assert.ok(fake.log[1].prompt.includes(segs[0].text.slice(-30)));
  const out = await tool(e, "get_transcript", { id });
  assert.ok(!out.includes("PARTIAL"));
  const marks = [...out.matchAll(/^\[(\d+):(\d\d)\]/gm)].map((m) => +m[1] * 60 + +m[2]);
  assert.ok(marks.at(-1) >= 600, out.slice(0, 300));
  fake.close();
});

await test("30-minute call: complete, no gaps or overlaps between pieces", async () => {
  const fake = await startFakeOpenAI();
  const e = await env(fake);
  const { id } = await ingest(e, "drive-30", "Dana (0500000000) ↗ (phone) 2026-11-20 10-00-00.m4a", b30, 1800000);
  await W.runSync(e, {});
  const row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.equal(row.status, "done");
  const segs = JSON.parse(row.segments);
  const covered = segs.reduce((s, x) => s + (x.end - x.start), 0);
  assert.ok(Math.abs(covered - 1800) < 1, `covered ${covered}`);
  const audioSum = fake.log.reduce((s, x) => s + x.dur, 0);
  assert.ok(Math.abs(audioSum - 1800) < 1, `sent ${audioSum}s of audio`);
  assert.equal(row.model, "gpt-4o-transcribe");
  fake.close();
});

await test("a piece that still hits the output limit is split again", async () => {
  const fake = await startFakeOpenAI({ tokensPerSec: 9 }); // 270 s -> 2430 tokens > cap
  const e = await env(fake);
  const { id } = await ingest(e, "drive-fast", "0500000000 ↙ (phone) 2026-11-23 13-11-16.m4a", b14, 848000);
  await W.runSync(e, {});
  const row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.equal(row.status, "done", row.partial_note);
  assert.ok(fake.log.some((x) => x.tokens === 2047), "some first attempts hit the cap");
  const segs = JSON.parse(row.segments);
  assert.ok(segs.every((s) => s.status === "ok"));
  assert.ok(segs.at(-1).end >= 847);
  fake.close();
});

await test("a piece that fails is marked partial and get_transcript warns", async () => {
  const fake = await startFakeOpenAI({ failAt: new Set([2, 3]) }); // piece 2 and its whisper fallback
  const e = await env(fake);
  const { id } = await ingest(e, "drive-fail", "0500000000 ↙ (phone) 2026-11-23 13-11-16.m4a", b14, 848000);
  await W.runSync(e, {});
  const row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.equal(row.status, "partial");
  assert.match(row.partial_note, /could not be transcribed/);
  const out = await tool(e, "get_transcript", { id });
  assert.match(out, /⚠️ PARTIAL: Transcript is incomplete \(call length 14:08\): 3:\d\d–\d:\d\d could not be transcribed/);
  assert.match(out, /\[not transcribed: /);
  const st = await tool(e, "sync_status");
  assert.match(st, /partial=1/);
  assert.match(st, /Partial transcripts/);
  const list = await tool(e, "list_calls");
  assert.match(list, /\[partial\]/);
  const search = await tool(e, "search_calls", { query: "מילה5" });
  assert.match(search, /PARTIAL/);
  // exported with the warning
  const done = await (await worker.fetch(new Request(`https://w/ingest/${TOKEN}/done`), e, {})).json();
  assert.equal(done.calls[0].status, "partial");
  assert.ok(done.calls[0].transcript_marked.startsWith("[0:00]"));
  fake.close();
});

await test("file that can't be cut (mp3): gpt-4o hits the limit -> whisper-1 completes it", async () => {
  const fake = await startFakeOpenAI();
  const e = await env(fake);
  const mp3 = path.join(tmp, "c.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", f14, "-c:a", "libmp3lame", "-b:a", "24k", mp3]);
  const r = await W.transcribe(e, toAB(fs.readFileSync(mp3)), "c.mp3", 848);
  assert.equal(r.model, "whisper-1");
  assert.equal(r.partialNote, null);
  assert.deepEqual(fake.log.map((x) => x.model), ["gpt-4o-transcribe", "whisper-1"]);
  fake.close();
});

await test("file that can't be cut and whisper fails: kept, marked partial", async () => {
  const fake = await startFakeOpenAI({ failAt: new Set([2]) });
  const e = await env(fake);
  const mp3 = path.join(tmp, "c2.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", f14, "-c:a", "libmp3lame", "-b:a", "24k", mp3]);
  const r = await W.transcribe(e, toAB(fs.readFileSync(mp3)), "c.mp3", 848).catch((x) => x);
  // whisper failed after gpt-4o returned truncated text: partial, not an error
  assert.ok(r.partialNote, JSON.stringify(r).slice(0, 200));
  assert.match(r.partialNote, /cut off/);
  fake.close();
});

await test("OpenAI account problem halts and leaves the call pending", async () => {
  const fake = await startFakeOpenAI({ status402: true });
  const e = await env(fake);
  const { id } = await ingest(e, "drive-q", "x ↙ (phone) 2026-11-23 13-11-16.m4a", b14, 848000);
  await W.runSync(e, {});
  const row = await e.DB.prepare("SELECT status, attempts FROM calls WHERE id=?").bind(id).first();
  assert.deepEqual({ ...row }, { status: "pending", attempts: 0 });
  assert.match(await tool(e, "sync_status"), /out of credit/);
  fake.close();
});

// ---------------------------------------------------------------------------
// 3. sync_now(retry_id) keeps the id and the old transcript
// ---------------------------------------------------------------------------
await test("retry of a call whose audio expired: same id, old transcript kept, audio requested, then replaced", async () => {
  const fake = await startFakeOpenAI();
  const e = await env(fake);
  // an old, truncated transcript from before the fix
  const { id } = await ingest(e, "drive-old", "0500000000 ↙ (phone) 2026-11-23 13-11-16.m4a", b14, 848000);
  e.AUDIO.map.clear();
  await e.DB.prepare("UPDATE calls SET status='done', model='gpt-4o-transcribe', transcript=?, exported=1 WHERE id=?").bind("ישן ".repeat(1500), id).run();

  const out = await tool(e, "sync_now", { retry_id: id });
  assert.match(out, /keeps its id/);
  assert.match(out, /send it again/);
  let row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.ok(row, "row must still exist");
  assert.equal(row.status, "done");
  assert.equal(row.needs_audio, 1);
  assert.ok(row.transcript.startsWith("ישן"));
  assert.match(await tool(e, "get_transcript", { id }), /ישן/);

  const c = await check(e, ["drive-old", "drive-new"]);
  assert.deepEqual(c.unknown, ["drive-new"]);
  assert.deepEqual(c.resend, ["drive-old"]);
  const again = await ingest(e, "drive-old", "0500000000 ↙ (phone) 2026-11-23 13-11-16.m4a", b14, 848000);
  assert.deepEqual(again, { status: "requeued", id });
  assert.match(await tool(e, "get_transcript", { id }), /in progress; showing the previous transcript/);

  await W.runSync(e, {});
  row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.equal(row.id, id);
  assert.equal(row.status, "done");
  assert.ok(row.transcript.startsWith("מילה0"));
  assert.equal(row.exported, 0, "Drive .md must be rewritten");
  assert.equal(row.prev_status, null);
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM calls").first()).n, 1);
  fake.close();
});

await test("retry whose new transcription fails keeps the previous transcript", async () => {
  const fake = await startFakeOpenAI({ failAt: new Set(Array.from({ length: 100 }, (_, i) => i + 1)) });
  const e = await env(fake);
  const { id } = await ingest(e, "drive-x", "0500000000 ↙ (phone) 2026-11-23 13-11-16.m4a", b3, 170000);
  await e.DB.prepare("UPDATE calls SET status='done', model='gpt-4o-transcribe', transcript='טקסט קודם', exported=1 WHERE id=?").bind(id).run();
  await tool(e, "sync_now", { retry_id: id });
  for (let i = 0; i < 3; i++) await W.runSync(e, {});
  const row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.equal(row.status, "done");
  assert.equal(row.transcript, "טקסט קודם");
  assert.match(row.error, /OpenAI/);
  fake.close();
});

await test("recording gone from Drive: call keeps its transcript and stops waiting", async () => {
  const e = await env(null);
  const { id } = await ingest(e, "drive-g", "x ↙ (phone) 2026-11-23 13-11-16.m4a", b3, 170000);
  await e.DB.prepare("UPDATE calls SET status='done', needs_audio=1, prev_status='done', transcript='קודם' WHERE id=?").bind(id).run();
  await worker.fetch(new Request(`https://w/ingest/${TOKEN}/gone`, { method: "POST", body: JSON.stringify({ ids: ["drive-g"] }) }), e, {});
  const row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(id).first();
  assert.equal(row.needs_audio, 0);
  assert.equal(row.status, "done");
  assert.equal(row.transcript, "קודם");
});

// ---------------------------------------------------------------------------
// 4. Finding transcripts made before the fix
// ---------------------------------------------------------------------------
await test("check_truncated lists, marks and re-queues old cut-off transcripts", async () => {
  const e = await env(null);
  const add = async (sid, dur, chars, model = "gpt-4o-transcribe") => {
    const { id } = await ingest(e, sid, `x ↙ (phone) 2026-11-2${sid.length % 9} 13-11-16.m4a`, b3, dur * 1000);
    await e.DB.prepare("UPDATE calls SET status='done', model=?, transcript=?, duration_sec=? WHERE id=?").bind(model, "א".repeat(chars), dur, id).run();
    return id;
  };
  const bad = await add("a1", 848, 5761);
  await add("a2", 300, 4000); // short call
  await add("a3", 900, 2000); // long but little speech
  await add("a4", 1600, 9000, "whisper-1"); // whisper has no such limit
  e.AUDIO.map.clear();
  const list = await tool(e, "check_truncated");
  assert.match(list, new RegExp(`^1 transcripts`));
  assert.match(list, new RegExp(`#${bad} `));
  assert.match(await tool(e, "sync_status"), /probably cut off: 1/);
  const q = await tool(e, "check_truncated", { mode: "retranscribe" });
  assert.match(q, /Queued 1 of 1/);
  const row = await e.DB.prepare("SELECT * FROM calls WHERE id=?").bind(bad).first();
  assert.equal(row.needs_audio, 1);
  assert.equal(row.status, "done");
  assert.match(await tool(e, "get_transcript", { id: bad }), /PARTIAL: Transcript is likely incomplete/);
  assert.equal(await tool(e, "check_truncated"), "No older transcripts look cut off.");
});

await test("each cron run cuts at most 2 long calls by default (CPU limit)", async () => {
  const fake = await startFakeOpenAI();
  const e = await env(fake);
  for (let i = 0; i < 3; i++) await ingest(e, `l${i}`, `x ↙ (phone) 2026-11-2${i} 13-11-16.m4a`, b14, 848000);
  await ingest(e, "s0", "x ↙ (phone) 2026-11-19 13-11-16.m4a", b3, 170000);
  const r = await W.runSync(e, {});
  assert.equal(r.transcribed, 3, JSON.stringify(r)); // 2 long + the short one
  assert.equal(r.pending, 1);
  fake.close();
});

await test("long calls are left for the next run instead of exceeding the request budget", async () => {
  const fake = await startFakeOpenAI();
  const e = await env(fake, { LONG_CALLS_PER_RUN: "10" });
  for (let i = 0; i < 6; i++) await ingest(e, `b${i}`, `x ↙ (phone) 2026-11-2${i} 13-11-16.m4a`, b30, 1800000);
  const r = await W.runSync(e, {});
  assert.ok(r.transcribed >= 3 && r.transcribed < 6, JSON.stringify(r));
  assert.ok(fake.log.length <= 40, `${fake.log.length} OpenAI requests`);
  fake.close();
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
process.exit();

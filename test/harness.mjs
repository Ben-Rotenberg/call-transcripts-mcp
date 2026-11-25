// Local test harness: D1 and KV stand-ins backed by node:sqlite and a Map, plus
// a fake OpenAI /audio/transcriptions server that measures each uploaded piece
// with ffprobe and simulates gpt-4o-transcribe's 2,048-token output limit.
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql) => {
    let args = [];
    const stmt = {
      bind(...a) { args = a.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x)); return stmt; },
      async run() {
        const st = db.prepare(sql);
        if (/\bRETURNING\b/i.test(sql)) return { results: st.all(...args), meta: {} };
        const r = st.run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
    };
    return stmt;
  };
  return {
    raw: db,
    prepare: wrap,
    async batch(stmts) { for (const s of stmts) await s.run(); return []; },
  };
}

export function makeKV() {
  const m = new Map();
  return {
    map: m,
    async get(k) { const v = m.get(k); return v ? v.slice(0) : null; },
    async put(k, v) { m.set(k, v instanceof ArrayBuffer ? v.slice(0) : new Uint8Array(v).buffer); },
    async delete(k) { m.delete(k); },
  };
}

// opts.tokensPerSec: simulated output tokens per second of audio
// opts.failAt: set of request numbers (1-based) that return HTTP 500
export async function startFakeOpenAI(opts = {}) {
  const tps = opts.tokensPerSec ?? 6.5;
  const log = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeoai-"));
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const boundary = /boundary=(.+)$/.exec(req.headers["content-type"])[1];
    const fields = {};
    let file = null;
    for (const part of body.toString("latin1").split("--" + boundary)) {
      const m = /name="([^"]+)"(?:; filename="([^"]*)")?/.exec(part);
      if (!m) continue;
      const start = part.indexOf("\r\n\r\n") + 4;
      const val = part.slice(start, part.length - 2);
      if (m[2] !== undefined) file = Buffer.from(val, "latin1");
      else fields[m[1]] = Buffer.from(val, "latin1").toString("utf8");
    }
    n++;
    const f = path.join(dir, `piece-${n}.m4a`);
    fs.writeFileSync(f, file);
    let dur;
    try {
      dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
    } catch (e) {
      res.writeHead(400); res.end("invalid file"); log.push({ n, invalid: true }); return;
    }
    const entry = { n, model: fields.model, dur, bytes: file.length, prompt: fields.prompt, file: f };
    log.push(entry);
    if (opts.failAt?.has(n)) { res.writeHead(500); res.end("server error"); entry.failed = true; return; }
    if (opts.status402) { res.writeHead(429); res.end('{"error":{"code":"insufficient_quota"}}'); return; }
    const words = Math.round(dur);
    let tokens = Math.round(dur * tps);
    let text = Array.from({ length: words }, (_, i) => `מילה${i}`).join(" ");
    if (fields.model !== "whisper-1" && tokens > 2048) {
      tokens = 2047;
      text = text.slice(0, Math.floor(text.length * (2047 / (dur * tps))));
    }
    entry.tokens = tokens;
    const out = { text, usage: { type: "tokens", input_tokens: 100, output_tokens: tokens } };
    if (fields.model === "whisper-1") {
      out.segments = Array.from({ length: Math.ceil(dur / 10) }, (_, i) => ({ start: i * 10, end: Math.min(dur, i * 10 + 10), text: `קטע${i}` }));
      delete out.usage;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close(), dir };
}

export function makeAudio(file, seconds, { faststart = false } = {}) {
  // speech-like: tone bursts with short pauses, AAC mono 16 kHz ~24 kbps like Cube ACR
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi",
    "-i", `aevalsrc='0.3*sin(2*PI*(300+200*sin(t/3))*t)*gt(mod(t,4),0.6)+0.01*random(0)':s=16000:d=${seconds}`,
    "-ac", "1", "-c:a", "aac", "-b:a", "24k", ...(faststart ? ["-movflags", "+faststart"] : []), file,
  ]);
  return fs.readFileSync(file);
}

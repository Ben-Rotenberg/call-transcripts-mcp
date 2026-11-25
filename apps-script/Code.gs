/**
 * 1. Sends new Cube ACR call recordings from Google Drive to the call-transcripts Worker.
 * 2. Saves every finished transcript back to Drive as a Markdown file, in the folder
 *    "Cube ACR Transcripts" (kept forever; the Worker's own copy expires after 120 days).
 *
 * Setup (once):
 *  1. Project Settings (gear icon) → Script Properties → add:
 *       WORKER_URL  = https://call-transcripts-mcp.<your-subdomain>.workers.dev
 *       MCP_TOKEN   = the same token you set as the Worker secret
 *       DRIVE_FOLDER_ID = id of the Drive folder Cube ACR uploads to (the part after /folders/ in its URL)
 *       ALERT_EMAIL = where to email you if OpenAI runs out of credit (optional)
 *  2. Run `setup` once (choose it in the toolbar, click Run, approve access).
 *     It runs a first sync and installs a trigger that runs every 5 minutes.
 */

// The Drive folder Cube ACR uploads to is read from the Script Property DRIVE_FOLDER_ID.
const FIRST_RUN_LOOKBACK_DAYS = 120; // how far back the very first run goes
const LOOKBACK_DAYS = 10;            // later runs re-check this window (covers the Worker's 7-day audio queue)
const MAX_FILES_PER_RUN = 10;            // matches the Worker's BATCH_SIZE so the KV queue stays small
const MAX_RUN_MS = 4.5 * 60 * 1000;  // Apps Script stops at 6 minutes
const MAX_BYTES = 25 * 1024 * 1024;  // OpenAI limit
const TRANSCRIPTS_FOLDER_NAME = 'Cube ACR Transcripts';
const ALERT_REMIND_HOURS = 24;       // re-send the OpenAI alert email at most once a day

function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncCalls')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncCalls').timeBased().everyMinutes(5).create();
  syncCalls();
}

function syncCalls() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a previous run is still going
  try {
    const props = PropertiesService.getScriptProperties();
    const base = (props.getProperty('WORKER_URL') || '').replace(/\/+$/, '');
    const token = props.getProperty('MCP_TOKEN');
    if (!base || !token) throw new Error('Set WORKER_URL and MCP_TOKEN in Script Properties');
    let error = null;
    try { pushRecordings(base, token, props); } catch (e) { error = e; console.error('push: ' + e); }
    try { exportTranscripts(base, token, props); } catch (e) { error = error || e; console.error('export: ' + e); }
    try { checkOpenAiHealth(base, token, props); } catch (e) { console.error('health: ' + e); }
    if (error) throw error; // shows up as a failed execution (and Google emails you)
  } finally {
    lock.releaseLock();
  }
}

// Emails you when the Worker reports an OpenAI problem (no credit / bad key),
// reminds once a day while it lasts, and emails once more when it is fixed.
// Recipient: Script Property ALERT_EMAIL.
function checkOpenAiHealth(base, token, props) {
  const res = UrlFetchApp.fetch(base + '/ingest/' + token + '/health', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;
  const h = JSON.parse(res.getContentText());
  const to = props.getProperty('ALERT_EMAIL');
  if (!to) { console.warn('ALERT_EMAIL script property is not set; cannot send the OpenAI alert'); return; }
  const last = Number(props.getProperty('ALERT_SENT_AT') || 0);
  if (h.alert) {
    if (Date.now() - last < ALERT_REMIND_HOURS * 3600 * 1000) return;
    MailApp.sendEmail({
      to: to,
      subject: '⚠️ תמלול השיחות נעצר: צריך לטפל בחשבון OpenAI',
      htmlBody:
        '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">' +
        '<p><b>התמלול של הקלטות השיחות נעצר.</b></p>' +
        '<p>OpenAI מחזיר: ' + h.alert.message + '</p>' +
        '<p>' + h.pending + ' הקלטות ממתינות. הן לא אבדו, והן יתומללו אוטומטית תוך כמה דקות מהרגע שהבעיה תיפתר.</p>' +
        '<p><a href="' + h.billing_url + '">להוספת קרדיט ב-OpenAI</a></p>' +
        '<p style="color:#666;font-size:12px">נשלח מ-Cube ACR Transcripts Sync. תזכורת תישלח פעם ביום עד שהבעיה תיפתר.</p></div>',
    });
    props.setProperty('ALERT_SENT_AT', String(Date.now()));
  } else if (last) {
    MailApp.sendEmail({
      to: to,
      subject: '✅ תמלול השיחות חזר לעבוד',
      htmlBody: '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px"><p>החשבון ב-OpenAI תקין שוב, וההקלטות שחיכו מתומללות עכשיו.</p></div>',
    });
    props.deleteProperty('ALERT_SENT_AT');
  }
}

function pushRecordings(base, token, props) {
  const started = Date.now();
  {
    const days = props.getProperty('INITIALIZED') ? LOOKBACK_DAYS : FIRST_RUN_LOOKBACK_DAYS;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const folderId = props.getProperty('DRIVE_FOLDER_ID');
    if (!folderId) throw new Error('Set DRIVE_FOLDER_ID in Script Properties');
    const folder = DriveApp.getFolderById(folderId);
    const it = folder.searchFiles('modifiedDate > "' + since + '" and trashed = false');

    const audio = [];
    const sidecars = {};
    while (it.hasNext()) {
      const f = it.next();
      const name = f.getName();
      if (/\.json$/i.test(name)) sidecars[name.replace(/\.json$/i, '')] = f;
      else if (/\.(m4a|mp3|mp4|wav|ogg|oga|webm|flac|amr|3gp|aac)$/i.test(name)) audio.push(f);
    }

    // Ask the Worker which files it hasn't seen yet
    const check = UrlFetchApp.fetch(base + '/ingest/' + token + '/check', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ ids: audio.map(f => f.getId()) }),
      muteHttpExceptions: true,
    });
    if (check.getResponseCode() !== 200) throw new Error('check failed: ' + check.getResponseCode() + ' ' + check.getContentText().slice(0, 200));
    const answer = JSON.parse(check.getContentText());
    const unknown = new Set(answer.unknown);

    // Recordings the Worker asks for again (a re-transcription, or audio that
    // expired from its queue). Looked up by id, so older files work too.
    const resend = [];
    const gone = [];
    for (const id of (answer.resend || [])) {
      try { resend.push(DriveApp.getFileById(id)); } catch (e) { gone.push(id); }
    }
    if (gone.length) {
      UrlFetchApp.fetch(base + '/ingest/' + token + '/gone', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify({ ids: gone }), muteHttpExceptions: true,
      });
    }

    const fresh = audio
      .filter(f => unknown.has(f.getId()))
      .sort((a, b) => b.getDateCreated() - a.getDateCreated()); // newest first
    const todo = resend.concat(fresh).slice(0, MAX_FILES_PER_RUN);
    if (!todo.length) { props.setProperty('INITIALIZED', '1'); return; }

    let sent = 0;
    for (const f of todo) {
      if (Date.now() - started > MAX_RUN_MS) break;
      const name = f.getName();
      let sidecar = sidecars[name.replace(/\.[^.]+$/, '')];
      if (!sidecar) sidecar = findSidecar(f);
      const meta = readSidecar(sidecar);
      const size = f.getSize();
      const params = {
        id: f.getId(),
        name: name,
        size: String(size),
        created: f.getDateCreated().toISOString(),
        duration_ms: meta.duration || '',
        callee: meta.callee || '',
        direction: meta.direction || '',
      };
      const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
      const res = UrlFetchApp.fetch(base + '/ingest/' + token + '?' + qs, {
        method: 'post',
        contentType: 'application/octet-stream',
        payload: size > MAX_BYTES ? '' : f.getBlob().getBytes(), // too big: register only
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) {
        console.warn('upload failed for ' + name + ': ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
        continue;
      }
      sent++;
    }
    console.log('Sent ' + sent + ' of ' + todo.length + ' recordings (' + unknown.size + ' new in window, ' + resend.length + ' asked for again)');
    if (sent === todo.length && todo.length < MAX_FILES_PER_RUN) props.setProperty('INITIALIZED', '1');
  }
}

/** Pull finished transcripts from the Worker and save each as a .md file in Drive. */
function exportTranscripts(base, token, props) {
  const folder = transcriptsFolder(props);
  for (let round = 0; round < 10; round++) {
    const res = UrlFetchApp.fetch(base + '/ingest/' + token + '/done?limit=20', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('done failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    const calls = JSON.parse(res.getContentText()).calls || [];
    if (!calls.length) return;

    const saved = [];
    for (const c of calls) {
      const name = transcriptFileName(c);
      const existing = folder.getFilesByName(name);
      // a re-transcribed call keeps its id, so its file is updated in place
      if (existing.hasNext()) existing.next().setContent(transcriptMarkdown(c));
      else folder.createFile(name, transcriptMarkdown(c), 'text/markdown');
      saved.push(c.id);
    }
    const ack = UrlFetchApp.fetch(base + '/ingest/' + token + '/ack', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify({ ids: saved }), muteHttpExceptions: true,
    });
    if (ack.getResponseCode() !== 200) throw new Error('ack failed: ' + ack.getResponseCode());
    console.log('Saved ' + saved.length + ' transcripts to Drive');
  }
}

function transcriptsFolder(props) {
  const id = props.getProperty('TRANSCRIPTS_FOLDER_ID');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* recreate */ }
  }
  const found = DriveApp.getRootFolder().getFoldersByName(TRANSCRIPTS_FOLDER_NAME);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(TRANSCRIPTS_FOLDER_NAME);
  props.setProperty('TRANSCRIPTS_FOLDER_ID', folder.getId());
  return folder;
}

function transcriptFileName(c) {
  const t = (c.call_time || '').replace('T', ' ');
  const who = (c.contact_name || c.phone_number || 'unknown').replace(/[\\/:*?"<>|]/g, '').trim();
  return t.slice(0, 10) + ' ' + t.slice(11, 16).replace(':', '-') + ' ' + who + ' (#' + c.id + ').md';
}

function transcriptMarkdown(c) {
  const dir = c.direction === 'Incoming' ? 'נכנסת' : c.direction === 'Outgoing' ? 'יוצאת' : (c.direction || '');
  const dur = c.duration_sec != null ? Math.floor(c.duration_sec / 60) + ':' + String(c.duration_sec % 60).padStart(2, '0') : '';
  const lines = [
    '# שיחה עם ' + (c.contact_name || c.phone_number || 'לא ידוע'),
    '',
    '- **תאריך ושעה:** ' + (c.call_time || '').replace('T', ' ').slice(0, 16),
    c.phone_number ? '- **מספר:** ' + c.phone_number : null,
    '- **סוג:** ' + [c.channel, dir].filter(Boolean).join(' '),
    dur ? '- **משך:** ' + dur : null,
    '- **קובץ הקלטה:** ' + c.file_name,
    '- **תומלל ע"י:** ' + c.model,
    c.partial_note ? '' : null,
    c.partial_note ? '> ⚠️ **תמלול חלקי:** ' + c.partial_note : null,
    '',
    '---',
    '',
    c.transcript_marked || c.transcript || '',
    '',
  ];
  return lines.filter(l => l !== null).join('\n');
}

// Cube ACR writes "<recording name>.json" next to the recording
function findSidecar(file) {
  try {
    const parents = file.getParents();
    if (!parents.hasNext()) return null;
    const it = parents.next().getFilesByName(file.getName().replace(/\.[^.]+$/, '') + '.json');
    return it.hasNext() ? it.next() : null;
  } catch (e) { return null; }
}

function readSidecar(file) {
  if (!file) return {};
  try { return JSON.parse(file.getBlob().getDataAsString()); } catch (e) { return {}; }
}

// Run once from the editor to confirm the script may send the alert email (sends nothing).
function checkMailPermission() {
  console.log('Mail permission OK. Emails left today: ' + MailApp.getRemainingDailyQuota());
}

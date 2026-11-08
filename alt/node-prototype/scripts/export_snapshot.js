'use strict';
// Saves evaluated results as a static, read-only snapshot for hosting without a backend (e.g. Vercel).
// It records the GET responses the UI needs, from a running local server, into public/snapshot.json.
// The UI switches to read-only mode when /api is unavailable and serves these responses instead.
//
// Usage (server running on :3000):  node scripts/export_snapshot.js [--group DEV] [--include-calls]
// By default voice calls are left out: they are real customer conversations (the 60 chats are synthetic).
// With --include-calls their transcripts are included, but recording links are always removed.

const fs = require('fs');
const path = require('path');

const BASE = process.env.SNAPSHOT_SOURCE || 'http://localhost:3000/api';
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const GROUP = arg('--group', 'DEV');
const INCLUDE_CALLS = args.includes('--include-calls');
const OUT = path.join(__dirname, '..', 'public', 'snapshot.json');

async function get(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const R = {};
  const config = await get('/config');
  const list = await get('/conversations?group_id=' + encodeURIComponent(GROUP));
  const items = list.items.filter((i) => i.evaluation_id && i.status !== 'error' && (INCLUDE_CALLS || i.channel !== 'voice call'));
  const keep = new Set(items.map((i) => i.conversation_id));

  for (const i of items) {
    const conv = await get(`/conversations/${encodeURIComponent(i.conversation_id)}?group_id=${encodeURIComponent(GROUP)}`);
    // only the evaluation shown in the list, so the history selector never points at missing data
    conv.evaluations = conv.evaluations.filter((e) => e.id === i.evaluation_id);
    // Never publish call recordings: the organizers' audio link gives access to real customers' voices.
    if (conv.record && conv.record.audio_url) { conv.record.audio_url = null; conv.record.audio_withheld = true; }
    R[`/conversations/${encodeURIComponent(i.conversation_id)}?group_id=${encodeURIComponent(GROUP)}`] = conv;
    R['/evaluations/' + i.evaluation_id] = await get('/evaluations/' + i.evaluation_id);
    i.open_appeals = 0;
  }

  const cls = await get('/checklists');
  R['/checklists'] = cls;
  for (const c of cls.items) R['/checklists/' + encodeURIComponent(c.uid)] = await get('/checklists/' + encodeURIComponent(c.uid));

  const created = new Date().toISOString();
  R['/config'] = { ...config, static: true, snapshot: { created_at: created, group_id: GROUP, conversations: items.length, calls_included: INCLUDE_CALLS } };
  R['/datasets'] = [{ group_id: GROUP, fetched_at: created, total: items.length }];
  R['/conversations?group_id=' + encodeURIComponent(GROUP)] = { ...list, items };
  R['/appeals'] = [];
  R['/appeals?status=open'] = [];
  const exp = await get('/export?group_id=' + encodeURIComponent(GROUP));
  R['/export?group_id=' + encodeURIComponent(GROUP)] = exp.filter((e) => keep.has(e.conversation_id));

  fs.writeFileSync(OUT, JSON.stringify({ created_at: created, responses: R }));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`Snapshot: ${items.length} dialogs of ${GROUP}${INCLUDE_CALLS ? ' (calls included)' : ' (calls excluded)'} -> ${path.relative(process.cwd(), OUT)}, ${kb} KB`);
}

main().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });

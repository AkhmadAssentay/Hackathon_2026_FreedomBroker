'use strict';
// Tiny JSON-file storage. Datasets are stored per group; everything else in db.json.
// Swappable later for Dataverse / SQL — the API layer only uses these functions.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DS_DIR = path.join(DATA_DIR, 'datasets');
fs.mkdirSync(DS_DIR, { recursive: true });

let db = { checklists: [], evaluations: [], appeals: [], active_checklist: null };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();

// ---------- datasets ----------
function safeGroup(g) {
  return String(g).replace(/[^A-Za-z0-9_-]/g, '_');
}
function saveDataset(groupId, records) {
  const file = path.join(DS_DIR, safeGroup(groupId) + '.json');
  fs.writeFileSync(file, JSON.stringify({ group_id: groupId, fetched_at: now(), records }, null, 1));
}
function listDatasets() {
  return fs
    .readdirSync(DS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const d = JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf8'));
      return { group_id: d.group_id, fetched_at: d.fetched_at, total: d.records.length };
    });
}
function getDataset(groupId) {
  const file = path.join(DS_DIR, safeGroup(groupId) + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function findConversation(conversationId, groupId) {
  const groups = groupId ? [groupId] : listDatasets().map((d) => d.group_id);
  for (const g of groups) {
    const d = getDataset(g);
    const r = d && d.records.find((x) => x.conversation_id === conversationId);
    if (r) return { record: r, group_id: g };
  }
  return null;
}

// ---------- checklists (versioned: every save = new immutable version) ----------
function listChecklists() {
  return db.checklists;
}
function getChecklist(cid) {
  return db.checklists.find((c) => c.uid === cid) || null;
}
function activeChecklist() {
  return getChecklist(db.active_checklist) || db.checklists[db.checklists.length - 1] || null;
}
function saveChecklist(cl, { activate = true } = {}) {
  const sameFamily = db.checklists.filter((c) => c.id === cl.id);
  const version = sameFamily.length ? Math.max(...sameFamily.map((c) => c.version || 1)) + 1 : cl.version || 1;
  const rec = { ...cl, version, uid: `${cl.id}@v${version}`, saved_at: now() };
  db.checklists.push(rec);
  if (activate) db.active_checklist = rec.uid;
  save();
  return rec;
}
function setActive(uid) {
  if (!getChecklist(uid)) return false;
  db.active_checklist = uid;
  save();
  return true;
}

// ---------- evaluations ----------
function addEvaluation(ev) {
  const rec = { id: id('ev'), created_at: now(), ...ev };
  db.evaluations.push(rec);
  save();
  return rec;
}
function getEvaluation(eid) {
  return db.evaluations.find((e) => e.id === eid) || null;
}
function updateEvaluation(eid, patch) {
  const e = getEvaluation(eid);
  Object.assign(e, patch, { updated_at: now() });
  save();
  return e;
}
function listEvaluations(filter = {}) {
  return db.evaluations.filter(
    (e) =>
      (!filter.conversation_id || e.conversation_id === filter.conversation_id) &&
      (!filter.group_id || e.group_id === filter.group_id) &&
      (!filter.checklist_uid || e.checklist_uid === filter.checklist_uid)
  );
}
function latestEvaluation(conversationId, checklistUid) {
  const list = listEvaluations({ conversation_id: conversationId, checklist_uid: checklistUid });
  return list[list.length - 1] || null;
}

// ---------- appeals ----------
function addAppeal(a) {
  const rec = { id: id('ap'), created_at: now(), status: 'open', ...a };
  db.appeals.push(rec);
  save();
  return rec;
}
function getAppeal(aid) {
  return db.appeals.find((a) => a.id === aid) || null;
}
function updateAppeal(aid, patch) {
  const a = getAppeal(aid);
  Object.assign(a, patch, { updated_at: now() });
  save();
  return a;
}
function listAppeals(filter = {}) {
  return db.appeals.filter((a) => (!filter.status || a.status === filter.status) && (!filter.evaluation_id || a.evaluation_id === filter.evaluation_id));
}

module.exports = {
  saveDataset, listDatasets, getDataset, findConversation,
  listChecklists, getChecklist, activeChecklist, saveChecklist, setActive,
  addEvaluation, getEvaluation, updateEvaluation, listEvaluations, latestEvaluation,
  addAppeal, getAppeal, updateAppeal, listAppeals,
};

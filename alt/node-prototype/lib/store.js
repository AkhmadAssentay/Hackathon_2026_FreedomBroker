'use strict';
// Storage behind one async interface, with two backends:
//   - MongoDB (MONGODB_URI set): used online (Vercel), shared by all users and instances;
//   - JSON files in data/ (default): local runs, no setup.
// The API layer only uses the functions exported at the bottom.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();
const clone = (x) => (x === null || x === undefined ? x : JSON.parse(JSON.stringify(x)));

// =====================================================================
// File backend
// =====================================================================
function fileBackend() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  const DS_DIR = path.join(DATA_DIR, 'datasets');
  fs.mkdirSync(DS_DIR, { recursive: true });
  let db = { checklists: [], evaluations: [], appeals: [], active_checklist: null };
  if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  const save = () => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  };
  const safeGroup = (g) => String(g).replace(/[^A-Za-z0-9_-]/g, '_');
  const dsFile = (g) => path.join(DS_DIR, safeGroup(g) + '.json');
  const evMatch = (f) => (e) =>
    (!f.conversation_id || e.conversation_id === f.conversation_id) &&
    (!f.group_id || e.group_id === f.group_id) &&
    (!f.checklist_uid || e.checklist_uid === f.checklist_uid);

  return {
    kind: 'file',
    async saveDataset(groupId, records) {
      fs.writeFileSync(dsFile(groupId), JSON.stringify({ group_id: groupId, fetched_at: now(), records }, null, 1));
    },
    async listDatasets() {
      return fs.readdirSync(DS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
        const d = JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf8'));
        return { group_id: d.group_id, fetched_at: d.fetched_at, total: d.records.length };
      });
    },
    async getDataset(groupId) {
      return fs.existsSync(dsFile(groupId)) ? JSON.parse(fs.readFileSync(dsFile(groupId), 'utf8')) : null;
    },
    async listChecklists() { return clone(db.checklists); },
    async getChecklist(uid) { return clone(db.checklists.find((c) => c.uid === uid) || null); },
    async getActiveUid() { return db.active_checklist; },
    async insertChecklist(rec, activate) {
      db.checklists.push(rec);
      if (activate) db.active_checklist = rec.uid;
      save();
    },
    async setActiveUid(uid) { db.active_checklist = uid; save(); },
    async insertEvaluation(rec) { db.evaluations.push(rec); save(); },
    async getEvaluation(eid) { return clone(db.evaluations.find((e) => e.id === eid) || null); },
    async updateEvaluation(eid, patch) {
      const e = db.evaluations.find((x) => x.id === eid);
      if (!e) return null;
      Object.assign(e, patch);
      save();
      return clone(e);
    },
    async listEvaluations(f) { return clone(db.evaluations.filter(evMatch(f))); },
    async latestEvaluations(conversationIds, checklistUid) {
      const want = new Set(conversationIds);
      const out = {};
      for (const e of db.evaluations) if (e.checklist_uid === checklistUid && want.has(e.conversation_id)) out[e.conversation_id] = e;
      return clone(out);
    },
    async insertAppeal(rec) { db.appeals.push(rec); save(); },
    async getAppeal(aid) { return clone(db.appeals.find((a) => a.id === aid) || null); },
    async updateAppeal(aid, patch) {
      const a = db.appeals.find((x) => x.id === aid);
      if (!a) return null;
      Object.assign(a, patch);
      save();
      return clone(a);
    },
    async listAppeals(f) {
      return clone(db.appeals.filter((a) => (!f.status || a.status === f.status) && (!f.evaluation_id || a.evaluation_id === f.evaluation_id)
        && (!f.evaluation_ids || f.evaluation_ids.includes(a.evaluation_id))));
    },
  };
}

// =====================================================================
// MongoDB backend (one document per dataset, checklist version, evaluation and appeal)
// =====================================================================
function mongoBackend(uri) {
  const { MongoClient } = require('mongodb');
  // Reuse the connection across serverless invocations of the same instance.
  const g = globalThis;
  if (!g.__cqaMongo) g.__cqaMongo = { client: new MongoClient(uri, { maxPoolSize: 5 }), ready: null };
  const state = g.__cqaMongo;
  const NO_ID = { projection: { _id: 0 } };
  async function col(name) {
    if (!state.ready) {
      state.ready = (async () => {
        await state.client.connect();
        const db = state.client.db(process.env.MONGODB_DB || 'cqa');
        await Promise.all([
          db.collection('evaluations').createIndex({ conversation_id: 1, checklist_uid: 1, created_at: 1 }),
          db.collection('evaluations').createIndex({ id: 1 }, { unique: true }),
          db.collection('appeals').createIndex({ id: 1 }, { unique: true }),
          db.collection('appeals').createIndex({ evaluation_id: 1, status: 1 }),
          db.collection('checklists').createIndex({ uid: 1 }, { unique: true }),
          db.collection('datasets').createIndex({ group_id: 1 }, { unique: true }),
        ]);
        return db;
      })().catch((e) => { state.ready = null; throw e; });
    }
    return (await state.ready).collection(name);
  }

  return {
    kind: 'mongodb',
    async saveDataset(groupId, records) {
      await (await col('datasets')).replaceOne({ group_id: groupId }, { group_id: groupId, fetched_at: now(), records }, { upsert: true });
    },
    async listDatasets() {
      const rows = await (await col('datasets')).aggregate([
        { $project: { _id: 0, group_id: 1, fetched_at: 1, total: { $size: '$records' } } },
        { $sort: { group_id: 1 } },
      ]).toArray();
      return rows;
    },
    async getDataset(groupId) { return (await col('datasets')).findOne({ group_id: groupId }, NO_ID); },
    async listChecklists() { return (await col('checklists')).find({}, NO_ID).sort({ saved_at: 1 }).toArray(); },
    async getChecklist(uid) { return (await col('checklists')).findOne({ uid }, NO_ID); },
    async getActiveUid() {
      const m = await (await col('meta')).findOne({ _id: 'active_checklist' });
      return m ? m.value : null;
    },
    async insertChecklist(rec, activate) {
      await (await col('checklists')).insertOne({ ...rec });
      if (activate) await this.setActiveUid(rec.uid);
    },
    async setActiveUid(uid) {
      await (await col('meta')).replaceOne({ _id: 'active_checklist' }, { _id: 'active_checklist', value: uid }, { upsert: true });
    },
    async insertEvaluation(rec) { await (await col('evaluations')).insertOne({ ...rec }); },
    async getEvaluation(eid) { return (await col('evaluations')).findOne({ id: eid }, NO_ID); },
    async updateEvaluation(eid, patch) {
      return (await col('evaluations')).findOneAndUpdate({ id: eid }, { $set: patch }, { returnDocument: 'after', projection: { _id: 0 } });
    },
    async listEvaluations(f) {
      const q = {};
      for (const k of ['conversation_id', 'group_id', 'checklist_uid']) if (f[k]) q[k] = f[k];
      return (await col('evaluations')).find(q, NO_ID).sort({ created_at: 1 }).toArray();
    },
    async latestEvaluations(conversationIds, checklistUid) {
      const rows = await (await col('evaluations')).aggregate([
        { $match: { checklist_uid: checklistUid, conversation_id: { $in: conversationIds } } },
        { $sort: { created_at: -1 } },
        { $group: { _id: '$conversation_id', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
        { $project: { _id: 0 } },
      ]).toArray();
      return Object.fromEntries(rows.map((e) => [e.conversation_id, e]));
    },
    async insertAppeal(rec) { await (await col('appeals')).insertOne({ ...rec }); },
    async getAppeal(aid) { return (await col('appeals')).findOne({ id: aid }, NO_ID); },
    async updateAppeal(aid, patch) {
      return (await col('appeals')).findOneAndUpdate({ id: aid }, { $set: patch }, { returnDocument: 'after', projection: { _id: 0 } });
    },
    async listAppeals(f) {
      const q = {};
      if (f.status) q.status = f.status;
      if (f.evaluation_id) q.evaluation_id = f.evaluation_id;
      if (f.evaluation_ids) q.evaluation_id = { $in: f.evaluation_ids };
      return (await col('appeals')).find(q, NO_ID).sort({ created_at: 1 }).toArray();
    },
  };
}

const B = process.env.MONGODB_URI ? mongoBackend(process.env.MONGODB_URI) : fileBackend();

// =====================================================================
// Public API (all async)
// =====================================================================
async function findConversation(conversationId, groupId) {
  const groups = groupId ? [groupId] : (await B.listDatasets()).map((d) => d.group_id);
  for (const g of groups) {
    const d = await B.getDataset(g);
    const r = d && d.records.find((x) => x.conversation_id === conversationId);
    if (r) return { record: r, group_id: g };
  }
  return null;
}

async function activeChecklist() {
  const uid = await B.getActiveUid();
  const byUid = uid ? await B.getChecklist(uid) : null;
  if (byUid) return byUid;
  const all = await B.listChecklists();
  return all[all.length - 1] || null;
}

// Every save creates a new immutable version.
async function saveChecklist(cl, { activate = true } = {}) {
  const all = await B.listChecklists();
  const sameFamily = all.filter((c) => c.id === cl.id);
  const version = sameFamily.length ? Math.max(...sameFamily.map((c) => c.version || 1)) + 1 : cl.version || 1;
  const rec = { ...cl, version, uid: `${cl.id}@v${version}`, saved_at: now() };
  await B.insertChecklist(rec, activate);
  return rec;
}

async function setActive(uid) {
  if (!(await B.getChecklist(uid))) return false;
  await B.setActiveUid(uid);
  return true;
}

async function addEvaluation(ev) {
  const rec = { id: id('ev'), created_at: now(), ...ev };
  await B.insertEvaluation(rec);
  return rec;
}

async function latestEvaluation(conversationId, checklistUid) {
  const m = await B.latestEvaluations([conversationId], checklistUid);
  return m[conversationId] || null;
}

async function addAppeal(a) {
  const rec = { id: id('ap'), created_at: now(), status: 'open', ...a };
  await B.insertAppeal(rec);
  return rec;
}

module.exports = {
  backend: B.kind,
  saveDataset: (g, r) => B.saveDataset(g, r),
  listDatasets: () => B.listDatasets(),
  getDataset: (g) => B.getDataset(g),
  findConversation,
  listChecklists: () => B.listChecklists(),
  getChecklist: (uid) => B.getChecklist(uid),
  activeChecklist,
  saveChecklist,
  setActive,
  addEvaluation,
  getEvaluation: (eid) => B.getEvaluation(eid),
  updateEvaluation: (eid, patch) => B.updateEvaluation(eid, { ...patch, updated_at: now() }),
  listEvaluations: (f = {}) => B.listEvaluations(f),
  latestEvaluation,
  latestEvaluations: (ids, uid) => B.latestEvaluations(ids, uid),
  addAppeal,
  getAppeal: (aid) => B.getAppeal(aid),
  updateAppeal: (aid, patch) => B.updateAppeal(aid, { ...patch, updated_at: now() }),
  listAppeals: (f = {}) => B.listAppeals(f),
};

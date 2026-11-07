'use strict';
// Uploads the local file storage (data/db.json, data/datasets/*.json) to MongoDB.
// Safe to re-run: every record is upserted by its id, nothing is duplicated.
// Usage: MONGODB_URI is read from .env (or the environment):  node scripts/migrate_to_mongo.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI не задан (.env)');
  const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
  const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
  const dsDir = path.join(DATA_DIR, 'datasets');
  const datasets = fs.readdirSync(dsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8')));

  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const m = client.db(process.env.MONGODB_DB || 'cqa');
    const upsertAll = async (name, docs, key) => {
      if (!docs.length) return 0;
      const ops = docs.map((d) => ({ replaceOne: { filter: { [key]: d[key] }, replacement: d, upsert: true } }));
      await m.collection(name).bulkWrite(ops, { ordered: false });
      return docs.length;
    };
    const counts = {
      datasets: await upsertAll('datasets', datasets, 'group_id'),
      checklists: await upsertAll('checklists', db.checklists, 'uid'),
      evaluations: await upsertAll('evaluations', db.evaluations, 'id'),
      appeals: await upsertAll('appeals', db.appeals, 'id'),
    };
    if (db.active_checklist) {
      await m.collection('meta').replaceOne({ _id: 'active_checklist' }, { _id: 'active_checklist', value: db.active_checklist }, { upsert: true });
    }
    const dialogs = datasets.reduce((n, d) => n + d.records.length, 0);
    console.log(`MongoDB (${m.databaseName}): ${counts.datasets} datasets (${dialogs} dialogs), ${counts.checklists} checklist versions, ${counts.evaluations} evaluations, ${counts.appeals} appeals; active checklist ${db.active_checklist}`);
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });

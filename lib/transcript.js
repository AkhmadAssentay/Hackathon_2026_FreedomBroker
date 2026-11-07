'use strict';
// Transcript helpers: indexing, timestamps (chat MM:SS, calls ISO 8601), timing facts.

function parseClock(ts) {
  // "MM:SS" or "HH:MM:SS" -> seconds
  const parts = String(ts).trim().split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function isIso(ts) {
  return typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(ts);
}

// Returns messages with idx, seconds offset from start (for audio seek), original timestamp kept intact.
function indexTranscript(record) {
  const tr = Array.isArray(record.transcript) ? record.transcript : [];
  let t0 = null;
  return tr.map((m, idx) => {
    let sec = null;
    if (isIso(m.timestamp)) {
      const ms = Date.parse(m.timestamp);
      if (!Number.isNaN(ms)) {
        if (t0 === null) t0 = ms;
        sec = (ms - t0) / 1000;
      }
    } else if (m.timestamp !== undefined && m.timestamp !== null) {
      sec = parseClock(m.timestamp);
    }
    return {
      idx,
      timestamp: m.timestamp,
      offset_sec: sec,
      speaker: String(m.speaker || '').toLowerCase(),
      text: String(m.text || ''),
    };
  });
}

function fmtSec(s) {
  if (s === null || s === undefined) return '?';
  const m = Math.floor(s / 60);
  const ss = Math.round(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

// Timing facts computed deterministically, passed to the model as hints.
function timingFacts(msgs, thresholdSec = 180) {
  const facts = { first_operator_idx: null, first_response_sec: null, long_waits: [] };
  const firstClient = msgs.find((m) => m.speaker === 'client');
  const firstOp = msgs.find((m) => m.speaker === 'operator');
  if (firstOp) facts.first_operator_idx = firstOp.idx;
  if (firstClient && firstOp && firstClient.offset_sec !== null && firstOp.offset_sec !== null && firstOp.idx > firstClient.idx) {
    facts.first_response_sec = firstOp.offset_sec - firstClient.offset_sec;
  }
  // Gaps where a client message waits for the next operator message longer than the threshold.
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.speaker !== 'client' || m.offset_sec === null) continue;
    const nextOp = msgs.slice(i + 1).find((x) => x.speaker === 'operator');
    if (!nextOp || nextOp.offset_sec === null) continue;
    // only count once per client "turn": skip if the next message is also client
    const next = msgs[i + 1];
    if (next && next.speaker === 'client') continue;
    const gap = nextOp.offset_sec - m.offset_sec;
    if (gap > thresholdSec) facts.long_waits.push({ from_idx: m.idx, to_idx: nextOp.idx, gap_sec: gap });
  }
  return facts;
}

function normText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[«»"“”„'`’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { indexTranscript, timingFacts, fmtSec, normText, parseClock };

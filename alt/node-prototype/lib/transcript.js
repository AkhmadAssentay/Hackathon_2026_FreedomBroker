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
    // Measured from the handover to the operator (the last system event before the operator's first line,
    // e.g. «Эскалация на оператора»): time spent talking to the bot is not the operator's reaction time.
    const handover = msgs.slice(firstClient.idx, firstOp.idx).reverse().find((m) => m.speaker === 'system' && m.offset_sec !== null);
    facts.first_response_sec = firstOp.offset_sec - (handover ? handover.offset_sec : firstClient.offset_sec);
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

// Structural facts read from system events, computed in code so the model does not have to infer them.
const RX = {
  holdEnd: /больше не находится на удержании|снят с удержания|off hold|no longer on hold|ұстаудан шықты/i,
  holdStart: /на удержании|on hold|ұстауда/i,
  consultStart: /началась консультация|консультация с агентом началась|consultation (has )?started/i,
  consultEnd: /агент вышел из разговора|consultation (has )?ended/i,
  operatorClosed: /оператор закрыл чат|agent closed the chat|оператор чатты жапты|оператор чатты аяқтады/i,
  clientEnded: /клиент завершил|клиент покинул|client (has )?(ended|left)|клиент чаттан шықты|клиент қоңырауды аяқтады|соединение с клиентом прервано|клиентпен байланыс үзілді|connection to customer lost/i,
  idConfirmed: /идентификац\S*\s+(успешно\s+)?(пройден|подтвержд|выполнен)|прош[её]л\s+идентификац|личност\S*\s+(клиента\s+)?подтвержд|жеке\s+басы\s+расталды|identity\s+(has\s+been\s+|was\s+)?(verified|confirmed)|verification\s+(passed|successful)/i,
};

function dialogFacts(msgs) {
  const internal = new Set();
  let hold = false;
  let consult = false;
  const holds = [];
  let holdFrom = null;
  for (const m of msgs) {
    if (m.speaker === 'system') {
      if (RX.holdEnd.test(m.text)) { if (hold) holds.push([holdFrom, m.idx]); hold = false; }
      else if (RX.holdStart.test(m.text)) { if (!hold) holdFrom = m.idx; hold = true; }
      if (RX.consultStart.test(m.text)) consult = true;
      else if (RX.consultEnd.test(m.text)) consult = false;
    } else if (m.speaker === 'operator' && (hold || consult)) internal.add(m.idx);
  }
  if (hold) holds.push([holdFrom, msgs.length - 1]);
  const ops = msgs.filter((m) => m.speaker === 'operator' && !internal.has(m.idx));
  const sys = msgs.filter((m) => m.speaker === 'system');
  const closedByOp = sys.find((m) => RX.operatorClosed.test(m.text));
  const endedByClient = sys.find((m) => RX.clientEnded.test(m.text));
  const idOk = sys.find((m) => RX.idConfirmed.test(m.text));
  return {
    internal_idx: [...internal],
    holds,
    first_client_facing_operator_idx: ops.length ? ops[0].idx : null,
    last_operator_idx: ops.length ? ops[ops.length - 1].idx : null,
    closed_by_operator_idx: closedByOp ? closedByOp.idx : null,
    ended_by_client_idx: endedByClient ? endedByClient.idx : null,
    id_confirmed_idx: idOk ? idOk.idx : null,
  };
}

module.exports = { indexTranscript, timingFacts, dialogFacts, fmtSec, normText, parseClock };

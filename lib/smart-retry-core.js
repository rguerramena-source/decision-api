// lib/smart-retry-core.js
// Smart Retry decision engine (CommonJS / Node)
// Exports: decideRetries(loans, txs, config)

function parseDateSafe(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  } catch (e) {}
  return null;
}
function daysBetween(a, b) {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}
function addDays(d, days) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + Math.round(days));
  return r;
}
function normalizeReason(r) {
  const s = String(r || '').toLowerCase();
  if (s.includes('insuf') || s.includes('fund')) return 'insufficient_funds';
  if (s.includes('network') || s.includes('timeout') || s.includes('gateway')) return 'network_error';
  if (s.includes('closed') || s.includes('cancel')) return 'account_closed';
  if (s.includes('blocked')) return 'blocked';
  if (s.includes('expire')) return 'expired';
  if (s.includes('fraud')) return 'fraud';
  if (s.includes('charge')) return 'chargeback';
  return 'unknown';
}

const defaultReasonWeights = {
  insufficient_funds: 0.6,
  network_error: 0.1,
  account_closed: -1.0,
  blocked: -0.8,
  expired: -0.5,
  chargeback: -1.0,
  unknown: 0.0
};

const defaultConfig = {
  now: undefined,
  maxAttempts: 12,
  zombieThresholdDays: 365,
  minDaysBetweenAttempts: 1,
  reasonWeights: defaultReasonWeights,
  daysWeight: 0.25,
  amountWeight: 0.2,
  attemptsWeight: -0.3,
  threshold: 0.45,
  banksKilllist: ['Monterrey Regional'],
  referenceDateField: 'last_attempt'
};

function next15or30(fromDate) {
  const y = fromDate.getUTCFullYear();
  const m = fromDate.getUTCMonth();
  const d = fromDate.getUTCDate();
  const candidate15 = new Date(Date.UTC(y, m, 15, 0, 0, 0));
  const candidate30 = new Date(Date.UTC(y, m, 30, 0, 0, 0));
  if (d < 15 && candidate15 > fromDate) return candidate15;
  if (d < 30 && candidate30 > fromDate) return candidate30;
  const nextMonth15 = new Date(Date.UTC(y, m + 1, 15, 0, 0, 0));
  return nextMonth15;
}

function decideRetries(loans, txs, cfg) {
  const config = Object.assign({}, defaultConfig, (cfg || {}));
  const now = config.now ? new Date(config.now) : new Date();

  // index txs by loan_id
  const txByLoan = {};
  (txs || []).forEach(t => {
    if (!t || !t.loan_id) return;
    if (!txByLoan[t.loan_id]) txByLoan[t.loan_id] = [];
    txByLoan[t.loan_id].push(t);
  });

  function computeForLoan(loan) {
    const bank = loan.payment_method_bank || loan.bank || loan.payment_method || null;
    const outstanding = Number(loan.total_amount_outstanding ?? loan.loan_amount ?? loan.outstanding_amount ?? 0) || 0;

    const hist = (txByLoan[loan.loan_id] || []).map(t => {
      const ts = parseDateSafe(t.completed_at || t.created_at || t.timestamp);
      return Object.assign({}, t, { ts: ts });
    }).filter(x => x.ts);
    hist.sort((a, b) => b.ts.getTime() - a.ts.getTime());
    const attempts = hist.length;
    const last = hist[0] || null;
    const lastReason = last ? normalizeReason(last.failed_reason || last.status || last.failed_message) : null;

    // KILL SWITCH: bank
    if (bank && Array.isArray(config.banksKilllist) && config.banksKilllist.includes(bank)) {
      return {
        loan_id: loan.loan_id,
        should_retry: false,
        score: 0,
        decision_reason: `killswitch_bank:${bank}`,
        proposed_charge_date: null,
        attempts,
        last_reason: lastReason,
        days_since_last_attempt: last && last.ts ? Math.round(daysBetween(now, last.ts)) : null,
        explain: { layer: 'kill_switch', bank }
      };
    }

    // Chargeback kill switch
    const anyChargeback = (txByLoan[loan.loan_id] || []).some(t => !!(t.chargeback_at));
    if (anyChargeback || (last && String(last.failed_reason || '').toLowerCase().includes('charge'))) {
      return {
        loan_id: loan.loan_id,
        should_retry: false,
        score: 0,
        decision_reason: `killswitch_chargeback`,
        proposed_charge_date: null,
        attempts,
        last_reason: lastReason,
        days_since_last_attempt: last && last.ts ? Math.round(daysBetween(now, last.ts)) : null,
        explain: { layer: 'kill_switch', chargeback: true }
      };
    }

    // hard caps: max attempts
    if (attempts >= (config.maxAttempts || defaultConfig.maxAttempts)) {
      return {
        loan_id: loan.loan_id,
        should_retry: false,
        score: 0,
        decision_reason: `max_attempts_reached:${attempts}`,
        proposed_charge_date: null,
        attempts,
        last_reason: lastReason,
        days_since_last_attempt: last && last.ts ? Math.round(daysBetween(now, last.ts)) : null,
        explain: { layer: 'hard_cap', attempts }
      };
    }

    // zombie rule
    const loanCreated = parseDateSafe(loan.created_at);
    const ageDays = loanCreated ? daysBetween(now, loanCreated) : null;
    if (ageDays !== null && ageDays > (config.zombieThresholdDays || defaultConfig.zombieThresholdDays) && attempts >= 3) {
      return {
        loan_id: loan.loan_id,
        should_retry: false,
        score: 0,
        decision_reason: `zombie_max_attempts`,
        proposed_charge_date: null,
        attempts,
        last_reason: lastReason,
        days_since_last_attempt: last && last.ts ? Math.round(daysBetween(now, last.ts)) : null,
        explain: { layer: 'hard_cap', zombie_age_days: Math.round(ageDays) }
      };
    }

    // scoring
    const r = lastReason || 'unknown';
    const reasonWeight = (config.reasonWeights && config.reasonWeights[r] !== undefined) ? config.reasonWeights[r] : (defaultReasonWeights[r] || 0);
    const daysSince = last && last.ts ? daysBetween(now, last.ts) : (loan.overdue_at ? daysBetween(now, parseDateSafe(loan.overdue_at) || now) : null);
    const daysVal = (daysSince !== null && !isNaN(daysSince)) ? daysSince : 999;
    const daysComponent = Math.tanh(daysVal / 30) * (config.daysWeight || defaultConfig.daysWeight);
    const amountComponent = (Math.log1p(outstanding) / 10) * (config.amountWeight || defaultConfig.amountWeight);
    const attemptsComp = ((Math.max(0, (config.maxAttempts || defaultConfig.maxAttempts) - attempts) / (config.maxAttempts || defaultConfig.maxAttempts)) * Math.abs(config.attemptsWeight || defaultConfig.attemptsWeight));
    const raw = reasonWeight + daysComponent + amountComponent + attemptsComp;
    const prob = 1 / (1 + Math.exp(-raw));

    // scheduling according to rules (file load day, overdue_at, 15/30)
    let baseDate = null;
    if (loan.overdue_at) baseDate = parseDateSafe(loan.overdue_at);
    if (!baseDate && last && last.ts) baseDate = last.ts;
    if (!baseDate) baseDate = now;
    let proposed = null;
    const effectiveDaysSince = daysVal;

    if (effectiveDaysSince <= 4) {
      proposed = addDays(now, 1);
    } else if (effectiveDaysSince >= 5 && effectiveDaysSince <= 14) {
      proposed = next15or30(now);
    } else if (effectiveDaysSince >= 15 && effectiveDaysSince <= 30) {
      proposed = next15or30(baseDate);
    } else {
      proposed = next15or30(baseDate);
    }

    const minGap = config.minDaysBetweenAttempts || 1;
    if (last && last.ts) {
      const minAllowed = addDays(last.ts, minGap);
      if (proposed && proposed < minAllowed) proposed = minAllowed;
    }
    if (proposed && proposed <= now) {
      proposed = next15or30(addDays(now, 1));
    }

    const shouldRetry = (prob >= (config.threshold || defaultConfig.threshold));

    return {
      loan_id: loan.loan_id,
      should_retry: !!shouldRetry,
      score: Number(prob.toFixed(4)),
      decision_reason: shouldRetry ? 'score_above_threshold' : 'below_threshold',
      proposed_charge_date: proposed ? proposed.toISOString() : null,
      attempts,
      last_reason: lastReason,
      days_since_last_attempt: daysSince !== null ? Math.round(daysSince) : null,
      explain: {
        raw,
        reasonWeight,
        daysComponent,
        amountComponent,
        attemptsComp,
        threshold: config.threshold
      }
    };
  }

  return (loans || []).map(l => computeForLoan(l));
}

module.exports = { decideRetries };

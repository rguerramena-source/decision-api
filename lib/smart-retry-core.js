// lib/smart-retry-core.js
//
// Motor de decisión basado en las reglas de aplicar_reglas_v2 del notebook.
// Entrada:
//   - loans: array de préstamos (loan_id, payment_method_bank, total_amount_outstanding, overdue_days, etc.)
//   - txs:   array de transacciones históricas (loan_id, created_at, status, failed_message, ...)
//   - config: opcional, hoy en día no lo usamos mucho
//
// Salida: array de decisiones por loan_id.

function normalizeStatus(status) {
  if (!status) return '';
  return String(status).trim().toLowerCase();
}

function summarizeHistoryByLoan(txs) {
  const byLoan = {};
  for (const tx of txs || []) {
    const loanId =
      tx && tx.loan_id != null ? String(tx.loan_id).trim() : '';
    if (!loanId) continue;
    if (!byLoan[loanId]) byLoan[loanId] = [];
    byLoan[loanId].push(tx);
  }

  const summaries = {};

  Object.keys(byLoan).forEach((loanId) => {
    // orden cronológico
    const list = byLoan[loanId].slice().sort((a, b) => {
      const da = new Date(a.created_at || a.completed_at || 0).getTime();
      const db = new Date(b.created_at || b.completed_at || 0).getTime();
      return da - db;
    });

    let prevStatus = null;
    let intentosActuales = 0;
    let lastStatus = 'new';
    let lastFailedMessage = 'none';

    for (const tx of list) {
      const status = normalizeStatus(tx.status);
      const msg = (
        tx.failed_message ||
        tx.failed_reason ||
        ''
      )
        .toString()
        .toLowerCase();

      // Ciclo nuevo si el anterior fue successful o no había previo
      const isNewCycle = prevStatus === null || prevStatus === 'successful';
      if (isNewCycle) {
        intentosActuales = 0;
      }

      intentosActuales += 1;
      prevStatus = status;

      if (status) lastStatus = status;
      if (msg) lastFailedMessage = msg;
    }

    summaries[loanId] = {
      intentos_ciclo_actual: intentosActuales,
      last_req_status: lastStatus,
      failed_message: lastFailedMessage,
    };
  });

  return summaries;
}

function nextQuincenaUtc(today) {
  const d = today instanceof Date ? today : new Date();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  let targetDay = day <= 15 ? 15 : 30;
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (targetDay > lastDayOfMonth) targetDay = lastDayOfMonth;

  return new Date(Date.UTC(year, month, targetDay));
}

function startOfDayUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Implementación en JS de aplicar_reglas_v2
function applyRulesForLoan(loan, state, today) {
  const bankRaw = loan && loan.payment_method_bank != null
    ? String(loan.payment_method_bank)
    : '';
  const bank = bankRaw.toUpperCase();

  const msg = (state.failed_message || '').toString().toLowerCase();
  const lastStatus = (state.last_req_status || 'new').toString().toLowerCase();
  const intentos = Number(state.intentos_ciclo_actual || 0);

  const diasMora = Number(loan && loan.overdue_days != null ? loan.overdue_days : 0);
  const montoPendiente = Number(
    loan && loan.total_amount_outstanding != null
      ? loan.total_amount_outstanding
      : loan && loan.loan_amount != null
      ? loan.loan_amount
      : 0
  );

  const todayDate = today instanceof Date ? today : new Date();
  const quincenaDate = nextQuincenaUtc(todayDate);
  const immediateDate = startOfDayUtc(todayDate);

  function buildDecision(decisionType, label) {
    // decisionType: 'STOP' | 'RETRY' | 'SCHEDULE'
    let confidence = 0.6;
    if (decisionType === 'STOP') confidence = 0.9;
    else if (decisionType === 'RETRY') confidence = 0.75;

    let proposedDate = null;
    if (decisionType === 'RETRY') {
      proposedDate = immediateDate.toISOString();
    } else if (decisionType === 'SCHEDULE') {
      proposedDate = quincenaDate.toISOString();
    }

    return {
      decision: decisionType,
      decision_reason: label,
      reason: label,
      confidence,
      score: confidence,
      proposed_date: proposedDate,
      should_retry: decisionType !== 'STOP',
    };
  }

  // REGLA 0: saldo real
  if (montoPendiente <= 1.0) {
    return buildDecision('STOP', 'STOP: Deuda Saldada (Saldo $0)');
  }

  // REGLA 1: Kill switch / seguridad
  if (lastStatus === 'chargeback') {
    return buildDecision('STOP', 'STOP: Riesgo Chargeback');
  }

  const fatalKeywords = ['cancelada', 'inexistente', 'fallecimiento', 'fraude', 'baja'];
  if (fatalKeywords.some((k) => msg.includes(k))) {
    return buildDecision('STOP', 'STOP: Cuenta Inválida (Hard Decline)');
  }

  if (bank.includes('MONTERREY')) {
    return buildDecision('STOP', 'STOP: Banco Bloqueado');
  }

  // REGLA 2: Hard cap por antigüedad e intentos
  if (diasMora > 365) {
    if (intentos >= 3) {
      return buildDecision('STOP', 'STOP: Límite Antigüedad (>1 año)');
    }
    return buildDecision('SCHEDULE', 'SCHEDULE: Solo Quincena (Zombie)');
  }

  if (intentos >= 12) {
    return buildDecision('STOP', 'STOP: Máximo de Intentos (12)');
  }

  // REGLA 3: Priorización (cuándo)
  if (montoPendiente < 1000) {
    return buildDecision('RETRY', 'RETRY: Inmediato (Micro-Deuda)');
  }

  if (diasMora <= 5) {
    return buildDecision('RETRY', 'RETRY: Inmediato (Fresca)');
  }

  if (bank.includes('AZTECA') || montoPendiente > 5000) {
    return buildDecision('SCHEDULE', 'SCHEDULE: Próxima Quincena (Riesgo/Monto)');
  }

  if (diasMora >= 6 && diasMora <= 20) {
    return buildDecision('RETRY', 'RETRY: Estándar (Cada 4 días)');
  }

  if (diasMora > 20) {
    return buildDecision('SCHEDULE', 'SCHEDULE: Próxima Quincena');
  }

  // Fallback
  return buildDecision('RETRY', 'RETRY: Estándar');
}

function decideRetries(loans, txs, config) {
  const cfg = config || {};
  const today = cfg.today ? new Date(cfg.today) : new Date();

  const summaries = summarizeHistoryByLoan(txs || []);

  const decisions = (loans || []).map((loan) => {
    const loanId =
      loan && loan.loan_id != null ? String(loan.loan_id).trim() : '';
    const state =
      (loanId && summaries[loanId]) || {
        intentos_ciclo_actual: 0,
        last_req_status: 'new',
        failed_message: 'none',
      };

    const ruleResult = applyRulesForLoan(loan, state, today);

    return {
      loan_id: loanId,
      ...ruleResult,
      // útil para debug: features usadas por el motor
      features: {
        payment_method_bank: loan.payment_method_bank,
        total_amount_outstanding: Number(
          loan.total_amount_outstanding != null
            ? loan.total_amount_outstanding
            : loan.loan_amount || 0
        ),
        overdue_days: Number(loan.overdue_days || 0),
        intentos_ciclo_actual: state.intentos_ciclo_actual,
        last_req_status: state.last_req_status,
        failed_message: state.failed_message,
      },
    };
  });

  return decisions;
}

module.exports = { decideRetries };

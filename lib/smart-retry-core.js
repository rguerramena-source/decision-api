// smart-retry-core.js
// Motor de decisión Smart Retry v2 (puro, sin Supabase ni fetch)

/**
 * Calcula la siguiente quincena (15 o 30) a partir de una fecha base.
 * - Si hoy <= 15 → 15 del mes.
 * - Si hoy > 15 y <= 30 → 30 del mes.
 * - Si hoy > 30 → 15 del mes siguiente.
 */
function nextQuincenaDate(from = new Date()) {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  let targetYear = year;
  let targetMonth = month;
  let targetDay;

  if (day <= 15) {
    targetDay = 15;
  } else if (day <= 30) {
    targetDay = 30;
  } else {
    targetMonth = month + 1;
    if (targetMonth > 11) {
      targetMonth = 0;
      targetYear += 1;
    }
    targetDay = 15;
  }

  const d = new Date(Date.UTC(targetYear, targetMonth, targetDay, 0, 0, 0));
  return d.toISOString();
}

/**
 * Fecha de retry inmediato (normalmente "ahora").
 */
function immediateRetryDate(from = new Date()) {
  const d = new Date(from);
  return d.toISOString();
}

function normalizeBank(bank) {
  return (bank || '').toUpperCase();
}

function normalizeMsg(msg) {
  return (msg || '').toLowerCase().trim();
}

/**
 * Motor de decisión v2.
 *
 * Espera un objeto features con al menos:
 * {
 *   loan_id: string,
 *   payment_method_bank: string,
 *   total_amount_outstanding: number,
 *   overdue_days: number,
 *   overdue_at?: string | null,
 *   intentos_ciclo_actual: number,
 *   last_req_status: string,
 *   failed_message: string
 * }
 *
 * Devuelve:
 * {
 *   loan_id,
 *   decision: 'STOP' | 'SCHEDULE' | 'RETRY',
 *   decision_reason: string,
 *   next_attempt_date: string | null
 * }
 */
function decideLoanV2(features, now = new Date()) {
  const loanId = features.loan_id;
  const bank = normalizeBank(features.payment_method_bank || '');
  const msg = normalizeMsg(features.failed_message || '');
  const lastStatus = String(features.last_req_status || 'new').toLowerCase();
  const daysOverdue = Number(features.overdue_days ?? 0);
  const amount = Number(features.total_amount_outstanding ?? 0);

  // Intentos “raw” del periodo / histórico
  const attemptsRaw = Number(features.intentos_ciclo_actual ?? 0) || 0;

  // attemptsForLimits:
  // Si el último status fue successful, tratamos los intentos como 0
  // para propósito de límites de reintento.
  const attemptsForLimits = lastStatus === 'successful' ? 0 : attemptsRaw;

  const isZombie = daysOverdue > 365;

  // ================================
  // REGLA 0: Validación de saldo
  // ================================
  if (amount <= 1.0) {
    return {
      loan_id: loanId,
      decision: 'STOP',
      decision_reason: 'STOP: Deuda Saldada (Saldo $0)',
      next_attempt_date: null,
    };
  }

  // ================================
  // REGLA 1: Kill-switch & hard declines
  // ================================
  // 1.1 Chargeback
  if (lastStatus === 'chargeback') {
    return {
      loan_id: loanId,
      decision: 'STOP',
      decision_reason: 'STOP: Riesgo Chargeback',
      next_attempt_date: null,
    };
  }

  // 1.2 Hard declines por mensaje, con subtipos
  // Catálogo:
  // - Cuenta con insuficiencia de fondos               → soft (NO hard decline)
  // - Cuenta cancelada                                  → hard
  // - Por orden del cliente: Orden de no pagar a ese Emisor  → Por orden del cliente
  // - Cuenta bloqueada                                  → hard
  // - Cuenta inexistente                                → Posible error
  // - Cuenta no pertenece al banco receptor             → Posible error
  // - Cliente no tiene autorizado el servicio           → hard
  // - Por orden del cliente: Cancelación del servicio   → Por orden del cliente
  // - Baja por oficina                                  → hard
  // - Domiciliación dada de baja                        → Por orden del cliente

  const isInsuficienciaFondos = msg.includes('insuficiencia de fondos');

  // “Por orden del cliente”
  const isOrdenCliente =
    msg.includes('por orden del cliente: orden de no pagar a ese emisor') ||
    msg.includes('por orden del cliente: cancelación del servicio') ||
    msg.includes('domiciliación dada de baja');

  if (isOrdenCliente) {
    return {
      loan_id: loanId,
      decision: 'STOP',
      decision_reason: 'STOP: Por orden del cliente',
      next_attempt_date: null,
    };
  }

  // “Posible error”
  const isPosibleError =
    msg.includes('cuenta inexistente') ||
    msg.includes('cuenta no pertenece al banco receptor');

  if (isPosibleError) {
    return {
      loan_id: loanId,
      decision: 'STOP',
      decision_reason: 'STOP: Posible error (Cuenta inválida)',
      next_attempt_date: null,
    };
  }

  // Otros hard declines (NO incluyen insuficiencia de fondos)
  const isOtherHardDecline =
    (msg.includes('cuenta cancelada') ||
      msg.includes('cuenta bloqueada') ||
      msg.includes('cliente no tiene autorizado el servicio') ||
      msg.includes('baja por oficina')) &&
    !isInsuficienciaFondos;

  if (isOtherHardDecline) {
    return {
      loan_id: loanId,
      decision: 'STOP',
      decision_reason: 'STOP: Cuenta Inválida (Hard Decline)',
      next_attempt_date: null,
    };
  }

  // Killlist banco (MONTERREY)
  if (bank.includes('MONTERREY')) {
    return {
      loan_id: loanId,
      decision: 'STOP',
      decision_reason: 'STOP: Banco Bloqueado',
      next_attempt_date: null,
    };
  }

  // ================================
  // REGLA 2: Hard caps de intentos
  // (usando attemptsForLimits)
  // ================================
  // 2.1 Zombie debt (> 1 año)
  if (isZombie) {
    if (attemptsForLimits >= 3) {
      return {
        loan_id: loanId,
        decision: 'STOP',
        decision_reason: 'STOP: Límite Antigüedad (>1 año)',
        next_attempt_date: null,
      };
    }
    // Menos de 3 intentos desde el último éxito en zombie → solo quincena
    return {
      loan_id: loanId,
      decision: 'SCHEDULE',
      decision_reason: 'SCHEDULE: Solo Quincena (Zombie)',
      next_attempt_date: nextQuincenaDate(now),
    };
  }

  // 2.2 Límite estándar de intentos en ciclo
  if (attemptsForLimits >= 12) {
    return {
      loan_id: loanId,
      decision: 'STOP',
      decision_reason: 'STOP: Máximo de Intentos (12)',
      next_attempt_date: null,
    };
  }

  // ================================
  // REGLA 3: Priorización & scheduling
  // ================================
  // 3.1 Micro-deuda
  if (amount < 1000) {
    return {
      loan_id: loanId,
      decision: 'RETRY',
      decision_reason: 'RETRY: Inmediato (Micro-Deuda)',
      next_attempt_date: immediateRetryDate(now),
    };
  }

  // 3.2 Deuda fresca (0–5 días)
  if (daysOverdue <= 5) {
    return {
      loan_id: loanId,
      decision: 'RETRY',
      decision_reason: 'RETRY: Inmediato (Fresca)',
      next_attempt_date: immediateRetryDate(now),
    };
  }

  // 3.3 Bancos de riesgo o montos altos
  if (bank.includes('AZTECA') || amount > 5000) {
    return {
      loan_id: loanId,
      decision: 'SCHEDULE',
      decision_reason: 'SCHEDULE: Próxima Quincena (Riesgo/Monto)',
      next_attempt_date: nextQuincenaDate(now),
    };
  }

  // 3.4 Mora media (6–20 días)
  if (daysOverdue >= 6 && daysOverdue <= 20) {
    return {
      loan_id: loanId,
      decision: 'RETRY',
      decision_reason: 'RETRY: Estándar (Cada 4 días)',
      next_attempt_date: immediateRetryDate(now),
    };
  }

  // 3.5 Mora alta (>20 y <=365)
  if (daysOverdue > 20) {
    return {
      loan_id: loanId,
      decision: 'SCHEDULE',
      decision_reason: 'SCHEDULE: Próxima Quincena',
      next_attempt_date: nextQuincenaDate(now),
    };
  }

  // Fallback
  return {
    loan_id: loanId,
    decision: 'RETRY',
    decision_reason: 'RETRY: Estándar',
    next_attempt_date: immediateRetryDate(now),
  };
}

module.exports = {
  decideLoanV2,
  nextQuincenaDate,
  immediateRetryDate,
};

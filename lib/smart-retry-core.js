// lib/smart-retry-core.js

// ---------------------------
//  Configuración por defecto
// ---------------------------
const DEFAULT_DECISION_CONFIG = {
  // Umbrales de negocio
  microDebtThreshold: 1000,      // < $1000 => Micro-deuda
  zombieDaysThreshold: 365,      // > 365 días => Zombie
  maxAttempts: 12,               // Límite estándar de intentos
  zombieMaxAttempts: 3,          // Límite de intentos para zombie
  freshDaysThreshold: 5,         // 0–5 días => Deuda fresca
  highAmountThreshold: 5000,     // > $5000 => Monto alto

  // Bancos especiales
  riskBanks: ['AZTECA'],         // Bancos que queremos espaciar (SCHEDULE)
  killBanks: ['MONTERREY'],      // Bancos bloqueados

  // Pesos de confianza (0–1)
  confidence: {
    stopSettled: 0.99,           // Deuda saldada
    stopChargeback: 0.95,
    stopByCustomer: 0.9,
    stopHardDecline: 0.9,
    stopPossibleError: 0.75,
    stopZombieLimit: 0.85,
    stopAttemptsLimit: 0.85,
    stopKillBank: 0.85,

    scheduleZombie: 0.7,
    scheduleRiskAmount: 0.7,
    scheduleStandardQuincena: 0.6,

    retryMicroDebt: 0.8,
    retryFresh: 0.8,
    retryStandard: 0.65,
    retryDefault: 0.6,
  },
};

// ---------------------------
//  Helpers de fechas
// ---------------------------

function cloneDate(d) {
  return new Date(d.getTime());
}

// Próxima quincena: 15 o 30 del mes en curso / siguiente
function nextQuincenaDate(now) {
  const d = cloneDate(now);
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();

  // Si estamos antes del 15, ir al 15
  if (day <= 15) {
    return new Date(Date.UTC(year, month, 15, 6, 0, 0)); // 6am UTC por seguridad
  }
  // Si estamos después del 15, ir al 30
  return new Date(Date.UTC(year, month, 30, 6, 0, 0));
}

// Retry estándar: cada 4 días
function standardRetryDate(now) {
  const d = cloneDate(now);
  d.setUTCDate(d.getUTCDate() + 4);
  d.setUTCHours(6, 0, 0, 0);
  return d;
}

// Retry inmediato: mismo día, a unas horas adelante
function immediateRetryDate(now) {
  const d = cloneDate(now);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

// ---------------------------
//  Motor principal v2
// ---------------------------

function decideLoanV2(features, now = new Date(), config = DEFAULT_DECISION_CONFIG) {
  const loanId = features.loan_id;
  const bankRaw = String(features.payment_method_bank || '');
  const bank = bankRaw.toUpperCase();

  const msgRaw = String(features.failed_message || '');
  const msg = msgRaw.toLowerCase();

  const lastStatusRaw = String(features.last_req_status || 'new');
  const lastStatus = lastStatusRaw.toLowerCase();

  const overdueDays = Number.isFinite(features.overdue_days)
    ? Number(features.overdue_days)
    : 0;

  const amount = Number.isFinite(features.total_amount_outstanding)
    ? Number(features.total_amount_outstanding)
    : 0;

  const attempts = Number.isFinite(features.intentos_ciclo_actual)
    ? Number(features.intentos_ciclo_actual)
    : 0;

  const isZombie = overdueDays > config.zombieDaysThreshold;
  const isMicroDebt = amount > 0 && amount < config.microDebtThreshold;
  const isFresh = overdueDays <= config.freshDaysThreshold;

  const c = config.confidence;

  const makeDecision = (decision, reason, nextDate, confidence) => ({
    loan_id: loanId,
    decision,
    decision_reason: reason,
    next_attempt_date: nextDate,
    confidence,
  });

  // 0) Saldo prácticamente en 0
  if (amount <= 1.0) {
    return makeDecision(
      'STOP',
      'STOP: Deuda Saldada (Saldo $0)',
      null,
      c.stopSettled
    );
  }

  // 1) Riesgo duro: chargeback y hard declines

  // 1.1 Chargeback
  if (lastStatus === 'chargeback') {
    return makeDecision(
      'STOP',
      'STOP: Riesgo Chargeback',
      null,
      c.stopChargeback
    );
  }

  // 1.2 Hard declines por mensaje
  const msgLower = msg;

  const isByCustomerOrder =
    msgLower.includes('por orden del cliente') ||
    msgLower.includes('cancelación del servicio') ||
    msgLower.includes('cancelaci\u00f3n del servicio') || // encoding alterno
    msgLower.includes('domiciliación dada de baja') ||
    msgLower.includes('domiciliaci\u00f3n dada de baja');

  const isPossibleError =
    msgLower.includes('cuenta inexistente') ||
    msgLower.includes('cuenta no pertenece al banco receptor');

  const isHardDeclineGeneric =
    msgLower.includes('cuenta cancelada') ||
    msgLower.includes('cuenta bloqueada') ||
    msgLower.includes('baja por oficina') ||
    msgLower.includes('cliente no tiene autorizado el servicio');

  if (isByCustomerOrder) {
    return makeDecision(
      'STOP',
      'STOP: Por orden del cliente',
      null,
      c.stopByCustomer
    );
  }

  if (isPossibleError) {
    return makeDecision(
      'STOP',
      'STOP: Posible error (Cuenta inválida)',
      null,
      c.stopPossibleError
    );
  }

  if (isHardDeclineGeneric) {
    return makeDecision(
      'STOP',
      'STOP: Cuenta Inválida (Hard Decline)',
      null,
      c.stopHardDecline
    );
  }

  // 1.3 Killlist de bancos
  if (config.killBanks.some((b) => bank.includes(b))) {
    return makeDecision(
      'STOP',
      'STOP: Banco Bloqueado',
      null,
      c.stopKillBank
    );
  }

  // 2) Antigüedad y límite de intentos

  // 2.1 Zombie
  if (isZombie) {
    if (attempts >= config.zombieMaxAttempts) {
      return makeDecision(
        'STOP',
        'STOP: Límite Antigüedad (>1 año)',
        null,
        c.stopZombieLimit
      );
    }
    return makeDecision(
      'SCHEDULE',
      'SCHEDULE: Solo Quincena (Zombie)',
      nextQuincenaDate(now),
      c.scheduleZombie
    );
  }

  // 2.2 Límite estándar de intentos
  if (attempts >= config.maxAttempts) {
    return makeDecision(
      'STOP',
      `STOP: Máximo de Intentos (${config.maxAttempts})`,
      null,
      c.stopAttemptsLimit
    );
  }

  // 3) Priorización: cuándo cobrar

  // 3.1 Micro-deuda
  if (isMicroDebt) {
    return makeDecision(
      'RETRY',
      'RETRY: Inmediato (Micro-Deuda)',
      immediateRetryDate(now),
      c.retryMicroDebt
    );
  }

  // 3.2 Deuda fresca
  if (isFresh) {
    return makeDecision(
      'RETRY',
      'RETRY: Inmediato (Fresca)',
      immediateRetryDate(now),
      c.retryFresh
    );
  }

  // 3.3 Bancos de riesgo o montos altos
  if (
    config.riskBanks.some((b) => bank.includes(b)) ||
    amount > config.highAmountThreshold
  ) {
    return makeDecision(
      'SCHEDULE',
      'SCHEDULE: Próxima Quincena (Riesgo/Monto)',
      nextQuincenaDate(now),
      c.scheduleRiskAmount
    );
  }

  // 3.4 Mora media (6–20 días)
  if (overdueDays >= 6 && overdueDays <= 20) {
    return makeDecision(
      'RETRY',
      'RETRY: Estándar (Cada 4 días)',
      standardRetryDate(now),
      c.retryStandard
    );
  }

  // 3.5 Mora alta (>20, <365, sin hard-decline)
  if (overdueDays > 20) {
    return makeDecision(
      'SCHEDULE',
      'SCHEDULE: Próxima Quincena',
      nextQuincenaDate(now),
      c.scheduleStandardQuincena
    );
  }

  // 4) Default
  return makeDecision(
    'RETRY',
    'RETRY: Estándar',
    standardRetryDate(now),
    c.retryDefault
  );
}

module.exports = {
  DEFAULT_DECISION_CONFIG,
  decideLoanV2,
};

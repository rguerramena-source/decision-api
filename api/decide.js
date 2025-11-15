// api/decide.js
// Serverless function en Vercel para el motor de decisión Smart Retry v2

/**
 * Construye features de histórico para un loan a partir de sus transacciones.
 * rows: array de { status, failed_message, created_at, chargeback_at? }
 */
function buildHistoryFeaturesForLoan(rows) {
  if (!rows || rows.length === 0) {
    return {
      last_req_status: 'new',
      failed_message: '',
      intentos_ciclo_actual: 0,
    };
  }

  // Ordenamos por fecha por si acaso
  const ordered = [...rows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  let attemptsSinceLastSuccess = 0;
  let lastStatus = 'new';
  let lastFailedMessage = '';

  for (const tx of ordered) {
    const status = (tx.status || '').toLowerCase();
    lastStatus = status;

    if (status === 'successful') {
      // Reinicia ciclo en cada éxito
      attemptsSinceLastSuccess = 0;
      lastFailedMessage = '';
    } else {
      // Cualquier intento no exitoso suma
      attemptsSinceLastSuccess += 1;
      if (tx.failed_message) {
        lastFailedMessage = tx.failed_message;
      }
    }

    // Si el esquema usa chargeback_at, forzamos estado chargeback
    if (tx.chargeback_at) {
      lastStatus = 'chargeback';
    }
  }

  return {
    last_req_status: lastStatus,
    failed_message: lastFailedMessage,
    intentos_ciclo_actual: attemptsSinceLastSuccess,
  };
}

/**
 * Handler principal: recibe { loans: [...] } y devuelve { decisions: [...] }
 */
module.exports = async (req, res) => {
  try {
    // 🔹 1) Cargar dependencias dentro del handler para poder capturar errores
    let supabase;
    let decideLoanV2;

    try {
      const supabaseModule = require('../supabase-admin');
      // Soporta tanto module.exports = supabase como module.exports = { supabase }
      supabase = supabaseModule.supabase ?? supabaseModule;

      const core = require('../lib/smart-retry-core');
      decideLoanV2 = core.decideLoanV2;
      if (typeof decideLoanV2 !== 'function') {
        throw new Error('decideLoanV2 is not a function from ../lib/smart-retry-core');
      }
    } catch (loadErr) {
      console.error('Error loading dependencies in /api/decide:', loadErr);
      return res.status(500).json({
        error: 'dependency_load_error',
        message: loadErr instanceof Error ? loadErr.message : String(loadErr),
      });
    }

    // 🔹 2) Validar método
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res
        .status(405)
        .json({ error: 'method_not_allowed', message: 'Use POST /api/decide' });
    }

    // 🔹 3) Parsear body
    let body = req.body || {};
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({
          error: 'invalid_json',
          message: 'Request body is not valid JSON',
        });
      }
    }

    const loans = Array.isArray(body.loans) ? body.loans : [];

    if (!loans.length) {
      return res.status(400).json({
        error: 'invalid_payload',
        message: 'Payload must include a non-empty "loans" array',
      });
    }

    // 🔹 4) Lista de loan_ids de la cartera actual
    const loanIds = loans
      .map((l) => (l.loan_id != null ? String(l.loan_id).trim() : ''))
      .filter((id) => id !== '');

    if (!loanIds.length) {
      return res.status(400).json({
        error: 'invalid_loans',
        message: 'All loans must have a non-empty loan_id',
      });
    }

    // 🔹 5) Traer histórico de transacciones en una sola query (IN)
    // Ajusta 'payment_requests' al nombre real de tu tabla en Supabase.
    let txRows, txError;
    try {
      const result = await supabase
        .from('payment_requests')
        .select(
          `
          loan_id,
          status,
          failed_message,
          created_at,
          chargeback_at
        `
        )
        .in('loan_id', loanIds);

      txRows = result.data;
      txError = result.error;
    } catch (callErr) {
      console.error('Supabase call error in /api/decide:', callErr);
      return res.status(500).json({
        error: 'supabase_call_failed',
        message: callErr instanceof Error ? callErr.message : String(callErr),
      });
    }

    if (txError) {
      console.error('Supabase error fetching history:', txError);
      return res.status(500).json({
        error: 'failed_to_fetch_history',
        message: txError.message || 'Error fetching transaction history from Supabase',
      });
    }

    // 🔹 6) Agrupar histórico por loan_id
    const historyByLoan = new Map();
    if (Array.isArray(txRows)) {
      for (const row of txRows) {
        const id = row.loan_id != null ? String(row.loan_id).trim() : '';
        if (!id) continue;
        if (!historyByLoan.has(id)) {
          historyByLoan.set(id, []);
        }
        historyByLoan.get(id).push(row);
      }
    }

    // 🔹 7) Para cada loan, construir features + decisión
    const now = new Date();

    const decisions = loans.map((loan) => {
      const loanId = loan.loan_id != null ? String(loan.loan_id).trim() : '';
      const historyRows = historyByLoan.get(loanId) || [];

      const historyFeatures = buildHistoryFeaturesForLoan(historyRows);

      // Parseo seguro de numéricos
      const amountRaw =
        loan.total_amount_outstanding ??
        loan.totalAmountOutstanding ??
        0;
      const overdueRaw =
        loan.overdue_days ??
        loan.overdueDays ??
        0;

      const amount = Number(amountRaw);
      const overdueDays = Number(overdueRaw);

      const features = {
        loan_id: loanId,
        payment_method_bank:
          loan.payment_method_bank ||
          loan.paymentMethodBank ||
          '',
        total_amount_outstanding: Number.isFinite(amount) ? amount : 0,
        overdue_days: Number.isFinite(overdueDays) ? overdueDays : 0,
        overdue_at: loan.overdue_at || loan.overdueAt || null,
        intentos_ciclo_actual: historyFeatures.intentos_ciclo_actual,
        last_req_status: historyFeatures.last_req_status,
        failed_message: historyFeatures.failed_message,
      };

      const decision = decideLoanV2(features, now);

      return {
        loan_id: loanId,
        decision: decision.decision,
        decision_reason: decision.decision_reason,
        next_attempt_date: decision.next_attempt_date,
        features,
      };
    });

    return res.status(200).json({ decisions });
  } catch (err) {
    console.error('Internal error in /api/decide:', err);
    return res.status(500).json({
      error: 'internal_error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
};

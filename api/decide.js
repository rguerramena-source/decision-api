// api/decide.js
// Serverless function en Vercel para el motor de decisión Smart Retry v2

const { supabaseAdmin } = require('../lib/supabase-admin');
const { decideLoanV2, DEFAULT_DECISION_CONFIG } = require('../lib/smart-retry-core');

// Construye features de histórico para un loan a partir de sus transacciones.
function buildHistoryFeaturesForLoan(rows) {
  if (!rows || rows.length === 0) {
    return {
      last_req_status: 'new',
      failed_message: '',
      intentos_ciclo_actual: 0,
    };
  }

  const ordered = [...rows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  let attemptsSinceLastSuccess = 0;
  let lastStatus = 'new';
  let lastFailedMessage = '';

  for (const tx of ordered) {
    const status = (tx.status || '').toLowerCase();
    const failMsg =
      (tx.failed_message && String(tx.failed_message).trim()) || '';

    lastStatus = status;

    if (status === 'successful') {
      attemptsSinceLastSuccess = 0;
      lastFailedMessage = '';
    } else {
      attemptsSinceLastSuccess += 1;
      if (failMsg) {
        lastFailedMessage = failMsg;
      }
    }

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

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res
        .status(405)
        .json({ error: 'method_not_allowed', message: 'Use POST /api/decide' });
    }

    // Aseguramos que el body sea un objeto
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

    // Config opcional desde el body (para futuros ajustes desde el front)
    const bodyConfig =
      body.config && typeof body.config === 'object' ? body.config : null;

    const decisionConfig = bodyConfig
      ? {
          ...DEFAULT_DECISION_CONFIG,
          ...bodyConfig,
          confidence: {
            ...DEFAULT_DECISION_CONFIG.confidence,
            ...(bodyConfig.confidence || {}),
          },
        }
      : DEFAULT_DECISION_CONFIG;

    // Lista de loan_ids de la cartera actual
    const loanIds = loans
      .map((l) => (l.loan_id != null ? String(l.loan_id).trim() : ''))
      .filter((id) => id !== '');

    if (!loanIds.length) {
      return res.status(400).json({
        error: 'invalid_loans',
        message: 'All loans must have a non-empty loan_id',
      });
    }

    // Traer histórico de transacciones vía RPC de Supabase
    const { data: txRows, error: txError } = await supabaseAdmin.rpc(
      'get_payment_history_by_loans',
      {
        loan_ids_input: loanIds,
      }
    );

    if (txError) {
      console.error('Supabase error fetching history:', txError);
      return res.status(500).json({
        error: 'failed_to_fetch_history',
        message:
          txError.message ||
          txError.details ||
          'Error fetching transaction history from Supabase',
      });
    }

    // Agrupar histórico por loan_id
    const historyByLoan = new Map();
    if (Array.isArray(txRows)) {
      for (const row of txRows) {
        const id =
          (row.loan_id != null ? String(row.loan_id).trim() : '') ||
          (row.loanid != null ? String(row.loanid).trim() : '') ||
          (row.loan != null ? String(row.loan).trim() : '');
        if (!id) continue;
        if (!historyByLoan.has(id)) {
          historyByLoan.set(id, []);
        }
        historyByLoan.get(id).push(row);
      }
    }

    const now = new Date();

    const decisions = loans.map((loan) => {
      const loanId = loan.loan_id != null ? String(loan.loan_id).trim() : '';
      const historyRows = historyByLoan.get(loanId) || [];

      const historyFeatures = buildHistoryFeaturesForLoan(historyRows);

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

      const decision = decideLoanV2(features, now, decisionConfig);

      return {
        loan_id: loanId,
        decision: decision.decision,
        decision_reason: decision.decision_reason,
        next_attempt_date: decision.next_attempt_date,
        confidence: decision.confidence ?? 0,
        features,
      };
    });

    // Opcional: debug
    console.log(
      'DEBUG_DECISIONS',
      JSON.stringify(
        decisions.slice(0, 20).map((d) => ({
          loan_id: d.loan_id,
          last_req_status: d.features.last_req_status,
          failed_message: d.features.failed_message,
          intentos_ciclo_actual: d.features.intentos_ciclo_actual,
          overdue_days: d.features.overdue_days,
          total_amount_outstanding: d.features.total_amount_outstanding,
          decision: d.decision,
          decision_reason: d.decision_reason,
          confidence: d.confidence,
        })),
        null,
        2
      )
    );

    return res.status(200).json({ decisions });
  } catch (err) {
    console.error('Internal error in /api/decide:', err);
    return res.status(500).json({
      error: 'internal_error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
};

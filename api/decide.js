// api/decide.js
const { decideRetries } = require('../lib/smart-retry-core');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const provided = String(req.headers['x-api-key'] || '');
    const API_KEY = String(process.env.DECISION_API_KEY || '');

    if (!API_KEY || provided !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = req.body || {};
    // Accept explicit shape { loans: [], txs: [] } or legacy { records: [] } (attempt to infer)
    let loans = Array.isArray(body.loans) ? body.loans : [];
    let txs = Array.isArray(body.txs) ? body.txs : [];

    if (!loans.length && !txs.length && Array.isArray(body.records)) {
      // simple heuristic to infer type
      const sample = body.records[0] || {};
      const keys = Object.keys(sample).map(k => String(k).toLowerCase());
      const looksLikeLoan = keys.includes('loan_id') && (keys.includes('total_amount_outstanding') || keys.includes('loan_amount'));
      const looksLikeTx = keys.includes('payment_request_id') || keys.includes('completed_at') || keys.includes('failed_reason');
      if (looksLikeLoan && !looksLikeTx) loans = body.records;
      else if (looksLikeTx && !looksLikeLoan) txs = body.records;
      else {
        return res.status(400).json({ error: 'Ambiguous records payload: use explicit { loans: [...], txs: [...] }' });
      }
    }

    if (!Array.isArray(loans) || !Array.isArray(txs)) {
      return res.status(400).json({ error: 'Bad request: loans and txs must be arrays' });
    }

    // Basic validation: loan_id present where needed
    const loansMissing = loans.filter(l => !l || !l.loan_id || String(l.loan_id).trim() === '');
    const txsMissing = txs.filter(t => !t || !t.loan_id || String(t.loan_id).trim() === '');
    if (loansMissing.length || txsMissing.length) {
      return res.status(400).json({
        error: 'Invalid request: each record must have loan_id',
        details: { loans_missing: loansMissing.length, txs_missing: txsMissing.length }
      });
    }

    // Protect the function from huge payloads (adjust as needed)
    if (loans.length > 20000 || txs.length > 2_000_000) {
      return res.status(413).json({ error: 'Payload too large. Use batch pipeline.' });
    }

    // Call decision engine
    const decisions = decideRetries(loans, txs, body.config || {});
    return res.status(200).json({ decisions });
  } catch (err) {
    console.error('decide error', err);
    return res.status(500).json({ error: 'internal_error', message: String(err?.message || err) });
  }
};

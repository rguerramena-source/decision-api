// api/decide.js
const { decideRetries } = require('../lib/smart-retry-core');
const { supabaseAdmin } = require('../lib/supabase-admin');

async function getHistoryForLoans(loanIds, maxPerLoan = 10) {
  if (!loanIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from('loan_transactions')
    .select(
      `
      loan_id,
      payment_request_id,
      created_at,
      completed_at,
      chargeback_at,
      status,
      amount,
      failed_reason,
      failed_message
    `
    )
    .in('loan_id', loanIds)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase history error:', error);
    throw new Error('failed_to_fetch_history');
  }

  // Si quieres limitar N por loan aquí mismo:
  const buckets = {};
  for (const row of data || []) {
    const id = row.loan_id;
    if (!buckets[id]) buckets[id] = [];
    if (buckets[id].length < maxPerLoan) {
      buckets[id].push(row);
    }
  }

  // Flatten a un solo array como antes, para decideRetries
  return Object.values(buckets).flat();
}

async function readJsonBodyFallback(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        const json = JSON.parse(data);
        resolve(json);
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', err => reject(err));
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-api-key'
  );
}

module.exports = async (req, res) => {
  try {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    const provided = String(req.headers['x-api-key'] || '');
    const API_KEY = String(process.env.DECISION_API_KEY || '');

    if (!API_KEY || provided !== API_KEY) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    let body = req.body;
    if (!body || typeof body !== 'object') {
      body = await readJsonBodyFallback(req);
    }

    const loans = Array.isArray(body.loans) ? body.loans : [];
    // ya no usamos body.txs; la fuente es Supabase
    const loanIds = [...new Set(
      loans
        .map(l => (l && l.loan_id != null ? String(l.loan_id).trim() : ''))
        .filter(id => id !== '')
    )];

    // Traer histórico desde Supabase
    const historyTxs = await getHistoryForLoans(loanIds, 10);

    if (typeof decideRetries !== 'function') {
      console.error('decideRetries is not a function');
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({ error: 'internal_error', message: 'Decision engine not available' })
      );
    }

    // Mantenemos la firma decideRetries(loans, txs, config)
    const decisions = decideRetries(loans, historyTxs, body.config || {});

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ decisions }));
  } catch (err) {
    console.error('decide error', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        error: 'internal_error',
        message: String(err?.message || err),
      })
    );
  }
};

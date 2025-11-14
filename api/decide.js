// api/decide.js
const { decideRetries } = require('../lib/smart-retry-core');

function setCors(res) {
  // En demo puedes dejar "*"; en producción mejor limitar al dominio del front
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-api-key'
  );
}

// Fallback por si req.body viniera vacío
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

module.exports = async (req, res) => {
  try {
    // Siempre poner CORS
    setCors(res);

    // Preflight CORS
    if (req.method === 'OPTIONS') {
      res.statusCode = 204; // No Content
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

    // En Vercel normalmente req.body ya existe, pero usamos fallback por si acaso
    let body = req.body;
    if (!body || typeof body !== 'object') {
      try {
        body = await readJsonBodyFallback(req);
      } catch (e) {
        console.error('Error parsing JSON body:', e);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        return res.end(
          JSON.stringify({ error: 'Invalid JSON', message: e.message })
        );
      }
    }

    const loans = Array.isArray(body.loans) ? body.loans : [];
    const txs = Array.isArray(body.txs) ? body.txs : [];

    if (!Array.isArray(loans) || !Array.isArray(txs)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          error: 'Bad request: loans and txs must be arrays'
        })
      );
    }

    if (typeof decideRetries !== 'function') {
      console.error(
        'decideRetries is not a function. Check smart-retry-core export.'
      );
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          error: 'internal_error',
          message: 'Decision engine not available'
        })
      );
    }

    const decisions = decideRetries(loans, txs, body.config || {});

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
        message: String(err?.message || err)
      })
    );
  }
};

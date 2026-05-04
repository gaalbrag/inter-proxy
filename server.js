const express = require('express');
const https = require('https');
const querystring = require('querystring');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const INTER_BASE = 'cdpj.partners.bancointer.com.br';

function getAgent() {
    const certB64 = process.env.INTER_CERT_B64 || '';
    const keyB64 = process.env.INTER_KEY_B64 || '';
    const cert = certB64.includes('-----') ? certB64 : Buffer.from(certB64, 'base64').toString('utf8');
    const key = keyB64.includes('-----') ? keyB64 : Buffer.from(keyB64, 'base64').toString('utf8');
    return new https.Agent({ cert, key, rejectUnauthorized: true });
}

async function getToken(scope) {
    const agent = getAgent();
    const clientId = process.env.INTER_CLIENT_ID;
    const clientSecret = process.env.INTER_CLIENT_SECRET;
    const body = querystring.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
          scope: scope
    });
    return new Promise((resolve, reject) => {
          const req = https.request({
                  hostname: INTER_BASE,
                  path: '/oauth/v2/token',
                  method: 'POST',
                  agent,
                  headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(body)
                  }
          }, (res) => {
                  let data = '';
                  res.on('data', chunk => data += chunk);
                  res.on('end', () => {
                            try {
                                        const parsed = JSON.parse(data);
                                        if (parsed.access_token) resolve(parsed.access_token);
                                        else reject(new Error('No token: ' + data));
                            } catch (e) { reject(e); }
                  });
          });
          req.on('error', reject);
          req.write(body);
          req.end();
    });
}

async function interRequest(method, path, token, body) {
    const agent = getAgent();
    const bodyStr = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
          const headers = {
                  'Authorization': 'Bearer ' + token,
                  'Content-Type': 'application/json'
          };
          if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
          const req = https.request({
                  hostname: INTER_BASE,
                  path,
                  method,
                  agent,
                  headers
          }, (res) => {
                  let data = '';
                  res.on('data', chunk => data += chunk);
                  res.on('end', () => { resolve({ status: res.statusCode, body: data }); });
          });
          req.on('error', reject);
          if (bodyStr) req.write(bodyStr);
          req.end();
    });
}

// GET /health
app.get('/health', async (req, res) => {
    const result = { status: 'ok', cert: false, oauth_pix: false, oauth_extrato: false };
    try { getAgent(); result.cert = true; } catch (e) { result.cert_error = e.message; }
    try { await getToken('pagamento-pix.write'); result.oauth_pix = true; } catch (e) { result.oauth_pix_error = e.message; }
    try { await getToken('extrato.read'); result.oauth_extrato = true; } catch (e) { result.oauth_extrato_error = e.message; }
    res.json(result);
});

// GET /diagnostics - try many path variants to find the right one
app.get('/diagnostics', async (req, res) => {
    const results = {};
    const cnpj = (process.env.INTER_CLIENT_ID || '').substring(0, 14);

          try {
                const tokenExt = await getToken('extrato.read');
                // Try different path variants
      const pathsToTest = [
              '/banking/v3/saldo',
              '/banking/v2/saldo',
              '/v3/banking/saldo',
              '/saldo',
              '/conta/saldo',
              '/open-banking/v3/saldo',
            ];
                for (const p of pathsToTest) {
                        const r = await interRequest('GET', p, tokenExt, null);
                        results['GET ' + p] = { status: r.status, body: r.body.substring(0, 200) };
                }
          } catch (e) { results.extrato_error = e.message; }

          try {
                const tokenPix = await getToken('pagamento-pix.write');
                const testBody = { valor: 0.01, destinatario: { tipo: 'CHAVE', chave: process.env.INTER_PIX_KEY || '09.483.480/0001-20' }, descricao: 'diag' };
                const pixPaths = [
                                '/banking/v2/pix/pagamento',
                                '/banking/v2/pix',
                        '/pix/v2/pagamento',
                        '/pix/v1/pagamento',
                        '/pagamento-pix/v3/pix/pagamento',
                      ];
                for (const p of pixPaths) {
                        const r = await interRequest('POST', p, tokenPix, testBody);
                        results['POST ' + p] = { status: r.status, body: r.body.substring(0, 200) };
                }
          } catch (e) { results.pix_error = e.message; }

          res.json(results);
});

// POST /pix/pay - used by Supabase edge function inter-api
app.post('/pix/pay', async (req, res) => {
    console.log('[pix/pay] received body:', JSON.stringify(req.body));
    try {
          const body = req.body || {};
          const valor = body.valor;
          const chave = body.chave || body.chavePix;
          const descricao = body.descricao || 'Pagamento PIX';
          const nomeDestinatario = body.nomeDestinatario;
          const valorReais = body.valorReais;
          const dataVencimento = body.dataVencimento;

      const valorNum = parseFloat(valorReais) || parseFloat((valor / 100).toFixed(2)) || 0;

      if (!chave) return res.status(400).json({ error: 'chave PIX e obrigatoria' });
          if (valorNum <= 0) return res.status(400).json({ error: 'valor deve ser maior que zero' });

      console.log('[pix/pay] getting token...');
          const token = await getToken('pagamento-pix.write');
          console.log('[pix/pay] token ok, calling Inter API...');

      const pixBody = {
              valor: parseFloat(valorNum.toFixed(2)),
              destinatario: {
                        tipo: 'CHAVE',
                        chave: chave
              },
              descricao: descricao
      };
          if (nomeDestinatario) pixBody.destinatario.nome = nomeDestinatario;
          if (dataVencimento) pixBody.dataVencimento = dataVencimento;

      console.log('[pix/pay] body to Inter:', JSON.stringify(pixBody));

      let result = await interRequest('POST', '/banking/v2/pix/pagamento', token, pixBody);
          console.log('[pix/pay] /banking/v3/pix/pagamento status:', result.status, 'body:', result.body.substring(0, 300));

      if (result.status === 404) {
              result = await interRequest('POST', '/banking/v2/pix', token, pixBody);
              console.log('[pix/pay] /banking/v3/pix status:', result.status, 'body:', result.body.substring(0, 300));
      }

      let parsed;
          try { parsed = JSON.parse(result.body); } catch (e) { parsed = { raw: result.body }; }
          return res.status(result.status).json(parsed);
    } catch (err) {
          console.error('[pix/pay] error:', err.message);
          return res.status(500).json({ error: err.message });
    }
});

// GET /extrato
app.get('/extrato', async (req, res) => {
    try {
          const token = await getToken('extrato.read');
          const params = querystring.stringify({
                  dataInicio: req.query.dataInicio || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0],
                  dataFim: req.query.dataFim || new Date().toISOString().split('T')[0],
                  pagina: req.query.pagina || 0,
                  tamanhoPagina: req.query.tamanhoPagina || 50
          });
          const result = await interRequest('GET', '/banking/v2/extrato?' + params, token, null);
          let parsed;
          try { parsed = JSON.parse(result.body); } catch (e) { parsed = { raw: result.body }; }
          return res.status(result.status).json(parsed);
    } catch (err) {
          return res.status(500).json({ error: err.message });
    }
});

// POST /inter - original action-based route (backward compatibility)
app.post('/inter', async (req, res) => {
    try {
          const { action, ...params } = req.body || {};
          if (action === 'extrato') {
                  const token = await getToken('extrato.read');
                  const qParams = querystring.stringify({
                            dataInicio: params.dataInicio || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0],
                            dataFim: params.dataFim || new Date().toISOString().split('T')[0],
                            pagina: params.pagina || 0,
                            tamanhoPagina: params.tamanhoPagina || 50
                  });
                  const result = await interRequest('GET', '/banking/v2/extrato?' + qParams, token, null);
                  let parsed;
                  try { parsed = JSON.parse(result.body); } catch (e) { parsed = { raw: result.body }; }
                  return res.status(result.status).json(parsed);
          }
          return res.status(400).json({ error: 'unknown action: ' + action });
    } catch (err) {
          return res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log('inter-proxy listening on port ' + PORT));

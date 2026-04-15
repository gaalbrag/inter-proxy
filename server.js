const express = require('express');
const https = require('https');
const querystring = require('querystring');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const INTER_BASE = 'cdpj.partners.bancointer.com.br';

function getAgent() {
  const cert = process.env.INTER_CERT_B64 || '';
  const key = process.env.INTER_KEY_B64 || '';
  return new https.Agent({
    cert: cert,
    key: key,
    rejectUnauthorized: true
  });
}

async function getToken(scope) {
  const agent = getAgent();
  const clientId = process.env.INTER_CLIENT_ID;
  const clientSecret = process.env.INTER_CLIENT_SECRET;

  const body = querystring.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    scope: scope,
    grant_type: 'client_credentials'
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: INTER_BASE,
      path: '/oauth/v2/token',
      method: 'POST',
      agent: agent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('Token error: ' + res.statusCode + ' - ' + data));
        }
        const json = JSON.parse(data);
        resolve(json.access_token);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function interRequest(method, path, token, body) {
  const agent = getAgent();
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: INTER_BASE,
      path: path,
      method: method,
      agent: agent,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

app.post('/inter', async (req, res) => {
  try {
    const { action, ...params } = req.body;

    if (action === 'test-auth') {
      const token = await getToken('extrato.read');
      return res.json({ success: true, token: token.substring(0, 20) + '...' });
    }

    if (action === 'saldo') {
      const token = await getToken('extrato.read');
      const result = await interRequest('GET', '/banking/v3/saldo', token, null);
      return res.status(result.status).json(JSON.parse(result.body));
    }

    if (action === 'extrato') {
      const token = await getToken('extrato.read');
      const { dataInicio, dataFim } = params;
      const result = await interRequest('GET', '/banking/v3/extrato?dataInicio=' + dataInicio + '&dataFim=' + dataFim, token, null);
      return res.status(result.status).json(JSON.parse(result.body));
    }

    if (action === 'pix-create') {
      const token = await getToken('pagamento-pix.write');
      const result = await interRequest('POST', '/banking/v3/pix', token, params);
      return res.status(result.status).json(JSON.parse(result.body));
    }

    if (action === 'pix-pay') {
      const token = await getToken('pagamento-pix.write');
      const result = await interRequest('POST', '/banking/v3/pix/pagamento', token, params);
      return res.status(result.status).json(JSON.parse(result.body));
    }

    if (action === 'boleto-create') {
      const token = await getToken('boleto-cobranca.write');
      const result = await interRequest('POST', '/cobranca/v3/cobrancas', token, params);
      return res.status(result.status).json(JSON.parse(result.body));
    }

    if (action === 'boleto-list') {
      const token = await getToken('boleto-cobranca.read');
      const { dataInicio, dataFim } = params;
      const result = await interRequest('GET', '/cobranca/v3/cobrancas?dataInicio=' + dataInicio + '&dataFim=' + dataFim, token, null);
      return res.status(result.status).json(JSON.parse(result.body));
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log('Inter proxy listening on port ' + PORT);
});

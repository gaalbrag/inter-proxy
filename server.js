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
            const result = { status: 'ok', cert: false, oauth_pix: false, oauth_extrato: false, oauth_boleto: false };
            try { getAgent(); result.cert = true; } catch (e) { result.cert_error = e.message; }
            try { await getToken('pagamento-pix.write'); result.oauth_pix = true; } catch (e) { result.oauth_pix_error = e.message; }
            try { await getToken('extrato.read'); result.oauth_extrato = true; } catch (e) { result.oauth_extrato_error = e.message; }
            try { await getToken('pagamento-boleto.write'); result.oauth_boleto = true; } catch (e) { result.oauth_boleto_error = e.message; }
            res.json(result);
});

// GET /diagnostics - try many path variants to find the right one
app.get('/diagnostics', async (req, res) => {
            const results = {};
            const cnpj = (process.env.INTER_CLIENT_ID || '').substring(0, 14);

            try {
                            const tokenExt = await getToken('extrato.read');
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

// GET /diagnostics/boleto - probes the boleto payment endpoint with an
// intentionally invalid linha digitavel (all zeros), so Inter rejects it with
// a data validation error instead of processing a real payment. Confirmed on
// 2026-08-06: /banking/v2/pagamento is the right path (returns 400 field
// validation instead of 404/405 like the other candidates).
app.get('/diagnostics/boleto', async (req, res) => {
            const results = {};
            try {
                            const token = await getToken('pagamento-boleto.write');
                            const hoje = new Date().toISOString().split('T')[0];
                            const testBody = {
                                                codBarra: '00000000000000000000000000000000000000000000',
                                                codBarraLinhaDigitavel: '00000000000000000000000000000000000000000000',
                                                dataVencimento: hoje,
                                                dataPagamento: hoje,
                                                valorPagamento: 0.01,
                                        valorPagar: 0.01,
                                                descricaoPagamento: 'diagnostics - nao processar',
                                                descricao: 'diagnostics - nao processar'
                            };
                            const boletoPaths = [
                                                '/banking/v2/pagamento',
                                                '/banking/v2/pagamento/pagamento',
                                                '/banking/v2/pagamento/boleto',
                                                '/pagamento-boleto/v1/pagamentos',
                                                '/banking/v2/boleto/pagamento',
                                            ];
                            for (const p of boletoPaths) {
                                                const r = await interRequest('POST', p, token, testBody);
                                                results['POST ' + p] = { status: r.status, body: r.body.substring(0, 400) };
                            }
            } catch (e) { results.boleto_error = e.message; }
            res.json(results);
});

// Candidate paths for paying a boleto via linha digitavel/codigo de barras.
// /banking/v2/pagamento confirmed as the correct path via /diagnostics/boleto
// (returns 400 field validation instead of 404/405); kept as first entry with
// the others as fallback in case Inter changes the contract.
const BOLETO_PAY_PATHS = [
            '/banking/v2/pagamento',
            '/banking/v2/pagamento/pagamento',
            '/banking/v2/pagamento/boleto',
            '/pagamento-boleto/v1/pagamentos',
            '/banking/v2/boleto/pagamento',
        ];

// POST /boleto/pay - used by Supabase edge function inter-api (action "boleto-pay")
// Expects: { linhaDigitavel | codigoBarras, valor (centavos) | valorReais, dataVencimento?, descricao? }
app.post('/boleto/pay', async (req, res) => {
            console.log('[boleto/pay] received body:', JSON.stringify(req.body));
            try {
                            const body = req.body || {};
                            const linhaDigitavel = (body.linhaDigitavel || body.codigoBarras || body.codBarraLinhaDigitavel || body.codBarra || '').replace(/[.\s]/g, '');
                            const valorReais = body.valorReais;
                            const valor = body.valor;
                            const dataVencimento = body.dataVencimento || body.dataPagamento || new Date().toISOString().split('T')[0];
                            const descricao = body.descricao || body.descricaoPagamento || 'Pagamento de boleto';

                const valorNum = parseFloat(valorReais) || parseFloat(((valor || 0) / 100).toFixed(2)) || 0;

                if (!linhaDigitavel) return res.status(400).json({ error: 'linha digitavel ou codigo de barras e obrigatorio' });
                            if (linhaDigitavel.length < 44) return res.status(400).json({ error: 'linha digitavel invalida (esperado 47 ou 48 digitos)' });
                            if (!valorNum) return res.status(400).json({ error: 'valor e obrigatorio' });

                console.log('[boleto/pay] getting token...');
                            const token = await getToken('pagamento-boleto.write');
                            console.log('[boleto/pay] token ok, calling Inter API...');

                const boletoBody = {
                                    codBarra: linhaDigitavel,
                                    codBarraLinhaDigitavel: linhaDigitavel,
                                    dataVencimento,
                                    valorPagamento: parseFloat(valorNum.toFixed(2)),
                            valorPagar: parseFloat(valorNum.toFixed(2)),
                                    descricaoPagamento: descricao,
                                    descricao
                };

                let result = null;
                            let lastPath = null;
                            for (const p of BOLETO_PAY_PATHS) {
                                                lastPath = p;
                                                result = await interRequest('POST', p, token, boletoBody);
                                                console.log('[boleto/pay]', p, 'status:', result.status, 'body:', result.body.substring(0, 300));
                                                if (result.status !== 404 && result.status !== 405) break;
                            }

                let parsed;
                            try { parsed = JSON.parse(result.body); } catch (e) { parsed = { raw: result.body }; }
                            if (result.status === 404 || result.status === 405) {
                                                parsed = {
                                                                        error: 'Nenhum endpoint de pagamento de boleto respondeu (todos 404/405). Confirme o path correto na documentacao do Inter Developers e o escopo habilitado no app.',
                                                                        lastPathTried: lastPath,
                                                                        allPathsTried: BOLETO_PAY_PATHS
                                                };
                            }
                            return res.status(result.status).json(parsed);
            } catch (err) {
                            console.error('[boleto/pay] error:', err.message);
                            return res.status(500).json({ error: err.message });
            }
});

// GET /diagnostics/transferencia - probes the Pix "dados bancarios" shape with an
// intentionally fake/nonexistent bank account, so Inter should reject it with a
// data/account validation error instead of transferring real money.
app.get('/diagnostics/transferencia', async (req, res) => {
                const results = {};
                try {
                                    const token = await getToken('pagamento-pix.write');
                                    const testBody = {
                                                            valor: 0.01,
                                                            destinatario: {
                                                                                        tipo: 'DADOS_BANCARIOS',
                                                                                        instituicaoFinanceira: '000',
                                                                                        agencia: '0000',
                                                                                        conta: '0000000',
                                                                                        tipoConta: 'CORRENTE',
                                                                                        cpfCnpj: '00000000000',
                                                                                        nome: 'Teste Diagnostico'
                                                                        },
                                                            descricao: 'diagnostics - nao processar'
                                    };
                                    const r = await interRequest('POST', '/banking/v2/pix', token, testBody);
                                    results['POST /banking/v2/pix'] = { status: r.status, body: r.body.substring(0, 1200) };
                } catch (e) { results.transferencia_error = e.message; }
                res.json(results);
});

// POST /transferencia/pay - used by Supabase edge function inter-api (action "transferencia-pay")
// O Inter nao expoe uma API publica de TED/DOC tradicional; a forma equivalente de
// transferir para uma conta de terceiros (banco/agencia/conta) e via Pix informando
// os dados bancarios do favorecido em vez de uma chave. Expects:
// { banco, agencia, conta, tipoConta?, cpfCnpjFavorecido, nomeFavorecido, valor (centavos) | valorReais, descricao? }
app.post('/transferencia/pay', async (req, res) => {
            console.log('[transferencia/pay] received body:', JSON.stringify(req.body));
            try {
                            const body = req.body || {};
                            const banco = body.banco || body.codigoBanco;
                            const agencia = body.agencia;
                            const conta = body.conta;
                            const tipoConta = body.tipoConta || 'CORRENTE';
                            const cpfCnpjFavorecido = (body.cpfCnpjFavorecido || body.documentoFavorecido || '').replace(/[.\-\/\s]/g, '');
                            const nomeFavorecido = body.nomeFavorecido || body.nomeDestinatario;
                            const valorReais = body.valorReais;
                            const valor = body.valor;
                            const descricao = body.descricao || 'Transferencia';

                const valorNum = parseFloat(valorReais) || parseFloat(((valor || 0) / 100).toFixed(2)) || 0;

                if (!banco || !agencia || !conta) {
                                    return res.status(400).json({ error: 'banco, agencia e conta sao obrigatorios para transferencia' });
                }
                            if (!valorNum) return res.status(400).json({ error: 'valor e obrigatorio' });

                console.log('[transferencia/pay] getting token...');
                            const token = await getToken('pagamento-pix.write');
                            console.log('[transferencia/pay] token ok, calling Inter API (via Pix - dados bancarios)...');

                const transfBody = {
                                    valor: parseFloat(valorNum.toFixed(2)),
                                    destinatario: {
                                                            tipo: 'DADOS_BANCARIOS',
                                                            instituicaoFinanceira: banco,
                                                            agencia,
                                                            conta,
                                                            tipoConta,
                                                            cpfCnpj: cpfCnpjFavorecido,
                                                            nome: nomeFavorecido
                                    },
                                    descricao
                };

                const result = await interRequest('POST', '/banking/v2/pix', token, transfBody);
                            console.log('[transferencia/pay] /banking/v2/pix status:', result.status, 'body:', result.body.substring(0, 300));

                let parsed;
                            try { parsed = JSON.parse(result.body); } catch (e) { parsed = { raw: result.body }; }
                            return res.status(result.status).json(parsed);
            } catch (err) {
                            console.error('[transferencia/pay] error:', err.message);
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

// -------- GET /pix/status/:id and /transferencia/status/:id --------
// Consulta o status de um pagamento Pix (dados bancarios) feito via /transferencia/pay.
// O Inter nao documenta endpoint dedicado para este tipo; tentamos os paths mais
// provaveis e, se nenhum responder, retornamos SEM_CONSULTA_DISPONIVEL (o outcome
// real ja foi decidido de forma sincrona na resposta do pagamento).
const PIX_STATUS_PATHS = ['/banking/v2/pix/', '/banking/v2/pix/pagamento/'];
async function handlePixStatus(req, res) {
            try {
                        const token = await getToken('pagamento-pix.write');
                        let lastResult = null;
                        for (const base of PIX_STATUS_PATHS) {
                                    lastResult = await interRequest('GET', base + encodeURIComponent(req.params.id), token, null);
                                    if (lastResult.status !== 404 && lastResult.status !== 405) break;
                        }
                        if (!lastResult || lastResult.status === 404 || lastResult.status === 405) {
                                    return res.status(200).json({ success: true, status: 'SEM_CONSULTA_DISPONIVEL', note: 'Inter nao expoe consulta para este tipo de Pix/transferencia; outcome ja decidido no pagamento.' });
                        }
                        let parsed;
                        try { parsed = JSON.parse(lastResult.body); } catch (e) { parsed = { raw: lastResult.body }; }
                        return res.status(lastResult.status).json(parsed);
            } catch (err) {
                        return res.status(500).json({ error: err.message });
            }
}
app.get('/pix/status/:id', handlePixStatus);
app.get('/transferencia/status/:id', handlePixStatus);

// -------- GET /boleto/status/:id --------
// Consulta o status de um pagamento de boleto pelo codigoSolicitacao retornado em /boleto/pay.
const BOLETO_STATUS_PATHS = ['/banking/v2/pagamento/', '/banking/v2/pagamento/pagamento/'];
app.get('/boleto/status/:id', async (req, res) => {
            try {
                        const token = await getToken('pagamento-boleto.write');
                        let lastResult = null;
                        for (const base of BOLETO_STATUS_PATHS) {
                                    lastResult = await interRequest('GET', base + encodeURIComponent(req.params.id), token, null);
                                    if (lastResult.status !== 404 && lastResult.status !== 405) break;
                        }
                        if (!lastResult || lastResult.status === 404 || lastResult.status === 405) {
                                    return res.status(200).json({ success: true, status: 'SEM_CONSULTA_DISPONIVEL', note: 'Nenhum endpoint de consulta de boleto respondeu; outcome ja decidido no pagamento.' });
                        }
                        let parsed;
                        try { parsed = JSON.parse(lastResult.body); } catch (e) { parsed = { raw: lastResult.body }; }
                        return res.status(lastResult.status).json(parsed);
            } catch (err) {
                        return res.status(500).json({ error: err.message });
            }
});

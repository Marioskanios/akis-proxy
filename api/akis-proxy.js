// /api/akis-proxy.js — Node serverless, NOT Edge
export const config = { runtime: 'nodejs20.x' };

const SOAP_URL = 'http://91.184.205.124:1978';
const NS_PRINT = '/GAPAKISPRINTSIDETA';

const esc = (s='') => String(s).replace(/[<&>]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
const wrap = (q, inner='') => `<${q}>${inner}</${q}>`;
const envelope = (nsUri, body) => `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${nsUri}">
  <soapenv:Header/><soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;

const userBlock = (c={}) => wrap('tns:user_details',
  wrap('tns:a_pel_code',     esc(c.a_pel_code||'')) +
  wrap('tns:a_user_code',    esc(c.a_user_code||'')) +
  wrap('tns:a_user_pass',    esc(c.a_user_pass||'')) +
  wrap('tns:a_pel_sub_code', esc(c.a_pel_sub_code||''))
);

const pick = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
};

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, ping: 'akis-proxy alive', runtime: 'node' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const need = process.env.PROXY_SECRET || '';
  const got  = req.headers['x-proxy-secret'] || req.headers['x-akis-secret'] || '';
  if (need && got !== need) return res.status(403).json({ ok: false, error: 'Forbidden (bad secret)' });

  const body = await parseBody(req);
  const { op, creds } = body || {};
  if (!op || !creds) return res.status(400).json({ ok: false, error: 'Missing op or creds' });

  if (String(op).toLowerCase() === 'print') {
    const sideta = body.payload?.akis_sideta || body.akis_sideta || body.data?.voucher_no || '';
    if (!sideta) return res.status(400).json({ ok: false, error: 'Missing akis_sideta for PRINT' });

    const xml = envelope(NS_PRINT,
      wrap('tns:PRINT', userBlock(creds) + wrap('tns:akis_sideta', esc(sideta)))
    );

    const r = await fetch(SOAP_URL, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', 'soapaction': '' }, body: xml });
    const txt = await r.text();

    const st_flag = pick(txt, 'st_flag');
    const st_title = pick(txt, 'st_title');
    const b64 = pick(txt, 'b64_string'); // correct field for PDF
    if (st_flag !== '1' || !b64) return res.status(400).json({ ok: false, error: st_title || 'Print failed', st_flag, raw: txt });

    return res.status(200).json({ ok: true, st_flag, st_title, pdf_base64: b64 });
  }

  return res.status(400).json({ ok: false, error: 'Unsupported op in this minimal test build' });
}

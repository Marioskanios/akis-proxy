// api/akis-proxy.js — SOAP relay for AKIS (Node runtime)
export const config = { runtime: 'nodejs20.x' };

const SOAP_URL = 'http://91.184.205.124:1978'; // from WSDL <soap:address>
const NS_MAP = {
  create: '/GAPAKISCREATESIDETA',
  print:  '/GAPAKISPRINTSIDETA',
  delete: '/GAPAKISDELETESIDETA',
  read:   '/GAPAKISTTSIDETA',
};

const ok   = (res, data) => res.status(200).json({ ok: true,  ...data });
const fail = (res, msg, extra = {}, code = 400) => res.status(code).json({ ok: false, error: msg, ...extra });

const esc = (s='') => String(s).replace(/[<&>]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
const wrap = (qname, inner='') => `<${qname}>${inner}</${qname}>`;

const envelope = (nsUri, body) => `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${nsUri}">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;

const userBlock = (c={}) => wrap('tns:user_details',
  wrap('tns:a_pel_code',     esc(c.a_pel_code || '')) +
  wrap('tns:a_user_code',    esc(c.a_user_code || '')) +
  wrap('tns:a_user_pass',    esc(c.a_user_pass || '')) +
  wrap('tns:a_pel_sub_code', esc(c.a_pel_sub_code || ''))
);

// vg_details (P2P requires delivery_flag=0 & delivery_station=<store code>, plus a_rec_postal mapped from CSV H)
const vgBlock = (vg={}) => wrap('tns:vg_details',
  wrap('tns:a_rec_title',      esc(vg.a_rec_title || '')) +
  wrap('tns:a_rec_address',    esc(vg.a_rec_address || '')) +
  wrap('tns:a_rec_area',       esc(vg.a_rec_area || '')) +
  wrap('tns:a_rec_postal',     esc(vg.a_rec_postal || '')) +        // <- CSV H
  wrap('tns:a_rec_tel',        esc(vg.a_rec_tel || '')) +
  wrap('tns:a_rec_mobile',     esc(vg.a_rec_mobile || '')) +
  wrap('tns:a_packages',       esc(vg.a_packages ?? '1')) +
  wrap('tns:a_weight',         esc(vg.a_weight   ?? '0.5')) +
  wrap('tns:a_rec_remarks',    esc(vg.a_rec_remarks || '')) +
  wrap('tns:a_rec_ref',        esc(vg.a_rec_ref || '')) +
  wrap('tns:a_cod_flag',       esc(vg.a_cod_flag ?? '0')) +
  wrap('tns:a_cod_poso',       esc(vg.a_cod_poso ?? '0')) +
  wrap('tns:a_cod_date',       esc(vg.a_cod_date || '')) +
  wrap('tns:delivery_flag',    esc(vg.delivery_flag ?? '0')) +      // <- P2P
  wrap('tns:delivery_station', esc(vg.delivery_station || ''))      // <- CSV B
);

// builders
const buildCreate = (creds, vg, nsUri) =>
  envelope(nsUri, wrap('tns:CREATE', userBlock(creds) + vgBlock(vg)));
const buildDelete = (creds, sideta, nsUri) =>
  envelope(nsUri, wrap('tns:DELETE', userBlock(creds) + wrap('tns:akis_sideta', esc(sideta||''))));
const buildPrint  = (creds, sideta, nsUri) =>
  envelope(nsUri, wrap('tns:PRINT',  userBlock(creds) + wrap('tns:akis_sideta', esc(sideta||''))));
const buildRead   = (creds, sideta, nsUri) =>
  envelope(nsUri, wrap('tns:READ',   userBlock(creds) + wrap('tns:akis_sideta', esc(sideta||'')) + wrap('tns:akis_sub_sideta', '')));

// xml helpers
const pick = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
};
const many = (xml, tag) => {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'ig');
  const out = []; let m; while ((m = re.exec(xml))) out.push(m[1].trim()); return out;
};

// robust body parse for Vercel Node
async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // already parsed
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return ok(res, { ping: 'akis-proxy alive' });
  if (req.method !== 'POST') return fail(res, 'POST only', {}, 405);

  const need = process.env.PROXY_SECRET || '';
  const got  = req.headers['x-proxy-secret'] || req.headers['x-akis-secret'] || '';
  if (need && got !== need) return fail(res, 'Forbidden (bad secret)', { status: 403 }, 403);

  const body = await parseBody(req);
  let { op, creds } = body || {};
  if (!op || !creds) return fail(res, 'Missing op or creds');

  op = String(op).toLowerCase();
  const nsUri = NS_MAP[op];
  if (!nsUri) return fail(res, 'Unknown op');

  const vg = body.vg_details || body.payload?.vg_details || {};
  const sideta = body.akis_sideta || body.payload?.akis_sideta || body.data?.voucher_no || '';

  let xml;
  if (op === 'create') xml = buildCreate(creds, vg, nsUri);
  else if (op === 'delete') xml = buildDelete(creds, sideta, nsUri);
  else if (op === 'print')  xml = buildPrint(creds, sideta, nsUri);
  else if (op === 'read')   xml = buildRead(creds, sideta, nsUri);

  const r = await fetch(SOAP_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', 'soapaction': '' },
    body: xml
  });

  const txt = await r.text();

  if (op === 'create') {
    const st_flag     = pick(txt, 'st_flag');
    const st_title    = pick(txt, 'st_title');
    const akis_sideta = pick(txt, 'akis_sideta');
    const sub         = many(txt, 'akis_sub_sideta');
    if (st_flag !== '1') return fail(res, st_title || 'Create failed', { st_flag, raw: txt });
    return ok(res, { st_flag, st_title, akis_sideta, akis_sub_sideta: sub });
  }

  if (op === 'delete') {
    const st_flag  = pick(txt, 'st_flag');
    const st_title = pick(txt, 'st_title');
    if (st_flag !== '1') return fail(res, st_title || 'Delete failed', { st_flag, raw: txt });
    return ok(res, { st_flag, st_title });
  }

  if (op === 'print') {
    const st_flag  = pick(txt, 'st_flag');
    const st_title = pick(txt, 'st_title');
    const b64      = pick(txt, 'b64_string'); // correct field name in PRINTResponse
    if (st_flag !== '1' || !b64) return fail(res, st_title || 'Print failed', { st_flag, raw: txt });
    return ok(res, { st_flag, st_title, pdf_base64: b64 });
  }

  if (op === 'read') {
    const st_flag  = pick(txt, 'st_flag');
    const st_title = pick(txt, 'st_title');
    return ok(res, { st_flag, st_title, raw: txt });
  }

  return fail(res, 'Unhandled');
}

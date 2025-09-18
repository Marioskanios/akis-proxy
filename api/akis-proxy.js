// /api/akis-proxy.js — AKIS SOAP relay (Node serverless)
export const config = { runtime: 'nodejs' };

const SOAP_URL = 'http://91.184.205.124:1978';
const NS_MAP = {
  create: '/GAPAKISCREATESIDETA',
  print:  '/GAPAKISPRINTSIDETA',
  delete: '/GAPAKISDELETESIDETA',
  read:   '/GAPAKISTTSIDETA',
};

const ok   = (res, data) => res.status(200).json({ ok: true,  ...data });
const fail = (res, msg, extra = {}, code = 400) => res.status(code).json({ ok: false, error: msg, ...extra });

const esc  = (s='') => String(s).replace(/[<&>]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
const wrap = (q, inner='') => `<${q}>${inner}</${q}>`;

const envelope = (nsUri, body) => `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${nsUri}">
  <soapenv:Header/><soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;

const userBlock = (c = {}) => wrap('tns:user_details',
  wrap('tns:a_pel_code',     esc(c.a_pel_code || '')) +
  wrap('tns:a_user_code',    esc(c.a_user_code || '')) +
  wrap('tns:a_user_pass',    esc(c.a_user_pass || '')) +
  wrap('tns:a_pel_sub_code', esc(c.a_pel_sub_code || '')) // keep even if empty
);

// vg_details — includes P2P routing fields
const vgBlock = (vg = {}) => {
  // defensive: sanitize delivery_station like your successful curl (remove < > and spaces)
  const station = String(vg.delivery_station || '').replace(/[^A-Za-z0-9]/g, '');
  return wrap('tns:vg_details',
    wrap('tns:a_rec_title',      esc(vg.a_rec_title || '')) +
    wrap('tns:a_rec_address',    esc(vg.a_rec_address || '')) +
    wrap('tns:a_rec_area',       esc(vg.a_rec_area || '')) +
    wrap('tns:a_rec_postal',     esc(vg.a_rec_postal || '')) +   // CSV H (digits only on client side)
    wrap('tns:a_rec_mobile',     esc(vg.a_rec_mobile || '')) +
    wrap('tns:a_packages',       esc(vg.a_packages ?? '1')) +
    wrap('tns:a_weight',         esc(vg.a_weight   ?? '0.5')) +
    wrap('tns:a_rec_remarks',    esc(vg.a_rec_remarks || '')) +
    wrap('tns:a_rec_ref',        esc(vg.a_rec_ref || '')) +
    wrap('tns:a_cod_flag',       esc(vg.a_cod_flag ?? '0')) +
    wrap('tns:a_cod_poso',       esc(vg.a_cod_poso ?? '0')) +
    wrap('tns:a_cod_date',       esc(vg.a_cod_date || '')) +
    wrap('tns:delivery_flag',    esc(vg.delivery_flag ?? '0')) + // P2P
    wrap('tns:delivery_station', esc(station))                   // sanitized CSV B
  );
};

// builders
const buildCreate = (creds, vg, ns) =>
  envelope(ns, wrap('tns:CREATE', userBlock(creds) + vgBlock(vg)));
const buildDelete = (creds, sideta, ns) =>
  envelope(ns, wrap('tns:DELETE', userBlock(creds) + wrap('tns:akis_sideta', esc(sideta || ''))));
const buildPrint  = (creds, sideta, ns) =>
  envelope(ns, wrap('tns:PRINT',  userBlock(creds) + wrap('tns:akis_sideta', esc(sideta || ''))));
const buildRead   = (creds, sideta, ns) =>
  envelope(ns, wrap('tns:READ',   userBlock(creds) + wrap('tns:akis_sideta', esc(sideta || '')) + wrap('tns:akis_sub_sideta', '')));

// xml pickers (namespace-agnostic: matches <ns:tag> or <tag>)
const pick = (xml, tag) => {
  const re = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
};
const many = (xml, tag) => {
  const re = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'ig');
  const out = []; let m; while ((m = re.exec(xml))) out.push(m[1].trim()); return out;
};

async function parseBody(req){
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export default async function handler(req, res){
  if (req.method === 'GET') return ok(res, { ping: 'akis-proxy alive', runtime: 'node' });
  if (req.method !== 'POST') return fail(res, 'POST only', {}, 405);

  // optional secret
  const need = process.env.PROXY_SECRET || '';
  const got  = req.headers['x-proxy-secret'] || req.headers['x-akis-secret'] || '';
  if (need && got !== need) return fail(res, 'Forbidden (bad secret)', { status: 403 }, 403);

  const body = await parseBody(req);
  let { op, creds } = body || {};
  if (!op || !creds) return fail(res, 'Missing op or creds');

  op = String(op).toLowerCase();
  const ns = NS_MAP[op];
  if (!ns) return fail(res, 'Unknown op');

  const vg     = body.vg_details || body.payload?.vg_details || {};
  const sideta = (body.akis_sideta || body.payload?.akis_sideta || body.data?.voucher_no || '').trim();

  let xml;
  if (op === 'create') xml = buildCreate(creds, vg, ns);
  else if (op === 'delete') xml = buildDelete(creds, sideta, ns);
  else if (op === 'print')  xml = buildPrint (creds, sideta, ns);
  else if (op === 'read')   xml = buildRead  (creds, sideta, ns);

  let txt;
  try {
    const r = await fetch(SOAP_URL, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', 'soapaction': '' }, body: xml });
    txt = await r.text();
  } catch (e) {
    return fail(res, 'Network error to SOAP host', { detail: String(e) }, 502);
  }

  if (op === 'create') {
    const st_flag     = pick(txt, 'st_flag');       // "0" on success
    const st_title    = pick(txt, 'st_title');
    const akis_sideta = pick(txt, 'akis_sideta').trim(); // AKIS pads with spaces — trim
    const sub         = many(txt, 'akis_sub_sideta');
    if (st_flag !== '0') return fail(res, st_title || 'Create failed', { st_flag, raw: txt });
    return ok(res, { st_flag, st_title, akis_sideta, akis_sub_sideta: sub });
  }

  if (op === 'delete') {
    const st_flag  = pick(txt, 'st_flag');
    const st_title = pick(txt, 'st_title');
    if (st_flag !== '0') return fail(res, st_title || 'Delete failed', { st_flag, raw: txt });
    return ok(res, { st_flag, st_title });
  }

  if (op === 'print') {
    const st_flag  = pick(txt, 'st_flag');
    const st_title = pick(txt, 'st_title');
    const b64      = pick(txt, 'b64_string'); // correct field name
    if (st_flag !== '0' || !b64) return fail(res, st_title || 'Print failed', { st_flag, raw: txt });
    return ok(res, { st_flag, st_title, pdf_base64: b64 });
  }

  if (op === 'read') {
    const st_flag  = pick(txt, 'st_flag');
    const st_title = pick(txt, 'st_title');
    return ok(res, { st_flag, st_title, raw: txt });
  }

  return fail(res, 'Unhandled');
}

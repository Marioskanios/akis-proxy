// api/akis-proxy.js — HTTPS → Akis :1978 relay (Node Serverless Function)
// /api/akis-proxy.js
export const config = { runtime: 'edge' };

const SOAP_URL = 'http://91.184.205.124:1978';            // from WSDLs
const NS = 'AKIS_WEB_SERVICE';                            // targetNamespace
const ok = (data) => new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'content-type': 'application/json' }});
const fail = (msg, extra={}) => new Response(JSON.stringify({ ok: false, error: msg, ...extra }), { status: 400, headers: { 'content-type': 'application/json' }});

function esc(s=''){ return String(s).replace(/[<&>]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m])); }

function wrap(tag, inner){ return `<${tag}>${inner}</${tag}>`; }
function userBlock(c){
  return wrap(`${NS}:user_details`,
    wrap(`${NS}:a_pel_code`, esc(c.a_pel_code)) +
    wrap(`${NS}:a_user_code`, esc(c.a_user_code)) +
    wrap(`${NS}:a_user_pass`, esc(c.a_user_pass)) +
    wrap(`${NS}:a_pel_sub_code`, esc(c.a_pel_sub_code||'')));
}
function ddBlock(dd={}){
  return wrap(`${NS}:drop_down`,
    wrap(`${NS}:value1`, esc(dd.value1||''))+
    wrap(`${NS}:value2`, esc(dd.value2||''))+
    wrap(`${NS}:value3`, esc(dd.value3||''))+
    wrap(`${NS}:value4`, esc(dd.value4||'')));
}
function vgBlock(vg={}){
  return wrap(`${NS}:vg_details`,
    wrap(`${NS}:a_rec_title`, esc(vg.a_rec_title||''))+
    wrap(`${NS}:a_rec_address`, esc(vg.a_rec_address||''))+
    wrap(`${NS}:a_rec_area`, esc(vg.a_rec_area||''))+
    wrap(`${NS}:a_rec_postal`, esc(vg.a_rec_postal||''))+
    wrap(`${NS}:a_rec_tel`, esc(vg.a_rec_tel||''))+
    wrap(`${NS}:a_rec_mobile`, esc(vg.a_rec_mobile||''))+
    wrap(`${NS}:a_packages`, esc(vg.a_packages||'1'))+
    wrap(`${NS}:a_weight`, esc(vg.a_weight||'0.5'))+
    wrap(`${NS}:a_rec_remarks`, esc(vg.a_rec_remarks||''))+
    wrap(`${NS}:a_rec_ref`, esc(vg.a_rec_ref||''))+
    wrap(`${NS}:a_cod_flag`, esc(vg.a_cod_flag||'0'))+
    wrap(`${NS}:a_cod_poso`, esc(vg.a_cod_poso||'0'))+
    wrap(`${NS}:a_cod_date`, esc(vg.a_cod_date||'')));
}
function wcodeBlock(w={}){  // optional block present in WSDL; keep empty by default
  return wrap(`${NS}:wcode_details`,
    wrap(`${NS}:wts_title`, esc(w.wts_title||''))+
    wrap(`${NS}:wts_name`, esc(w.wts_name||''))+
    wrap(`${NS}:wts_tel`, esc(w.wts_tel||''))+
    wrap(`${NS}:wts_afm`, esc(w.wts_afm||''))+
    wrap(`${NS}:wts_doy`, esc(w.wts_doy||''))+
    wrap(`${NS}:wts_address`, esc(w.wts_address||''))+
    wrap(`${NS}:wts_area`, esc(w.wts_area||''))+
    wrap(`${NS}:wts_postal`, esc(w.wts_postal||'')));
}

function envelope(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:${NS}="${NS}">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
}

/* ----------- SOAP builders (names exactly from WSDLs) ----------- */
function buildCreate(creds, payload){
  const st_code = payload.st_code || '';  // REQUIRED: store CODE from CSV
  return envelope(
    wrap(`${NS}:CREATE`,
      userBlock(creds) +
      ddBlock(payload.drop_down||{}) +
      wrap(`${NS}:st_code`, esc(st_code)) +
      vgBlock(payload.vg_details||{}) +
      wcodeBlock(payload.wcode_details||{})
    )
  );
}
function buildDelete(creds, akis_sideta){
  return envelope(
    wrap(`${NS}:DELETE`,
      userBlock(creds) + wrap(`${NS}:akis_sideta`, esc(akis_sideta))
    )
  );
}
function buildPrint(creds, akis_sideta){
  return envelope(
    wrap(`${NS}:PRINT`,
      userBlock(creds) + wrap(`${NS}:akis_sideta`, esc(akis_sideta))
    )
  );
}
function buildRead(creds, akis_sideta){
  return envelope(
    wrap(`${NS}:READ`,
      userBlock(creds) + wrap(`${NS}:akis_sideta`, esc(akis_sideta)) + wrap(`${NS}:akis_sub_sideta`, '')
    )
  );
}

/* ------------- tiny XML helpers to extract values --------------- */
function pick(xml, tag){
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}
function many(xml, tag){
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'ig');
  const out=[]; let m; while((m=re.exec(xml))) out.push(m[1].trim()); return out;
}

export default async function handler(req) {
  if (req.method !== 'POST') return fail('POST only');
  const secret = req.headers.get('x-akis-secret');
  const need = process.env.PROXY_SECRET || '';
  if (need && secret !== need) return fail('Forbidden (bad secret)', { status: 403 });

  let body;
  try { body = await req.json(); } catch { return fail('Invalid JSON'); }

  const { op, creds, payload } = body || {};
  if (!op || !creds) return fail('Missing op or creds');

  let xml;
  if (op === 'create') xml = buildCreate(creds, payload||{});
  else if (op === 'delete') xml = buildDelete(creds, payload?.akis_sideta||'');
  else if (op === 'print')  xml = buildPrint(creds, payload?.akis_sideta||'');
  else if (op === 'read')   xml = buildRead(creds, payload?.akis_sideta||'');
  else return fail('Unknown op');

  const res = await fetch(SOAP_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', 'soapaction': '' },
    body: xml
  });

  const txt = await res.text();

  // Normalize result to JSON
  if (op === 'create') {
    const st_flag = pick(txt, 'st_flag');
    const st_title= pick(txt, 'st_title');
    const akis_sideta = pick(txt, 'akis_sideta');
    const sub = many(txt, 'akis_sub_sideta');
    if (st_flag !== '1') return fail(st_title || 'Create failed', { st_flag, raw: txt });
    return ok({ st_flag, st_title, akis_sideta, akis_sub_sideta: sub, raw: txt });
  }
  if (op === 'delete') {
    const st_flag = pick(txt, 'st_flag');
    const st_title= pick(txt, 'st_title');
    if (st_flag !== '1') return fail(st_title || 'Delete failed', { st_flag, raw: txt });
    return ok({ st_flag, st_title, raw: txt });
  }
  if (op === 'print') {
    const st_flag = pick(txt, 'st_flag');
    const st_title= pick(txt, 'st_title');
    const b64     = pick(txt, 'akis_sideta_pdf');  // WSDL PRINTResponse
    if (st_flag !== '1' || !b64) return fail(st_title || 'Print failed', { st_flag, raw: txt });
    return ok({ st_flag, st_title, pdf_base64: b64 });
  }
  if (op === 'read') {
    const st_flag = pick(txt, 'st_flag');
    const st_title= pick(txt, 'st_title');
    return ok({ st_flag, st_title, raw: txt });
  }

  return fail('Unhandled');
}

// api/akis-proxy.js — HTTPS → Akis :1978 relay (serverless function)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  // Optional shared secret to prevent public abuse
  if (process.env.PROXY_SECRET && req.headers['x-proxy-secret'] !== process.env.PROXY_SECRET) {
    return res.status(403).send('Forbidden');
  }

  const body = await req.text();

  try {
    const upstream = 'http://91.184.205.124:1978';
    const r = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '' },
      body,
      redirect: 'manual',
    });
    const text = await r.text();
    res.status(r.status || 200)
       .setHeader('Content-Type', 'text/xml; charset=utf-8')
       .send(text);
  } catch (e) {
    res.status(502).send('Upstream error: ' + (e?.message || e));
  }
}

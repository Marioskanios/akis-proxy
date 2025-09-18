// api/akis-proxy.js — HTTPS → Akis :1978 relay (Node Serverless Function)

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const secret = process.env.PROXY_SECRET || '';
  if (secret && req.headers['x-proxy-secret'] !== secret) {
    return res.status(403).send('Forbidden');
  }

  // Read raw body safely in Node runtime
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => (data += chunk));
  req.on('end', async () => {
    try {
      const r = await fetch('http://91.184.205.124:1978', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': ''
        },
        body: data,
        redirect: 'manual'
      });

      const text = await r.text();
      res
        .status(r.status || 200)
        .setHeader('Content-Type', 'text/xml; charset=utf-8')
        .send(text);
    } catch (e) {
      res.status(502).send('Upstream error: ' + (e?.message || e));
    }
  });
}

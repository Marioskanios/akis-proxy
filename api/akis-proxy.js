// pages/api/akis-proxy.js  (Next.js / Vercel)
// HTTPS → Akis :1978 relay for SOAP (works for CREATE / PRINT / DELETE)

export const config = {
  api: { bodyParser: false }, // we need the raw XML body unchanged
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const secret = process.env.PROXY_SECRET || '';
  if (secret && req.headers['x-proxy-secret'] !== secret) {
    return res.status(403).send('Forbidden');
  }

  // Read raw body
  let data = '';
  req.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    req.on('data', chunk => (data += chunk));
    req.on('end', resolve);
    req.on('error', reject);
  });

  // Optional: short-circuit bad/empty requests
  if (!data || data.length < 20) return res.status(400).send('Empty SOAP body');

  // Timeout guard
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);

  try {
    const upstream = await fetch('http://91.184.205.124:1978', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        // Keep SOAPAction header blank as per WSDLs
        'SOAPAction': '',
      },
      body: data,
      redirect: 'manual',
      signal: ac.signal,
    });

    const text = await upstream.text();
    res.status(upstream.status || 200)
       .setHeader('Content-Type', 'text/xml; charset=utf-8')
       .send(text);
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'Timeout contacting Akis' : (e?.message || String(e));
    res.status(502).send('Upstream error: ' + msg);
  } finally {
    clearTimeout(t);
  }
}

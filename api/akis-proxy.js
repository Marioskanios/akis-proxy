// api/akis-proxy.js — HTTPS → Akis :1978 relay (Edge Function)

export const config = { runtime: 'edge' };

export default async function handler(request) {
  // Only POST
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405 });
  }

  // Optional shared secret
  const secret = process.env.PROXY_SECRET;
  if (secret && request.headers.get('x-proxy-secret') !== secret) {
    return new Response('Forbidden', { status: 403 });
  }

  // Read raw body
  const body = await request.text();

  try {
    const upstream = await fetch('http://91.184.205.124:1978', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': ''
      },
      body,
      redirect: 'manual'
    });

    const text = await upstream.text();

    return new Response(text, {
      status: upstream.status || 200,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' }
    });
  } catch (e) {
    return new Response('Upstream error: ' + (e?.message || e), { status: 502 });
  }
}

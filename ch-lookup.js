/**
 * Netlify Serverless Function: ch-lookup
 * ───────────────────────────────────────────────────────────────────────────
 * Handles Companies House OAuth 2.0 (Web Application flow) server-side so
 * the Client Secret is NEVER exposed to the browser.
 *
 * Usage (from the browser):
 *   GET /api/ch-lookup?company=12345678
 *
 * Required Netlify environment variables:
 *   CH_CLIENT_ID     = e10f1086-60be-4f04-a065-06988f62efbb
 *   CH_CLIENT_SECRET = B6b9A3Z1lSbnXtWlZAe5SpRaa0Vfxn1qRvO/n1pBhAk
 *
 * The function:
 *  1. Requests a Bearer token from CH OAuth endpoint using client_credentials
 *  2. Calls the CH REST API with the Bearer token
 *  3. Returns the company JSON to the browser
 *
 * Token is cached in module scope for its lifetime (typically 5 min) to avoid
 * hammering the token endpoint on every lookup.
 */

const CH_TOKEN_URL = 'https://identity.company-information.service.gov.uk/oauth2/token';
const CH_API_BASE  = 'https://api.company-information.service.gov.uk';

// Module-level token cache (lives for the duration of the Lambda warm instance)
let _cachedToken   = null;
let _tokenExpiry   = 0;

async function getAccessToken(clientId, clientSecret) {
  const now = Date.now();
  // Re-use cached token if still valid (with 30 s safety buffer)
  if (_cachedToken && now < _tokenExpiry - 30_000) {
    return _cachedToken;
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(CH_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CH token request failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  _cachedToken = json.access_token;
  // expires_in is in seconds; default to 300 s if missing
  _tokenExpiry = now + (json.expires_in || 300) * 1000;
  return _cachedToken;
}

exports.handler = async function (event) {
  // Only allow GET
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const companyNumber = (event.queryStringParameters?.company || '').trim().toUpperCase();
  if (!companyNumber) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing company parameter' }) };
  }

  const clientId     = process.env.CH_CLIENT_ID     || 'e10f1086-60be-4f04-a065-06988f62efbb';
  const clientSecret = process.env.CH_CLIENT_SECRET;

  if (!clientSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'CH_CLIENT_SECRET environment variable not set in Netlify' }),
    };
  }

  try {
    const token = await getAccessToken(clientId, clientSecret);

    const apiUrl = `${CH_API_BASE}/company/${encodeURIComponent(companyNumber)}`;
    const apiRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    });

    const responseBody = await apiRes.text();

    // Pass through the exact status code and body from CH API
    return {
      statusCode: apiRes.status,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: responseBody,
    };
  } catch (err) {
    console.error('[ch-lookup] Error:', err.message);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

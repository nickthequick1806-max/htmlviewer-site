import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './worker.js';

const ALLOWED_ORIGIN = 'https://htmlviewer.site';
const TEST_ENV = {
  ALLOWED_ORIGINS:ALLOWED_ORIGIN,
  GEMINI_API_KEY:'test-auth-key'
};

function createGeminiRequest(model = 'gemini-2.5-flash'){
  return new Request('https://worker.example/api/ai/gemini', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      Origin:ALLOWED_ORIGIN
    },
    body:JSON.stringify({
      model,
      contents:[{ role:'user', parts:[{ text:'Reply with OK' }] }]
    })
  });
}

test('returns Gemini responses from the upstream API', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /gemini-2\.5-flash:generateContent$/);
    assert.equal(init.headers['x-goog-api-key'], TEST_ENV.GEMINI_API_KEY);
    return Response.json({
      candidates:[{ content:{ parts:[{ text:'OK' }] } }]
    });
  };

  const response = await worker.fetch(createGeminiRequest(), TEST_ENV);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.equal((await response.json()).candidates[0].content.parts[0].text, 'OK');
});

test('turns Gemini 401 responses into an actionable key-rotation error', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => Response.json(
    {
      error:{
        message:'Request had invalid authentication credentials.'
      }
    },
    { status:401 }
  );

  const response = await worker.fetch(createGeminiRequest(), TEST_ENV);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error:
      'Gemini authentication failed. Replace GEMINI_API_KEY with a current ' +
      'Gemini Auth key created in Google AI Studio.'
  });
});

test('rejects Gemini models outside the allowlist before calling upstream', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error('Upstream should not be called.');
  };

  const response = await worker.fetch(
    createGeminiRequest('gemini-not-allowed'),
    TEST_ENV
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error:'The selected Gemini model is not allowed.'
  });
});

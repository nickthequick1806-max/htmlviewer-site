import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './worker.js';

const ALLOWED_ORIGIN = 'https://htmlviewer.site';
const TEST_ENV = {
  ALLOWED_ORIGINS:ALLOWED_ORIGIN,
  GEMINI_API_KEY:'test-auth-key',
  AI:{
    run:async () => ({
      image:Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00
      ]).toString('base64')
    })
  }
};

function createGeminiRequest(model = 'gemini-3.6-flash'){
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
    assert.match(String(url), /gemini-3\.6-flash:generateContent$/);
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

test('allows Gemini 3.5 Flash-Lite and forwards its model ID', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(init.headers['x-goog-api-key'], TEST_ENV.GEMINI_API_KEY);
    return Response.json({
      candidates:[{ content:{ parts:[{ text:'Fast OK' }] } }]
    });
  };

  const response = await worker.fetch(
    createGeminiRequest('gemini-3.5-flash-lite'),
    TEST_ENV
  );

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).candidates[0].content.parts[0].text,
    'Fast OK'
  );
});

test('allows Gemini 3.6 Flash and forwards its stable model ID', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /gemini-3\.6-flash:generateContent$/);
    assert.equal(init.headers['x-goog-api-key'], TEST_ENV.GEMINI_API_KEY);
    return Response.json({
      candidates:[{ content:{ parts:[{ text:'Gemini 3.6 OK' }] } }]
    });
  };

  const response = await worker.fetch(
    createGeminiRequest('gemini-3.6-flash'),
    TEST_ENV
  );

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).candidates[0].content.parts[0].text,
    'Gemini 3.6 OK'
  );
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

test('generates images with only FLUX.2 Klein 4B through the AI binding', async () => {
  let call;
  const env = {
    ...TEST_ENV,
    AI:{
      async run(model, input){
        call = { model, input };
        return TEST_ENV.AI.run();
      }
    }
  };
  const request = new Request('https://worker.example/api/ai/image', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      Origin:ALLOWED_ORIGIN
    },
    body:JSON.stringify({ prompt:'A clean monochrome website mockup' })
  });

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(call.model, '@cf/black-forest-labs/flux-2-klein-4b');
  assert.ok(call.input.multipart.body instanceof ReadableStream);
  assert.match(call.input.multipart.contentType, /^multipart\/form-data; boundary=/);

  const forwardedForm = await new Response(
    call.input.multipart.body,
    { headers:{ 'Content-Type':call.input.multipart.contentType } }
  ).formData();
  assert.equal(forwardedForm.get('prompt'), 'A clean monochrome website mockup');
  assert.equal(forwardedForm.get('width'), '1024');
  assert.equal(forwardedForm.get('height'), '1024');
});

test('returns a setup error when the Workers AI binding is missing', async () => {
  const request = new Request('https://worker.example/api/ai/image', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      Origin:ALLOWED_ORIGIN
    },
    body:JSON.stringify({ prompt:'A test image' })
  });
  const response = await worker.fetch(request, {
    ...TEST_ENV,
    AI:undefined
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error:'Cloudflare Workers AI is not configured.'
  });
});

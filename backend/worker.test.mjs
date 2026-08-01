import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './worker.js';

const ALLOWED_ORIGIN = 'https://htmlviewer.site';
const TEST_ENV = {
  ALLOWED_ORIGINS:ALLOWED_ORIGIN,
  GEMINI_API_KEY:'test-auth-key',
  UPTIMEROBOT_API_KEY:'test-uptime-key',
  UPTIMEROBOT_RESPONSE_API_KEY:'test-response-key',
  AI:{
    run:async () => ({
      image:Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00
      ]).toString('base64')
    })
  }
};

function createJsonRequest(path, body, method = 'POST'){
  return new Request('https://worker.example' + path, {
    method,
    headers:{
      'Content-Type':'application/json',
      Origin:ALLOWED_ORIGIN
    },
    body:method === 'GET' ? undefined : JSON.stringify(body || {})
  });
}

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

test('forwards Google Search grounding only when requested', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url,init) => {
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.tools,[{ googleSearch:{} }]);
    return Response.json({ candidates:[{ content:{ parts:[{ text:'Grounded' }] } }] });
  };
  const request = createGeminiRequest();
  const payload = await request.json();
  payload.grounding = true;
  const response = await worker.fetch(createJsonRequest('/api/ai/gemini',payload),TEST_ENV);
  assert.equal(response.status,200);
});

test('generates Gemini Flash TTS audio with Charon and retries a server failure', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let attempts = 0;
  globalThis.fetch = async (url,init) => {
    attempts += 1;
    assert.equal(String(url),'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(init.headers['Api-Revision'],'2026-05-20');
    const payload = JSON.parse(init.body);
    assert.equal(payload.model,'gemini-3.1-flash-tts-preview');
    assert.equal(payload.generation_config.speech_config[0].voice,'Charon');
    if(attempts === 1) return Response.json({error:{message:'temporary'}},{status:500});
    return Response.json({ output:{ audio:{ data:'AAECAw==', mime_type:'audio/L16', sample_rate:24000, channels:1 } } });
  };
  const response = await worker.fetch(createJsonRequest('/api/ai/tts',{input:'Hello',voice:'Charon'}),TEST_ENV);
  const data = await response.json();
  assert.equal(response.status,200);
  assert.equal(attempts,2);
  assert.equal(data.audio.data,'AAECAw==');
  assert.equal(data.audio.sampleRate,24000);
});

test('sends AI feedback to the private Discord webhook', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let discordPayload;
  globalThis.fetch = async (url,init) => {
    assert.match(String(url),/^https:\/\/discord\.com\/api\/webhooks\/test\/token\?wait=true$/);
    discordPayload = JSON.parse(init.body);
    return new Response(null,{status:204});
  };
  const response = await worker.fetch(createJsonRequest('/api/ai/feedback',{
    prompt:'Prompt',response:'Response',model:'gemini-3.6-flash',rating:'like',
    date:'2026-08-01T10:00:00.000Z',chatId:'chat-1',messageId:'message-1'
  }),{...TEST_ENV,DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/test/token'});
  assert.equal(response.status,200);
  assert.match(discordPayload.embeds[0].title,/liked/i);
  assert.equal(discordPayload.embeds[0].fields.find(field => field.name === 'Message ID').value,'message-1');
});

test('rejects invalid AI feedback ratings before Discord', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('Discord should not be called.'); };
  const response = await worker.fetch(createJsonRequest('/api/ai/feedback',{
    prompt:'Prompt',response:'Response',model:'gemini-3.6-flash',rating:'neutral',
    date:'2026-08-01T10:00:00.000Z',chatId:'chat-1',messageId:'message-1'
  }),{...TEST_ENV,DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/test/token'});
  assert.equal(response.status,400);
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

test('creates a one-use Gemini Live token with Charon as the default voice', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let provisioningBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(
      String(url),
      'https://generativelanguage.googleapis.com/v1beta/auth_tokens'
    );
    assert.equal(init.headers['x-goog-api-key'], TEST_ENV.GEMINI_API_KEY);
    provisioningBody = JSON.parse(init.body);
    return Response.json({
      name:'auth_tokens/live-test-token',
      expireTime:'2026-07-28T17:30:00.000Z'
    });
  };

  const response = await worker.fetch(
    createJsonRequest('/api/ai/live-token', {
      editorContext:'Current file: landing-page.html'
    }),
    TEST_ENV
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.model, 'gemini-3.1-flash-live-preview');
  assert.equal(data.voice, 'Charon');
  assert.equal(data.token, 'auth_tokens/live-test-token');
  assert.equal(provisioningBody.uses, 1);
  assert.equal(provisioningBody.liveConnectConstraints, undefined);
  assert.equal(provisioningBody.bidiGenerateContentSetup, undefined);
  assert.equal(
    data.config.generationConfig.speechConfig
      .voiceConfig.prebuiltVoiceConfig.voiceName,
    'Charon'
  );
  assert.match(
    data.config.systemInstruction
      .parts[0].text,
    /Current file: landing-page\.html/
  );
  assert.match(
    data.config.systemInstruction.parts[0].text,
    /You are ONYX/
  );
  assert.match(
    data.config.systemInstruction.parts[0].text,
    /ONYX online/
  );
  assert.match(
    data.config.systemInstruction.parts[0].text,
    /autonomously improve/
  );
  assert.match(
    data.config.systemInstruction.parts[0].text,
    /FLUX\.2 Klein 4B/
  );
  assert.match(
    data.config.systemInstruction.parts[0].text,
    /activate the final publish action/
  );
});

test('rotates the requested professional ONYX introduction variant', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => Response.json({
    name:'auth_tokens/live-intro-token',
    expireTime:'2026-08-01T18:30:00.000Z'
  });

  const response = await worker.fetch(
    createJsonRequest('/api/ai/live-token', {
      voice:'Charon',
      introductionVariant:3
    }),
    TEST_ENV
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.match(
    data.config.systemInstruction.parts[0].text,
    /ONYX at your service/
  );
  assert.doesNotMatch(
    data.config.systemInstruction.parts[0].text,
    /ONYX online\. I can inspect/
  );
});

test('rejects unsupported Gemini Live voices before provisioning a token', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error('Token provisioning should not be called.');
  };

  const response = await worker.fetch(
    createJsonRequest('/api/ai/live-token', { voice:'Not-A-Voice' }),
    TEST_ENV
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error:'The selected Gemini Live voice is not allowed.'
  });
});

test('classifies stabilized coding commands with the dedicated intent route', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /gemini-3\.5-flash-lite:generateContent$/);
    const body = JSON.parse(init.body);
    assert.match(
      body.contents[0].parts[0].text,
      /Add a responsive contact section/
    );
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return Response.json({
      candidates:[{
        content:{
          parts:[{
            text:JSON.stringify({
              intent:'ACTIONABLE',
              action:'NONE',
              confidence:0.97,
              reason:'The user requested a code change.'
            })
          }]
        }
      }]
    });
  };

  const response = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Add a responsive contact section to my page.'
    }),
    TEST_ENV
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    actionable:true,
    intent:'ACTIONABLE',
    uiAction:null,
    uiTarget:null,
    uiValue:null,
    confidence:0.97,
    reason:'The user requested a code change.'
  });
});

test('classifies supported Voice Mode interface commands', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => Response.json({
    candidates:[{
      content:{
        parts:[{
          text:JSON.stringify({
            intent:'UI_ACTION',
            action:'OPEN_PROJECTS',
            confidence:0.99,
            reason:'The user asked to open Projects.'
          })
        }]
      }
    }]
  });

  const response = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Please open my projects section.'
    }),
    TEST_ENV
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'OPEN_PROJECTS',
    uiTarget:null,
    uiValue:null,
    confidence:0.99,
    reason:'The user asked to open Projects.'
  });
});

test('classifies named controls and code-search values for Voice Mode', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return Response.json({
      candidates:[{
        content:{
          parts:[{
            text:JSON.stringify(call === 1
              ? {
                  intent:'UI_ACTION',
                  action:'CLICK_CONTROL',
                  target:'Validate HTML',
                  value:'',
                  confidence:0.99,
                  reason:'The user asked to press Validate HTML.'
                }
              : {
                  intent:'UI_ACTION',
                  action:'SEARCH_CODE',
                  target:'Search editor code',
                  value:'contact-form',
                  confidence:0.98,
                  reason:'The user asked to search the editor.'
                })
          }]
        }
      }]
    });
  };

  const clickResponse = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Click the Validate HTML button.'
    }),
    TEST_ENV
  );
  assert.equal(clickResponse.status, 200);
  assert.deepEqual(await clickResponse.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'CLICK_CONTROL',
    uiTarget:'Validate HTML',
    uiValue:null,
    confidence:0.99,
    reason:'The user asked to press Validate HTML.'
  });

  const searchResponse = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Search the code for contact-form.'
    }),
    TEST_ENV
  );
  assert.equal(searchResponse.status, 200);
  assert.deepEqual(await searchResponse.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'SEARCH_CODE',
    uiTarget:null,
    uiValue:'contact-form',
    confidence:0.98,
    reason:'The user asked to search the editor.'
  });
});

test('classifies preview-device and open-download Voice Mode commands', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return Response.json({
      candidates:[{
        content:{
          parts:[{
            text:JSON.stringify(call === 1
              ? {
                  intent:'UI_ACTION',
                  action:'SET_PREVIEW_DEVICE',
                  target:'Live Preview',
                  value:'tablet',
                  confidence:0.99,
                  reason:'The user requested Tablet view.'
                }
              : {
                  intent:'UI_ACTION',
                  action:'OPEN_DOWNLOAD',
                  target:'Download',
                  value:'',
                  confidence:0.99,
                  reason:'The user requested the Download section.'
                })
          }]
        }
      }]
    });
  };

  const previewResponse = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Switch the Live Preview to tablet view.'
    }),
    TEST_ENV
  );
  assert.deepEqual(await previewResponse.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'SET_PREVIEW_DEVICE',
    uiTarget:null,
    uiValue:'tablet',
    confidence:0.99,
    reason:'The user requested Tablet view.'
  });

  const downloadResponse = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Open the Download section.'
    }),
    TEST_ENV
  );
  assert.deepEqual(await downloadResponse.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'OPEN_DOWNLOAD',
    uiTarget:null,
    uiValue:null,
    confidence:0.99,
    reason:'The user requested the Download section.'
  });
});

test('routes explicit Voice Mode image requests to the FLUX action', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => Response.json({
    candidates:[{
      content:{
        parts:[{
          text:JSON.stringify({
            intent:'UI_ACTION',
            action:'GENERATE_IMAGE',
            target:'FLUX.2 Klein 4B',
            value:'a polished onyx dashboard illustration',
            confidence:0.99,
            reason:'The user explicitly requested an image generation.'
          })
        }]
      }
    }]
  });

  const response = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Generate an image of a polished onyx dashboard illustration.'
    }),
    TEST_ENV
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'GENERATE_IMAGE',
    uiTarget:null,
    uiValue:'a polished onyx dashboard illustration',
    confidence:0.99,
    reason:'The user explicitly requested an image generation.'
  });
});

test('classifies named saves and explicit saved-version actions', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return Response.json({
      candidates:[{
        content:{
          parts:[{
            text:JSON.stringify(call === 1
              ? {
                  intent:'UI_ACTION',
                  action:'SAVE_CODE',
                  target:'Save Version',
                  value:'Landing page v2',
                  confidence:0.99,
                  reason:'The user supplied a name for the current code.'
                }
              : {
                  intent:'UI_ACTION',
                  action:'SAVED_VERSION_ACTION',
                  target:'update',
                  value:'Landing page v2',
                  confidence:0.98,
                  reason:'The user explicitly identified a saved version.'
                })
          }]
        }
      }]
    });
  };

  const saveResponse = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Save this code as Landing page v2.'
    }),
    TEST_ENV
  );
  assert.deepEqual(await saveResponse.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'SAVE_CODE',
    uiTarget:null,
    uiValue:'Landing page v2',
    confidence:0.99,
    reason:'The user supplied a name for the current code.'
  });

  const savedVersionResponse = await worker.fetch(
    createJsonRequest('/api/ai/voice-intent', {
      transcript:'Update the saved version named Landing page v2.'
    }),
    TEST_ENV
  );
  assert.deepEqual(await savedVersionResponse.json(), {
    actionable:false,
    intent:'UI_ACTION',
    uiAction:'SAVED_VERSION_ACTION',
    uiTarget:'update',
    uiValue:'Landing page v2',
    confidence:0.98,
    reason:'The user explicitly identified a saved version.'
  });
});

test('returns sanitized UptimeRobot v3 monitor data and status bars', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const seen = [];
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(url);
    seen.push({
      path:requestUrl.pathname,
      authorization:init.headers.Authorization
    });

    if(requestUrl.pathname === '/v3/monitors'){
      return Response.json({
        data:[{
          id:42,
          friendlyName:'htmlviewer.site',
          url:'https://htmlviewer.site/',
          status:'UP',
          privateField:'must not be exposed'
        }]
      });
    }

    if(requestUrl.pathname.endsWith('/stats/uptime')){
      return Response.json({
        uptime:99.99,
        total_downtime_seconds:260,
        incident_count:1,
        mtbf:100000,
        from:'2026-06-28T00:00:00.000Z',
        to:'2026-07-28T00:00:00.000Z'
      });
    }

    if(requestUrl.pathname.endsWith('/stats/response-time')){
      return Response.json({
        summary:{ min:35, max:140, avg:72 },
        data_points:2,
        from:'2026-06-28T00:00:00.000Z',
        to:'2026-07-28T00:00:00.000Z',
        time_series:[
          { timestamp:new Date().toISOString(), value:72 }
        ]
      });
    }

    if(requestUrl.pathname === '/v3/incidents'){
      return Response.json({
        data:[{
          id:'incident-17',
          status:'RESOLVED',
          type:'DOWNTIME',
          cause:500,
          reason:'Origin returned an error',
          monitor:{ id:42, friendlyName:'htmlviewer.site' },
          commentsCount:0,
          startedAt:new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString(),
          resolvedAt:new Date(Date.now() - (60 * 60 * 1000)).toISOString(),
          duration:3600,
          includeInReports:true,
          privateRootCause:'must not be exposed'
        }]
      });
    }

    return Response.json({ error:'Unexpected route' }, { status:404 });
  };

  const response = await worker.fetch(
    createJsonRequest('/api/status', null, 'GET'),
    TEST_ENV
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.allOperational, true);
  assert.equal(data.monitorCount, 1);
  assert.equal(data.monitors[0].name, 'htmlviewer.site');
  assert.equal(data.monitors[0].uptime, 99.99);
  assert.equal(data.monitors[0].responseTime, 72);
  assert.equal(data.monitors[0].responseTimeMin, 35);
  assert.equal(data.monitors[0].responseTimeMax, 140);
  assert.equal(data.monitors[0].responseDataPoints, 2);
  assert.equal(data.monitors[0].bars.length, 30);
  assert.equal(data.monitors[0].bars.at(-1).state, 'down');
  assert.equal(data.incidentCount, 1);
  assert.equal(data.activeIncidentCount, 0);
  assert.equal(data.incidentsAvailable, true);
  assert.deepEqual(data.incidents[0], {
    id:'incident-17',
    status:'resolved',
    type:'DOWNTIME',
    reason:'Origin returned an error',
    monitorId:42,
    monitorName:'htmlviewer.site',
    startedAt:data.incidents[0].startedAt,
    resolvedAt:data.incidents[0].resolvedAt,
    duration:3600
  });
  assert.equal('privateField' in data.monitors[0], false);
  assert.equal('privateRootCause' in data.incidents[0], false);
  assert.ok(seen.some(call =>
    call.path === '/v3/monitors' &&
    call.authorization === 'Bearer test-uptime-key'
  ));
  assert.ok(seen.some(call =>
    call.path.endsWith('/stats/response-time') &&
    call.authorization === 'Bearer test-response-key'
  ));
  assert.ok(seen.some(call =>
    call.path === '/v3/incidents' &&
    call.authorization === 'Bearer test-uptime-key'
  ));
});

test('does not fabricate down status bars when UptimeRobot returns no incidents', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    if(requestUrl.pathname === '/v3/monitors'){
      return Response.json({
        data:[{
          id:7,
          friendlyName:'No incidents',
          url:'https://example.com/',
          status:'UP'
        }]
      });
    }
    if(requestUrl.pathname === '/v3/incidents'){
      return Response.json({ data:[] });
    }
    if(requestUrl.pathname.endsWith('/stats/uptime')){
      return Response.json({
        uptime:99.5,
        total_downtime_seconds:120,
        incident_count:0,
        mtbf:null,
        from:'2026-06-28T00:00:00.000Z',
        to:'2026-07-28T00:00:00.000Z'
      });
    }
    if(requestUrl.pathname.endsWith('/stats/response-time')){
      return Response.json({
        summary:{ min:null, max:null, avg:null },
        data_points:0,
        from:'2026-06-28T00:00:00.000Z',
        to:'2026-07-28T00:00:00.000Z',
        time_series:[]
      });
    }
    return Response.json({ error:'Unexpected route' }, { status:404 });
  };

  const response = await worker.fetch(
    createJsonRequest('/api/status', null, 'GET'),
    TEST_ENV
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.monitors[0].responseTime, null);
  assert.equal(
    data.monitors[0].bars.some(bar => bar.state === 'down'),
    false
  );
  assert.equal(
    data.monitors[0].bars.every(bar => bar.state === 'unknown'),
    true
  );
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

test('sends the selected contact category in the Discord embed', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let discordPayload;
  globalThis.fetch = async (url,init) => {
    assert.match(String(url), /^https:\/\/discord\.com\/api\/webhooks\//);
    discordPayload = JSON.parse(init.body);
    return Response.json({ id:'message-id' });
  };

  const response = await worker.fetch(
    new Request('https://worker.example/api/contact', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Origin:ALLOWED_ORIGIN
      },
      body:JSON.stringify({
        name:'Test User',
        message:'The editor toolbar overlaps on mobile.',
        category:'Bug Report'
      })
    }),
    {
      ...TEST_ENV,
      DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/123/test-token'
    }
  );

  assert.equal(response.status,200);
  assert.deepEqual(
    discordPayload.embeds[0].fields.find(field => field.name === 'Category'),
    { name:'Category',value:'Bug Report',inline:true }
  );
});

test('rejects unknown contact categories before calling Discord', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error('Discord should not be called.');
  };

  const response = await worker.fetch(
    new Request('https://worker.example/api/contact', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Origin:ALLOWED_ORIGIN
      },
      body:JSON.stringify({
        name:'Test User',
        message:'Hello',
        category:'Security'
      })
    }),
    {
      ...TEST_ENV,
      DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/123/test-token'
    }
  );

  assert.equal(response.status,400);
  assert.deepEqual(await response.json(), {
    error:'The contact category is not allowed.'
  });
});

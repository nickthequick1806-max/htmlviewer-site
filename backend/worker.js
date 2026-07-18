const GEMINI_MODELS = new Set([
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]);

const MAX_AI_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FORM_BODY_BYTES = 160 * 1024;
const POLLINATIONS_BASE_URL = 'https://gen.pollinations.ai';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if(request.method === 'GET' && url.pathname === '/health'){
      return jsonResponse(
        { ok:true, service:'html-viewer-secure-backend' },
        200,
        '*'
      );
    }

    const origin = getAllowedOrigin(request, env);

    if(request.method === 'OPTIONS'){
      if(!origin){
        return jsonResponse({ error:'Origin is not allowed.' }, 403);
      }

      return new Response(null, {
        status:204,
        headers:responseHeaders(origin)
      });
    }

    if(!origin){
      return jsonResponse({ error:'Origin is not allowed.' }, 403);
    }

    try{
      if(request.method === 'GET' && url.pathname === '/api/pollinations/balance'){
        await enforceRateLimit(env.AI_RATE_LIMITER, request, 'ai');
        return await getPollinationsBalance(env, origin);
      }

      if(request.method === 'POST' && url.pathname === '/api/ai/image'){
        await enforceRateLimit(env.AI_RATE_LIMITER, request, 'ai');
        return await generatePollinationsImage(request, env, origin);
      }

      if(request.method === 'POST' && url.pathname === '/api/ai/gemini'){
        await enforceRateLimit(env.AI_RATE_LIMITER, request, 'ai');
        return await generateGeminiResponse(request, env, origin);
      }

      if(request.method === 'POST' && url.pathname === '/api/contact'){
        await enforceRateLimit(env.FORM_RATE_LIMITER, request, 'form');
        return await sendContactMessage(request, env, origin);
      }

      if(request.method === 'POST' && url.pathname === '/api/community-preset'){
        await enforceRateLimit(env.FORM_RATE_LIMITER, request, 'form');
        return await sendCommunityPreset(request, env, origin);
      }

      return jsonResponse({ error:'Route not found.' }, 404, origin);
    }catch(error){
      const status = error instanceof PublicError ? error.status : 500;
      const message = error instanceof PublicError
        ? error.message
        : 'The backend could not complete the request.';

      return jsonResponse({ error:message }, status, origin);
    }
  }
};

async function generateGeminiResponse(request, env, origin){
  const apiKey = requireSecret(env, 'GEMINI_API_KEY');
  const body = await readJson(request, MAX_AI_BODY_BYTES);
  const model = requireText(body.model, 'model', 80);

  if(!GEMINI_MODELS.has(model)){
    throw new PublicError(400, 'The selected Gemini model is not allowed.');
  }

  if(!Array.isArray(body.contents) || body.contents.length === 0){
    throw new PublicError(400, 'Gemini contents are required.');
  }

  const upstream = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-goog-api-key':apiKey
      },
      body:JSON.stringify({ contents:body.contents })
    }
  );

  const rawText = await upstream.text();

  if(!upstream.ok){
    throw new PublicError(
      normalizeUpstreamStatus(upstream.status),
      getGeminiUpstreamMessage(upstream.status, rawText)
    );
  }

  let data;
  try{
    data = rawText ? JSON.parse(rawText) : null;
  }catch(error){
    throw new PublicError(502, 'Gemini returned an invalid response.');
  }

  return jsonResponse(data, 200, origin);
}

async function generatePollinationsImage(request, env, origin){
  const apiKey = requireSecret(env, 'POLLINATIONS_API_KEY');
  const body = await readJson(request, 32 * 1024);
  const prompt = requireText(body.prompt, 'prompt', 4000);
  const upstream = await fetch(
    POLLINATIONS_BASE_URL +
      '/image/' +
      encodeURIComponent(prompt) +
      '?model=flux',
    {
      headers:{ Authorization:'Bearer ' + apiKey }
    }
  );

  if(!upstream.ok){
    const rawText = await upstream.text().catch(() => '');
    throw new PublicError(
      normalizeUpstreamStatus(upstream.status),
      getUpstreamMessage(rawText, 'Pollinations rejected the image request.')
    );
  }

  const headers = responseHeaders(origin, {
    'Content-Type':upstream.headers.get('Content-Type') || 'image/png'
  });

  return new Response(upstream.body, { status:200, headers });
}

async function getPollinationsBalance(env, origin){
  const apiKey = requireSecret(env, 'POLLINATIONS_API_KEY');
  const upstream = await fetch(POLLINATIONS_BASE_URL + '/account/balance', {
    method:'GET',
    headers:{
      Authorization:'Bearer ' + apiKey,
      Accept:'application/json'
    }
  });
  const rawText = await upstream.text();

  if(!upstream.ok){
    throw new PublicError(
      normalizeUpstreamStatus(upstream.status),
      getUpstreamMessage(rawText, 'Pollinations rejected the balance request.')
    );
  }

  let data;
  try{
    data = rawText ? JSON.parse(rawText) : null;
  }catch(error){
    throw new PublicError(502, 'Pollinations returned an invalid balance response.');
  }

  return jsonResponse(data, 200, origin);
}

async function sendContactMessage(request, env, origin){
  const body = await readJson(request, MAX_FORM_BODY_BYTES);
  const name = requireText(body.name, 'name', 80);
  const message = requireText(body.message, 'message', 3000);
  const payload = {
    username:'HTML Viewer Contact',
    allowed_mentions:{ parse:[] },
    embeds:[
      {
        title:'New Contact Message',
        description:message,
        color:3447003,
        fields:[{ name:'Name', value:name, inline:true }],
        footer:{ text:'HTML Viewer Contact Form' },
        timestamp:new Date().toISOString()
      }
    ]
  };

  await postDiscordWebhook(env, JSON.stringify(payload), {
    'Content-Type':'application/json'
  });

  return jsonResponse({ ok:true }, 200, origin);
}

async function sendCommunityPreset(request, env, origin){
  const body = await readJson(request, MAX_FORM_BODY_BYTES);
  const name = requireText(body.name, 'name', 80);
  const title = requireText(body.title, 'title', 120);
  const link = requireText(body.link, 'link', 120000);

  let parsedLink;
  try{
    parsedLink = new URL(link);
  }catch(error){
    throw new PublicError(400, 'A valid preset link is required.');
  }

  if(!['http:', 'https:'].includes(parsedLink.protocol)){
    throw new PublicError(400, 'The preset link must use http or https.');
  }

  const submittedAt = new Date();
  const fileName = createPresetFileName(title);
  const linkDocument = [
    'HTML Viewer Community Preset',
    'Preset: ' + title,
    'Submitted By: ' + name,
    'Submitted At: ' + submittedAt.toISOString(),
    '',
    'Full Preset Share Link:',
    link,
    ''
  ].join('\n');
  const payload = {
    username:'HTML Viewer Presets',
    allowed_mentions:{ parse:[] },
    embeds:[
      {
        title:'New Community Preset Submission',
        description:'The full preset share link is attached below as a text document.',
        color:0xffffff,
        fields:[
          { name:'Submitted By', value:name, inline:true },
          { name:'Preset Title', value:title, inline:true },
          { name:'Link Document', value:'Attached below as `' + fileName + '`.', inline:false },
          { name:'Submitted At', value:submittedAt.toISOString(), inline:false }
        ],
        footer:{ text:'Htmlviewer.site Community Presets' },
        timestamp:submittedAt.toISOString()
      }
    ],
    attachments:[
      {
        id:0,
        filename:fileName,
        description:'Full HTML Viewer community preset share link'
      }
    ]
  };
  const formData = new FormData();
  formData.append('payload_json', JSON.stringify(payload));
  formData.append(
    'files[0]',
    new Blob([linkDocument], { type:'text/plain;charset=utf-8' }),
    fileName
  );

  await postDiscordWebhook(env, formData);
  return jsonResponse({ ok:true }, 200, origin);
}

async function postDiscordWebhook(env, body, headers){
  const configuredUrl = requireSecret(env, 'DISCORD_WEBHOOK_URL');
  let webhookUrl;

  try{
    webhookUrl = new URL(configuredUrl);
  }catch(error){
    throw new PublicError(503, 'The Discord webhook secret is not a valid URL.');
  }

  const validDiscordHost =
    webhookUrl.hostname === 'discord.com' ||
    webhookUrl.hostname === 'discordapp.com';

  if(
    webhookUrl.protocol !== 'https:' ||
    !validDiscordHost ||
    !webhookUrl.pathname.startsWith('/api/webhooks/')
  ){
    throw new PublicError(503, 'The Discord webhook secret is not a Discord webhook URL.');
  }

  webhookUrl.searchParams.set('wait', 'true');
  const upstream = await fetch(webhookUrl.toString(), {
    method:'POST',
    headers,
    body
  });

  if(!upstream.ok){
    const rawText = await upstream.text().catch(() => '');
    throw new PublicError(
      normalizeUpstreamStatus(upstream.status),
      getUpstreamMessage(rawText, 'Discord rejected the webhook request.')
    );
  }
}

async function readJson(request, maxBytes){
  const contentType = request.headers.get('Content-Type') || '';
  if(!contentType.toLowerCase().includes('application/json')){
    throw new PublicError(415, 'Content-Type must be application/json.');
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if(declaredLength > maxBytes){
    throw new PublicError(413, 'The request is too large.');
  }

  const rawText = await request.text();
  if(rawText.length > maxBytes){
    throw new PublicError(413, 'The request is too large.');
  }

  try{
    return JSON.parse(rawText);
  }catch(error){
    throw new PublicError(400, 'The request body must be valid JSON.');
  }
}

function requireText(value, fieldName, maxLength){
  const text = typeof value === 'string' ? value.trim() : '';
  if(!text){
    throw new PublicError(400, fieldName + ' is required.');
  }
  if(text.length > maxLength){
    throw new PublicError(400, fieldName + ' is too long.');
  }
  return text;
}

function requireSecret(env, name){
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if(!value){
    throw new PublicError(503, 'Backend secret ' + name + ' is not configured.');
  }
  return value;
}

function getAllowedOrigin(request, env){
  const requestOrigin = request.headers.get('Origin') || '';
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return allowedOrigins.includes(requestOrigin) ? requestOrigin : '';
}

async function enforceRateLimit(binding, request, group){
  if(!binding || typeof binding.limit !== 'function'){
    return;
  }

  const clientAddress =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown-client';
  const result = await binding.limit({ key:group + ':' + clientAddress });

  if(!result.success){
    throw new PublicError(429, 'Too many requests. Please wait a minute and try again.');
  }
}

function createPresetFileName(title){
  const safeTitle = String(title || 'community-preset')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return (safeTitle || 'community-preset') + '-share-link.txt';
}

function getUpstreamMessage(rawText, fallback){
  if(!rawText){
    return fallback;
  }

  try{
    const data = JSON.parse(rawText);
    const message =
      (typeof data.error === 'string' && data.error) ||
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error?.message === 'string' && data.error.message) ||
      (typeof data.message?.message === 'string' && data.message.message);

    return message ? message.slice(0, 500) : fallback;
  }catch(error){
    return rawText.slice(0, 500) || fallback;
  }
}

function getGeminiUpstreamMessage(status, rawText){
  if(status === 401){
    return (
      'Gemini authentication failed. Replace GEMINI_API_KEY with a current ' +
      'Gemini Auth key created in Google AI Studio.'
    );
  }

  return getUpstreamMessage(rawText, 'Gemini rejected the request.');
}

function normalizeUpstreamStatus(status){
  if(status === 400 || status === 401 || status === 403 || status === 404 || status === 429){
    return status;
  }
  return 502;
}

function responseHeaders(origin, additionalHeaders){
  const headers = new Headers(additionalHeaders || {});
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');

  if(origin){
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
    if(origin !== '*'){
      headers.append('Vary', 'Origin');
    }
  }

  return headers;
}

function jsonResponse(data, status, origin){
  const headers = responseHeaders(origin, {
    'Content-Type':'application/json; charset=utf-8'
  });
  return new Response(JSON.stringify(data), { status, headers });
}

class PublicError extends Error {
  constructor(status, message){
    super(message);
    this.name = 'PublicError';
    this.status = status;
  }
}

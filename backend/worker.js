const GEMINI_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite'
]);

const MAX_AI_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FORM_BODY_BYTES = 160 * 1024;
const FLUX_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const FLUX_IMAGE_SIZE = 1024;
const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_VOICE_INTENT_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_VOICE_UI_ACTIONS = new Set([
  'NEW_CHAT',
  'OPEN_PROJECTS',
  'OPEN_LIBRARY',
  'OPEN_CHAT_HISTORY',
  'ADD_IMAGE',
  'ATTACH_CODE_FILE',
  'CLICK_CONTROL',
  'SEARCH_CODE',
  'FILL_CONTROL',
  'SAVE_CODE',
  'SAVED_VERSION_ACTION'
]);
const GEMINI_LIVE_VOICES = new Set([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird',
  'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]);
const UPTIMEROBOT_API_BASE = 'https://api.uptimerobot.com/v3';
const UPTIMEROBOT_STATUS_CACHE_SECONDS = 60;
const STATUS_CACHE_KEY = 'https://html-viewer-status-cache.invalid/v2';

export default {
  async fetch(request, env, ctx) {
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
      if(request.method === 'POST' && url.pathname === '/api/ai/image'){
        await enforceRateLimit(env.AI_RATE_LIMITER, request, 'ai');
        return await generateFluxImage(request, env, origin);
      }

      if(request.method === 'POST' && url.pathname === '/api/ai/gemini'){
        await enforceRateLimit(env.AI_RATE_LIMITER, request, 'ai');
        return await generateGeminiResponse(request, env, origin);
      }

      if(request.method === 'POST' && url.pathname === '/api/ai/live-token'){
        await enforceRateLimit(env.AI_RATE_LIMITER, request, 'voice');
        return await createGeminiLiveToken(request, env, origin);
      }

      if(request.method === 'POST' && url.pathname === '/api/ai/voice-intent'){
        await enforceRateLimit(env.AI_RATE_LIMITER, request, 'voice');
        return await classifyVoiceIntent(request, env, origin);
      }

      if(request.method === 'GET' && url.pathname === '/api/status'){
        return await getServiceStatus(env, origin, ctx);
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

async function createGeminiLiveToken(request, env, origin){
  const apiKey = requireSecret(env, 'GEMINI_API_KEY');
  const body = await readJson(request, 48 * 1024);
  const voice = requireText(body.voice || 'Charon', 'voice', 40);

  if(!GEMINI_LIVE_VOICES.has(voice)){
    throw new PublicError(400, 'The selected Gemini Live voice is not allowed.');
  }

  const editorContext = typeof body.editorContext === 'string'
    ? body.editorContext.trim().slice(0, 24000)
    : '';
  const language = typeof body.language === 'string'
    ? body.language.trim().slice(0, 20)
    : 'auto';
  const hasIntroduced = body.hasIntroduced === true;
  const systemInstruction = createVoiceSystemInstruction(
    editorContext,
    language,
    hasIntroduced
  );
  const liveConfig = {
    generationConfig:{
      responseModalities:['AUDIO'],
      speechConfig:{
        voiceConfig:{
          prebuiltVoiceConfig:{ voiceName:voice }
        }
      },
      thinkingConfig:{ thinkingLevel:'low' }
    },
    inputAudioTranscription:{},
    outputAudioTranscription:{},
    realtimeInputConfig:{
      automaticActivityDetection:{
        disabled:false,
        startOfSpeechSensitivity:'START_SENSITIVITY_LOW',
        endOfSpeechSensitivity:'END_SENSITIVITY_LOW',
        prefixPaddingMs:120,
        silenceDurationMs:650
      }
    },
    sessionResumption:{},
    systemInstruction:{
      parts:[{ text:systemInstruction }]
    }
  };
  const now = Date.now();
  const upstream = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/auth_tokens',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-goog-api-key':apiKey
      },
      body:JSON.stringify({
        uses:1,
        expireTime:new Date(now + (30 * 60 * 1000)).toISOString(),
        newSessionExpireTime:new Date(now + (60 * 1000)).toISOString()
      })
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
    throw new PublicError(502, 'Gemini returned an invalid Live API token.');
  }

  const token = typeof data?.name === 'string' ? data.name : '';
  if(!token){
    throw new PublicError(502, 'Gemini returned no Live API token.');
  }

  return jsonResponse({
    token,
    model:GEMINI_LIVE_MODEL,
    voice,
    config:liveConfig,
    expiresAt:data.expireTime || new Date(now + (30 * 60 * 1000)).toISOString()
  }, 200, origin);
}

function createVoiceSystemInstruction(editorContext, language, hasIntroduced){
  const context = editorContext
    ? '\n\nCURRENT EDITOR CONTEXT:\n' + editorContext
    : '';
  const languageInstruction = language && language !== 'auto'
    ? ' Prefer spoken language ' + language + ' unless the user asks to switch.'
    : '';
  const introductionInstruction = hasIntroduced
    ? 'You have already introduced yourself in this chat. Do not introduce yourself again.'
    : (
      'On your first response after the user speaks, introduce yourself once with: ' +
      '"ONYX online. I can inspect your current code, build new features, modify ' +
      'the latest edit, debug problems, or recommend the strongest next upgrade." ' +
      'Then respond directly to what the user said. Do not repeat this introduction later.'
    );

  return [
    'You are ONYX, the advanced voice-powered coding architect embedded directly',
    'inside HTMLViewer.site. You are an elite senior developer, UI/UX strategist,',
    'debugging specialist, product advisor, and active coding partner—not a generic',
    'chatbot. Be calm, confident, friendly, direct, honest, and execution-focused.',
    'Speak naturally in short complete sentences suited to voice. Avoid filler, fake',
    'enthusiasm, repeated introductions, and long code recitations unless requested.',
    '',
    introductionInstruction,
    '',
    'Maintain awareness of the current editor code, selection, project, chat,',
    'attachments, diagnostics, preview mode, latest edit, and recent conversation',
    'whenever that context is supplied. Never pretend to see unavailable information.',
    'Treat the most recent edit as important: explain what changed, spot regressions,',
    'say what to test, and suggest the strongest one to three relevant next upgrades.',
    '',
    'Help the user build complete production-quality HTML, CSS, and JavaScript;',
    'create and modify components, pages, modals, forms, dashboards, animations, and',
    'interactions; debug root causes; improve responsive behavior, accessibility,',
    'performance, security, SEO, usability, validation, and maintainability. Preserve',
    'the existing design language, architecture, data, and unrelated working features.',
    'Offer decisive project-specific advice rather than generic lists. Ask only a',
    'focused question when a missing choice would materially change the result.',
    '',
    'When the user gives an actionable coding command, briefly acknowledge the exact',
    'request without claiming it is complete. The application will route the stabilized',
    'final transcript into the dedicated Gemini coding pipeline, which performs the',
    'actual code change. Never claim an edit was applied until that pipeline confirms it.',
    'When the user asks you to click, press, open, select, validate, download, or',
    'otherwise operate a named website control, acknowledge naturally; the application',
    'will resolve the exact visible button and execute it. Existing confirmation dialogs',
    'remain responsible for destructive actions, so never claim a deletion is confirmed.',
    '',
    'Protect the project. Never expose credentials, silently delete working features,',
    'overwrite saved work, invent test results, or hide limitations. Give concise',
    'spoken conclusions and useful next actions, not hidden reasoning.',
    languageInstruction,
    context
  ].join('\n');
}

async function classifyVoiceIntent(request, env, origin){
  const apiKey = requireSecret(env, 'GEMINI_API_KEY');
  const body = await readJson(request, 32 * 1024);
  const transcript = requireText(body.transcript, 'transcript', 12000);
  const context = typeof body.context === 'string'
    ? body.context.trim().slice(0, 12000)
    : '';
  const prompt = [
    'Classify this stabilized voice transcript for an HTML editor.',
    'UI_ACTION means the user is explicitly directing the app interface to click, press,',
    'open, select, validate, download, or activate a website or AI-editor control.',
    'Use a dedicated action for New Chat, Projects, Library, Chat History, Add Image,',
    'and Attach Code File. Use SEARCH_CODE when the user asks to find text in the code',
    'editor, with the search text in value. Use FILL_CONTROL when the user explicitly',
    'asks to enter a value in a named visible field, with its accessible name in target',
    'and the requested contents in value. Use SAVE_CODE when the user asks to save the',
    'current code with a specific name; put that name in value. Use SAVED_VERSION_ACTION',
    'only when the transcript explicitly says saved version or saved versions and asks',
    'to update, pin, unpin, delete, share, or add one to a project. Put the operation in',
    'target and the exact saved-version name in value. Never infer SAVED_VERSION_ACTION',
    'from an ambiguous reference to code. For every other control use CLICK_CONTROL and put its concise',
    'visible or accessible button name in target (for example Validate HTML, Download,',
    'Saved Codes, Community Presets, Settings, Format, Compress, or Live Preview).',
    'ACTIONABLE means the user is directing the coding model to create, edit, fix,',
    'replace, remove, debug, or otherwise change code or a project. If the user asks',
    'to click or use an existing Format, Compress, Validate, Download, Search, Save,',
    'or other interface button, classify it as UI_ACTION instead. CONVERSATIONAL means',
    'a question, explanation request, greeting,',
    'discussion, or clarification that should stay in the live conversation.',
    'Use meaning and context, not a single keyword. Return only JSON.',
    '',
    'Transcript:',
    transcript,
    context ? '\nEditor context:\n' + context : ''
  ].join('\n');
  const upstream = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      GEMINI_VOICE_INTENT_MODEL +
      ':generateContent',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-goog-api-key':apiKey
      },
      body:JSON.stringify({
        contents:[{ role:'user', parts:[{ text:prompt }] }],
        generationConfig:{
          temperature:0,
          responseMimeType:'application/json',
          responseSchema:{
            type:'OBJECT',
            properties:{
              intent:{ type:'STRING', enum:['UI_ACTION','ACTIONABLE','CONVERSATIONAL'] },
              action:{
                type:'STRING',
                enum:[
                  'NONE',
                  'NEW_CHAT',
                  'OPEN_PROJECTS',
                  'OPEN_LIBRARY',
                  'OPEN_CHAT_HISTORY',
                  'ADD_IMAGE',
                  'ATTACH_CODE_FILE',
                  'CLICK_CONTROL',
                  'SEARCH_CODE',
                  'FILL_CONTROL',
                  'SAVE_CODE',
                  'SAVED_VERSION_ACTION'
                ]
              },
              target:{ type:'STRING' },
              value:{ type:'STRING' },
              confidence:{ type:'NUMBER' },
              reason:{ type:'STRING' }
            },
            required:['intent','action','target','value','confidence']
          }
        }
      })
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
    data = JSON.parse(rawText);
  }catch(error){
    throw new PublicError(502, 'Gemini returned an invalid intent response.');
  }

  const classifierText = data?.candidates?.[0]?.content?.parts
    ?.map(part => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
  let result;
  try{
    result = JSON.parse(classifierText || '');
  }catch(error){
    throw new PublicError(502, 'Gemini returned an unreadable intent result.');
  }

  const intent = result.intent === 'ACTIONABLE'
    ? 'ACTIONABLE'
    : result.intent === 'UI_ACTION'
      ? 'UI_ACTION'
      : 'CONVERSATIONAL';
  const requestedAction = GEMINI_VOICE_UI_ACTIONS.has(result.action)
    ? result.action
    : null;
  const uiTarget = requestedAction === 'CLICK_CONTROL' &&
    typeof result.target === 'string'
    ? result.target.trim().slice(0, 120)
    : (
        requestedAction === 'FILL_CONTROL' ||
        requestedAction === 'SAVED_VERSION_ACTION'
      ) && typeof result.target === 'string'
      ? result.target.trim().slice(0, 120)
      : null;
  const uiValue = (
    requestedAction === 'SEARCH_CODE' ||
    requestedAction === 'FILL_CONTROL' ||
    requestedAction === 'SAVE_CODE' ||
    requestedAction === 'SAVED_VERSION_ACTION'
  ) && typeof result.value === 'string'
    ? result.value.slice(0, 4000)
    : null;
  const uiAction = intent === 'UI_ACTION' &&
    requestedAction &&
    (requestedAction !== 'CLICK_CONTROL' || uiTarget) &&
    (requestedAction !== 'SEARCH_CODE' || uiValue) &&
    (requestedAction !== 'FILL_CONTROL' || (uiTarget && uiValue !== null)) &&
    (requestedAction !== 'SAVE_CODE' || uiValue) &&
    (requestedAction !== 'SAVED_VERSION_ACTION' || (uiTarget && uiValue))
    ? requestedAction
    : null;
  const confidence = Number.isFinite(Number(result.confidence))
    ? Math.max(0, Math.min(1, Number(result.confidence)))
    : 0;

  return jsonResponse({
    actionable:intent === 'ACTIONABLE' && confidence >= 0.6,
    intent,
    uiAction,
    uiTarget,
    uiValue,
    confidence,
    reason:typeof result.reason === 'string'
      ? result.reason.slice(0, 240)
      : ''
  }, 200, origin);
}

async function getServiceStatus(env, origin, ctx){
  const cached = await readStatusCache();
  if(cached){
    return jsonResponse(cached, 200, origin, {
      'Cache-Control':'public, max-age=30',
      'X-Status-Cache':'HIT'
    });
  }

  const apiKey = requireSecret(env, 'UPTIMEROBOT_API_KEY');
  const responseApiKey = requireSecret(env, 'UPTIMEROBOT_RESPONSE_API_KEY');
  const to = new Date();
  const from = new Date(to.getTime() - (30 * 24 * 60 * 60 * 1000));
  const incidentQuery =
    '?started_after=' + encodeURIComponent(from.toISOString()) +
    '&started_before=' + encodeURIComponent(to.toISOString());
  const [monitorPayload, incidentResult] = await Promise.all([
    fetchUptimeRobotJson('/monitors?limit=10', apiKey),
    fetchIncidentSummary(incidentQuery, apiKey)
  ]);
  const rawMonitors = Array.isArray(monitorPayload?.data)
    ? monitorPayload.data.slice(0, 10)
    : [];
  const rawIncidents = Array.isArray(incidentResult.data)
    ? incidentResult.data
    : [];

  if(rawMonitors.length === 0){
    throw new PublicError(502, 'UptimeRobot returned no configured monitors.');
  }

  const query =
    '?from=' + encodeURIComponent(from.toISOString()) +
    '&to=' + encodeURIComponent(to.toISOString());
  const monitors = await Promise.all(rawMonitors.map(async monitor => {
    const id = Number(monitor?.id);
    if(!Number.isFinite(id)){
      return null;
    }

    const [uptime, responseStats] = await Promise.all([
      fetchUptimeRobotJson(
        '/monitors/' + encodeURIComponent(String(id)) + '/stats/uptime' + query,
        apiKey
      ),
      fetchResponseTimeStats(id, query, responseApiKey, apiKey)
    ]);
    const monitorIncidents = rawIncidents.filter(incident =>
      Number(incident?.monitor?.id) === id
    );
    const uptimeValue = clampNumber(uptime?.uptime, 0, 100, null);
    const responseAverage = clampNumber(
      responseStats?.summary?.avg,
      0,
      1000000,
      null
    );

    return {
      id,
      name:safePublicText(monitor?.friendlyName, 'Service', 100),
      url:safePublicUrl(monitor?.url),
      status:normalizeMonitorStatus(monitor?.status),
      uptime:uptimeValue,
      responseTime:responseAverage == null ? null : Math.round(responseAverage),
      responseTimeMin:roundNullable(responseStats?.summary?.min),
      responseTimeMax:roundNullable(responseStats?.summary?.max),
      responseDataPoints:Math.max(
        0,
        Math.round(Number(responseStats?.data_points) || 0)
      ),
      incidents:Math.max(0, Math.round(Number(uptime?.incident_count) || 0)),
      bars:buildStatusBars(
        responseStats?.time_series,
        responseAverage,
        monitor?.responseTimeThreshold,
        monitorIncidents,
        from,
        to
      )
    };
  }));
  const validMonitors = monitors.filter(Boolean);
  const incidents = rawIncidents
    .map(sanitizeIncident)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, 20);
  const allOperational = validMonitors.length > 0 &&
    validMonitors.every(monitor => monitor.status === 'up');
  const result = {
    allOperational,
    summary:allOperational
      ? 'All systems operational'
      : 'Some services need attention',
    checkedAt:new Date().toISOString(),
    source:'UptimeRobot API v3',
    period:{
      from:from.toISOString(),
      to:to.toISOString(),
      label:'Last 30 days'
    },
    monitorCount:validMonitors.length,
    monitors:validMonitors,
    incidentCount:incidents.length,
    activeIncidentCount:incidents.filter(incident => incident.status === 'ongoing').length,
    incidentsAvailable:incidentResult.available,
    incidents
  };

  await writeStatusCache(result, ctx);
  return jsonResponse(result, 200, origin, {
    'Cache-Control':'public, max-age=30',
    'X-Status-Cache':'MISS'
  });
}

async function fetchIncidentSummary(query, apiKey){
  try{
    const payload = await fetchUptimeRobotJson('/incidents' + query, apiKey);
    return {
      available:true,
      data:Array.isArray(payload?.data) ? payload.data : []
    };
  }catch(error){
    if(error instanceof PublicError){
      return { available:false, data:[] };
    }
    throw error;
  }
}

async function fetchResponseTimeStats(id, query, responseApiKey, fallbackApiKey){
  const path =
    '/monitors/' + encodeURIComponent(String(id)) +
    '/stats/response-time' + query + '&includeTimeSeries=true';

  try{
    return await fetchUptimeRobotJson(path, responseApiKey);
  }catch(error){
    if(
      responseApiKey !== fallbackApiKey &&
      error instanceof PublicError &&
      (error.status === 401 || error.status === 403)
    ){
      return await fetchUptimeRobotJson(path, fallbackApiKey);
    }
    throw error;
  }
}

async function fetchUptimeRobotJson(path, apiKey){
  const upstream = await fetch(UPTIMEROBOT_API_BASE + path, {
    method:'GET',
    headers:{
      Accept:'application/json',
      Authorization:'Bearer ' + apiKey
    }
  });
  const rawText = await upstream.text();

  if(!upstream.ok){
    throw new PublicError(
      normalizeUpstreamStatus(upstream.status),
      getUpstreamMessage(rawText, 'UptimeRobot rejected the status request.')
    );
  }

  try{
    return rawText ? JSON.parse(rawText) : {};
  }catch(error){
    throw new PublicError(502, 'UptimeRobot returned invalid status data.');
  }
}

function normalizeMonitorStatus(value){
  const status = String(value || '').toUpperCase();
  if(status === 'UP' || status === 'STARTED'){
    return 'up';
  }
  if(status === 'PAUSED'){
    return 'paused';
  }
  if(status === 'DOWN' || status === 'LOOKS_DOWN'){
    return 'down';
  }
  return 'unknown';
}

function buildStatusBars(
  timeSeries,
  averageResponse,
  configuredSlowThreshold,
  incidents,
  rangeFrom,
  rangeTo
){
  const buckets = Array.from({ length:30 }, () => []);
  const series = Array.isArray(timeSeries) ? timeSeries : [];
  const rangeStart = Date.parse(rangeFrom);
  const rangeEnd = Date.parse(rangeTo);
  const safeRangeStart = Number.isFinite(rangeStart)
    ? rangeStart
    : Date.now() - (30 * 24 * 60 * 60 * 1000);
  const safeRangeEnd = Number.isFinite(rangeEnd) && rangeEnd > safeRangeStart
    ? rangeEnd
    : Date.now();
  const bucketWidth = (safeRangeEnd - safeRangeStart) / buckets.length;

  series.forEach(point => {
    const time = Date.parse(point?.timestamp);
    const value = Number(point?.value);
    if(
      !Number.isFinite(time) ||
      !Number.isFinite(value) ||
      time < safeRangeStart ||
      time > safeRangeEnd
    ){
      return;
    }
    const index = Math.max(
      0,
      Math.min(29, Math.floor((time - safeRangeStart) / bucketWidth))
    );
    buckets[index].push(value);
  });

  const configuredThreshold = Number(configuredSlowThreshold);
  const slowThreshold = Number.isFinite(configuredThreshold) && configuredThreshold > 0
    ? configuredThreshold
    : Math.max(1200, Number(averageResponse || 0) * 1.8);
  const bars = buckets.map(values => {
    if(values.length === 0){
      return { state:'unknown', responseTime:null };
    }
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      state:avg >= slowThreshold ? 'slow' : 'up',
      responseTime:Math.round(avg)
    };
  });

  (Array.isArray(incidents) ? incidents : []).forEach(incident => {
    const incidentStart = Date.parse(incident?.startedAt);
    const parsedEnd = Date.parse(incident?.resolvedAt);
    const incidentEnd = Number.isFinite(parsedEnd) ? parsedEnd : safeRangeEnd;
    if(!Number.isFinite(incidentStart) || incidentEnd < safeRangeStart){
      return;
    }
    bars.forEach((bar, index) => {
      const bucketStart = safeRangeStart + (index * bucketWidth);
      const bucketEnd = bucketStart + bucketWidth;
      if(incidentStart < bucketEnd && incidentEnd >= bucketStart){
        bars[index] = { state:'down', responseTime:bar.responseTime };
      }
    });
  });
  return bars;
}

function clampNumber(value, min, max, fallback){
  if(value == null || value === ''){
    return fallback;
  }
  const number = Number(value);
  if(!Number.isFinite(number)){
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function roundNullable(value){
  const number = Number(value);
  return value == null || value === '' || !Number.isFinite(number)
    ? null
    : Math.round(number);
}

function sanitizeIncident(value){
  if(!value || typeof value !== 'object'){
    return null;
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const startedAt = normalizeIsoDate(value.startedAt);
  if(!id || !startedAt){
    return null;
  }
  const resolvedAt = normalizeIsoDate(value.resolvedAt);
  const rawStatus = String(value.status || '').trim().toUpperCase();
  const status = resolvedAt || rawStatus === 'RESOLVED'
    ? 'resolved'
    : 'ongoing';
  const duration = Number(value.duration);

  return {
    id:id.slice(0, 100),
    status,
    type:safePublicText(value.type, 'Incident', 80),
    reason:safePublicText(value.reason, 'Service interruption detected', 240),
    monitorId:Number.isFinite(Number(value.monitor?.id))
      ? Number(value.monitor.id)
      : null,
    monitorName:safePublicText(
      value.monitor?.friendlyName,
      'Monitored service',
      100
    ),
    startedAt,
    resolvedAt,
    duration:Number.isFinite(duration) && duration >= 0
      ? Math.round(duration)
      : null
  };
}

function normalizeIsoDate(value){
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safePublicText(value, fallback, maxLength){
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maxLength);
}

function safePublicUrl(value){
  try{
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol)
      ? url.toString().slice(0, 500)
      : '';
  }catch(error){
    return '';
  }
}

async function readStatusCache(){
  if(typeof caches === 'undefined' || !caches.default){
    return null;
  }

  try{
    const response = await caches.default.match(new Request(STATUS_CACHE_KEY));
    return response ? await response.json() : null;
  }catch(error){
    return null;
  }
}

async function writeStatusCache(data, ctx){
  if(typeof caches === 'undefined' || !caches.default){
    return;
  }

  const task = caches.default.put(
    new Request(STATUS_CACHE_KEY),
    new Response(JSON.stringify(data), {
      headers:{
        'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'public, max-age=' + UPTIMEROBOT_STATUS_CACHE_SECONDS
      }
    })
  ).catch(() => undefined);

  if(ctx && typeof ctx.waitUntil === 'function'){
    ctx.waitUntil(task);
  }else{
    await task;
  }
}

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

async function generateFluxImage(request, env, origin){
  if(!env.AI || typeof env.AI.run !== 'function'){
    throw new PublicError(503, 'Cloudflare Workers AI is not configured.');
  }

  const body = await readJson(request, 32 * 1024);
  const prompt = requireText(body.prompt, 'prompt', 4000);

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(FLUX_IMAGE_SIZE));
  form.append('height', String(FLUX_IMAGE_SIZE));
  const serializedForm = new Response(form);

  let result;
  try{
    result = await env.AI.run(FLUX_IMAGE_MODEL, {
      multipart:{
        body:serializedForm.body,
        contentType:serializedForm.headers.get('Content-Type')
      }
    });
  }catch(error){
    throw new PublicError(502, getWorkersAiMessage(error));
  }

  const imageBase64 = typeof result?.image === 'string' ? result.image : '';
  if(!imageBase64){
    throw new PublicError(502, 'Cloudflare Workers AI returned no image.');
  }

  let imageBytes;
  try{
    imageBytes = base64ToBytes(imageBase64);
  }catch(error){
    throw new PublicError(502, 'Cloudflare Workers AI returned an invalid image.');
  }

  const headers = responseHeaders(origin, {
    'Content-Type':detectImageContentType(imageBytes),
    'Content-Length':String(imageBytes.byteLength)
  });

  return new Response(imageBytes, { status:200, headers });
}

async function sendContactMessage(request, env, origin){
  const body = await readJson(request, MAX_FORM_BODY_BYTES);
  const name = requireText(body.name, 'name', 80);
  const message = requireText(body.message, 'message', 3000);
  const category = requireContactCategory(body.category);
  const payload = {
    username:'HTML Viewer Contact',
    allowed_mentions:{ parse:[] },
    embeds:[
      {
        title:'New Contact Message',
        description:message,
        color:3447003,
        fields:[
          { name:'Name', value:name, inline:true },
          { name:'Category', value:category, inline:true }
        ],
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

function requireContactCategory(value){
  const category = typeof value === 'string' ? value.trim() : 'General';
  const allowed = new Set(['General','Bug Report','Feature Request']);
  if(!allowed.has(category)){
    throw new PublicError(400, 'The contact category is not allowed.');
  }
  return category;
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

function getWorkersAiMessage(error){
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return message
    ? 'Cloudflare Workers AI could not generate the image: ' + message.slice(0, 400)
    : 'Cloudflare Workers AI could not generate the image.';
}

function base64ToBytes(value){
  const normalized = String(value).replace(/^data:image\/[^;]+;base64,/i, '');
  const binary = atob(normalized);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function detectImageContentType(bytes){
  if(bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47){
    return 'image/png';
  }
  if(bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff){
    return 'image/jpeg';
  }
  if(bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50){
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function normalizeUpstreamStatus(status){
  if(status === 400 || status === 401 || status === 403 || status === 404 || status === 429){
    return status;
  }
  return 502;
}

function responseHeaders(origin, additionalHeaders){
  const headers = new Headers(additionalHeaders || {});
  if(!headers.has('Cache-Control')){
    headers.set('Cache-Control', 'no-store');
  }
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

function jsonResponse(data, status, origin, additionalHeaders){
  const headers = responseHeaders(origin, {
    'Content-Type':'application/json; charset=utf-8',
    ...(additionalHeaders || {})
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

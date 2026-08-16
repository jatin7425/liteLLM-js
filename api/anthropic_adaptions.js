import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import axios from 'axios';

let cachedConfig = null;
let cachedPools = null;

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  
  if (process.env.LITELLM_CONFIG_JSON) {
    cachedConfig = JSON.parse(process.env.LITELLM_CONFIG_JSON);
    return cachedConfig;
  }
  
  try {
    const configPath = path.resolve(process.cwd(), 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    cachedConfig = yaml.load(raw);
    return cachedConfig;
  } catch (err) {
    throw new Error('Config loading failed: set LITELLM_CONFIG_JSON or commit config.yaml');
  }
}

function resolveApiKey(maybeEnv) {
  if (!maybeEnv) return null;
  if (typeof maybeEnv !== 'string') return maybeEnv;
  if (maybeEnv.startsWith('os.environ/')) {
    const varName = maybeEnv.replace(/^os\.environ\//, '');
    return process.env[varName] || null;
  }
  return maybeEnv;
}

function buildPools(cfg) {
  if (cachedPools) return cachedPools;
  
  const pools = {};
  const list = cfg.model_list || [];
  
  for (const entry of list) {
    const name = entry.model_name;
    if (!pools[name]) pools[name] = { items: [], rr: 0 };
    
    const params = entry.litellm_params || {};
    const apiKey = resolveApiKey(params.api_key);
    const apiBase = params.api_base || null;
    const rpm = params.rpm || null;
    
    pools[name].items.push({
      params,
      apiKey,
      apiBase,
      rpm,
      tokens: rpm || null,
      lastRefill: Date.now()
    });
  }
  
  cachedPools = pools;
  return pools;
}

function refillTokens(item) {
  if (!item.rpm) return;
  const now = Date.now();
  if (now - item.lastRefill >= 60000) {
    item.tokens = item.rpm;
    item.lastRefill = now;
  }
}

function pickProvider(pool) {
  if (!pool || pool.items.length === 0) return null;
  
  const n = pool.items.length;
  for (let i = 0; i < n; i++) {
    const idx = (pool.rr + i) % n;
    const item = pool.items[idx];
    
    refillTokens(item);
    if (item.tokens === null || item.tokens > 0) {
      pool.rr = (idx + 1) % n;
      if (item.tokens !== null) item.tokens -= 1;
      return { item, idx };
    }
  }
  
  return null;
}

function inferApiBaseFromModel(model) {
  if (!model) return null;
  if (model.startsWith('gemini/')) return 'https://generativelanguage.googleapis.com/v1beta/openai';
  if (model.startsWith('groq/')) return 'https://api.groq.com/openai/v1';
  if (model.startsWith('openrouter/')) return 'https://openrouter.ai/api/v1';
  if (model.startsWith('nvidia/') || model.includes('nvidia')) return 'https://integrate.api.nvidia.com/v1';
  if (model.includes('@cf/')) return null;
  return 'https://api.openai.com/v1';
}

function modelForUpstream(model) {
  // Remove provider prefix (e.g., "claude-3-5-sonnet-20241022")
  return model.replace(/^(claude|gemini|groq|openrouter|openai|nvidia)\//, '');
}

/**
 * Convert Anthropic request format to OpenAI-compatible format
 * Anthropic uses /v1/messages, OpenAI uses /v1/chat/completions
 */
function convertAnthropicToOpenAI(anthropicBody, model) {
  const messages = anthropicBody.messages || [];
  
  const convertedMessages = messages.map(msg => {
    if (msg.content && typeof msg.content === 'string') {
      return msg;
    }
    if (Array.isArray(msg.content)) {
      return {
        role: msg.role,
        content: msg.content
          .map(c => {
            if (c.type === 'text') {
              return {
                type: 'text',
                text: c.text
              };
            }

            if (c.type === 'image') {
              if (c.source?.type === 'base64') {
                return {
                  type: 'image_url',
                  image_url: {
                    url: `data:${c.source.media_type};base64,${c.source.data}`
                  }
                };
              }

              if (c.source?.type === 'url') {
                return {
                  type: 'image_url',
                  image_url: {
                    url: c.source.url
                  }
                };
              }

              return null;
            }

            return null;
          })
          .filter(Boolean)
      };
    }
    return msg;
  });

  // Convert tools if present
  let tools = undefined;
  if (anthropicBody.tools && Array.isArray(anthropicBody.tools)) {
    tools = anthropicBody.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || {}
      }
    }));
  }

  return {
    model: modelForUpstream(model),
    messages: convertedMessages,
    max_tokens: anthropicBody.max_tokens,
    temperature: anthropicBody.temperature,
    top_p: anthropicBody.top_p,
    stream: anthropicBody.stream || false,
    ...(tools ? { tools } : {}),  // Only include if present
    tool_choice: anthropicBody.tool_choice
  };
} 

/**
 * Convert OpenAI response format back to Anthropic format
 */
function convertOpenAIToAnthropic(openaiResponse, model) {
  if (!openaiResponse.choices || openaiResponse.choices.length === 0) {
    throw new Error('No choices in upstream response');
  }

  const choice = openaiResponse.choices[0];
  const content = [];

  // Convert OpenAI message to Anthropic format
  if (choice.message?.content) {
    content.push({
      type: 'text',
      text: choice.message.content
    });
  }

  if (choice.message?.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments || '{}')
      });
    }
  }

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0
    }
  };
}

export function convertOpenAIStreamChunkToAnthropicEvents(chunkText, model, messageId, state = {}) {
  const events = [];
  const rawText = typeof chunkText === 'string' ? chunkText : chunkText.toString();
  const lines = rawText.split('\n').map(line => line.trim()).filter(Boolean);
  const streamState = state;
  streamState.emittedStart ??= false;
  streamState.emittedContentStart ??= false;
  streamState.emittedContentStop ??= false;
  streamState.emittedMessageStop ??= false;

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;

    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (err) {
      continue;
    }

    const choice = payload.choices?.[0];
    if (!choice) continue;

    if (!streamState.emittedStart) {
      streamState.emittedStart = true;
      events.push({
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: payload.id || messageId || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0
            }
          }
        }
      });
    }

    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!streamState.emittedContentStart) {
        streamState.emittedContentStart = true;
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'text',
              text: ''
            }
          }
        });
      }

      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: delta.content
          }
        }
      });
    }

    if (choice.finish_reason) {
      const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
      if (streamState.emittedContentStart && !streamState.emittedContentStop) {
        streamState.emittedContentStop = true;
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: 0 }
        });
      }

      if (!streamState.emittedMessageStop) {
        streamState.emittedMessageStop = true;
        events.push({
          event: 'message_delta',
          data: {
            type: 'message_delta',
            delta: { stop_reason: stopReason },
            usage: { output_tokens: 0 }
          }
        });
        events.push({
          event: 'message_stop',
          data: { type: 'message_stop' }
        });
      }
    }
  }

  return { events, state: streamState };
}

async function forwardRequest(item, upstream, originalReq) {
  const modelName = originalReq.body?.model || originalReq.query?.model_name;
  const upstreamModel = item.params?.model || item.params?.model_name || modelName || 'openai/gpt-4o-mini';
  const base = upstream || inferApiBaseFromModel(upstreamModel) || 'https://api.openai.com/v1';
  const normalizedBase = base.replace(/\/$/, '');
  const url = `${normalizedBase}/chat/completions`;

  const headers = {
    'authorization': `Bearer ${item.apiKey}`,
    'content-type': 'application/json'
  };

  // Add Anthropic-specific headers if using Anthropic API
  if (item.apiBase?.includes('anthropic')) {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = item.apiKey;
    delete headers['authorization'];
  }

  console.log(`Forwarding request to ${url} with model ${upstreamModel} key ${item.apiKey}`);

  const openaiBody = convertAnthropicToOpenAI(originalReq.body, upstreamModel);

  try {
    const resp = await axios({
      url,
      method: 'POST',
      headers,
      data: openaiBody,
      maxBodyLength: Infinity,
      timeout: 25000,
      responseType: openaiBody.stream ? 'stream' : 'arraybuffer',
      validateStatus: () => true
    });

    console.log(`Forwarded request to ${url} with status ${resp}`);

    return resp;
  } catch (err) {
    throw new Error(`Forward request failed: ${err.message}`);
  }
}

export default async function handler(req, res) {
  // CORS headers
  console.log('Incoming request:', {
    method: req.method,
    url: req.url,
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
    model: req.body?.model,
    stream: req.body?.stream
  });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, X-Model-Name, Anthropic-Version'
  );
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // === Authentication ===
  try {
    const cfg = loadConfig();
    const masterKey = resolveApiKey(
      cfg.general_settings && cfg.general_settings.master_key
    );

    const cleanPath = req.url ? req.url.split('?')[0] : '';
    const isAllowlisted =
      cleanPath === '/health' ||
      cleanPath === '/api/hello' ||
      cleanPath === '/v1/api/hello' ||
      cleanPath.startsWith('/docs') ||
      cleanPath.startsWith('/anthropic');

    if (!isAllowlisted) {
      if (!masterKey) {
        return res.status(500).json({
          error: { message: 'server misconfigured: master_key not set' }
        });
      }

      const auth = req.headers['authorization'] || req.headers['Authorization'];
      const xApiKey = req.headers['x-api-key'] || req.headers['X-Api-Key'];
      const authToken = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
      const providedKey = authToken || xApiKey || null;

      console.log(`Auth header: ${auth}`);
      console.log(`X-API-Key header: ${xApiKey}`);

      if (!providedKey) {
        return res.status(401).json({
          error: { message: 'missing bearer token' }
        });
      }

      if (providedKey !== masterKey) {
        return res.status(403).json({
          error: { message: 'forbidden' }
        });
      }
    }
  } catch (err) {
    console.error('Auth check error:', err, req);
    return res.status(500).json({
      error: { message: 'auth setup error' }
    });
  }

  // === Main Handler ===
  try {
    const cfg = loadConfig();
    const pools = buildPools(cfg);

    if (req.url === '/health' || req.url === '/api/hello' || req.url === '/v1/api/hello') {
      return res.status(200).json({ ok: true, message: 'hello' });
    }

    if (req.url === '/anthropic/models') {
      return res.status(200).json({
        object: 'list',
        data: Object.keys(pools).map(name => ({
          id: name,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'anthropic'
        }))
      });
    }

    // === /v1/messages endpoint (Anthropic format) ===
    if (req.url?.startsWith('/v1/messages')) {
      const requestedModel = req.body?.model || req.query?.model;
      const modelName = Object.keys(pools).includes(requestedModel)
        ? requestedModel
        : 'nvidia';

      if (!requestedModel) {
        console.warn('No model provided for /v1/messages; defaulting to nvidia');
      }

      const pool = pools[modelName];
      if (!pool) {
        return res.status(404).json({
          error: {
            type: 'not_found_error',
            message: `Model '${modelName}' not found in pools`
          }
        });
      }

      const tried = [];
      let lastErr = null;

      for (let attempt = 0; attempt < pool.items.length; attempt++) {
        const pick = pickProvider(pool);
        if (!pick) break;

        const { item } = pick;
        console.log(`Forwarding /v1/messages request to upstream model: `, JSON.stringify(item, null, 2));
        const upstreamBase = item.apiBase || inferApiBaseFromModel(item.params?.model) || null;
        tried.push({ apiBase: upstreamBase });

        try {
          const resp = await forwardRequest(item, upstreamBase, req);
          console.log('Upstream response:', {
            status: resp.status,
            contentType: resp.headers?.['content-type'],
            dataType: typeof resp.data,
            isStream: typeof resp.data?.pipe === 'function'
          });

          if (resp.status >= 200 && resp.status < 500) {
            const rawText = typeof resp.data === 'string' ? resp.data : resp.data?.toString?.() || '';
            const parsed = rawText ? (() => { try { return JSON.parse(rawText); } catch { return null; } })() : null;

            if (parsed && !parsed.choices && parsed.error) {
              return res.status(resp.status).json({ error: parsed.error });
            }

            // Handle streaming
            if (typeof resp.data?.pipe === 'function') {
              res.status(resp.status);
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');

              let sawMessageStop = false;
              const streamMessageId = `msg_${Date.now()}`;
              const streamState = { emittedStart: false, emittedContentStart: false, emittedContentStop: false, emittedMessageStop: false };

              resp.data.on('data', chunk => {
                const result = convertOpenAIStreamChunkToAnthropicEvents(chunk, modelName, streamMessageId, streamState);
                for (const event of result.events) {
                  if (event.event === 'message_stop') sawMessageStop = true;
                  res.write(`event: ${event.event}\n`);
                  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
                }
              });

              resp.data.on('error', err => {
                console.error('Upstream stream failed:', err.message);
                res.destroy(err);
              });

              resp.data.on('end', () => {
                if (!sawMessageStop) {
                  res.write('event: message_stop\n');
                  res.write('data: {"type":"message_stop"}\n\n');
                }
                res.end();
              });

              return;
            }

            // Non-streaming response
            const parsedBody = parsed ?? JSON.parse(rawText || '{}');
            const anthropicResp = convertOpenAIToAnthropic(parsedBody, modelName);

            return res.status(resp.status).json(anthropicResp);
          }

          lastErr = new Error(`upstream ${resp.status}`);
        } catch (err) {
          lastErr = err;
          console.error(`Attempt ${attempt} failed:`, err.message);
        }
      }

      return res.status(502).json({
        error: {
          type: 'api_error',
          message: 'no healthy upstreams',
          tried,
          last_error: lastErr ? lastErr.message : null
        }
      });
    }

    // === Fallback ===
    res.status(404).json({
      error: { message: 'endpoint not found' }
    });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({
      error: { message: err.message }
    });
  }
}
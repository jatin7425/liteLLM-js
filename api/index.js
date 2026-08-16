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
    const varName = maybeEnv.split('/')[1];
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
  return model.replace(/^(gemini|groq|openrouter|openai|nvidia)\//, '');
}

function buildUpstreamBody(item, originalBody) {
  if (!originalBody || Array.isArray(originalBody) || typeof originalBody !== 'object') {
    return originalBody;
  }

  const body = { ...originalBody };
  if (item.params.model) {
    body.model = modelForUpstream(item.params.model);
  }
  delete body.model_name;
  return body;
}

async function forwardRequest(item, forwardPath, originalReq) {
  const base = item.apiBase || inferApiBaseFromModel(item.params.model) || 'https://api.openai.com/v1';
  const normalizedBase = base.replace(/\/$/, '');
  const normalizedPath = '/' + forwardPath.replace(/^\//, '');
  const url = normalizedBase.endsWith('/v1') && normalizedPath.startsWith('/v1/')
    ? normalizedBase + normalizedPath.slice(3)
    : normalizedBase + normalizedPath;
  
  const headers = { ...originalReq.headers };
  if (item.apiKey) {
    headers['authorization'] = `Bearer ${item.apiKey}`;
  }
  
  delete headers['host'];
  delete headers['connection'];
  delete headers['content-length'];
  const isMultipart = originalReq.headers['content-type']?.startsWith('multipart/form-data');
  const wantsStream = originalReq.body?.stream === true;
  
  try {
    const resp = await axios({
      url,
      method: originalReq.method,
      headers,
      // Multipart uploads are not parsed by Express, so preserve their stream.
      data: isMultipart ? originalReq : buildUpstreamBody(item, originalReq.body),
      maxBodyLength: Infinity,
      timeout: 25000,
      responseType: wantsStream ? 'stream' : 'arraybuffer',
      validateStatus: () => true
    });
    return resp;
  } catch (err) {
    throw new Error(`Forward request failed: ${err.message}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Model-Name');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Authorization: protect most routes with master_key bearer token
  try {
    const cfg = loadConfig();
    const masterKey = resolveApiKey(cfg.general_settings && cfg.general_settings.master_key);
    // allowlist: health, docs, and openai-prefixed paths
    const cleanPath = req.url ? req.url.split('?')[0] : '';
    const isAllowlisted = cleanPath === '/health' || cleanPath.startsWith('/docs') || cleanPath.startsWith('/openai');
    if (!isAllowlisted) {
      if (!masterKey) {
        return res.status(500).json({ error: 'server misconfigured: master_key not set' });
      }
      const auth = req.headers['authorization'] || req.headers['Authorization'];
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'missing bearer token' });
      }
      const token = auth.slice(7).trim();
      if (token !== masterKey) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
  } catch (err) {
    console.error('Auth check error:', err);
    return res.status(500).json({ error: 'auth setup error' });
  }

  try {
    const cfg = loadConfig();
    const pools = buildPools(cfg);

    if (req.url === '/health') {
      return res.status(200).json({ ok: true });
    }

    if (req.url === '/pools') {
      return res.status(200).json({ model_names: Object.keys(pools) });
    }

    const requestUrl = new URL(req.url, 'http://localhost');
    requestUrl.searchParams.delete('model_name');
    const forwardPath = (requestUrl.pathname.startsWith('/v1/')
      ? requestUrl.pathname
      : '/v1' + requestUrl.pathname) + requestUrl.search;
    const modelName = 
      req.query?.model_name || 
      req.headers['x-model-name'] || 
      req.body?.model_name;

    if (!modelName) {
      return res.status(400).json({ error: 'model_name required (query/header/body)' });
    }

    const pool = pools[modelName];
    if (!pool) {
      return res.status(404).json({ error: `no pool for model_name=${modelName}` });
    }

    const tried = [];
    let lastErr = null;

    for (let attempt = 0; attempt < pool.items.length; attempt++) {
      const pick = pickProvider(pool);
      if (!pick) break;

      const { item, idx } = pick;
      tried.push({ idx, apiBase: item.apiBase || null });

      try {
        const resp = await forwardRequest(item, forwardPath, req);
        
        if (resp.status >= 200 && resp.status < 500) {
          for (const h of Object.keys(resp.headers || {})) {
            if (['transfer-encoding', 'connection', 'content-encoding'].includes(h)) continue;
            res.setHeader(h, resp.headers[h]);
          }
          if (typeof resp.data?.pipe === 'function') {
            res.status(resp.status);
            resp.data.on('error', (err) => {
              console.error('Upstream stream failed:', err.message);
              res.destroy(err);
            });
            return resp.data.pipe(res);
          }
          return res.status(resp.status).send(resp.data);
        }
        
        lastErr = new Error(`upstream ${resp.status}`);
      } catch (err) {
        lastErr = err;
        console.error(`Attempt ${attempt} failed:`, err.message);
      }
    }

    res.status(502).json({
      error: 'no healthy upstreams',
      tried,
      last: lastErr ? lastErr.message : null
    });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

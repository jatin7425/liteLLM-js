# LiteLLM Proxy for Vercel

Multi-provider LLM proxy with load balancing and failover. Deploy on Vercel free tier.

## Features

✅ **Load balancing** across multiple API keys per provider  
✅ **Automatic failover** to next provider if one fails  
✅ **Rate limiting** per provider (RPM enforcement)  
✅ **CORS enabled** for browser requests  
✅ **Health checks** for monitoring  
✅ **Zero-cold-start** on warm invocations (config cached)  

## Supported Models

- **Gemini** (6 keys × 1 model)
- **Groq** (7 keys × 1 model + 7 keys × transcription)
- **AION** (8 keys × 1 model)
- **OpenRouter** (7 keys × Nemotron free tier)
- **NVIDIA NIM** (5 keys × 2 models each)
- **Cloudflare** (BGE-M3 embeddings)

## File Structure

```
litellm-proxy-vercel/
├── api/
│   └── index.js              ← Serverless handler
├── config.yaml               ← Model configuration (keep secret)
├── package.json              ← Dependencies
├── vercel.json               ← Vercel config
├── .env.example              ← Environment variables template
├── DEPLOY.md                 ← Step-by-step deployment guide
├── test-proxy.js             ← Test script
└── README.md                 ← This file
```

## Quick Start

### 1. Clone or Copy Files
```bash
git clone <your-repo> litellm-proxy-vercel
cd litellm-proxy-vercel
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Add Environment Variables

Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
# Edit .env.local and add your API keys
```

### 4. Test Locally
```bash
npm run dev
# Visit http://localhost:3000/health
```

### 5. Deploy to Vercel
```bash
npm i -g vercel
vercel link
npm run deploy
```

## API Usage

### Health Check
```bash
curl https://your-project.vercel.app/health
# {"ok":true}
```

### List Available Pools
```bash
curl https://your-project.vercel.app/pools
```

### Forward LLM Request
```bash
curl -X POST https://your-project.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Model-Name: groq" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}],
    "model": "groq/llama-3.3-70b-versatile"
  }'
```

**Pass model_name via:**
- Query: `?model_name=groq`
- Header: `X-Model-Name: groq`
- Body: `{"model_name": "groq", ...}`

## Use in Your Code

### Python
```python
import anthropic

client = anthropic.Anthropic(
    api_key="unused",
    base_url="https://your-project.vercel.app"
)

response = client.messages.create(
    model="groq",
    messages=[{"role": "user", "content": "Hello"}],
    max_tokens=100
)
```

### Node.js
```javascript
import axios from 'axios';

const response = await axios.post(
  'https://your-project.vercel.app/v1/chat/completions',
  {
    model: 'groq/llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100
  },
  {
    headers: {
      'X-Model-Name': 'groq'
    }
  }
);
```

### Claude Code / Anthropic-compatible clients
```bash
export ANTHROPIC_API_KEY=unused
export ANTHROPIC_BASE_URL=https://your-project.vercel.app
```

Anthropic-style clients can now call:
- `POST https://your-project.vercel.app/v1/messages`
- `GET https://your-project.vercel.app/anthropic/models`

Use `model` values like `groq`, `gemini`, or your configured pool name.

## Configuration

Edit `config.yaml` to:
- Add/remove model providers
- Adjust RPM limits
- Change API keys (use `os.environ/VAR_NAME` format)

## Environment Variables

All API keys are required as environment variables. See `.env.example` for the full list.

Set them in Vercel Dashboard → Settings → Environment Variables

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `config.yaml: ENOENT` | Commit to repo: `git add config.yaml && git push` |
| `undefined is not a valid bearer token` | Check env vars: `vercel env pull && cat .env.local` |
| `502 Bad Gateway` | Check logs: `vercel logs --follow` |
| Timeout errors | Increase `maxDuration` in `vercel.json` |

## Monitoring

```bash
# View logs
vercel logs --follow

# Check deployment
vercel deploy --confirm
```

## Rate Limiting

Each provider has an RPM (requests per minute) limit defined in `config.yaml`. The proxy enforces these limits per-invocation. For persistent rate limiting across instances, use Vercel KV or Upstash Redis.

## Costs

- **Vercel**: Free tier (~100 invocations/month, scales up to $0.50/invocation)
- **API Keys**: All providers use free tier keys (Groq, Gemini, OpenRouter, NVIDIA NIM)

## License

MIT

## Support

See `DEPLOY.md` for detailed deployment guide.
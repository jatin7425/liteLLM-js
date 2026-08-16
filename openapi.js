export default {
  openapi: '3.0.3',
  info: {
    title: 'LiteLLM Proxy API',
    version: '1.0.0',
    description: 'Multi-provider LLM proxy with provider selection through model_name.'
  },
  servers: [{ url: '/' }],
  security: [
    {
      bearerAuth: []
    }
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Health check',
        security: [],
        responses: { 200: { description: 'Proxy is available' } }
      }
    },
    '/pools': {
      get: {
        security: [],
        summary: 'List provider pools',
        responses: { 200: { description: 'Configured pool names' } }
      }
    },
    '/v1/chat/completions': {
      post: {
        summary: 'Create a chat completion',
        description: 'Set stream to true to receive server-sent event chunks.',
        parameters: [{ $ref: '#/components/parameters/ModelName' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } }
        },
        responses: {
          200: { description: 'Chat completion or server-sent event stream' },
          400: { description: 'Invalid request' },
          404: { description: 'Unknown provider pool' },
          502: { description: 'No healthy provider available' }
        }
      }
    },
    '/v1/embeddings': {
      post: {
        summary: 'Create embeddings',
        parameters: [{ $ref: '#/components/parameters/ModelName' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/EmbeddingRequest' } } }
        },
        responses: { 200: { description: 'Embedding response' } }
      }
    },
    '/v1/audio/transcriptions': {
      post: {
        summary: 'Transcribe audio with Groq',
        parameters: [{ $ref: '#/components/parameters/ModelName' }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  model: { type: 'string', example: 'whisper-large-v3-turbo' }
                }
              }
            }
          }
        },
        responses: { 200: { description: 'Transcription response' } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Token',
        description: 'Provide the master key as `Bearer <token>` for protected routes.'
      }
    },
    parameters: {
      ModelName: {
        name: 'model_name',
        in: 'query',
        required: true,
        schema: {
          type: 'string',
          enum: ['gemini', 'groq', 'aion-2.0', 'openrouter', 'nvidia', 'embed-gemini', 'embed-cloudflare', 'transcribe-groq']
        },
        description: 'Configured provider pool to route the request to.'
      }
    },
    schemas: {
      ChatRequest: {
        type: 'object',
        required: ['messages'],
        properties: {
          messages: {
            type: 'array',
            example: [{ role: 'user', content: 'Hello' }],
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['user', 'system', 'assistant'], example: 'user' },
                content: { type: 'string', example: 'Hello' }
              }
            }
          },
          stream: { type: 'boolean', default: false, example: false },
          max_tokens: { type: 'integer', minimum: 1, example: 256 }
        }
      },
      EmbeddingRequest: {
        type: 'object',
        required: ['input'],
        properties: {
          input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          encoding_format: { type: 'string', enum: ['float', 'base64'], default: 'float' }
        }
      }
    }
  }
};

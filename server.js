import express from 'express';
import morgan from 'morgan';
import handler from './api/index.js';
import openapi from './openapi.js';

const app = express();
const port = Number(process.env.PROXY_PORT || 3001);

app.use(morgan('dev'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.get('/openapi.json', (_req, res) => res.json(openapi));
app.get(['/docs', '/docs/'], (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>LiteLLM Proxy API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true, persistAuthorization: true });</script>
  </body>
</html>`);
});
app.all('*', handler);

app.listen(port, () => {
  console.log(`LiteLLM proxy listening at http://localhost:${port}`);
});

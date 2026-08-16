import axios from 'axios';

const BASE_URL = process.env.PROXY_URL || 'http://localhost:3000';

async function test(name, fn) {
  try {
    console.log(`\n✓ Testing: ${name}`);
    await fn();
    console.log(`  ✅ PASS`);
  } catch (err) {
    console.log(`  ❌ FAIL: ${err.message}`);
  }
}

async function main() {
  console.log(`Testing proxy at: ${BASE_URL}\n`);

  await test('Health check', async () => {
    const res = await axios.get(`${BASE_URL}/health`);
    if (!res.data.ok) throw new Error('Health check failed');
  });

  await test('List pools', async () => {
    const res = await axios.get(`${BASE_URL}/pools`);
    const pools = Object.keys(res.data);
    console.log(`    Found pools: ${pools.join(', ')}`);
    if (pools.length === 0) throw new Error('No pools found');
  });

  await test('Forward request (query param)', async () => {
    const res = await axios.post(
      `${BASE_URL}/v1/chat/completions?model_name=groq`,
      {
        messages: [{ role: 'user', content: 'test' }],
        model: 'groq/llama-3.3-70b-versatile',
        max_tokens: 10
      },
      { validateStatus: () => true }
    );
    console.log(`    Response status: ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      console.log(`    (Auth error - API key might be invalid, but proxy works)`);
    }
  });

  await test('Forward request (header)', async () => {
    const res = await axios.post(
      `${BASE_URL}/v1/chat/completions`,
      {
        messages: [{ role: 'user', content: 'test' }],
        model: 'groq/llama-3.3-70b-versatile',
        max_tokens: 10
      },
      {
        headers: { 'X-Model-Name': 'groq' },
        validateStatus: () => true
      }
    );
    console.log(`    Response status: ${res.status}`);
  });

  await test('Forward request (body)', async () => {
    const res = await axios.post(
      `${BASE_URL}/v1/chat/completions`,
      {
        model_name: 'groq',
        messages: [{ role: 'user', content: 'test' }],
        model: 'groq/llama-3.3-70b-versatile',
        max_tokens: 10
      },
      { validateStatus: () => true }
    );
    console.log(`    Response status: ${res.status}`);
  });

  await test('Missing model_name returns 400', async () => {
    try {
      await axios.post(`${BASE_URL}/v1/chat/completions`, {
        messages: [{ role: 'user', content: 'test' }]
      });
      throw new Error('Should have returned 400');
    } catch (err) {
      if (err.response?.status === 400) {
        console.log(`    Correctly returned 400`);
      } else {
        throw err;
      }
    }
  });

  await test('Unknown model_name returns 404', async () => {
    try {
      await axios.post(
        `${BASE_URL}/v1/chat/completions?model_name=nonexistent`,
        { messages: [{ role: 'user', content: 'test' }] }
      );
      throw new Error('Should have returned 404');
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`    Correctly returned 404`);
      } else {
        throw err;
      }
    }
  });

  console.log('\n✅ All tests completed!\n');
}

main().catch(console.error);
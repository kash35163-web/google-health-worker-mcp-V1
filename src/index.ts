import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { guardMiddleware } from './auth/guard';
import type { Env } from './env';
import { GoogleHealthProvider } from './providers/google';
import { buildServer } from './server';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('fitbit-googlehealth-mcp — see /health and POST /mcp/:secret'));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'fitbit-googlehealth-mcp',
    mcpProtocolVersion: '2025-06-18',
  }),
);

app.get('/api/daily-summary', async (c) => {
  const secret = c.req.query('secret');

  if (secret !== c.env.MCP_SHARED_SECRET) {
    return c.json(
      {
        error: 'unauthorized',
      },
      401,
    );
  }

  const date = c.req.query('date');

  if (!date) {
    return c.json(
      {
        error: 'missing_date',
        message: 'Use ?date=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  try {
    const summary = await provider.getDailySummary(date);
    return c.json(summary);
  } catch (error) {
    console.error(
      '[daily-summary]',
      error instanceof Error ? error.message : String(error),
    );

    return c.json(
      {
        error: 'daily_summary_failed',
      },
      500,
    );
  }
});

app.post('/mcp/:secret', guardMiddleware(), async (c) => {
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.text('', 200);
});

export default app;

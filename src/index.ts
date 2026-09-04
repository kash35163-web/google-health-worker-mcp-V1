import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { guardMiddleware } from './auth/guard';
import type { Env } from './env';
import { GoogleHealthProvider } from './providers/google';
import { ActivityResource, IntradayDetailLevel } from './providers/types';
import { buildServer } from './server';

const app = new Hono<{ Bindings: Env }>();

// ---------- Basic routes ----------

app.get('/', (c) => c.text('fitbit-googlehealth-mcp — see /health and /api/*'));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'fitbit-googlehealth-mcp',
    mcpProtocolVersion: '2025-06-18',
  }),
);

// ---------- Shared API authentication ----------

app.use('/api/*', async (c, next) => {
  const authorization = c.req.header('Authorization');
  const expectedAuthorization = `Bearer ${c.env.MCP_SHARED_SECRET}`;

  if (authorization !== expectedAuthorization) {
    return c.json(
      {
        error: 'unauthorized',
      },
      401,
    );
  }

  await next();
});

// ---------- Shared validation helpers ----------

function isIsoDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date.toISOString().slice(0, 10) === value;
}

function validDateRange(start: string, end: string): boolean {
  return isIsoDate(start) && isIsoDate(end) && start <= end;
}

// ---------- Global API error handling ----------

app.onError((error, c) => {
  console.error('[api]', error instanceof Error ? error.message : String(error));

  return c.json(
    {
      error: 'health_api_request_failed',
    },
    500,
  );
});

// ---------- Profile ----------

app.get('/api/profile', async (c) => {
  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getProfile());
});

// ---------- Daily summary ----------

app.get('/api/daily-summary', async (c) => {
  const date = c.req.query('date');

  if (!isIsoDate(date)) {
    return c.json(
      {
        error: 'invalid_date',
        message: 'Use ?date=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getDailySummary(date));
});

// ---------- Activity ----------

app.get('/api/activity', async (c) => {
  const resourceResult = ActivityResource.safeParse(c.req.query('resource'));
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!resourceResult.success) {
    return c.json(
      {
        error: 'invalid_resource',
        allowed: ActivityResource.options,
      },
      400,
    );
  }

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?resource=steps&start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);

  return c.json(await provider.getActivityTimeSeries(resourceResult.data, start, end));
});

// ---------- Exercise ----------

app.get('/api/exercise', async (c) => {
  const beforeDate = c.req.query('beforeDate');
  const limitRaw = c.req.query('limit');

  if (beforeDate !== undefined && !isIsoDate(beforeDate)) {
    return c.json(
      {
        error: 'invalid_date',
        message: 'beforeDate must use YYYY-MM-DD',
      },
      400,
    );
  }

  let limit: number | undefined;

  if (limitRaw !== undefined) {
    limit = Number(limitRaw);

    if (!Number.isInteger(limit) || limit <= 0) {
      return c.json(
        {
          error: 'invalid_limit',
          message: 'limit must be a positive integer',
        },
        400,
      );
    }
  }

  const provider = new GoogleHealthProvider(c.env);

  return c.json(
    await provider.getExerciseList({
      beforeDate,
      limit,
    }),
  );
});

// ---------- Heart rate ----------

app.get('/api/heart-rate', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getHeartRateRange(start, end));
});

// ---------- Heart rate intraday ----------

app.get('/api/heart-rate-intraday', async (c) => {
  const date = c.req.query('date');
  const detailResult = IntradayDetailLevel.safeParse(c.req.query('detail') ?? '1min');

  if (!isIsoDate(date)) {
    return c.json(
      {
        error: 'invalid_date',
        message: 'Use ?date=YYYY-MM-DD&detail=1min',
      },
      400,
    );
  }

  if (!detailResult.success) {
    return c.json(
      {
        error: 'invalid_detail',
        allowed: IntradayDetailLevel.options,
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);

  return c.json(await provider.getHeartRateIntraday(date, detailResult.data));
});

// ---------- Sleep ----------

app.get('/api/sleep', async (c) => {
  const date = c.req.query('date');

  if (!isIsoDate(date)) {
    return c.json(
      {
        error: 'invalid_date',
        message: 'Use ?date=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getSleep(date));
});

app.get('/api/sleep-range', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getSleepRange(start, end));
});

// ---------- Body ----------

app.get('/api/body', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getBodyLog(start, end));
});

// ---------- Food ----------

app.get('/api/food', async (c) => {
  const date = c.req.query('date');

  if (!isIsoDate(date)) {
    return c.json(
      {
        error: 'invalid_date',
        message: 'Use ?date=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getFoodLog(date));
});

// ---------- HRV ----------

app.get('/api/hrv', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getHRV(start, end));
});

// ---------- SpO2 ----------

app.get('/api/spo2', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getSpO2(start, end));
});

// ---------- Respiratory rate ----------

app.get('/api/respiratory-rate', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getRespiratoryRate(start, end));
});

// ---------- Skin temperature ----------

app.get('/api/skin-temperature', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(
      {
        error: 'invalid_date_range',
        message: 'Use ?start=YYYY-MM-DD&end=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getSkinTemperature(start, end));
});

// ---------- Cardio fitness ----------

app.get('/api/cardio-fitness', async (c) => {
  const date = c.req.query('date');

  if (!isIsoDate(date)) {
    return c.json(
      {
        error: 'invalid_date',
        message: 'Use ?date=YYYY-MM-DD',
      },
      400,
    );
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getCardioFitness(date));
});

// ---------- Existing MCP endpoint ----------

app.post('/mcp/:secret', guardMiddleware(), async (c) => {
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport();

  await server.connect(transport);

  const response = await transport.handleRequest(c);

  return response ?? c.text('', 200);
});

export default app;

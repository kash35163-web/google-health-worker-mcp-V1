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

function invalidDateResponse() {
  return {
    error: 'invalid_date',
    message: 'Use YYYY-MM-DD',
  };
}

function invalidDateRangeResponse() {
  return {
    error: 'invalid_date_range',
    message: 'Use start=YYYY-MM-DD&end=YYYY-MM-DD',
  };
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

// ---------- Unified query endpoint ----------

app.get('/api/query', async (c) => {
  const type = c.req.query('type');
  const provider = new GoogleHealthProvider(c.env);

  switch (type) {
    case 'profile':
      return c.json(await provider.getProfile());

    case 'daily-summary': {
      const date = c.req.query('date');

      if (!isIsoDate(date)) {
        return c.json(invalidDateResponse(), 400);
      }

      return c.json(await provider.getDailySummary(date));
    }

    case 'sleep': {
      const date = c.req.query('date');

      if (!isIsoDate(date)) {
        return c.json(invalidDateResponse(), 400);
      }

      return c.json(await provider.getSleep(date));
    }

    case 'sleep-range': {
      const start = c.req.query('start');
      const end = c.req.query('end');

      if (!start || !end || !validDateRange(start, end)) {
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getSleepRange(start, end));
    }

    case 'heart-rate': {
      const start = c.req.query('start');
      const end = c.req.query('end');

      if (!start || !end || !validDateRange(start, end)) {
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getHeartRateRange(start, end));
    }

    case 'heart-rate-intraday': {
      const date = c.req.query('date');
      const detailResult = IntradayDetailLevel.safeParse(c.req.query('detail') ?? '1min');

      if (!isIsoDate(date)) {
        return c.json(invalidDateResponse(), 400);
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

      return c.json(await provider.getHeartRateIntraday(date, detailResult.data));
    }

    case 'hrv': {
      const start = c.req.query('start');
      const end = c.req.query('end');

      if (!start || !end || !validDateRange(start, end)) {
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getHRV(start, end));
    }

    case 'spo2': {
      const start = c.req.query('start');
      const end = c.req.query('end');

      if (!start || !end || !validDateRange(start, end)) {
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getSpO2(start, end));
    }

    case 'respiratory-rate': {
      const start = c.req.query('start');
      const end = c.req.query('end');

      if (!start || !end || !validDateRange(start, end)) {
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getRespiratoryRate(start, end));
    }

    case 'skin-temperature': {
      const start = c.req.query('start');
      const end = c.req.query('end');

      if (!start || !end || !validDateRange(start, end)) {
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getSkinTemperature(start, end));
    }

    case 'cardio-fitness': {
      const date = c.req.query('date');

      if (!isIsoDate(date)) {
        return c.json(invalidDateResponse(), 400);
      }

      return c.json(await provider.getCardioFitness(date));
    }

    case 'body': {
      const start = c.req.query('start');
      const end = c.req.query('end');

      if (!start || !end || !validDateRange(start, end)) {
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getBodyLog(start, end));
    }

    case 'food': {
      const date = c.req.query('date');

      if (!isIsoDate(date)) {
        return c.json(invalidDateResponse(), 400);
      }

      return c.json(await provider.getFoodLog(date));
    }

    case 'exercise': {
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

      return c.json(
        await provider.getExerciseList({
          beforeDate,
          limit,
        }),
      );
    }

    case 'activity': {
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
        return c.json(invalidDateRangeResponse(), 400);
      }

      return c.json(await provider.getActivityTimeSeries(resourceResult.data, start, end));
    }

    default:
      return c.json(
        {
          error: 'invalid_type',
          allowed: [
            'profile',
            'daily-summary',
            'sleep',
            'sleep-range',
            'heart-rate',
            'heart-rate-intraday',
            'hrv',
            'spo2',
            'respiratory-rate',
            'skin-temperature',
            'cardio-fitness',
            'body',
            'food',
            'exercise',
            'activity',
          ],
        },
        400,
      );
  }
});

// ---------- Existing dedicated routes ----------

app.get('/api/profile', async (c) => {
  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getProfile());
});

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
    return c.json(invalidDateRangeResponse(), 400);
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getSleepRange(start, end));
});

app.get('/api/body', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(invalidDateRangeResponse(), 400);
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getBodyLog(start, end));
});

app.get('/api/food', async (c) => {
  const date = c.req.query('date');

  if (!isIsoDate(date)) {
    return c.json(invalidDateResponse(), 400);
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getFoodLog(date));
});

app.get('/api/hrv', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(invalidDateRangeResponse(), 400);
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getHRV(start, end));
});

app.get('/api/spo2', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(invalidDateRangeResponse(), 400);
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getSpO2(start, end));
});

app.get('/api/respiratory-rate', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(invalidDateRangeResponse(), 400);
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getRespiratoryRate(start, end));
});

app.get('/api/skin-temperature', async (c) => {
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!start || !end || !validDateRange(start, end)) {
    return c.json(invalidDateRangeResponse(), 400);
  }

  const provider = new GoogleHealthProvider(c.env);
  return c.json(await provider.getSkinTemperature(start, end));
});

app.get('/api/cardio-fitness', async (c) => {
  const date = c.req.query('date');

  if (!isIsoDate(date)) {
    return c.json(invalidDateResponse(), 400);
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

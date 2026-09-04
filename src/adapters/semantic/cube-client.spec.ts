import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import { CubeClient, type CubeQuery } from './cube-client';
import type { SemanticConfig } from './semantic-config';

const CONFIG: SemanticConfig = {
  url: 'http://cube:4000',
  secret: 'a-secret-of-at-least-thirty-two-characters',
  questionTimeoutMs: 30_000,
};

const A_QUESTION: CubeQuery = {
  measures: ['movements.net_quantity'],
  dimensions: ['movements.kind'],
};

const CONTEXT = 'a.signed.context';

/** A response the way `fetch` hands one over. */
function responded(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONTINUE_WAIT = () => responded(200, { error: 'Continue wait' });
const ANSWERED = () =>
  responded(200, {
    data: [{ 'movements.net_quantity': '12' }],
    external: true,
  });

/** Answers with each response in turn, and records what it was asked. */
function replying(...responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let next = 0;

  const fetching = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const respond = responses[Math.min(next, responses.length - 1)];
    next += 1;
    return Promise.resolve(respond());
  };

  return { fetching, calls };
}

function clientOver(
  fetching: (url: string, init: RequestInit) => Promise<Response>,
  config: SemanticConfig = CONFIG,
): CubeClient {
  return new CubeClient(config, { fetching, waiting: () => Promise.resolve() });
}

async function refusalFrom(
  load: Promise<unknown>,
): Promise<AnalyticsUnavailable> {
  try {
    await load;
  } catch (error) {
    if (error instanceof AnalyticsUnavailable) {
      return error;
    }
    throw error;
  }

  throw new Error('expected the load to be refused, and it was not');
}

describe('reaching the semantic layer', () => {
  it('asks the load endpoint, carrying the signed context and the question', async () => {
    const { fetching, calls } = replying(ANSWERED);

    await clientOver(fetching).load({ query: A_QUESTION, context: CONTEXT });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://cube:4000/cubejs-api/v1/load');
    expect(calls[0].init.method).toBe('POST');
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe(CONTEXT);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      query: A_QUESTION,
    });
  });

  it('returns the rows, and whether the answer came from the store', async () => {
    const answer = await clientOver(replying(ANSWERED).fetching).load({
      query: A_QUESTION,
      context: CONTEXT,
    });

    expect(answer.data).toEqual([{ 'movements.net_quantity': '12' }]);
    expect(answer.servedFromStore).toBe(true);
  });

  it('waits out a still-working answer rather than reporting an empty one', async () => {
    const { fetching, calls } = replying(
      CONTINUE_WAIT,
      CONTINUE_WAIT,
      ANSWERED,
    );

    const answer = await clientOver(fetching).load({
      query: A_QUESTION,
      context: CONTEXT,
    });

    expect(calls).toHaveLength(3);
    expect(answer.data).toHaveLength(1);
  });

  it('refuses when the deadline passes, rather than waiting forever', async () => {
    const { fetching, calls } = replying(CONTINUE_WAIT);

    const refusal = await refusalFrom(
      clientOver(fetching, { ...CONFIG, questionTimeoutMs: 0 }).load({
        query: A_QUESTION,
        context: CONTEXT,
      }),
    );

    expect(refusal.reason).toBe('question-timed-out');
    expect(calls.length).toBeLessThan(50);
  });

  it('reports a service that is not there as unreachable', async () => {
    const refusal = await refusalFrom(
      clientOver(() =>
        Promise.reject(new Error('connect ECONNREFUSED 172.22.0.4:4000')),
      ).load({ query: A_QUESTION, context: CONTEXT }),
    );

    expect(refusal.reason).toBe('model-unreachable');
  });

  it('reports a service that answered with an error as rejected', async () => {
    for (const response of [
      () => responded(400, { error: "Query param isn't set" }),
      () => responded(403, { error: "Authorization header isn't set" }),
      () => responded(500, { error: 'Internal Server Error' }),
      () => responded(200, { error: 'Compile errors: unknown member' }),
    ]) {
      const refusal = await refusalFrom(
        clientOver(replying(response).fetching).load({
          query: A_QUESTION,
          context: CONTEXT,
        }),
      );

      expect(refusal.reason).toBe('model-rejected');
    }
  });

  /**
   * A query layer's error body routinely carries the statement it generated,
   * and the address of the thing it read. Neither may reach a message that a
   * caller could ever be shown; both belong in `cause`, which the log reads.
   */
  it('keeps the statement and the address out of what it says', async () => {
    const leaky =
      'Compile errors: SELECT tenant_id FROM movements at http://cube:4000';

    const refusal = await refusalFrom(
      clientOver(
        replying(() => responded(400, { error: leaky })).fetching,
      ).load({ query: A_QUESTION, context: CONTEXT }),
    );

    expect(refusal.message).not.toContain('SELECT');
    expect(refusal.message).not.toContain('cube:4000');
    // What an operator reads in a log, which is the only place it may appear.
    expect((refusal.cause as Error).message).toContain('SELECT');
    expect((refusal.cause as Error).message).toContain('cube:4000');
  });

  it('never asks twice for a question that was refused', async () => {
    const { fetching, calls } = replying(() =>
      responded(400, { error: 'no such member' }),
    );

    await refusalFrom(
      clientOver(fetching).load({ query: A_QUESTION, context: CONTEXT }),
    );

    expect(calls).toHaveLength(1);
  });

  it('carries a deadline into the request itself, not only around it', async () => {
    const { fetching, calls } = replying(ANSWERED);

    await clientOver(fetching).load({ query: A_QUESTION, context: CONTEXT });

    expect(calls[0].init.signal).toBeDefined();
  });
});

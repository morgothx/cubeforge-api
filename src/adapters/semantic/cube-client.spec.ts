import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import { DomainViolation } from '../../domain/errors';
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
    lastRefreshTime: '2026-03-29T10:00:00.000Z',
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

/** The refusal a load produced, when it is one about the question. */
async function violationFrom(load: Promise<unknown>): Promise<DomainViolation> {
  try {
    await load;
  } catch (error) {
    if (error instanceof DomainViolation) {
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

  it('carries the moment the layer says the data was refreshed', async () => {
    const answer = await clientOver(replying(ANSWERED).fetching).load({
      query: A_QUESTION,
      context: CONTEXT,
    });

    expect(answer.refreshedAt).toEqual(new Date('2026-03-29T10:00:00.000Z'));
  });

  /**
   * Absent is not "now". A layer that said nothing about freshness has told the
   * caller nothing, and inventing a moment here would let an answer look as
   * current as the instant it was asked for.
   */
  it('reports no refresh moment when the layer did not state one', async () => {
    for (const body of [{ data: [] }, { data: [], lastRefreshTime: 'soon' }]) {
      const answer = await clientOver(
        replying(() => responded(200, body)).fetching,
      ).load({ query: A_QUESTION, context: CONTEXT });

      expect(answer.refreshedAt).toBeNull();
    }
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

  /**
   * The engine answered, and what came back could not be read as an answer at
   * all. That is this platform's problem or the engine's, never the caller's
   * question — and it is a different thing to look at than a refused query.
   */
  it('reports an answer it cannot read as unreadable', async () => {
    const refusal = await refusalFrom(
      clientOver(
        replying(
          () =>
            new Response('not json at all', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ).fetching,
      ).load({ query: A_QUESTION, context: CONTEXT }),
    );

    expect(refusal.reason).toBe('model-unreadable');
  });

  it('reports a service that is not there as unreachable', async () => {
    const refusal = await refusalFrom(
      clientOver(() =>
        Promise.reject(new Error('connect ECONNREFUSED 172.22.0.4:4000')),
      ).load({ query: A_QUESTION, context: CONTEXT }),
    );

    expect(refusal.reason).toBe('model-unreachable');
  });

  /**
   * The engine looked at what it was sent and would not run it. That is a fact
   * about the question, not about the service — it will be refused identically
   * for as long as the question stands, so reporting it as an outage invites a
   * retry that cannot succeed.
   *
   * Classified by **status**, never by what the error says. Matching an
   * engine's wording is how a rephrased library message silently turns one
   * kind of failure into another.
   */
  it('reports a query the engine would not run as a question nobody can answer', async () => {
    for (const response of [
      () => responded(400, { error: "Query param isn't set" }),
      () => responded(422, { error: 'Compile errors: unknown member' }),
      () => responded(200, { error: 'Compile errors: unknown member' }),
    ]) {
      const refused = await violationFrom(
        clientOver(replying(response).fetching).load({
          query: A_QUESTION,
          context: CONTEXT,
        }),
      );

      expect(refused.error).toEqual({ kind: 'unanswerable' });
    }
  });

  /**
   * Neither of these is the caller's question. A refused credential is the
   * context this platform signed, and a `500` is the engine failing — both are
   * ours to fix, and both leave the analytics genuinely unavailable.
   */
  it('reports a refused credential and an engine failure as unavailable', async () => {
    for (const response of [
      () => responded(401, { error: "Authorization header isn't set" }),
      () => responded(403, { error: 'Forbidden' }),
      () => responded(500, { error: 'Internal Server Error' }),
      () => responded(503, { error: 'Service Unavailable' }),
    ]) {
      const refusal = await refusalFrom(
        clientOver(replying(response).fetching).load({
          query: A_QUESTION,
          context: CONTEXT,
        }),
      );

      expect(refusal).toBeInstanceOf(AnalyticsUnavailable);
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

    const refused = await violationFrom(
      clientOver(
        replying(() => responded(400, { error: leaky })).fetching,
      ).load({ query: A_QUESTION, context: CONTEXT }),
    );

    expect(refused.message).not.toContain('SELECT');
    expect(refused.message).not.toContain('cube:4000');
    expect(JSON.stringify(refused.error)).not.toContain('SELECT');
    // What an operator reads in a log, which is the only place it may appear.
    expect((refused.cause as Error).message).toContain('SELECT');
    expect((refused.cause as Error).message).toContain('cube:4000');
  });

  it('never asks twice for a question that was refused', async () => {
    const { fetching, calls } = replying(() =>
      responded(400, { error: 'no such member' }),
    );

    // The refusal is about the question now rather than about the service, and
    // the claim that matters is unchanged: a query the engine would not run is
    // not run again.
    await violationFrom(
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

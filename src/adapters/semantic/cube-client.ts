import {
  AnalyticsUnavailable,
  askingAs,
} from '../../application/analytics/analytics-failure';
import type { SemanticConfig } from './semantic-config';

/** One question, in the shape the semantic layer's own API takes. */
export interface CubeQuery {
  readonly measures?: readonly string[];
  readonly dimensions?: readonly string[];
  readonly timeDimensions?: readonly {
    readonly dimension: string;
    readonly granularity?: string;
    readonly dateRange?: readonly [string, string];
  }[];
  readonly limit?: number;
  readonly order?: Readonly<Record<string, 'asc' | 'desc'>>;
}

/**
 * One question and the standing it is asked with.
 *
 * **One query, not a list.** The design expected the watermark to travel in the
 * same load as a second query; measured, an array of queries is treated as data
 * blending and refused without a shared granularity, which a watermark question
 * has no reason to have. So a load carries one question and the caller issues
 * two when it needs two.
 */
export interface CubeLoad {
  readonly query: CubeQuery;
  /** The signed security context. Never a caller's own token. */
  readonly context: string;
}

export interface CubeResult {
  readonly data: readonly Readonly<Record<string, unknown>>[];
  /**
   * Whether the answer came from what was prepared.
   *
   * Read from the response's `external` flag rather than from
   * `usedPreAggregations`, which the design named and which is `null` on every
   * answer this platform has yet seen — prepared or not. An adapter reading it
   * would report every answer as read from the exported objects and would never
   * be wrong out loud, which is a check that cannot fail.
   */
  readonly servedFromStore: boolean;
}

/** What the client needs from the world, so a test can supply its own. */
export interface CubeSurroundings {
  fetching(url: string, init: RequestInit): Promise<Response>;
  waiting(milliseconds: number): Promise<void>;
}

/** How long to pause before asking again about a question still being computed. */
const BETWEEN_ATTEMPTS_MS = 500;

const STILL_WORKING = 'Continue wait';

/**
 * The first outbound call this platform makes, and so the convention for them.
 *
 * **A deadline, not a timeout per attempt.** The configured deadline bounds the
 * whole exchange including every continue-wait, and an `AbortSignal` carries it
 * into the request itself so a socket that goes quiet is cut rather than waited
 * on forever. On expiry the question is refused as timed out. There is nothing
 * to stop remotely: unlike the query engine, the semantic layer holds no handle
 * this side can cancel, and saying so is more useful than implying otherwise.
 *
 * **No retry beyond the waiting.** A refused analytical question is refused for
 * a reason, and asking again doubles the cost of every incident.
 */
export class CubeClient {
  constructor(
    private readonly config: SemanticConfig,
    private readonly world: CubeSurroundings = {
      fetching: (url, init) => fetch(url, init),
      waiting: (milliseconds) =>
        new Promise((resume) => setTimeout(resume, milliseconds)),
    },
  ) {}

  async load(load: CubeLoad): Promise<CubeResult> {
    const deadline = Date.now() + this.config.questionTimeoutMs;

    for (;;) {
      const body = await this.askOnce(load, deadline);

      if (body.error !== STILL_WORKING) {
        return answerFrom(body);
      }

      // Still being computed. A client that read this one response and stopped
      // would report an empty answer for every question slow enough to matter.
      //
      // The deadline is not re-checked here: `askOnce` refuses before asking
      // once there is no time left, so a second check would be a second place
      // to keep the same rule — and a probe that deleted it broke nothing,
      // which is what redundant looks like.
      await this.world.waiting(BETWEEN_ATTEMPTS_MS);
    }
  }

  private async askOnce(load: CubeLoad, deadline: number): Promise<CubeBody> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AnalyticsUnavailable(
        'question-timed-out',
        new Error(`no answer within ${this.config.questionTimeoutMs}ms`),
      );
    }

    const stop = AbortSignal.timeout(remaining);

    // `model-unreachable` covers the connection: nothing listening, a name that
    // does not resolve, a reset. A body that came back is a different failure
    // and is classified below, where what it says is known.
    const response = await askingAs('model-unreachable', () =>
      this.world.fetching(`${this.config.url}/cubejs-api/v1/load`, {
        method: 'POST',
        headers: {
          Authorization: load.context,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: load.query }),
        signal: stop,
      }),
    );

    const body = await askingAs('model-rejected', async () =>
      responseBody(await response.json()),
    );

    if (
      !response.ok ||
      (body.error !== undefined && body.error !== STILL_WORKING)
    ) {
      // The cause carries the body; the message carries none of it. A query
      // layer's error routinely contains the statement it generated and the
      // address it read from, and neither may reach a caller.
      throw new AnalyticsUnavailable(
        'model-rejected',
        new Error(`the semantic layer refused: ${JSON.stringify(body)}`),
      );
    }

    return body;
  }
}

interface CubeBody {
  readonly error?: string;
  readonly data?: readonly Readonly<Record<string, unknown>>[];
  readonly external?: boolean;
}

/**
 * Every field is optional, so anything shaped like an object is accepted here
 * and each field is checked where it is read. This is an external boundary and
 * the body is whatever arrived, not whatever was expected.
 */
function responseBody(parsed: unknown): CubeBody {
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }

  return parsed;
}

function answerFrom(body: CubeBody): CubeResult {
  return {
    data: Array.isArray(body.data) ? body.data : [],
    servedFromStore: body.external === true,
  };
}

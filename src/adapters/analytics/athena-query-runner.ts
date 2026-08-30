import {
  AnalyticsUnavailable,
  askingAs,
} from '../../application/analytics/analytics-failure';

/** What the engine says a question is doing. */
export type QuestionState =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** One page of an answer, and the token for the next if there is one. */
export interface EnginePage {
  /** The column names, from the answer's own description of itself. */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly next?: string;
}

/**
 * The four things this runner needs an engine to do.
 *
 * Named as operations rather than as the client's commands, so the waiting, the
 * paging and the giving up can be exercised without one. The local engine
 * answers in milliseconds and returns small results in a single page, so
 * neither behaviour this file exists for would ever be reached by pointing a
 * test at it.
 */
export interface Engine {
  submit(statement: string): Promise<string>;
  stateOf(question: string): Promise<QuestionState>;
  pageOf(question: string, token?: string): Promise<EnginePage>;
  stop(question: string): Promise<void>;
}

export interface QueryResult {
  readonly header: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
}

/**
 * Asks a question, waits for it, and reads all of the answer.
 *
 * The three things it is responsible for are the three a naive version gets
 * wrong: it stops waiting at a deadline **and tells the engine to stop too**,
 * it follows every page rather than reading the first, and it lets a diagnosis
 * made further down survive the step it was made in.
 */
export class QueryRunner {
  constructor(
    private readonly engine: Engine,
    /** How long between asking whether a question has finished. */
    private readonly pollMilliseconds = 250,
  ) {}

  async run(statement: string, deadline: Date): Promise<QueryResult> {
    const question = await askingAs('question-failed', () =>
      this.engine.submit(statement),
    );

    await this.settle(question, deadline);
    return this.readAll(question);
  }

  /**
   * Waits until the engine is done, or until the deadline — and on the deadline
   * asks it to stop.
   *
   * Abandoning a question would leave work running that nobody is waiting for,
   * which where this runs for real is billed by the byte it goes on scanning.
   */
  private async settle(question: string, deadline: Date): Promise<void> {
    for (;;) {
      const state = await askingAs('question-failed', () =>
        this.engine.stateOf(question),
      );

      if (state === 'SUCCEEDED') {
        return;
      }
      if (state !== 'QUEUED' && state !== 'RUNNING') {
        // Failed or cancelled. There is no answer to read, and reading one
        // anyway is how a partial result becomes a chart.
        throw new AnalyticsUnavailable(
          'question-failed',
          new Error(`the engine answered ${state}`),
        );
      }

      if (Date.now() >= deadline.getTime()) {
        await this.engine.stop(question).catch(() => undefined);
        throw new AnalyticsUnavailable(
          'question-timed-out',
          new Error('the deadline passed before the question finished'),
        );
      }

      await pause(this.pollMilliseconds);
    }
  }

  /**
   * Every page, until one names no successor.
   *
   * A `SELECT` repeats its column names as the first row of the first page.
   * That row is dropped only when it *is* the header: dropping row zero
   * unconditionally would eat a real row the day the engine stops doing it.
   */
  private async readAll(question: string): Promise<QueryResult> {
    const rows: (readonly (string | null)[])[] = [];
    let header: readonly string[] = [];
    let token: string | undefined;
    let first = true;

    do {
      const page: EnginePage = await askingAs('question-failed', () =>
        this.engine.pageOf(question, token),
      );

      if (first) {
        header = page.columns;
        rows.push(...withoutHeaderRow(page.rows, header));
        first = false;
      } else {
        rows.push(...page.rows);
      }

      token = page.next;
    } while (token !== undefined);

    return { header, rows };
  }
}

function withoutHeaderRow(
  rows: readonly (readonly (string | null)[])[],
  header: readonly string[],
): readonly (readonly (string | null)[])[] {
  const [first] = rows;
  const isHeader =
    first !== undefined &&
    first.length === header.length &&
    first.every((value, at) => value === header[at]);

  return isHeader ? rows.slice(1) : rows;
}

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

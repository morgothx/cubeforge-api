import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import {
  QueryRunner,
  type Engine,
  type EnginePage,
  type QuestionState,
} from './athena-query-runner';

const COLUMNS = ['sku', 'quantity'];

/**
 * The part of asking a question that has nothing to do with which engine
 * answers: waiting for it, giving up on it, and reading all of it.
 *
 * Exercised against a fabricated engine on purpose. The local one returns small
 * results in a single page and answers in milliseconds, so neither of the two
 * behaviours this task exists to get right would ever be reached by pointing at
 * it. What a real deployment does is paginate and occasionally take too long.
 */
describe('asking a question and reading the answer', () => {
  it('reads every page, not the first one', async () => {
    // The failure this prevents is the quiet kind: a busy month answered with
    // its first thousand rows and no error at all.
    const engine = fake({
      pages: [
        page([COLUMNS, ['ACME-001', '1']], 'more'),
        page([['ACME-002', '2']], 'still-more'),
        page([['ACME-003', '3']]),
      ],
    });

    const result = await new QueryRunner(engine, 1).run('SELECT …', far());

    expect(result.header).toEqual(COLUMNS);
    expect(result.rows).toEqual([
      ['ACME-001', '1'],
      ['ACME-002', '2'],
      ['ACME-003', '3'],
    ]);
  });

  it('drops the header row the engine repeats as data', async () => {
    // A `SELECT` comes back with its column names as the first row of the first
    // page, and a row that happens to look the same is still data.
    const engine = fake({
      pages: [page([COLUMNS, ['sku', 'quantity'], ['ACME-001', '1']])],
    });

    const result = await new QueryRunner(engine, 1).run('SELECT …', far());

    expect(result.rows).toEqual([
      ['sku', 'quantity'],
      ['ACME-001', '1'],
    ]);
  });

  it('keeps a first row that is not the header', async () => {
    // The distinguishing case, and the first version of the test above did not
    // have it: both of its rows equalled the header, so dropping row zero
    // unconditionally gave the same answer and the probe walked through.
    //
    // An engine that stops repeating its column names — or a statement that
    // never did — must not lose its first row of real data.
    const engine = fake({
      pages: [
        page([
          ['ACME-001', '1'],
          ['ACME-002', '2'],
        ]),
      ],
    });

    const result = await new QueryRunner(engine, 1).run('SELECT …', far());

    expect(result.rows).toEqual([
      ['ACME-001', '1'],
      ['ACME-002', '2'],
    ]);
  });

  it('asks the engine to stop a question that outlives its deadline', async () => {
    const engine = fake({ neverSettles: true });

    await expect(
      new QueryRunner(engine, 1).run('SELECT …', new Date(Date.now() + 30)),
    ).rejects.toMatchObject({ reason: 'question-timed-out' });

    // Stopped, not abandoned. Work nobody is waiting for still costs something
    // where this runs for real.
    expect(engine.stopped).toEqual(['question-1']);
  });

  it('reports a question the engine could not answer', async () => {
    const engine = fake({ settlesAs: 'FAILED' });

    await expect(
      new QueryRunner(engine, 1).run('SELECT …', far()),
    ).rejects.toMatchObject({ reason: 'question-failed' });
    expect(engine.stopped).toEqual([]);
  });

  it('does not read an answer it was never given', async () => {
    const engine = fake({ settlesAs: 'CANCELLED' });

    await expect(
      new QueryRunner(engine, 1).run('SELECT …', far()),
    ).rejects.toMatchObject({ reason: 'question-failed' });
    expect(engine.read).toEqual([]);
  });

  it('carries through the diagnosis the engine already made', async () => {
    // A refused credential is classified where the status still exists, and the
    // runner must not relabel it into whatever step it happened to be in.
    const engine = fake({ submitRefuses: 'store-rejected' });

    await expect(
      new QueryRunner(engine, 1).run('SELECT …', far()),
    ).rejects.toMatchObject({ reason: 'store-rejected' });
  });
});

const far = () => new Date(Date.now() + 60_000);

const page = (rows: string[][], next?: string): EnginePage => ({
  columns: COLUMNS,
  rows,
  next,
});

interface Fake extends Engine {
  readonly stopped: string[];
  readonly read: string[];
}

function fake(behaviour: {
  pages?: EnginePage[];
  neverSettles?: boolean;
  settlesAs?: QuestionState;
  submitRefuses?: 'store-rejected';
}): Fake {
  const stopped: string[] = [];
  const read: string[] = [];
  const pages = behaviour.pages ?? [page([COLUMNS])];

  return {
    stopped,
    read,
    submit: () => {
      if (behaviour.submitRefuses) {
        // The real diagnosis, not a lookalike. The first version of this fake
        // threw an `Error` wearing the right `name` and `reason`, which is not
        // what `askingAs` recognises — and the failing test was the fake being
        // looser than the thing it stands for, one more time.
        return Promise.reject(
          new AnalyticsUnavailable(
            behaviour.submitRefuses,
            new Error('refused'),
          ),
        );
      }
      return Promise.resolve('question-1');
    },
    stateOf: () =>
      Promise.resolve(
        behaviour.neverSettles
          ? 'RUNNING'
          : (behaviour.settlesAs ?? 'SUCCEEDED'),
      ),
    pageOf: (id, token) => {
      read.push(id);
      const index =
        token === undefined ? 0 : pages.findIndex((p) => p.next === token) + 1;
      return Promise.resolve(pages[index]);
    },
    stop: (id) => {
      stopped.push(id);
      return Promise.resolve();
    },
  };
}

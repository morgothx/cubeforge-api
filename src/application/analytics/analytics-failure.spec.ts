import { AnalyticsUnavailable, askingAs, reasonOf } from './analytics-failure';

describe('deciding what a question failed for', () => {
  const location = 's3://cubeforge-analytics-results/';
  const address = 'http://cube:4000/cubejs-api/v1/load';

  it('gives an unclassified failure the reason of the step that raised it', async () => {
    const failed = askingAs('question-failed', () =>
      Promise.reject(new Error('the socket closed')),
    );

    await expect(failed).rejects.toEqual(
      new AnalyticsUnavailable('question-failed', expect.anything()),
    );
  });

  it('leaves an already-classified failure exactly as it was', async () => {
    // The step that knew what went wrong is the one entitled to name it. A
    // timeout raised inside a step labelled "the question failed" is still a
    // timeout, and an operator waits differently for the two.
    const timedOut = new AnalyticsUnavailable(
      'question-timed-out',
      new Error('the deadline passed'),
    );

    await expect(
      askingAs('question-failed', () => Promise.reject(timedOut)),
    ).rejects.toBe(timedOut);
  });

  it('keeps what the cause said out of what it says', async () => {
    const failed = askingAs('question-failed', () =>
      Promise.reject(
        new Error(`SELECT * FROM movements failed writing to ${location}`),
      ),
    );

    // A run's report is read by somebody acting for the whole platform, and an
    // engine's message can carry the statement it ran and where the data lives.
    // The cause travels beside the error, never inside its message.
    await expect(failed).rejects.toThrow(
      'the question failed: question-failed',
    );
    await expect(failed).rejects.not.toThrow(location);
    await expect(failed).rejects.not.toThrow('SELECT');
  });

  it('tells a service that does not answer from one that answers badly', async () => {
    // Two different things for an operator to do. A container that is not
    // running is started; a service answering with an error is read. Filing
    // both under one word would send whoever is on call to the wrong place, and
    // filing either under an unreachable object store would send them to a
    // third place that is fine.
    const unreachable = askingAs('model-unreachable', () =>
      Promise.reject(new Error('connect ECONNREFUSED 172.18.0.4:4000')),
    );
    const rejected = askingAs('model-rejected', () =>
      Promise.reject(new Error('Error: Query is invalid')),
    );

    await expect(unreachable).rejects.toMatchObject({
      reason: 'model-unreachable',
    });
    await expect(rejected).rejects.toMatchObject({ reason: 'model-rejected' });
  });

  it('keeps what a query layer said out of what a rejection says', async () => {
    // An error body from a semantic layer routinely carries the statement it
    // generated and the address it generated it for. Both are exactly what the
    // caller-facing refusal may not contain.
    const rejected = askingAs('model-rejected', () =>
      Promise.reject(
        new Error(
          `Error: SELECT sum(quantity) FROM movements failed against ${address}`,
        ),
      ),
    );

    await expect(rejected).rejects.toThrow(
      'the question failed: model-rejected',
    );
    await expect(rejected).rejects.not.toThrow(address);
    await expect(rejected).rejects.not.toThrow('SELECT');
  });

  it('reads the reason back, and falls back only for what escaped a step', () => {
    expect(reasonOf(new AnalyticsUnavailable('store-rejected', null))).toBe(
      'store-rejected',
    );
    expect(reasonOf(new AnalyticsUnavailable('model-unreachable', null))).toBe(
      'model-unreachable',
    );
    expect(reasonOf(new Error('something else entirely'))).toBe(
      'question-failed',
    );
  });
});

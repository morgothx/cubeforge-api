import { AnalyticsUnavailable, askingAs, reasonOf } from './analytics-failure';

describe('deciding what a question failed for', () => {
  const location = 's3://cubeforge-analytics-results/';

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

  it('reads the reason back, and falls back only for what escaped a step', () => {
    expect(reasonOf(new AnalyticsUnavailable('store-rejected', null))).toBe(
      'store-rejected',
    );
    expect(reasonOf(new Error('something else entirely'))).toBe(
      'question-failed',
    );
  });
});

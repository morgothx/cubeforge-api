import { ExportFailed, failingAs, reasonOf } from './export-failure';

describe('deciding what a failure was', () => {
  // Named so the repository-wide secrets grep does not meet a variable called
  // "secret" at every gate. The value is the point: it must not come back out.
  const refusedKey = 'AKIA-not-a-real-key';

  it('gives an unclassified failure the reason of the step that raised it', async () => {
    const failed = failingAs('write-failed', () =>
      Promise.reject(new Error('the socket closed')),
    );

    await expect(failed).rejects.toEqual(
      new ExportFailed('write-failed', expect.anything()),
    );
  });

  it('leaves an already-classified failure exactly as it was', async () => {
    // The whole mechanism the sink's own diagnosis depends on. `reachable()` is
    // called inside a step labelled "unreachable", and a rejected credential
    // must survive that as *rejected* — the innermost place that knew what went
    // wrong is the one entitled to name it.
    const rejected = new ExportFailed('storage-rejected', new Error('403'));

    await expect(
      failingAs('storage-unreachable', () => Promise.reject(rejected)),
    ).rejects.toBe(rejected);
  });

  it('keeps what the cause said out of what it says', async () => {
    const failed = failingAs('write-failed', () =>
      Promise.reject(new Error(`credential ${refusedKey} was refused`)),
    );

    // A run's report is read by an operator acting for the whole platform, and
    // a driver's message can carry a key, a record, or another tenant in it.
    // The cause travels beside the error, never inside its message.
    await expect(failed).rejects.toThrow('the export failed: write-failed');
    await expect(failed).rejects.not.toThrow(refusedKey);
  });

  it('reads the reason back, and falls back only for what escaped a step', () => {
    expect(reasonOf(new ExportFailed('storage-rejected', null))).toBe(
      'storage-rejected',
    );
    // Anything unclassified reached here from between the steps, which would be
    // a defect in the export rather than in something it talked to.
    expect(reasonOf(new Error('something else entirely'))).toBe(
      'database-unavailable',
    );
  });
});

import {
  answeredFrom,
  neverExported,
  type ModelledAnswer,
  type ModelledRow,
} from './answer';

const exportedThrough = new Date('2026-03-07T00:00:00.000Z');

const aRow: ModelledRow = {
  values: { recorded_day: '2026-03-07', kind: 'receipt', net_quantity: 42 },
};

/** What a reader can learn about an answer without knowing how it was made. */
function readerSees(answer: ModelledAnswer): string {
  if (answer.state === 'never-exported') {
    return 'never-exported';
  }

  return `${answer.servedFrom}/${answer.rows.length === 0 ? 'empty' : 'rows'}`;
}

describe('a modelled answer', () => {
  it('states the moment it is complete through, with the rows it carries', () => {
    const answer = answeredFrom('exported-objects', exportedThrough, [aRow]);

    expect(answer.state).toBe('answered');
    if (answer.state !== 'answered') {
      throw new Error('unreachable');
    }
    expect(answer.completeThrough).toBe(exportedThrough);
    expect(answer.rows).toEqual([aRow]);
  });

  it('says whether it was prepared or read from the exported objects', () => {
    const prepared = answeredFrom('prepared', exportedThrough, [aRow]);
    const read = answeredFrom('exported-objects', exportedThrough, [aRow]);

    expect(readerSees(prepared)).toBe('prepared/rows');
    expect(readerSees(read)).toBe('exported-objects/rows');
  });

  it('answers a period with no records rather than refusing it', () => {
    const empty = answeredFrom('exported-objects', exportedThrough, []);

    expect(empty.state).toBe('answered');
    if (empty.state !== 'answered') {
      throw new Error('unreachable');
    }
    expect(empty.rows).toEqual([]);
    expect(empty.completeThrough).toBe(exportedThrough);
  });

  it('keeps a tenant never exported apart from a period with nothing in it', () => {
    const empty = answeredFrom('exported-objects', exportedThrough, []);

    expect(readerSees(neverExported())).toBe('never-exported');
    expect(readerSees(empty)).not.toBe(readerSees(neverExported()));
  });

  it('carries neither rows nor a moment when nothing was ever exported', () => {
    expect(Object.keys(neverExported())).toEqual(['state']);
  });

  it('tells four outcomes apart', () => {
    const outcomes = [
      answeredFrom('prepared', exportedThrough, [aRow]),
      answeredFrom('exported-objects', exportedThrough, [aRow]),
      answeredFrom('exported-objects', exportedThrough, []),
      neverExported(),
    ].map(readerSees);

    expect(new Set(outcomes).size).toBe(4);
  });

  it('refuses a moment that is not on the clock', () => {
    expect(() =>
      answeredFrom('prepared', new Date('not a moment'), []),
    ).toThrow('complete through');
  });
});

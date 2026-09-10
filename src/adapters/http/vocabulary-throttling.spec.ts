import { platformThrottlerOptions } from './platform-throttling';
import {
  VOCABULARY_BY_CALLER,
  loadVocabularyThrottlingConfig,
  vocabularyThrottlerOptions,
} from './vocabulary-throttling';

describe('the vocabulary allowance', () => {
  it('allows sixty requests a minute when nothing says otherwise', () => {
    expect(loadVocabularyThrottlingConfig({})).toEqual({
      windowSeconds: 60,
      requestsPerCaller: 60,
    });
  });

  it('reads both settings from the environment', () => {
    expect(
      loadVocabularyThrottlingConfig({
        ANALYTICS_VOCABULARY_WINDOW_SECONDS: '30',
        ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER: '90',
      }),
    ).toEqual({ windowSeconds: 30, requestsPerCaller: 90 });
  });

  it.each(['0', '-5', '1.5', 'sixty'])(
    'refuses %s as an allowance, naming the setting',
    (raw) => {
      expect(() =>
        loadVocabularyThrottlingConfig({
          ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER: raw,
        }),
      ).toThrow('ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER');
    },
  );

  it('registers one bucket, under its own name, over its own window', () => {
    const [bucket, ...others] = vocabularyThrottlerOptions({
      windowSeconds: 60,
      requestsPerCaller: 60,
    });

    expect(others).toEqual([]);
    expect(bucket).toMatchObject({
      name: VOCABULARY_BY_CALLER,
      ttl: 60_000,
      limit: 60,
    });
    expect(bucket?.getTracker).toBeInstanceOf(Function);
  });
});

/**
 * Describing what may be asked has to stay cheaper to ask for than asking.
 *
 * The two allowances are configured separately and compared nowhere else, so an
 * operator tightening one could quietly leave a dashboard unable to learn its
 * own vocabulary while it could still ask questions. Refused at start-up, when
 * the person who set the values is still looking at them.
 */
describe('the vocabulary allowance, against the question allowance', () => {
  it('starts with the defaults, sixty a minute against ten', () => {
    expect(() => platformThrottlerOptions({})).not.toThrow();
  });

  it('refuses to start when the vocabulary allows no more than questions do', () => {
    const inverted = () =>
      platformThrottlerOptions({
        ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER: '10',
      });

    expect(inverted).toThrow('ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER');
    expect(inverted).toThrow('ANALYTICS_QUESTIONS_PER_CALLER');
  });

  it('compares rates, not counts, when the windows differ', () => {
    // Twenty over two minutes is ten a minute: equal to the questions, so not
    // above them, although twenty is the larger number.
    expect(() =>
      platformThrottlerOptions({
        ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER: '20',
        ANALYTICS_VOCABULARY_WINDOW_SECONDS: '120',
      }),
    ).toThrow('ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER');
  });
});

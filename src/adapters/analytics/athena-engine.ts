import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import type { AnalyticsConfig } from './analytics-config';
import type { Engine, EnginePage, QuestionState } from './athena-query-runner';

/**
 * The only file that speaks to the client.
 *
 * Everything about waiting, paging and giving up lives next door, against the
 * four operations below — so that behaviour can be exercised without an engine,
 * and this file has nothing in it but the translation.
 *
 * It is also where a refusal is classified, because **this is the last place
 * the status code exists**. One layer up there is an exception carrying a
 * driver's wording, and matching on those is how a rephrased library message
 * turns every failure into the wrong kind.
 */
export class AthenaEngine implements Engine {
  private readonly client: AthenaClient;

  constructor(private readonly config: AnalyticsConfig) {
    this.client = new AthenaClient({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
    });
  }

  async submit(statement: string): Promise<string> {
    const started = await this.classifying(() =>
      this.client.send(
        new StartQueryExecutionCommand({
          QueryString: statement,
          QueryExecutionContext: { Database: this.config.database },
          WorkGroup: this.config.workgroup,
          ResultConfiguration: { OutputLocation: this.config.resultsLocation },
        }),
      ),
    );

    const question = started.QueryExecutionId;
    if (question === undefined) {
      throw new AnalyticsUnavailable(
        'question-failed',
        new Error('the engine accepted the question and named nothing'),
      );
    }
    return question;
  }

  async stateOf(question: string): Promise<QuestionState> {
    const execution = await this.classifying(() =>
      this.client.send(
        new GetQueryExecutionCommand({ QueryExecutionId: question }),
      ),
    );

    return execution.QueryExecution?.Status?.State ?? 'FAILED';
  }

  async pageOf(question: string, token?: string): Promise<EnginePage> {
    const answered = await this.classifying(() =>
      this.client.send(
        new GetQueryResultsCommand({
          QueryExecutionId: question,
          NextToken: token,
        }),
      ),
    );

    const columns = (
      answered.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []
    ).map((column) => column.Name ?? '');

    // Names from the answer's own description, values from its rows — and
    // **only** the names. The local engine reports every column's type as text
    // whatever it really is, so a type read from here would be right in a
    // deployment and wrong in development.
    const rows = (answered.ResultSet?.Rows ?? []).map((row) =>
      (row.Data ?? []).map((cell) => cell.VarCharValue ?? null),
    );

    return { columns, rows, next: answered.NextToken };
  }

  async stop(question: string): Promise<void> {
    await this.classifying(() =>
      this.client.send(
        new StopQueryExecutionCommand({ QueryExecutionId: question }),
      ),
    );
  }

  close(): void {
    this.client.destroy();
  }

  /**
   * Turns whatever the client threw into the class of problem it is.
   *
   * A refused credential and a destination that is not there are different
   * things to do about, and by the time an exception has travelled one layer it
   * is a string. The status is here; the classification belongs here too.
   */
  private async classifying<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new AnalyticsUnavailable(reasonRefusing(error), error);
    }
  }
}

function reasonRefusing(
  error: unknown,
): 'store-rejected' | 'store-unreachable' {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;

  return status === 401 || status === 403
    ? 'store-rejected'
    : 'store-unreachable';
}

import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import {
  describeRun,
  exitStatusOf,
  parseExportArguments,
} from '../src/adapters/cli/export-command';
import { RunExportUseCase } from '../src/application/export/run-export.use-case';
import { ExportModule } from '../src/export.module';

/**
 * `pnpm ops:export` — a full export, or one named tenant.
 *
 * No prompt and no interactive input, because the operation a scheduler will
 * eventually run has to be the operation an operator runs today. The schedule
 * itself belongs to the deployment feature; this is the thing it will call.
 *
 * It boots the export's own module rather than the whole application: an
 * operator command has no use for an HTTP surface, and the API has no use for
 * the export's configuration.
 */
async function main(): Promise<number> {
  const { onlyTenant } = parseExportArguments(process.argv.slice(2));
  // One identifier for everything this run says, generated where the run
  // begins — the same place an inbound request's is.
  const correlationId = randomUUID();

  const context = await NestFactory.createApplicationContext(ExportModule, {
    // The report is the output. Nest's startup chatter would bury it.
    logger: ['error', 'warn'],
  });

  try {
    const run = await context.get(RunExportUseCase).execute({
      correlationId,
      ...(onlyTenant === null ? {} : { onlyTenant }),
    });

    for (const line of describeRun(run)) {
      console.log(line);
    }

    return exitStatusOf(run.report);
  } finally {
    await context.close();
  }
}

void main().then(
  (status) => {
    process.exitCode = status;
  },
  (error: unknown) => {
    // A refusal is the ordinary outcome of a missing setting or an unreachable
    // destination, and it is worth exactly one legible line.
    console.error(
      `export refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  },
);

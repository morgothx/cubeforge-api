import { reportOf } from '../../domain/export/report';
import {
  carriedTenant,
  failedTenant,
  upToDateTenant,
} from '../../domain/export/report';
import { transactionId } from '../../domain/export/window';
import { tenantId } from '../../domain/identifiers';
import {
  describeRun,
  exitStatusOf,
  parseExportArguments,
} from './export-command';

const ACME = tenantId('00000001-0000-4000-8000-000000000001');
const GLOBEX = tenantId('00000001-0000-4000-8000-000000000002');
const RUN = 'run-0123456789';

describe('the operator command', () => {
  describe('reading its arguments', () => {
    it('runs every tenant when given none', () => {
      expect(parseExportArguments([])).toEqual({ onlyTenant: null });
    });

    it('runs one tenant when given one', () => {
      expect(parseExportArguments(['--tenant', ACME])).toEqual({
        onlyTenant: ACME,
      });
    });

    it('sees through the separator a package manager adds', () => {
      // `pnpm ops:export -- --tenant X` is the documented invocation, and this
      // is the shape it arrives in.
      expect(parseExportArguments(['--', '--tenant', ACME])).toEqual({
        onlyTenant: ACME,
      });
      expect(parseExportArguments(['--'])).toEqual({ onlyTenant: null });
    });

    it('refuses a flag with nothing after it', () => {
      expect(() => parseExportArguments(['--tenant'])).toThrow('--tenant');
    });

    it('refuses anything it was not taught', () => {
      // Not ignored: an operator who meant to narrow a run and mistyped the
      // flag would otherwise export every tenant and be told it went well.
      expect(() => parseExportArguments(['--tenants', ACME])).toThrow(
        '--tenants',
      );
      expect(() => parseExportArguments([ACME])).toThrow(ACME);
    });
  });

  describe('saying what happened', () => {
    const run = (...outcomes: Parameters<typeof reportOf>[0]) => ({
      correlationId: RUN,
      report: reportOf(outcomes),
    });

    it('reports every tenant, against the run that carried it', () => {
      const lines = describeRun(
        run(
          carriedTenant(ACME, {
            movements: 3,
            partitions: 2,
            through: transactionId(1234n),
          }),
          upToDateTenant(GLOBEX),
        ),
      );

      // Every line carries the run's identifier, which is the whole of what a
      // correlation identifier is for: one run's lines are findable together.
      expect(lines.every((line) => line.startsWith(RUN))).toBe(true);
      expect(lines).toContain(
        `${RUN} tenant ${ACME}: carried 3 movements into 2 partitions, through 1234`,
      );
      expect(lines).toContain(`${RUN} tenant ${GLOBEX}: up to date`);
      expect(lines.at(-1)).toBe(
        `${RUN} finished: 1 carried, 1 up to date, 0 failed`,
      );
    });

    it('names the failure by its class and by nothing else', () => {
      const lines = describeRun(
        run(upToDateTenant(ACME), failedTenant(GLOBEX, 'write-failed')),
      );

      expect(lines).toContain(`${RUN} tenant ${GLOBEX}: failed, write-failed`);
      expect(lines.at(-1)).toBe(
        `${RUN} finished: 0 carried, 1 up to date, 1 failed`,
      );
    });
  });

  describe('what it exits with', () => {
    it('reports success only when every tenant was carried', () => {
      expect(exitStatusOf(reportOf([upToDateTenant(ACME)]))).toBe(0);
      expect(
        exitStatusOf(
          reportOf([
            carriedTenant(ACME, {
              movements: 1,
              partitions: 1,
              through: transactionId(2n),
            }),
            failedTenant(GLOBEX, 'storage-rejected'),
          ]),
        ),
      ).toBe(1);
    });
  });
});

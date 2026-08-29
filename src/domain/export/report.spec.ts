import {
  carriedTenant,
  failedTenant,
  reportOf,
  upToDateTenant,
  type ExportReport,
} from './report';
import { transactionId } from './window';

const ACME = '018f2c00-0000-7000-8000-00000000ac01';
const RIVAL = '018f2c00-0000-7000-8000-00000000ac02';

/**
 * What a run says it did.
 *
 * Per tenant, the same shape a movement batch reports per row and for the same
 * reason: one tenant with odd data must not cost every other tenant its nightly
 * export, and an operator has to be able to see which one it was.
 */
describe('an export report', () => {
  it('reports success when every tenant was carried', () => {
    const report = reportOf([
      carriedTenant(ACME, {
        movements: 12,
        partitions: 3,
        through: transactionId(500n),
      }),
      upToDateTenant(RIVAL),
    ]);

    expect(report.succeeded).toBe(true);
    expect(report.carried).toBe(1);
    expect(report.upToDate).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('reports failure when any tenant failed, and still names the rest', () => {
    const report: ExportReport = reportOf([
      carriedTenant(ACME, {
        movements: 12,
        partitions: 3,
        through: transactionId(500n),
      }),
      failedTenant(RIVAL, 'storage-unreachable'),
    ]);

    // One failure fails the run — an operator who reads only the exit status
    // must not be told everything is fine. And the tenant that worked is still
    // reported as worked, because it was.
    expect(report.succeeded).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.carried).toBe(1);
  });

  it('succeeds on a run with nothing to do', () => {
    // Every tenant already up to date is a successful night, not an empty one.
    expect(reportOf([upToDateTenant(ACME)]).succeeded).toBe(true);
    expect(reportOf([]).succeeded).toBe(true);
  });

  it('adds up what was carried across tenants', () => {
    const report = reportOf([
      carriedTenant(ACME, {
        movements: 12,
        partitions: 3,
        through: transactionId(500n),
      }),
      carriedTenant(RIVAL, {
        movements: 8,
        partitions: 1,
        through: transactionId(400n),
      }),
    ]);

    expect(report.movements).toBe(20);
    expect(report.partitions).toBe(4);
  });

  it('says why a tenant failed without saying what it holds', () => {
    const report = reportOf([failedTenant(ACME, 'write-failed')]);

    const said = JSON.stringify(report);
    // A reason names a class of problem. It never carries a SKU, an object key,
    // a row, or another tenant — the report is read by whoever runs the export,
    // and a platform-wide operator reading one tenant's records out of a log is
    // the leak this rule exists to prevent.
    expect(said).toContain('write-failed');
    expect(said).not.toMatch(/sku|external_id|\.parquet/i);
    expect(said).not.toContain(RIVAL);
  });

  it('keeps each tenant to one outcome', () => {
    // Two answers for one tenant is a run that cannot be read: carried and
    // failed at once says nothing about whether its cursor moved.
    expect(() =>
      reportOf([upToDateTenant(ACME), failedTenant(ACME, 'write-failed')]),
    ).toThrow();
  });
});

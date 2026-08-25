import { externalMovementId, locationCode, parseSku, sku } from './identifiers';

/**
 * The codes in this feature are the *tenant's*, not the platform's: a SKU comes
 * out of whatever system the tenant already runs, and the platform never
 * invents one. So these constructors are not generators — they are the place
 * where a foreign string stops being arbitrary.
 */
describe('inventory identifiers', () => {
  describe('a SKU', () => {
    it('keeps a code a real system would use', () => {
      expect(sku('ACME-001')).toBe('ACME-001');
      expect(sku('widget.42_b')).toBe('widget.42_b');
    });

    it('refuses one that says nothing', () => {
      for (const blank of ['', '   ', '\t']) {
        expect(parseSku(blank)).toEqual({
          malformed: true,
          because: 'blank',
        });
      }
    });

    it('refuses one longer than a column can hold meaningfully', () => {
      expect(parseSku('A'.repeat(65))).toEqual({
        malformed: true,
        because: 'too-long',
      });
      expect(parseSku('A'.repeat(64))).toEqual({
        malformed: false,
        value: 'A'.repeat(64),
      });
    });

    it('refuses characters that make a code ambiguous', () => {
      // Spaces and casing are how `WH 1`, `WH1` and `wh-1` become three
      // warehouses to anything that groups by them. A code arriving from an
      // upstream system is either exactly right or it is a different code.
      for (const awkward of ['ACME 001', 'ACME/001', 'ACME\n001', 'ACMÉ']) {
        expect(parseSku(awkward)).toEqual({
          malformed: true,
          because: 'unsupported-characters',
        });
      }
    });

    it('does not quietly repair a code by trimming it', () => {
      // Trimming would make ` ACME-001` and `ACME-001` the same product on one
      // path and two on another, depending on which one reached the database
      // first.
      expect(parseSku(' ACME-001')).toEqual({
        malformed: true,
        because: 'unsupported-characters',
      });
    });

    it('throws where a caller has no per-row answer to give', () => {
      expect(() => sku('')).toThrow(/sku/i);
    });
  });

  describe('the other two', () => {
    it('accept and refuse by the same rules', () => {
      expect(locationCode('WH-1')).toBe('WH-1');
      expect(externalMovementId('ERP-MOV-88412')).toBe('ERP-MOV-88412');
      expect(() => locationCode('WH 1')).toThrow(/location/i);
      expect(() => externalMovementId('')).toThrow(/movement/i);
    });
  });
});

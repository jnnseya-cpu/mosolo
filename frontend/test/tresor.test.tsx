import { describe, expect, it } from 'vitest';
import { extractCode, parseScan } from '../src/pages/Verify';

describe('Lecture des QR de quittance (Verify)', () => {
  it('charge utile signée, duplicata, URL et code nu', () => {
    expect(parseScan('MOSOLO1|Q26KIN0000000011|c2lnbmF0dXJl')).toEqual({ code: 'Q26KIN0000000011' });
    expect(parseScan('MOSOLO1|Q26KIN0000000011|c2lnbmF0dXJl|DUPLICATA-2')).toEqual({ code: 'Q26KIN0000000011', duplicateNo: 2 });
    expect(parseScan('https://exemple.cd/verifier/Q26KIN0000000011?duplicata=3')).toEqual({ code: 'Q26KIN0000000011', duplicateNo: 3 });
    expect(parseScan(' Q-2026-KIN-000000123-6 ')).toEqual({ code: 'Q-2026-KIN-000000123-6' });
    expect(extractCode('MOSOLO1|Q26KIN0000000011|sig')).toBe('Q26KIN0000000011');
  });
});

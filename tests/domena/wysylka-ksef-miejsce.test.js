import { describe, expect, it } from 'vitest';
import { coWolnoWyslac, powodJuzZlecona } from '../../src/domena/wysylka-ksef.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createWysylkaKsef } from '../../src/moduly/faktury/services/wysylka-ksef.js';
import { programTestowy } from '../pomoc/program-testowy.js';

const program = { opis: { wbudowany: true } };
const dokument = { uuid: 'u1', number: 'FV/1', rodzaj: 'vat', client_tax_code: '1234500011', ksefZleconaAt: '2026-10-01' };

describe('miejsce sprawdzenia wysyłki KSeF', () => {
  it('bez programu zachowuje zdanie o inFakcie z polskim stemplem', () => {
    expect(powodJuzZlecona('2026-10-29T07:27:03.587Z')).toBe('Panel już zlecił wysyłkę tego dokumentu do KSeF (29.10.2026, 08:27) — drugie zgłoszenie byłoby duplikatem u organu, a duplikatu nie da się skasować. Następny krok: otwórz ten dokument w inFakcie — tam widać, czy zlecenie doszło i czy ma już numer KSeF. Panel sam tego NIE ponowi.');
  });
  it('dla wbudowanego zostawia samo pierwsze zdanie', () => {
    expect(powodJuzZlecona(null, program)).toBe('Panel już zlecił wysyłkę tego dokumentu do KSeF.');
    expect(powodJuzZlecona(null, program)).not.toContain('inFakt');
  });
  it('podgląd przekazuje program do powodu pominięcia', () => {
    const wynik = coWolnoWyslac(['u1'], [dokument], false, undefined, program);
    expect(wynik.pominiete[0].powod).toBe('Panel już zlecił wysyłkę tego dokumentu do KSeF (01.10.2026, 00:00).');
  });
  it('kolizja rezerwacji w usłudze daje krótkie zdanie', async () => {
    const db = openOmsDb(':memory:');
    try {
      db.prepare('INSERT INTO wysylki_ksef (uuid, zlecona_at, numer) VALUES (?, ?, ?)').run('u1', '2026-10-01', 'FV/1');
      const p = programTestowy({ id: 'test' });
      p.opis = { ...p.opis, wbudowany: true };
      const u = createWysylkaKsef({ db, program: p, fakturyWidok: { dokumenty: async () => [{ ...dokument, ksefZleconaAt: null }] } });
      const wynik = await u.wyslij({ uuids: ['u1'], miesiac: '2026-10', pole: 'invoice_date' });
      expect(wynik.pominiete[0].powod).toBe('Panel już zlecił wysyłkę tego dokumentu do KSeF (01.10.2026, 00:00).');
    } finally { db.close(); }
  });
  it('usługa przekazuje program do podglądu', async () => {
    const db = openOmsDb(':memory:');
    try {
      const p = programTestowy({ id: 'test' });
      p.opis = { ...p.opis, wbudowany: true };
      const u = createWysylkaKsef({ db, program: p, fakturyWidok: { dokumenty: async () => [dokument] } });
      const wynik = await u.podglad({ uuids: ['u1'], miesiac: '2026-10', pole: 'invoice_date' });
      expect(wynik.pominiete[0].powod).toBe('Panel już zlecił wysyłkę tego dokumentu do KSeF (01.10.2026, 00:00).');
    } finally { db.close(); }
  });
});

it.each([
  ['2026-10-29T07:27:03.587Z', '29.10.2026, 08:27'],
  ['2026-07-29T07:27:03.587Z', '29.07.2026, 09:27'],
])('stempel %s w czasie polskim bez sekund', (iso, stempel) => {
  expect(powodJuzZlecona(iso, program)).toBe(`Panel już zlecił wysyłkę tego dokumentu do KSeF (${stempel}).`);
  expect(powodJuzZlecona(iso)).toContain(`(${stempel}) — drugie zgłoszenie`);
});

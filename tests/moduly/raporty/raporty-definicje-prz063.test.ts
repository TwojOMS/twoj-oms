// PRZ-063: pełne złożenie produktu przekazuje modułowi raportów definicje kanałów instalacji
// (PRZ-053: createModulRaporty(definicje)). Miejsce konfliktu scalenia z 028K, gdzie strona K miała
// stałą modulRaporty bez definicji; mutacja `createModulRaporty([])` w modulyDla przechodziła
// wszystkie dotychczasowe testy — raporty traciłyby kanały sklepów po cichu.
import { it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  OMS_KANALY: JSON.stringify([{ klucz: 'sklep-test', typ: 'woo', prefiks: 'SKLEP_TEST', etykieta: 'Sklep Testowy', raport: 'SKLEP_TESTOWY' }]),
  SKLEP_TEST_URL: 'https://sklep.example.test', SKLEP_TEST_CK: 'ck_fikcja', SKLEP_TEST_CS: 'cs_fikcja',
  OMS_RAPORTY_NAZWY_KANALOW: JSON.stringify({ SKLEP_TESTOWY: 'Sklep Testowy (raport)' }) };

it('PRZ063 złożenie produktu: raporty znają kanał raportowy z OMS_KANALY', async () => {
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  const db = openOmsDb();
  try {
    // Bez definicji złożenie odmawia startu („nieznany kanał raportowy”) — asercja pokazuje powód.
    let a: Awaited<ReturnType<typeof zbudujOms>> | null = null, odmowa: string | null = null;
    try { a = await zbudujOms({ db, env }); } catch (e) { odmowa = String(e); }
    expect(odmowa).toBeNull();
    try {
      const config = a!.usluga<any>('raporty', 'config');
      expect(config.nazwyKanalow).toEqual({ SKLEP_TESTOWY: 'Sklep Testowy (raport)' });
      expect(config.regulySprzedazy.klasyfikacja.sklepy.get('sklep-test')).toBe('SKLEP_TESTOWY');
      expect(siec).not.toHaveBeenCalled();
    } finally { await a!.app.close(); }
  } finally { db.close(); siec.mockRestore(); }
});

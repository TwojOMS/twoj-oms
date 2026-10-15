// PRZ-063: ekran Kampanii podpisuje sklep kampanii etykietą kanału z definicji instalacji
// (OMS_KANALY), nie surowym kluczem. Po PRZ-053 adresKanalu wymaga jawnych definicji —
// przywrócony z 028K widok wołał go bez nich (GET /kampania → 500), a sama naprawa
// bez tego testu przeżyłaby mutację „definicje → []” (ekran pokazałby klucz).
import { it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  OMS_KANALY: JSON.stringify([{ klucz: 'sklep-test', typ: 'woo', prefiks: 'SKLEP_TEST', etykieta: 'Sklep Testowy PRZ063' }]),
  SKLEP_TEST_URL: 'https://sklep.example.test', SKLEP_TEST_CK: 'ck_fikcja', SKLEP_TEST_CS: 'cs_fikcja' };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };

it('PRZ063 /kampania podpisuje sklep kampanii etykietą z OMS_KANALY', async () => {
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  const db = openOmsDb();
  db.prepare(`INSERT INTO kampanie (kod,nazwa,od_dnia,do_dnia,sklep,cel_uzyc) VALUES (?,?,?,?,?,?)`)
    .run('promo-test', 'Kampania testowa', '2026-08-24', '2026-09-07', 'sklep-test', 10);
  const a = await zbudujOms({ db, env });
  try {
    const odp = await a.app.inject({ method: 'GET', url: '/kampania?kampania=promo-test&dzien=2026-08-25', headers });
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('(sklep: Sklep Testowy PRZ063)');
    expect(siec).not.toHaveBeenCalled();
  } finally { await a.app.close(); db.close(); siec.mockRestore(); }
});

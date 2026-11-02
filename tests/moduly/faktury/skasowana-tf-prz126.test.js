// Publiczny rdzeń: inFakt działa, a dokument obcego programu nie zostanie przypadkiem zwolniony.
import { afterEach, describe, expect, it } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
const sprzatanie = [];
afterEach(async () => { for (const f of sprzatanie.splice(0).reverse()) await f(); });
async function przypadek(programWiersza = 'infakt') {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 'test', pass: 'test' } },
    env: { OMS_PROGRAM_FAKTUROWY: 'infakt' },
    fakturyWidok: { dokumenty: async () => [], nieoplacone: async () => [], proformy: () => [] },
  });
  sprzatanie.push(() => db.close(), () => app.close());
  await app.ready();
  const id = zapiszZamowienie(db, 'demo', { zrodlo_id: 'p7b', numer: '1', klient: {}, dostawa: {},
    metoda_wysylki: 'osobisty', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '123.00', status_woo: 'processing', oplacone_at: null, anulowane: 0 }, {});
  const f = db.prepare('INSERT INTO faktury (zamowienie_id, utworzona_at) VALUES (?, ?)').run(id, '2026-10-01T10:00:00Z');
  zakonczFakture(db, f.lastInsertRowid, { uuid: 'p7b', numer: 'FV/1', ksefStatus: null }, { program: programWiersza });
  const headers = { authorization: 'Basic ' + Buffer.from('test:test').toString('base64'), origin: 'http://localhost' };
  return { app, db, id, headers };
}
describe('odnotowanie skasowania faktury programu zewnętrznego', () => {
  it('inFakt: sekcja jest widoczna i można zwolnić zamówienie', async () => {
    const { app, db, id, headers } = await przypadek();
    const lista = await app.inject({ url: '/faktury?miesiac=2026-10', headers });
    expect(lista.statusCode).toBe(200);
    expect(lista.body).toContain('Odnotuj, że skasowałeś');
    expect(lista.body).toContain('/zamowienia/' + id + '/faktura/skasowana');
    const r = await app.inject({ method: 'POST', url: '/zamowienia/' + id + '/faktura/skasowana', headers });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id)).toBeUndefined();
  });
  it('dokument TwojeFaktury po przełączeniu na inFakt: odmowa, wiersz pozostaje', async () => {
    const { app, db, id, headers } = await przypadek('twojefaktury');
    const lista = await app.inject({ url: '/faktury?miesiac=2026-10', headers });
    expect(lista.statusCode).toBe(200);
    expect(lista.body).not.toContain('/zamowienia/' + id + '/faktura/skasowana');
    const r = await app.inject({ method: 'POST', url: '/zamowienia/' + id + '/faktura/skasowana', headers });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('pochodzi z programu wbudowanego w panel');
    expect(db.prepare('SELECT program FROM faktury WHERE zamowienie_id = ?').get(id)?.program).toBe('twojefaktury');
  });
});

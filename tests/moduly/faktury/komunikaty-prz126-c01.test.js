import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../../pomoc/konta-prz068.js';
import { POWOD_BRAK_ZGODY } from '../../../src/domena/zgoda-ksef.js';
import { EKRAN_KSEF_SPRZEDAZY } from '../../../src/domena/ekrany.js';
import { registerDrukFakturRoutes } from '../../../src/moduly/faktury/trasy/druk.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { programTestowy } from '../../pomoc/program-testowy.js';
import { bladOperatora } from '../../../src/domena/bledy.js';

const sprzatanie = [];
afterEach(async () => {
  for (const sprzataj of sprzatanie.splice(0).reverse()) await sprzataj();
  vi.unstubAllGlobals();
});

async function ekran({ admin = false, wbudowany = false, blad = POWOD_BRAK_ZGODY, wyjatek = false } = {}) {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Sieć zabroniona'); }));
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'fikcyjne' } }, env: wbudowany ? { OMS_TWOJEFAKTURY: 'tak', OMS_PROGRAM_FAKTUROWY: 'twojefaktury' } : {},
    fakturyWidok: { dokumenty: async () => [], nieoplacone: async () => [], proformy: () => [] },
    wysylkaKsef: { wyslij: async () => {
      if (wyjatek) throw bladOperatora(blad);
      return { wyslane: [], pominiete: [], niepewne: [], blad };
    } },
  });
  sprzatanie.push(() => db.close(), () => app.close());
  await app.ready();
  zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'fikcyjne', rola: 'sprzedaz', admin });
  ustawUprawnienia(db, kontoPoLoginie(db, 'ola').id, ['faktury', 'ustawienia']);
  const headers = { ...jako(db, 'ola'), origin: 'http://localhost' };
  return { app, headers };
}

describe('komunikaty faktur C01', () => {
  it.each([[true, false], [false, false], [true, true], [false, true]])('link do zgody: admin=%s, wyjątek=%s (samo prawo ustawień nie wystarcza)', async (admin, wyjatek) => {
    const { app, headers } = await ekran({ admin, wyjatek });
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/wyslij', headers,
      payload: { miesiac: '2026-10', pole: 'invoice_date' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(POWOD_BRAK_ZGODY);
    expect(r.body.includes(`<a href="${EKRAN_KSEF_SPRZEDAZY}">Otwórz ustawienia wysyłki do KSeF</a>`)).toBe(admin);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('inny błąd jest escapowany i nie dostaje linku do zgody', async () => {
    const { app, headers } = await ekran({ admin: true, blad: '<b>awaria</b>' });
    const r = await app.inject({ method: 'POST', url: '/faktury/ksef/wyslij', headers,
      payload: { miesiac: '2026-10' } });
    expect(r.body).toContain('&lt;b&gt;awaria&lt;/b&gt;');
    expect(r.body).not.toContain('Otwórz ustawienia wysyłki do KSeF');
  });

  it.each([[true, false], [false, false]])('archiwum: admin=%s, wbudowany=%s', async (admin, wbudowany) => {
    const { app, headers } = await ekran({ admin, wbudowany });
    const r = await app.inject({ url: '/faktury?miesiac=2026-10', headers });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Archiwum na serwerze: wyłączone. Gdy je włączysz, OMS zapisuje kopię PDF i XML każdej faktury sprzedaży w katalogu na serwerze.');
    expect(r.body.includes('Przy TwojeFaktury nie jest konieczne — faktury i tak leżą w KSeF.')).toBe(wbudowany);
    const zmienna = wbudowany ? 'OMS_ARCHIWUM_SPRZEDAZY' : 'INFAKT_ARCHIWUM';
    expect(r.body.includes(`Włącza administrator: zmienna ${zmienna} = ścieżka katalogu.`)).toBe(admin);
    expect(r.body.includes(zmienna)).toBe(admin);
    expect(r.body).not.toContain('/faktury/archiwum/uruchom');
  });

  it.each([
    [{ mianownik: 'Testownik', dopelniacz: 'Testownika', miejscownik: 'Testowniku', narzednik: 'Testownikiem' }, false],
  ])('brak dokumentu do druku używa odmiany programu %j', async (nazwa, wbudowany) => {
    const db = openOmsDb(':memory:');
    const app = Fastify();
    sprzatanie.push(() => db.close(), () => app.close());
    const program = programTestowy({ nazwa });
    program.opis = { ...program.opis, wbudowany };
    registerDrukFakturRoutes(app, { db, infakt: program });
    const id = zapiszZamowienie(db, 'demo', { zrodlo_id: 'c01', numer: '1', klient: {}, dostawa: {},
      metoda_wysylki: 'osobisty', kwota_pobrania: null, chce_fakture: 1, nip: null,
      kwota_brutto: '123.00', status_woo: 'processing', oplacone_at: null, anulowane: 0 }, {});
    db.prepare('INSERT INTO faktury (zamowienie_id, utworzona_at) VALUES (?, ?)').run(id, '2026-10-29T07:27:00Z');
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/drukuj` });
    expect(r.statusCode).toBe(400);
    expect(r.body).toBe(`Ta faktura nie ma jeszcze dokumentu w ${nazwa.miejscownik} — nie ma czego drukować.`);
    expect(r.body).not.toContain('inFakt');
  });
});

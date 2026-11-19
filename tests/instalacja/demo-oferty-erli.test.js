import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { modulyDla } from '../../src/moduly/lista.ts';
import { ENV_DEMO, utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { uzupelnijDemoErli } from '../../scripts/demo-dane-erli.mjs';
import { createAtrapaErli } from '../../deploy/proba/atrapy/erli.mjs';
import { katalogErli } from '../../src/integracje/kanal-modul.ts';
import { createPetlaOfert } from '../../src/moduly/magazyn/services/petla-ofert.js';
import { ofertyKarty, ustawieniaOfertKonta } from '../../src/oms/db/oferty-kanalow.ts';

let db, katalog;
afterEach(() => {
  db?.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('demo przez istniejące uzupełnienie ERLI zachowuje sześć scenariuszy, bez zapisu i duplikatów', async () => {
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  katalog = mkdtempSync(join(tmpdir(), 'demo-oferty-erli-'));
  const baza = join(katalog, 'demo.sqlite');
  const env = { ...ENV_DEMO };
  await utworzBazeDemo({ baza, dzis: '2026-11-13', env });
  db = openOmsDb(baza, { moduly: modulyDla(env) });
  const opcje = { db, kanal: 'erli_polcien', env, teraz: () => new Date('2026-11-13T12:00:00Z'), log: () => {} };
  const atrapa = createAtrapaErli({ ...opcje, demoZmiany: true });
  // Ta sama ścieżka co w piaskownicy po imporcie zamówień.
  await atrapa.oznaczPrzeczytane([]);
  const lista = () =>
    db
      .prepare('SELECT id FROM karty_produktow')
      .all()
      .flatMap((k) => ofertyKarty(db, k.id))
      .filter((o) => o.kanal === opcje.kanal);
  const oferty = lista();
  expect(oferty).toHaveLength(120);
  expect(new Set(oferty.map((o) => o.kartaId)).size).toBe(120);
  expect(oferty).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ stan: 'aktywna', odczytStatus: 'active', problemy: [] }),
      expect.objectContaining({ stan: 'do_wyslania', wyslanoAt: null }),
      expect.objectContaining({
        stan: 'problem',
        problemy: expect.arrayContaining([
          expect.objectContaining({ tekst: expect.stringMatching(/ERLI.*kategori/), kod: 'category' }),
        ]),
      }),
      expect.objectContaining({ stan: 'blad', blad: expect.stringMatching(/ERLI/) }),
      expect.objectContaining({
        stan: 'aktywna',
        cenaDoPotwierdzeniaGr: expect.any(Number),
        problemy: expect.arrayContaining([expect.objectContaining({ kod: 'cena' })]),
      }),
      expect.objectContaining({ pochodzenie: 'przejeta', tryb: 'obserwowana' }),
    ]),
  );
  expect(ustawieniaOfertKonta(db, opcje.kanal)).toMatchObject({ czynne: false, stalaIlosc: 5 });
  const szukajProduktow = () => atrapa.szukajProduktow({ pagination: { limit: 200 } });
  const produkty = await szukajProduktow();
  const istniejace = oferty.filter((o) => o.wyslanoAt || o.pochodzenie === 'przejeta');
  expect(produkty.map((p) => p.externalId).sort()).toEqual(istniejace.map((o) => o.idZewnetrzne).sort());
  for (const o of istniejace) {
    const karta = db.prepare('SELECT * FROM karty_produktow WHERE id=?').get(o.kartaId);
    expect(produkty.find((p) => p.externalId === o.idZewnetrzne)).toMatchObject({
      name: karta.nazwa,
      sku: karta.sku,
      price: o.odczytCenaGr,
      stock: o.odczytIlosc,
      status: o.odczytStatus,
    });
  }
  const cena = oferty.find((o) => o.cenaDoPotwierdzeniaGr !== null);
  expect(cena.cenaDoPotwierdzeniaGr).toBeGreaterThan(cena.odczytCenaGr * 1.2);
  await expect(uzupelnijDemoErli(opcje)).resolves.toBeUndefined();
  expect(lista()).toEqual(oferty);
  const stabilneProdukty = (lista) =>
    lista.map(({ externalId, name, sku, price, stock, status }) => ({ externalId, name, sku, price, stock, status }));
  expect(stabilneProdukty(await szukajProduktow())).toEqual(stabilneProdukty(produkty));
  await uzupelnijDemoErli({ ...opcje, kanal: 'erli_inny' });
  expect(lista()).toEqual(oferty);
  const zapisy = ['utworzProdukt', 'zmienProdukt', 'zmienProdukty'].map((m) => vi.spyOn(atrapa, m));
  const petla = createPetlaOfert({
    db,
    teraz: opcje.teraz,
    konta: () => [{ klucz: opcje.kanal, katalog: katalogErli(atrapa), tylkoOdczyt: () => false }],
  });
  for (let i = 0; i < 4; i++) {
    await petla.przebieg();
    expect(
      lista().map(({ kartaId, stan, tryb, cenaDoPotwierdzeniaGr, problemy, blad }) => ({
        kartaId,
        stan,
        tryb,
        cenaDoPotwierdzeniaGr,
        problemy,
        blad,
      })),
    ).toEqual(
      oferty.map(({ kartaId, stan, tryb, cenaDoPotwierdzeniaGr, problemy, blad }) => ({
        kartaId,
        stan,
        tryb,
        cenaDoPotwierdzeniaGr,
        problemy,
        blad,
      })),
    );
  }
  for (const zapis of zapisy) expect(zapis).not.toHaveBeenCalled();
  expect(siec).not.toHaveBeenCalled();
  console.log(
    `Demo: ${oferty.length} ofert; ${produkty.length} produktów atrapy; konto wstrzymane; ponowne zasianie bez zmian.`,
  );
});

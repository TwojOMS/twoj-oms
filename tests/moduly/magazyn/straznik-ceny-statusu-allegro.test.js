// Strażnik: flaga „cena z OMS” albo „status z OMS” na ofercie obserwowanej nie otwiera drogi do treści,
// zdjęć ani ilości. Sterowanie ceną oddaje OMS-owi wyłącznie cenę — PATCH oferty, wgranie zdjęcia czy komenda
// ilości na takiej ofercie nadpisałyby to, czym sprzedawca nadal zarządza w Allegro.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zmienOferte, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { bramkaZapisu } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';

const mock = vi.hoisted(() => ({ migawka: null }));
vi.mock('../../../src/oms/db/stany-magazynowe.js', async (importOriginal) => {
  const oryginal = await importOriginal();
  return {
    ...oryginal,
    migawkaStanow: vi.fn(() => mock.migawka),
    wyjasnieniaOfert: vi.fn(
      (_db, oferty) =>
        new Map(
          oferty.map((o) => [
            o.id,
            {
              sprzedaneOd: 0,
              anulowaneOd: 0,
              wyjasnioneKarty: 1,
              poller: { ostatniPrzebiegAt: '2026-11-14T11:59:59Z', ostatniBlad: null },
            },
          ]),
        ),
    ),
  };
});
// Treść z OMS różni się od Allegro (inna nazwa i cena, zdjęcie do wgrania) — gdyby bramka puściła, pętla
// miałaby co wysłać.
vi.mock('../../../src/moduly/magazyn/services/tresc-oferty-allegro.js', () => ({
  ofertaAllegroKarty: (_db, kartaId, _konto, opcje) => ({
    bledy: [],
    doWgrania: [{ id: 900 + kartaId, typ: 'image/jpeg', ai: 0 }],
    droga: 'nowy',
    zadanie: {
      name: 'Lampa Półcień — nowa nazwa z OMS',
      stock: { available: opcje?.migawka?.stany.get(kartaId)?.stan ?? 5 },
      sellingMode: { price: { amount: '64.90' } },
    },
  }),
}));

const KLUCZ = 'allegro-polcien';
const zamknij = [];
afterEach(() => {
  zamknij.splice(0).forEach((f) => f());
  vi.clearAllMocks();
});

function srodowisko() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  zamknij.push(() => db.close());
  const ms = Date.parse('2026-11-14T12:00:00Z');
  mock.migawka = {
    wlaczone: true,
    przelaczenieId: 1,
    zatwierdzenie: { przelaczenieId: 1 },
    znane: new Set(),
    stany: new Map(),
    policzonoAt: new Date(ms).toISOString(),
  };
  const odczyty = [];
  const allegro = {
    komendaIlosci: vi.fn(async () => {}),
    komendaCeny: vi.fn(async () => {}),
    komendaPublikacji: vi.fn(async () => {}),
    wynikKomendy: vi.fn(async () => []),
    wgrajZdjecie: vi.fn(async () => ({ location: 'https://polcien.example.invalid/wgrane.jpg' })),
    podgladOplat: vi.fn(),
  };
  const katalog = {
    odczytOfert: vi.fn(async () => ({ ok: true, dane: { oferty: odczyty } })),
    zmienOferte: vi.fn(async () => ({ ok: true, dane: {} })),
  };
  const konto = { klucz: KLUCZ, zgoda: true, allegro, katalog };
  zapiszUstawieniaOfertKonta(db, KLUCZ, { czynne: true, stalaIlosc: 5 });
  /** Oferta obserwowana: stan magazynu 3, Allegro pokazuje 7 sztuk i starą treść. */
  const dodaj = (flagi) => {
    const kartaId = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 5900, stawka_vat: '23' });
    mock.migawka.znane.add(kartaId);
    mock.migawka.stany.set(kartaId, { stan: 3 });
    const o = wstawOferte(db, {
      kartaId,
      kanal: KLUCZ,
      idZewnetrzne: `oferta-${kartaId}`,
      pochodzenie: 'przejeta',
      tryb: 'obserwowana',
      stan: 'aktywna',
    });
    zmienOferte(db, o.id, {
      ...flagi,
      odczytIlosc: 7,
      wyslanaIlosc: 7,
      odczytanoAt: '2026-11-14T11:58:00Z',
    });
    odczyty.push({
      id: o.idZewnetrzne,
      publication: { status: 'ACTIVE' },
      stock: { available: 7 },
      sellingMode: { price: { amount: '59.00' } },
    });
    db.prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?').run('Lampa Półcień — nowa nazwa', kartaId);
    return o;
  };
  const przebieg = () =>
    createPetlaOfertAllegro({
      db,
      konta: () => [konto],
      teraz: () => new Date(ms),
      pollerMs: 60_000,
      zwolnijOperacje: vi.fn(),
      czytajZdjecie: vi.fn(async () => new Uint8Array([1])),
      log: vi.fn(),
    }).przebieg();
  return { dodaj, przebieg, allegro, katalog };
}

describe('pętla ofert Allegro na ofercie obserwowanej z flagą ceny albo statusu', () => {
  for (const flaga of ['cenaZOms', 'statusZOms']) {
    it(`${flaga} bez ilości z OMS: zero PATCH treści, zero zdjęć, zero komend ilości`, async () => {
      const e = srodowisko();
      e.dodaj({ [flaga]: true });
      await e.przebieg();
      expect(e.katalog.odczytOfert).toHaveBeenCalled();
      expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
      expect(e.allegro.wgrajZdjecie).toHaveBeenCalledTimes(0);
      expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    });

    // Ilość z OMS wpuszcza ofertę do przebiegu zapisów; wtedy o treści i zdjęciach decyduje sama bramka zapisu.
    it(`${flaga} razem z ilością z OMS: wychodzi tylko ilość, nadal zero PATCH treści i zero zdjęć`, async () => {
      const e = srodowisko();
      e.dodaj({ [flaga]: true, iloscZOms: true });
      await e.przebieg();
      expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(1);
      expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
      expect(e.allegro.wgrajZdjecie).toHaveBeenCalledTimes(0);
    });
  }
});

describe('bramka zapisu: flaga obserwowanej otwiera tylko swój zakres', () => {
  const konto = { klucz: KLUCZ, tylkoOdczyt: () => false };
  const wolno = (flagi, zakres) =>
    bramkaZapisu({
      konto,
      ustawienia: { czynne: true },
      oferta: { kanal: KLUCZ, tryb: 'obserwowana', ...flagi },
      klucze: [KLUCZ],
      kanal: 'Allegro',
      zakres,
    }).wolno;

  it('cena_z_oms=1 wpuszcza tylko zakres „cena”', () => {
    expect(wolno({ cena_z_oms: 1 }, 'cena')).toBe(true);
    for (const zakres of [null, 'ilosc', 'status']) expect(wolno({ cena_z_oms: 1 }, zakres)).toBe(false);
  });
  it('status_z_oms=1 wpuszcza tylko zakres „status”', () => {
    expect(wolno({ status_z_oms: 1 }, 'status')).toBe(true);
    for (const zakres of [null, 'ilosc', 'cena']) expect(wolno({ status_z_oms: 1 }, zakres)).toBe(false);
  });
});

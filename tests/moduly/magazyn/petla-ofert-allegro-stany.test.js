import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  wstawOferte,
  ofertaPoId,
  zmienOferte,
  zapiszUstawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { migawkaStanow, wyjasnieniaOfert, przelaczStany, dodajRuch } from '../../../src/oms/db/stany-magazynowe.js';

const mock = vi.hoisted(() => ({ migawka: null, wyjasnienie: {}, blad: false, bladWyjasnien: false }));
vi.mock('../../../src/oms/db/stany-magazynowe.js', async (importOriginal) => {
  const oryginal = await importOriginal();
  return {
    ...oryginal,
    migawkaStanow: vi.fn((db) => {
      if (mock.blad) throw new Error('migawka');
      return mock.migawka ?? oryginal.migawkaStanow(db);
    }),
    // `mock.wyjasnienie` jako funkcja liczy wyjaśnienie z okna wiersza (`od`), jak prawdziwe zapytanie.
    wyjasnieniaOfert: vi.fn((db, oferty) => {
      if (mock.bladWyjasnien) throw new Error('wyjaśnienia');
      return mock.wyjasnienie == null
        ? oryginal.wyjasnieniaOfert(db, oferty)
        : new Map(
            oferty.map((o) => [o.id, typeof mock.wyjasnienie === 'function' ? mock.wyjasnienie(o) : mock.wyjasnienie]),
          );
    }),
  };
});
vi.mock('../../../src/moduly/magazyn/services/tresc-oferty-allegro.js', () => ({
  ofertaAllegroKarty: (_db, kartaId, _konto, opcje) => ({
    bledy: [],
    doWgrania: [],
    droga: 'nowy',
    zadanie: {
      name: 'Lampa Półcień',
      stock: { available: opcje?.migawka?.wlaczone ? opcje.migawka.stany.get(kartaId)?.stan : 5 },
      sellingMode: { price: { amount: '59.00' } },
    },
  }),
}));

const zamknij = [];
afterEach(() => {
  zamknij.splice(0).forEach((f) => f());
  vi.clearAllMocks();
});
function srodowisko({ wlaczone = true, czynne = true } = {}) {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  zamknij.push(() => db.close());
  let ms = Date.parse('2026-11-14T12:00:00Z');
  const iso = () => new Date(ms).toISOString();
  mock.blad = false;
  mock.bladWyjasnien = false;
  mock.migawka = {
    wlaczone,
    przelaczenieId: 1,
    zatwierdzenie: { przelaczenieId: 1 },
    znane: new Set(),
    stany: new Map(),
    policzonoAt: iso(),
  };
  mock.wyjasnienie = {
    sprzedaneOd: 2,
    anulowaneOd: 0,
    wyjasnioneKarty: 2,
    poller: { ostatniPrzebiegAt: '2026-11-14T11:59:59Z', ostatniBlad: null },
  };
  const odczyty = [];
  const wyslane = new Map();
  const allegro = {
    komendaIlosci: vi.fn(async (id, pozycje) => {
      wyslane.set(
        id,
        pozycje.map((p) => p.ofertaId),
      );
    }),
    komendaCeny: vi.fn(async (id, pozycje) => {
      wyslane.set(
        id,
        pozycje.map((p) => p.ofertaId),
      );
    }),
    komendaPublikacji: vi.fn(async (id, ids) => {
      wyslane.set(id, ids);
    }),
    wynikKomendy: vi.fn(async (_rodzaj, id) =>
      (wyslane.get(id) ?? []).map((id) => ({ offer: { id }, status: 'SUCCESS' })),
    ),
    podgladOplat: vi.fn(),
  };
  const katalog = {
    odczytOfert: vi.fn(async () => ({ ok: true, dane: { oferty: odczyty } })),
    zmienOferte: vi.fn(async () => ({ ok: true, dane: {} })),
  };
  const konto = { klucz: 'allegro-polcien', zgoda: true, allegro, katalog };
  zapiszUstawieniaOfertKonta(db, konto.klucz, { czynne, stalaIlosc: 5 });
  const log = vi.fn();
  const petla = () =>
    createPetlaOfertAllegro({
      db,
      konta: () => [konto],
      teraz: () => new Date(ms),
      pollerMs: 60_000,
      zwolnijOperacje: vi.fn(),
      czytajZdjecie: vi.fn(),
      log,
    });
  const dodaj = ({ stan = 3, odczyt = 5, status = 'ACTIVE', tryb = 'obserwowana', flaga = true, pola = {} } = {}) => {
    const kartaId = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 5900, stawka_vat: '23' });
    mock.migawka.znane.add(kartaId);
    mock.migawka.stany.set(kartaId, { stan });
    const o = wstawOferte(db, {
      kartaId,
      kanal: konto.klucz,
      idZewnetrzne: `oferta-${kartaId}`,
      tryb,
      stan: status === 'ENDED' ? 'nieaktywna' : 'aktywna',
    });
    zmienOferte(db, o.id, {
      iloscZOms: flaga,
      wyslanePola: pola,
      odczytIlosc: odczyt,
      odczytanoAt: '2026-11-14T11:58:00Z',
      wyslanaIlosc: odczyt,
    });
    const x = {
      id: o.idZewnetrzne,
      publication: { status },
      stock: { available: odczyt },
      sellingMode: { price: { amount: '59.00' } },
    };
    odczyty.push(x);
    return { id: o.id, kartaId, x, w: () => ofertaPoId(db, o.id) };
  };
  const krok = async (p) => {
    ms += 120_000;
    mock.migawka.policzonoAt = iso();
    if (mock.wyjasnienie?.poller) mock.wyjasnienie.poller.ostatniPrzebiegAt = new Date(ms - 1000).toISOString();
    await p.przebieg();
  };
  return {
    db,
    dodaj,
    petla,
    krok,
    allegro,
    katalog,
    log,
    konto,
    ms: () => ms,
    przesun: (d) => {
      ms += d;
    },
  };
}

describe('ilość Allegro', () => {
  it('sprzedaż 2 sztuk w innym kanale daje jedną FIXED i zapis bazy po SUCCESS', async () => {
    const e = srodowisko();
    const o = e.dodaj();
    przelaczStany(e.db, { wlacz: true, at: '2026-11-14T10:00:00Z' });
    e.db
      .prepare(
        `INSERT INTO stany_zatwierdzenia (przelaczenie_id, zatwierdzono_at, ofert, skrot)
      VALUES (1, '2026-11-14T10:01:00Z', 1, 'sprzedaz-erli')`,
      )
      .run();
    dodajRuch(e.db, {
      kartaId: o.kartaId,
      rodzaj: 'przyjecie',
      ilosc: 5,
      klucz: 'lampy-erli-przyjecie',
      at: '2026-11-14T10:02:00Z',
    });
    powiazProdukt(
      e.db,
      zapiszProduktSklepowy(e.db, {
        kanal: 'erli-polcien',
        produkt_id: 'lampa-1',
        wariant_id: '',
        nazwa: 'Lampa Półcień',
        odczytane_at: '2026-11-14T10:00:00Z',
      }),
      o.kartaId,
    );
    zapiszZamowienie(
      e.db,
      'erli-polcien',
      {
        zrodlo_id: 'zakup-1',
        numer: 'zakup-1',
        klient: {},
        dostawa: {},
        metoda_wysylki: 'kurier',
        kwota_pobrania: null,
        chce_fakture: 0,
        nip: null,
        status_woo: null,
        oplacone_at: null,
        anulowane: 0,
        kwota_brutto: '118.00',
        utworzone_at: '2026-11-14T11:00:00Z',
        pozycje: [
          {
            zrodlo_id: 'poz-1',
            produkt_id: 'lampa-1',
            oferta_id: null,
            wariant_id: null,
            sku: null,
            zdjecie_url: null,
            nazwa: 'Lampa Półcień',
            ilosc: 2,
            cena_brutto: '59.00',
            vat: '23',
          },
        ],
      },
      {},
    );
    mock.migawka = null;
    mock.wyjasnienie = null;
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci.mock.calls[0]?.[1]).toEqual([{ ofertaId: o.x.id, ilosc: 3 }]);
    expect(o.w()).toMatchObject({ wyslanaIlosc: 3, stanKartyWyslany: 3 });
    expect(o.w().iloscWyslanaAt).toBeTruthy();
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('stock 1'));
  });
  it('trzy cele dają trzy komendy, obniżki przed podwyżką', async () => {
    const e = srodowisko();
    e.dodaj({ stan: 7 });
    e.dodaj({ stan: 4 });
    e.dodaj({ stan: 2 });
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1][0].ilosc)).toEqual([4, 2, 7]);
  });
  it('zero kończy publikację; UUID i znacznik są zapisane przed PUT', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 0 });
    e.allegro.komendaPublikacji.mockImplementation(async (id, ids, akcja) => {
      expect(o.w().wyslanePola.komendaPublikacji).toMatchObject({ id, wartosc: 'END' });
      expect(o.w().wyslanePola.zakonczonaPrzezOms.at).toBeTruthy();
      expect(ids).toEqual([o.x.id]);
      expect(akcja).toBe('END');
    });
    await e.petla().przebieg();
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });
  it('przejęta bez mapy kategorii: FIXED 3, po SUCCESS ACTIVATE, bez fee-preview i treści', async () => {
    const e = srodowisko();
    const o = e.dodaj({ odczyt: 0, status: 'ENDED' });
    const p = e.petla();
    // ACTIVATE dopiero, gdy odczyt pokazuje wysłane 3 (FIXED wykonany w Allegro).
    await p.przebieg();
    o.x.stock.available = 3;
    await e.krok(p);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaPublikacji.mock.calls[0]?.slice(1)).toEqual([[o.x.id], 'ACTIVATE']);
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
    expect(e.allegro.podgladOplat).toHaveBeenCalledTimes(0);
  });
  it('ACTIVATE czeka na SUCCESS ilości także po restarcie', async () => {
    const e = srodowisko();
    const o = e.dodaj({ odczyt: 0, status: 'ENDED' });
    e.allegro.wynikKomendy.mockResolvedValue([{ offer: { id: o.x.id }, status: 'NEW' }]);
    const p = e.petla();
    await p.przebieg();
    await e.krok(p);
    const id = o.w().wyslanePola.komendaIlosci.id;
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    e.allegro.wynikKomendy.mockResolvedValue([{ offer: { id: o.x.id }, status: 'SUCCESS' }]);
    o.x.stock.available = 3;
    await e.krok(e.petla());
    expect(e.allegro.wynikKomendy).toHaveBeenCalledWith('ilosc', id);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(1);
  });
  it('zarządzana zakończona przez OMS przy zachowanej ilości wznawia bez opłat', async () => {
    const e = srodowisko();
    const o = e.dodaj({
      stan: 4,
      odczyt: 5,
      status: 'ENDED',
      tryb: 'zarzadzana',
      pola: { zakonczonaPrzezOms: { at: '2026-11-14T10:00:00Z' } },
    });
    await e.petla().przebieg();
    expect(e.katalog.zmienOferte).toHaveBeenCalledWith(o.x.id, {
      stock: { available: 4 },
      publication: { status: 'ACTIVE' },
    });
    expect(e.allegro.podgladOplat).toHaveBeenCalledTimes(0);
  });
  it.each(['obserwowana', 'zarzadzana'])('ręcznie zakończona %s z 5 sztukami czeka na człowieka', async (tryb) => {
    const e = srodowisko();
    const o = e.dodaj({ status: 'ENDED', tryb });
    await e.petla().przebieg();
    expect(o.w().stan).toBe('problem');
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
  });
  it('fulfillment FAIL trwale blokuje ilość i druga próba nie wychodzi', async () => {
    const e = srodowisko();
    const o = e.dodaj();
    e.allegro.wynikKomendy.mockResolvedValue([
      { offer: { id: o.x.id }, status: 'FAIL', errors: [{ code: 'AvailableStockCannotBeChanged' }] },
    ]);
    const p = e.petla();
    await p.przebieg();
    await e.krok(p);
    expect(o.w().iloscProblem).toMatchObject({ kod: 'ilosc-niezmienialna', wstrzymuje: true });
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(1);
  });
  it('pięć awarii wznowienia zarządzanej zatrzymuje ponawianie', async () => {
    const e = srodowisko();
    const o = e.dodaj({ status: 'ENDED', odczyt: 0, tryb: 'zarzadzana' });
    e.katalog.zmienOferte.mockRejectedValue(new Error('awaria'));
    const p = e.petla();
    for (let i = 0; i < 8; i++) {
      zmienOferte(e.db, o.id, { nastepnaProbaAt: null });
      await e.krok(p);
    }
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(5);
    expect(o.w().stan).toBe('problem');
  });
  it.each(['skok', 'zero-masowe', 'brak-stanu', 'stany-niezatwierdzone'])(
    'bezpiecznik %s blokuje wysyłkę ilości',
    async (kod) => {
      const e = srodowisko();
      const o = e.dodaj({ stan: kod === 'zero-masowe' ? 0 : 3 });
      if (kod === 'skok') zmienOferte(e.db, o.id, { stanKartyWyslany: 20 });
      if (kod === 'zero-masowe') {
        e.dodaj({ stan: 0 });
        e.dodaj({ stan: 0 });
      }
      if (kod === 'brak-stanu') mock.migawka.znane.clear();
      if (kod === 'stany-niezatwierdzone') mock.migawka.zatwierdzenie = null;
      await e.petla().przebieg();
      expect(o.w().iloscProblem?.kod).toBe(kod);
      expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
      expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    },
  );
  it('konto wyłączone nie wykonuje żadnego żądania', async () => {
    const e = srodowisko({ czynne: false });
    e.dodaj();
    await e.petla().przebieg();
    expect(e.katalog.odczytOfert).toHaveBeenCalledTimes(0);
  });
  it('brak flagi obserwowanej i zmiana opisu nie wysyłają treści ani ilości', async () => {
    const e = srodowisko();
    const o = e.dodaj({ flaga: false });
    e.db.prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?').run('Lampa zmieniona', o.kartaId);
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
  });
  it('obserwowana z flagą po zmianie opisu wysyła wyłącznie ilość', async () => {
    const e = srodowisko();
    const o = e.dodaj();
    e.db.prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?').run('Lampa zmieniona', o.kartaId);
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaCeny).toHaveBeenCalledTimes(0);
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
  });
  it('null ilości nie blokuje ceny i treści zarządzanej', async () => {
    const e = srodowisko();
    const o = e.dodaj({ tryb: 'zarzadzana' });
    mock.migawka.znane.clear();
    o.x.sellingMode.price.amount = '58.00';
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaCeny).toHaveBeenCalledTimes(1);
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(1);
    expect(o.w().problemy).toEqual([]);
    expect(o.w().iloscProblem?.kod).toBe('brak-stanu');
  });
  it('zaległa ilość ACTIVE po SUCCESS nie wychodzi ponownie przy opóźnionej liście', async () => {
    const e = srodowisko();
    const o = e.dodaj();
    zmienOferte(e.db, o.id, {
      wyslanePola: { komendaIlosci: { id: 'uuid-przed-restartem', wartosc: 3, stanKarty: 3 } },
    });
    e.allegro.wynikKomendy.mockResolvedValue([{ offer: { id: o.x.id }, status: 'SUCCESS' }]);
    await e.petla().przebieg();
    expect(e.allegro.wynikKomendy).toHaveBeenCalledWith('ilosc', 'uuid-przed-restartem');
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(o.w().wyslanaIlosc).toBe(3);
  });
  it('odczyt niepoprawny i fulfillment z listy nie zerują oferty', async () => {
    const e = srodowisko();
    const a = e.dodaj();
    a.x.stock.available = null;
    const b = e.dodaj();
    b.x.isFulfillment = true;
    await e.petla().przebieg();
    expect(a.w().iloscProblem?.kod).toBe('karencja');
    expect(b.w().iloscProblem?.kod).toBe('ilosc-niezmienialna');
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });
  it('migawka jest jedna na przebieg, jej awaria nie wysyła ilości', async () => {
    const e = srodowisko();
    e.dodaj();
    e.dodaj();
    mock.blad = true;
    await e.petla().przebieg();
    expect(migawkaStanow).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });
  it('publikacja używa klienta konta przy starszym adapterze węzłów', async () => {
    const e = srodowisko();
    e.dodaj({ stan: 0 });
    const publikacja = e.allegro.komendaPublikacji;
    e.konto.klient = { komendaPublikacji: publikacja };
    delete e.allegro.komendaPublikacji;
    await e.petla().przebieg();
    expect(publikacja).toHaveBeenCalledTimes(1);
  });
  it('brak pollera zatrzymuje podwyżkę, pozwala obniżyć', async () => {
    const e = srodowisko();
    mock.wyjasnienie.poller = null;
    const gora = e.dodaj({ stan: 7 });
    const dol = e.dodaj();
    await e.petla().przebieg();
    expect(gora.w().iloscProblem?.kod).toBe('brak-pollera');
    expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1])).toEqual([[{ ofertaId: dol.x.id, ilosc: 3 }]]);
  });
  it('rozjazd w górę zachowuje alarm i obniża do celu', async () => {
    const e = srodowisko();
    const o = e.dodaj({ odczyt: 12 });
    zmienOferte(e.db, o.id, { wyslanaIlosc: 5 });
    await e.petla().przebieg();
    expect(o.w().iloscProblem?.kod).toBe('rozjazd-gora');
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(1);
  });
  it('niepotwierdzony alarm rozjazdu w górę nadal blokuje podwyżkę', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 7 });
    zmienOferte(e.db, o.id, { iloscProblem: { kod: 'rozjazd-gora', wstrzymuje: true, od: '2026-11-14T10:00:00Z' } });
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(o.w().iloscProblem?.kod).toBe('rozjazd-gora');
  });
  it('rozjazd w dół po karencji wstrzymuje obniżkę', async () => {
    const e = srodowisko();
    const o = e.dodaj({ odczyt: 2, stan: 1 });
    zmienOferte(e.db, o.id, { wyslanaIlosc: 10, iloscProblem: { kod: 'karencja', od: '2026-11-14T11:00:00Z' } });
    await e.petla().przebieg();
    expect(o.w().iloscProblem?.kod).toBe('rozjazd-dol');
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });
  it('po ACTIVATE opóźniona lista nie uruchamia drugiego wznowienia', async () => {
    const e = srodowisko();
    const o = e.dodaj({ odczyt: 0, status: 'ENDED' });
    const p = e.petla();
    await p.przebieg();
    o.x.stock.available = 3;
    await e.krok(p);
    await e.krok(p);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(1);
  });
  it.each(['obserwowana', 'zarzadzana'])('odczyt potwierdzający END aktualizuje lokalny stan %s', async (tryb) => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 0, tryb });
    const p = e.petla();
    await p.przebieg();
    o.x.publication.status = 'ENDED';
    await e.krok(p);
    expect(o.w().stan).toBe('nieaktywna');
  });
  it('odczyt potwierdzający ACTIVATE przywraca lokalny stan aktywny przejętej', async () => {
    const e = srodowisko();
    const o = e.dodaj({ odczyt: 0, status: 'ENDED' });
    const p = e.petla();
    await p.przebieg();
    o.x.stock.available = 3;
    await e.krok(p);
    o.x.publication.status = 'ACTIVE';
    await e.krok(p);
    expect(o.w().stan).toBe('aktywna');
  });
  it('przyspiesz scala zgłoszenia i zachowuje odstęp 60 s', async () => {
    vi.useFakeTimers();
    try {
      const e = srodowisko();
      const p = e.petla();
      await p.przebieg();
      p.przyspiesz();
      p.przyspiesz();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(migawkaStanow).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(migawkaStanow).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('przyspiesz w trakcie zachowuje następny przebieg', async () => {
    vi.useFakeTimers();
    try {
      const e = srodowisko();
      e.dodaj();
      const p = e.petla();
      let dokoncz;
      e.katalog.odczytOfert.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            dokoncz = resolve;
          }),
      );
      const trwa = p.przebieg();
      p.przyspiesz();
      dokoncz({ ok: true, dane: { oferty: [] } });
      await trwa;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(migawkaStanow).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it.each([0, 1, 2])(
    'bliźniak wyłączonych stanów (wariant %i): obserwowana bez zapisu, zarządzana stałe 5',
    async (historia) => {
      const e = srodowisko({ wlaczone: false });
      e.dodaj({ stan: 99, odczyt: 3 });
      const o = e.dodaj({ stan: 99, odczyt: 3, tryb: 'zarzadzana' });
      if (historia) {
        przelaczStany(e.db, { wlacz: true, at: '2026-11-14T10:00:00Z' });
        if (historia === 2)
          e.db
            .prepare(
              `INSERT INTO stany_zatwierdzenia
        (przelaczenie_id, zatwierdzono_at, ofert, skrot) VALUES (1, '2026-11-14T10:01:00Z', 2, 'blizniak')`,
            )
            .run();
        przelaczStany(e.db, { wlacz: false, at: '2026-11-14T11:00:00Z' });
      }
      mock.migawka = null; // Rzeczywista historia i migawka z SQLite, nie samo ustawienie flagi.
      await e.petla().przebieg();
      expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1])).toEqual([[{ ofertaId: o.x.id, ilosc: 5 }]]);
      expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    },
  );
});

describe('przebiegi bez skoku ilości, alarm rozjazdu i awaria wyjaśnień', () => {
  it('siedem przebiegów po jednej sprzedaży Allegro (odczyt = cel) nie daje skoku', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 10, odczyt: 10 });
    const p = e.petla();
    zmienOferte(e.db, o.id, { stanKartyWyslany: 10, iloscWyslanaAt: new Date(e.ms() - 60_000).toISOString() });
    const sprzedaze = [];
    mock.wyjasnienie = (w) => {
      const n = sprzedaze.filter((t) => t > Date.parse(w.od)).length;
      return {
        sprzedaneOd: n,
        anulowaneOd: 0,
        wyjasnioneKarty: n,
        poller: { ostatniPrzebiegAt: new Date(e.ms() - 1000).toISOString(), ostatniBlad: null },
      };
    };
    for (let i = 0; i < 7; i++) {
      sprzedaze.push(e.ms() + 1000);
      mock.migawka.stany.set(o.kartaId, { stan: 9 - i });
      o.x.stock.available = 9 - i;
      await e.krok(p);
      expect(o.w().iloscProblem?.kod ?? null).not.toBe('skok');
    }
    expect(o.w()).toMatchObject({ stanKartyWyslany: 3, wyslanaIlosc: 3 });
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });
  it('alarm skoku przetrwa przebieg z awarią migawki i nie wysyła stałej ilości', async () => {
    const e = srodowisko();
    const o = e.dodaj({ tryb: 'zarzadzana' });
    o.x.stock.available = 3;
    const p = e.petla();
    zmienOferte(e.db, o.id, { stanKartyWyslany: 20, wyslanaIlosc: 3, odczytIlosc: 3 });
    await p.przebieg();
    expect(o.w().iloscProblem?.kod).toBe('skok');
    mock.blad = true;
    await e.krok(p);
    expect(o.w().iloscProblem?.kod).toBe('skok');
    mock.blad = false;
    await e.krok(p);
    expect(o.w().iloscProblem?.kod).toBe('skok');
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
  });
  it('alarm rozjazdu w górę przetrwa brak celu, brak odczytu i zgodny odczyt', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 3, odczyt: 3 });
    const p = e.petla();
    zmienOferte(e.db, o.id, { iloscProblem: { kod: 'rozjazd-gora', wstrzymuje: true, od: '2026-11-14T10:00:00Z' } });
    mock.migawka.znane.delete(o.kartaId);
    await e.krok(p);
    expect(o.w().iloscProblem?.kod).toBe('rozjazd-gora');
    mock.migawka.znane.add(o.kartaId);
    o.x.stock.available = null;
    await e.krok(p);
    expect(o.w().iloscProblem?.kod).toBe('rozjazd-gora');
    o.x.stock.available = 3;
    await e.krok(p);
    expect(o.w().iloscProblem).toMatchObject({ kod: 'rozjazd-gora', od: '2026-11-14T10:00:00Z' });
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });
  it('karencja z oceny rozjazdu nie nadpisuje alarmu w górę', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 2, odczyt: 3 });
    const p = e.petla();
    zmienOferte(e.db, o.id, {
      wyslanaIlosc: 10,
      iloscProblem: { kod: 'rozjazd-gora', wstrzymuje: true, od: '2026-11-14T12:01:30Z' },
    });
    await e.krok(p);
    expect(o.w().iloscProblem).toMatchObject({ kod: 'rozjazd-gora', od: '2026-11-14T12:01:30Z' });
  });
  it('awaria wyjaśnień pomija tylko ilość — cena idzie, zakończona nie jest wznawiana, przebieg trwa', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 2, odczyt: 5, tryb: 'zarzadzana' });
    o.x.sellingMode.price.amount = '58.00';
    const konczona = e.dodaj({ stan: 4, odczyt: 0, status: 'ENDED', tryb: 'zarzadzana' });
    e.dodaj({ stan: 1, odczyt: 5 });
    mock.bladWyjasnien = true;
    const wynik = await e
      .petla()
      .przebieg()
      .catch((err) => err);
    expect(wynik).toEqual({ pominiety: false });
    expect(wyjasnieniaOfert).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaCeny).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    expect(e.katalog.zmienOferte.mock.calls.filter((c) => c[0] === konczona.x.id)).toEqual([]);
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('pominięto ilość'));
    expect(e.log).not.toHaveBeenCalledWith(expect.stringContaining('synchronizacja oferty'));
    expect(o.w().iloscProblem).toBeNull();
  });
  it('wyłączone stany nie wołają wyjaśnień — ich awaria nie zmienia przebiegu bazy', async () => {
    const e = srodowisko({ wlaczone: false });
    e.dodaj({ stan: 99, odczyt: 3 });
    const o = e.dodaj({ stan: 99, odczyt: 3, tryb: 'zarzadzana' });
    mock.migawka = null;
    mock.bladWyjasnien = true;
    await e.petla().przebieg();
    expect(wyjasnieniaOfert).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1])).toEqual([[{ ofertaId: o.x.id, ilosc: 5 }]]);
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    expect(e.log).not.toHaveBeenCalledWith(expect.stringContaining('pominięto ilość'));
  });
  it('okno wyjaśnień obejmuje tylko oferty z ilością z OMS; baza starsza niż 7 dni nie ma okna (wyjaśnienia zerowe)', async () => {
    const e = srodowisko();
    const stara = e.dodaj();
    e.dodaj({ flaga: false });
    const swieza = e.dodaj();
    zmienOferte(e.db, stara.id, { iloscWyslanaAt: '2026-10-01T00:00:00Z' });
    zmienOferte(e.db, swieza.id, { iloscWyslanaAt: '2026-11-14T11:00:00Z' });
    await e.petla().przebieg();
    expect(wyjasnieniaOfert.mock.calls[0][1].map((w) => [w.id, w.od && Date.parse(w.od)])).toEqual([
      [stara.id, null],
      [swieza.id, Date.parse('2026-11-14T11:00:00Z')],
    ]);
  });
});

describe('ilość Allegro — bezpieczniki masowe, przerwy i wznowienia', () => {
  const ZNACZNIK = { zakonczonaPrzezOms: { at: '2026-11-14T10:00:00Z' } };
  const puls = (e) => ({ ostatniPrzebiegAt: new Date(e.ms() - 1000).toISOString(), ostatniBlad: null });
  const zera = (e) => ({ sprzedaneOd: 0, anulowaneOd: 0, wyjasnioneKarty: 0, poller: puls(e) });
  const publikacje = (e) => e.allegro.komendaPublikacji.mock.calls.map((c) => [c[1], c[2]]);

  it('ruch +20 w trakcie odczytu ofert liczy się po bazie — następny przebieg bez skoku, podwyżka po pulsie', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 3, odczyt: 3 });
    const p = e.petla();
    zmienOferte(e.db, o.id, { stanKartyWyslany: 3, iloscWyslanaAt: '2026-11-14T11:00:00Z' });
    const ruchy = [];
    mock.wyjasnienie = (w) => {
      const n = ruchy.filter((r) => r.t > Date.parse(w.od)).reduce((s, r) => s + r.n, 0);
      return { sprzedaneOd: 0, anulowaneOd: 0, wyjasnioneKarty: n, poller: puls(e) };
    };
    e.katalog.odczytOfert.mockImplementationOnce(async () => {
      e.przesun(30_000);
      ruchy.push({ t: e.ms() - 10_000, n: 20 });
      return { ok: true, dane: { oferty: [o.x] } };
    });
    await p.przebieg();
    expect(o.w().iloscWyslanaAt).toBe('2026-11-14T12:00:00.000Z');
    mock.migawka.stany.set(o.kartaId, { stan: 23 });
    await e.krok(p);
    expect(o.w().iloscProblem?.kod ?? null).not.toBe('skok');
    expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1])).toEqual([[{ ofertaId: o.x.id, ilosc: 23 }]]);
  });

  it('baza starsza niż 7 dni — prawdziwe W/stan karty i zerowe wyjaśnienia dają skok, bez komendy', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 20, odczyt: 3 });
    zmienOferte(e.db, o.id, { stanKartyWyslany: 3, iloscWyslanaAt: '2026-10-01T00:00:00Z' });
    // Okno sztucznie przycięte do 7 dni „wyjaśniłoby” 17 sztuk sprzed horyzontu.
    mock.wyjasnienie = (w) => {
      const n = w.od && Date.parse(w.od) < Date.parse('2026-11-10T00:00:00Z') ? 17 : 0;
      return { sprzedaneOd: 0, anulowaneOd: 0, wyjasnioneKarty: n, poller: puls(e) };
    };
    await e.petla().przebieg();
    expect(o.w().iloscProblem?.kod).toBe('skok');
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
  });

  it('trzy oferty ENDED nie robią bezpiecznika masowego — czwarta aktywna z celem 0 dostaje END', async () => {
    const e = srodowisko();
    for (let i = 0; i < 3; i++) e.dodaj({ stan: 0, odczyt: 3, status: 'ENDED', pola: ZNACZNIK });
    const czwarta = e.dodaj({ stan: 0, odczyt: 3 });
    await e.petla().przebieg();
    expect(czwarta.w().iloscProblem?.kod ?? null).not.toBe('zero-masowe');
    expect(publikacje(e)).toEqual([[[czwarta.x.id], 'END']]);
  });

  it('oferta ENDED nie dostaje alarmu zero-masowe od trzech aktywnych', async () => {
    const e = srodowisko();
    const aktywne = [0, 1, 2].map(() => e.dodaj({ stan: 0, odczyt: 3 }));
    const konczona = e.dodaj({ stan: 0, odczyt: 3, status: 'ENDED', pola: ZNACZNIK });
    await e.petla().przebieg();
    expect(aktywne.map((a) => a.w().iloscProblem?.kod)).toEqual(['zero-masowe', 'zero-masowe', 'zero-masowe']);
    expect(konczona.w().iloscProblem?.kod ?? null).toBeNull();
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
  });

  it('oferta INACTIVE z celem 0 nie dostaje END ani FIXED', async () => {
    const e = srodowisko();
    e.dodaj({ stan: 0, odczyt: 3, status: 'INACTIVE' });
    await e.petla().przebieg();
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });

  it('problem komendy ceny nie zatrzymuje END przy celu 0 i zostaje w wierszu', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 0, odczyt: 3, tryb: 'zarzadzana' });
    const cena = { kod: 'komenda', rodzaj: 'cena', tekst: 'Allegro odrzuciło cenę.' };
    zmienOferte(e.db, o.id, { stan: 'problem', problemy: [cena] });
    const p = e.petla();
    await p.przebieg();
    expect(publikacje(e)).toEqual([[[o.x.id], 'END']]);
    expect(o.w()).toMatchObject({ stan: 'problem', problemy: [cena] });
    o.x.publication.status = 'ENDED';
    await e.krok(p);
    expect(o.w()).toMatchObject({ stan: 'problem', problemy: [cena] });
    expect(o.w().wyslanePola.publikacjaWToku).toBeUndefined();
  });

  it('przerwa po błędzie ceny (nastepnaProbaAt) nie wstrzymuje END ilości', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 0, odczyt: 3, tryb: 'zarzadzana' });
    zmienOferte(e.db, o.id, { nastepnaProbaAt: '2026-11-14T13:00:00Z', liczbaProb: 2, blad: 'cena' });
    await e.petla().przebieg();
    expect(publikacje(e)).toEqual([[[o.x.id], 'END']]);
    expect(o.w()).toMatchObject({ liczbaProb: 2, nastepnaProbaAt: '2026-11-14T13:00:00Z' });
  });

  it('FAIL ilości ma własną przerwę i licznik — nie rusza przerwy ceny, po 5 próbach problem komendy', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 2, odczyt: 5, tryb: 'zarzadzana' });
    e.allegro.wynikKomendy.mockImplementation(async (rodzaj, id) => [
      { offer: { id: o.x.id }, status: 'FAIL', message: `odrzucono ${rodzaj}` },
    ]);
    const p = e.petla();
    for (let i = 0; i < 7; i++) {
      e.przesun(7_200_000);
      await p.przebieg();
    }
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(5);
    expect(o.w()).toMatchObject({ stan: 'problem', liczbaProb: 0, problemy: [{ kod: 'komenda', rodzaj: 'ilosc' }] });
    expect(o.w().wyslanePola.przerwaIlosci).toBeUndefined();
  });

  it('stany wyłączone: FAIL „AvailableStockCannotBeChanged” liczy się jak każdy FAIL — 5 komend, potem problem', async () => {
    const e = srodowisko({ wlaczone: false });
    const o = e.dodaj({ stan: 99, odczyt: 12, tryb: 'zarzadzana' });
    e.allegro.wynikKomendy.mockImplementation(async () => [
      { offer: { id: o.x.id }, status: 'FAIL', message: 'AvailableStockCannotBeChanged' },
    ]);
    const p = e.petla();
    for (let i = 0; i < 6; i++) {
      e.przesun(7_200_000);
      await p.przebieg();
    }
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(5);
    expect(o.w()).toMatchObject({ stan: 'problem', problemy: [{ kod: 'komenda', rodzaj: 'ilosc' }] });
    expect(o.w().iloscProblem).toBeNull();
  });

  it('po END rozjazd nie jest liczony, a nowa dostawa wznawia przejętą przez FIXED', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 0, odczyt: 3 });
    const p = e.petla();
    zmienOferte(e.db, o.id, { wyslanaIlosc: 5 });
    await p.przebieg();
    expect(publikacje(e)).toEqual([[[o.x.id], 'END']]);
    o.x.publication.status = 'ENDED';
    mock.wyjasnienie = zera(e);
    await e.krok(p);
    expect(o.w().iloscProblem).toBeNull();
    mock.migawka.stany.set(o.kartaId, { stan: 4 });
    mock.wyjasnienie = { ...zera(e), wyjasnioneKarty: 4 };
    await e.krok(p);
    expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1])).toEqual([[{ ofertaId: o.x.id, ilosc: 4 }]]);
  });

  it('ACTIVATE dopiero gdy odczyt równa się celowi wznowienia — inaczej najpierw FIXED', async () => {
    const e = srodowisko();
    const o = e.dodaj({
      stan: 3,
      odczyt: 20,
      status: 'ENDED',
      pola: { ...ZNACZNIK, wznowienieIlosc: { cel: 3, gotowe: true } },
    });
    await e.petla().przebieg();
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1])).toEqual([[{ ofertaId: o.x.id, ilosc: 3 }]]);
  });

  it('ACTIVATE wychodzi po obniżkach ilości', async () => {
    const e = srodowisko();
    const wznawiana = e.dodaj({
      stan: 3,
      odczyt: 3,
      status: 'ENDED',
      pola: { ...ZNACZNIK, wznowienieIlosc: { cel: 3, gotowe: true } },
    });
    const obnizana = e.dodaj({ stan: 2, odczyt: 5 });
    await e.petla().przebieg();
    expect(publikacje(e)).toEqual([[[wznawiana.x.id], 'ACTIVATE']]);
    expect(e.allegro.komendaIlosci.mock.calls.map((c) => c[1])).toEqual([[{ ofertaId: obnizana.x.id, ilosc: 2 }]]);
    expect(e.allegro.komendaIlosci.mock.invocationCallOrder[0]).toBeLessThan(
      e.allegro.komendaPublikacji.mock.invocationCallOrder[0],
    );
  });

  it('przejęta wznowiona 3 razy w ciągu doby czeka na człowieka (częste wznawianie)', async () => {
    const e = srodowisko();
    const wznowienia = ['2026-11-13T13:00:00Z', '2026-11-14T02:00:00Z', '2026-11-14T09:00:00Z'];
    const o = e.dodaj({ stan: 3, odczyt: 0, status: 'ENDED', pola: { ...ZNACZNIK, wznowienia } });
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    expect(e.allegro.komendaPublikacji).toHaveBeenCalledTimes(0);
    expect(o.w()).toMatchObject({ stan: 'problem', problemy: [{ kod: 'zakonczona', czeste: true }] });
    expect(o.w().problemy[0].tekst).toMatch(/Częste wznawianie/);
  });

  it('zarządzana wznowiona 3 razy w ciągu doby nie dostaje PATCH wznowienia', async () => {
    const e = srodowisko();
    const wznowienia = ['2026-11-13T13:00:00Z', '2026-11-14T02:00:00Z', '2026-11-14T09:00:00Z'];
    const o = e.dodaj({ stan: 3, odczyt: 0, status: 'ENDED', tryb: 'zarzadzana', pola: { ...ZNACZNIK, wznowienia } });
    await e.petla().przebieg();
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
    expect(o.w()).toMatchObject({ stan: 'problem', problemy: [{ kod: 'zakonczona', czeste: true }] });
  });

  it('przy stanach druga wyprzedaż w ciągu doby wznawia zarządzaną (limit 3/dobę zamiast 24 h)', async () => {
    const e = srodowisko();
    const o = e.dodaj({
      stan: 3,
      odczyt: 0,
      status: 'ENDED',
      tryb: 'zarzadzana',
      pola: { ...ZNACZNIK, wznowionaAt: '2026-11-14T10:00:00Z', wznowienia: ['2026-11-14T10:00:00Z'] },
    });
    await e.petla().przebieg();
    expect(e.katalog.zmienOferte).toHaveBeenCalledWith(o.x.id, {
      stock: { available: 3 },
      publication: { status: 'ACTIVE' },
    });
    expect(o.w().wyslanePola.wznowienia).toHaveLength(2);
  });

  it('stany wyłączone: odczyt ACTIVE kasuje znacznik zakończenia przez OMS', async () => {
    const e = srodowisko({ wlaczone: false });
    const o = e.dodaj({ stan: 5, odczyt: 5, tryb: 'zarzadzana', pola: ZNACZNIK });
    await e.petla().przebieg();
    expect(o.w().wyslanePola.zakonczonaPrzezOms).toBeUndefined();
  });

  it('stany wyłączone: piąty FAIL z zaległej komendy kończy wiersz problemem, bez szóstej komendy', async () => {
    const e = srodowisko({ wlaczone: false });
    const o = e.dodaj({ stan: 99, odczyt: 12, tryb: 'zarzadzana' });
    const znane = new Set();
    e.allegro.wynikKomendy.mockImplementation(async (_r, id) => {
      if (!znane.has(id)) {
        znane.add(id);
        return [];
      }
      return [{ offer: { id: o.x.id }, status: 'FAIL', message: 'Allegro odrzuciło ilość.' }];
    });
    const p = e.petla();
    for (let i = 0; i < 12; i++) {
      e.przesun(7_200_000);
      await p.przebieg();
    }
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(5);
    expect(o.w()).toMatchObject({ stan: 'problem', problemy: [{ kod: 'komenda', rodzaj: 'ilosc' }] });
  });

  it('ręczne „Wznów” przy celu 0 kończy się powodem i zdjęciem znacznika', async () => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 0, odczyt: 0, status: 'ENDED', tryb: 'zarzadzana', pola: { wznow: true } });
    await e.petla().przebieg();
    expect(o.w()).toMatchObject({
      stan: 'problem',
      problemy: [{ kod: 'zakonczona', tekst: 'Nie wznowiono: karta nie ma sztuk do wystawienia.' }],
    });
    expect(o.w().wyslanePola.wznow).toBeUndefined();
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(0);
  });

  it('bramka zamknięta między zebraniem a wysłaniem komendy ilości zatrzymuje komendę', async () => {
    const e = srodowisko();
    e.dodaj({ stan: 3, odczyt: 5 });
    e.dodaj({ stan: 5, odczyt: 5, tryb: 'zarzadzana' });
    e.katalog.zmienOferte.mockImplementation(async () => {
      zapiszUstawieniaOfertKonta(e.db, e.konto.klucz, { czynne: false, stalaIlosc: 5 });
      return { ok: true, dane: {} };
    });
    await e.petla().przebieg();
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });

  it('prawdziwy ofertaAllegroKarty — null ilości nie daje problemu karty, cena i treść idą', async () => {
    vi.resetModules();
    vi.doUnmock('../../../src/moduly/magazyn/services/tresc-oferty-allegro.js');
    const { createPetlaOfertAllegro: petlaPrawdziwa } =
      await import('../../../src/moduly/magazyn/services/petla-ofert-allegro.js');
    const { kartaAllegro } = await import('../../pomoc/e4-blizniak.js');
    const e = srodowisko();
    zapiszUstawieniaOfertKonta(e.db, e.konto.klucz, {
      czynne: true,
      aktywujPoSprawdzeniu: true,
      narzutProcent: 0,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      producentId: 'prod-konta',
    });
    Object.assign(e.konto, { nazwa: 'Półcień Allegro', srodowisko: 'produkcja' });
    e.konto.allegro.wgrajZdjecie = vi.fn(async () => ({ location: 'https://polcien.example.invalid/wgrane.jpg' }));
    const { kartaId, ofertaId } = kartaAllegro(e.db, e.konto.klucz, 0, e.ms());
    e.db
      .prepare(`UPDATE oferty_kanalow SET id_zewnetrzne = 'oferta-prawdziwa', stan = 'aktywna' WHERE id = ?`)
      .run(ofertaId);
    zmienOferte(e.db, ofertaId, { wyslanePola: { droga: 'nowy' }, iloscZOms: true });
    expect(mock.migawka.znane.has(kartaId)).toBe(false);
    const x = {
      id: 'oferta-prawdziwa',
      publication: { status: 'ACTIVE' },
      stock: { available: 3 },
      sellingMode: { price: { amount: '58.00' } },
    };
    e.katalog.odczytOfert.mockResolvedValue({ ok: true, dane: { oferty: [x] } });
    await petlaPrawdziwa({
      db: e.db,
      konta: () => [e.konto],
      teraz: () => new Date(e.ms()),
      pollerMs: 60_000,
      zwolnijOperacje: vi.fn(),
      czytajZdjecie: vi.fn(async () => new Uint8Array([1])),
      log: e.log,
    }).przebieg();
    const w = ofertaPoId(e.db, ofertaId);
    expect(w.problemy).toEqual([]);
    expect(w.iloscProblem?.kod).toBe('brak-stanu');
    expect(e.allegro.komendaCeny).toHaveBeenCalledTimes(1);
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(1);
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['znacznik END przez OMS', { zakonczonaPrzezOms: { at: '2026-11-14T10:00:00Z' } }],
    ['samo wznowienie bez znacznika', { wznowienieIlosc: { cel: 3, gotowe: true } }],
  ])('%s: ręczna aktywacja w trakcie wznowienia, potem ręczny koniec z 3 szt. — bez ACTIVATE', async (_n, pola) => {
    const e = srodowisko();
    const o = e.dodaj({ stan: 3, odczyt: 0, status: 'ENDED', pola });
    const p = e.petla();
    await p.przebieg(); // FIXED 3 → wznowienieIlosc
    expect(o.w().wyslanePola.wznowienieIlosc).toBeTruthy();
    o.x.publication.status = 'ACTIVE';
    o.x.stock.available = 3; // sprzedawca aktywuje sam, przed naszym ACTIVATE
    await e.krok(p);
    expect(o.w().wyslanePola.wznowienieIlosc).toBeUndefined();
    expect(o.w().wyslanePola.zakonczonaPrzezOms).toBeUndefined();
    o.x.publication.status = 'ENDED'; // sprzedawca kończy ręcznie przy 3 szt.
    await e.krok(p);
    await e.krok(p);
    expect(publikacje(e)).toEqual([]);
    expect((o.w().problemy ?? []).map((x) => x.kod)).toContain('zakonczona');
  });

  it('nasze ACTIVATE potwierdzone, sprzedawca kończy ręcznie z 3 szt. przed następnym odczytem — bez drugiego ACTIVATE', async () => {
    const e = srodowisko();
    const o = e.dodaj({
      stan: 3,
      odczyt: 0,
      status: 'ENDED',
      pola: { zakonczonaPrzezOms: { at: '2026-11-14T10:00:00Z' } },
    });
    const p = e.petla();
    await p.przebieg();
    o.x.stock.available = 3;
    await e.krok(p); // FIXED potwierdzony → nasze ACTIVATE
    expect(publikacje(e)).toEqual([[[o.x.id], 'ACTIVATE']]);
    o.x.publication.status = 'ACTIVE';
    await e.krok(p); // potwierdzenie ACTIVATE
    expect(o.w().wyslanePola.zakonczonaPrzezOms).toBeUndefined();
    expect(o.w().wyslanePola.wznowienieIlosc).toBeUndefined();
    o.x.publication.status = 'ENDED'; // ręczny koniec przy 3 szt.
    await e.krok(p);
    await e.krok(p);
    await e.krok(p);
    expect(publikacje(e)).toEqual([[[o.x.id], 'ACTIVATE']]);
    expect((o.w().problemy ?? []).map((x) => x.kod)).toContain('zakonczona');
  });
});

describe('Wznów nie znika w przerwie po 5xx wznowienia', () => {
  it('przebieg w przerwie zostawia „zakończona” z 5 sztukami, Wznów dalej możliwe', async () => {
    const { mozeWznowic } = await import('../../../src/moduly/magazyn/oferty.js');
    const e = srodowisko();
    const o = e.dodaj({
      stan: 4,
      odczyt: 5,
      status: 'ENDED',
      tryb: 'zarzadzana',
      pola: { zakonczonaPrzezOms: { at: '2026-11-14T10:00:00Z' } },
    });
    e.katalog.zmienOferte.mockRejectedValue(new Error('HTTP 503 Allegro chwilowo niedostępne'));
    const p = e.petla();
    await p.przebieg();
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(1);
    expect(o.w().problemy).toMatchObject([{ kod: 'zakonczona', sztuk: 5 }]);
    expect(o.w().nastepnaProbaAt).toBeTruthy();
    e.przesun(10_000);
    await p.przebieg();
    expect(e.katalog.zmienOferte).toHaveBeenCalledTimes(1);
    expect(o.w().problemy).toMatchObject([{ kod: 'zakonczona', sztuk: 5 }]);
    expect(mozeWznowic(o.w())).toBe(true);
  });
});

describe('„Wyślij zera” jest jednorazowe na ofertę', () => {
  // Tak samo jak trasa ekranu (problemy-ofert.js): problem zdjęty, potwierdzenie w `wyslanePola`.
  const potwierdzZera = (e, lista) => {
    for (const o of lista)
      zmienOferte(e.db, o.id, {
        iloscProblem: null,
        wyslanePola: {
          ...o.w().wyslanePola,
          zeraPotwierdzone: {
            login: 'operator',
            at: '2026-11-14T12:00:30Z',
            przelaczenieId: mock.migawka.przelaczenieId,
          },
        },
      });
  };
  const publikacje = (e) => e.allegro.komendaPublikacji.mock.calls.map((c) => [c[1], c[2]]);
  const zapisy = (e) => e.allegro.komendaPublikacji.mock.calls.length + e.allegro.komendaIlosci.mock.calls.length;

  it('następny przebieg kończy 3 oferty, potem flaga znika i nowe masowe zero znów staje', async () => {
    const e = srodowisko();
    const zera = [0, 1, 2].map(() => e.dodaj({ stan: 0, odczyt: 3 }));
    const inne = [0, 1, 2].map(() => e.dodaj({ stan: 3, odczyt: 3 }));
    const p = e.petla();
    await p.przebieg();
    expect(zapisy(e)).toBe(0);
    for (const o of zera) expect(o.w().iloscProblem?.kod).toBe('zero-masowe');
    potwierdzZera(e, zera);
    await e.krok(p);
    expect(
      publikacje(e)
        .flatMap(([ids, akcja]) => ids.map((id) => `${id}:${akcja}`))
        .sort(),
    ).toEqual(zera.map((o) => `${o.x.id}:END`).sort());
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    for (const o of zera) {
      expect(o.w().iloscProblem ?? null).toBeNull();
      o.x.publication.status = 'ENDED';
    }
    const poZerach = zapisy(e);
    await e.krok(p);
    expect(zapisy(e)).toBe(poZerach);
    for (const o of zera) expect(o.w().wyslanePola?.zeraPotwierdzone).toBeUndefined();
    for (const o of inne) mock.migawka.stany.set(o.kartaId, { stan: 0 });
    await e.krok(p);
    expect(zapisy(e)).toBe(poZerach);
    for (const o of inne) expect(o.w().iloscProblem?.kod).toBe('zero-masowe');
  });

  // Potwierdzenie sprzed wyłączenia stanów nie omija zera masowego po ponownym włączeniu.
  it('potwierdzenie z poprzedniego przełączenia stanów → 6/6 zero-masowe, 0 zapisów', async () => {
    const e = srodowisko();
    const oferty = [0, 1, 2, 3, 4, 5].map((i) => e.dodaj({ stan: i < 3 ? 0 : 3, odczyt: 3 }));
    const p = e.petla();
    await p.przebieg();
    potwierdzZera(e, oferty.slice(0, 3));
    // Wyłączenie i ponowne włączenie stanów: nowe przełączenie, nowe zatwierdzenie, wszystkie karty na 0.
    mock.migawka.przelaczenieId = 2;
    mock.migawka.zatwierdzenie = { przelaczenieId: 2 };
    for (const o of oferty) mock.migawka.stany.set(o.kartaId, { stan: 0 });
    await e.krok(p);
    expect(zapisy(e)).toBe(0);
    for (const o of oferty) expect(o.w().iloscProblem?.kod).toBe('zero-masowe');
    for (const o of oferty.slice(0, 3)) expect(o.w().wyslanePola?.zeraPotwierdzone).toBeUndefined();
  });

  // Zero masowe zależy od ofert z nieważną flagą — bez nich 2 zera z 4 nie przekraczają progu.
  it('6 ofert, 2 z nieważną flagą i 2 inne do zera → zero masowe, 0 zapisów', async () => {
    const e = srodowisko();
    const oferty = [0, 1, 2, 3, 4, 5].map((i) => e.dodaj({ stan: i < 4 ? 0 : 3, odczyt: 3 }));
    for (const o of oferty.slice(0, 2))
      zmienOferte(e.db, o.id, {
        wyslanePola: {
          ...o.w().wyslanePola,
          zeraPotwierdzone: { login: 'operator', at: '2026-11-14T12:00:30Z', przelaczenieId: 999 },
        },
      });
    await e.petla().przebieg();
    expect(zapisy(e)).toBe(0);
    for (const o of oferty.slice(0, 4)) expect(o.w().iloscProblem?.kod).toBe('zero-masowe');
  });

  it('potwierdzenie znika bez zapisu, gdy Allegro ma już 0 albo cel wzrósł', async () => {
    const e = srodowisko();
    const juzZero = e.dodaj({ stan: 0, odczyt: 0 });
    const wzrosl = e.dodaj({ stan: 3, odczyt: 3 });
    potwierdzZera(e, [juzZero, wzrosl]);
    await e.petla().przebieg();
    expect(e.allegro.komendaIlosci).toHaveBeenCalledTimes(0);
    for (const o of [juzZero, wzrosl]) expect(o.w().wyslanePola?.zeraPotwierdzone).toBeUndefined();
  });
});

it('bliźniak (iii): rzeczywisty klient i atrapa po zatwierdzeniu i wyłączeniu — nagranie żądań bajt w bajt jak zapisany wzorzec', async () => {
  vi.resetModules();
  vi.doUnmock('../../../src/oms/db/stany-magazynowe.js');
  vi.doUnmock('../../../src/moduly/magazyn/services/tresc-oferty-allegro.js');
  const { przygotujAllegro } = await import('../../pomoc/e4-blizniak.js');
  const { readFileSync } = await import('node:fs');
  const e = await przygotujAllegro({ wariant: 'ii' });
  try {
    e.db
      .prepare(
        `INSERT INTO stany_zatwierdzenia (przelaczenie_id, zatwierdzono_at, ofert, skrot)
      SELECT id, datetime(utworzono_at, '+5 minutes'), 10, 'zatwierdzony-blizniak'
      FROM magazyn_przelaczenia WHERE wlaczone = 1`,
      )
      .run();
    await e.przebiegi();
    expect(e.nagr.tekst()).toBe(
      readFileSync(new URL('../../fixtures/e4-blizniak-allegro.json', import.meta.url), 'utf8'),
    );
  } finally {
    e.zamknij();
  }
});

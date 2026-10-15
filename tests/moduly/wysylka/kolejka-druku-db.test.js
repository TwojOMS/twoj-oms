import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zakonczPrzesylke, rozpocznijPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import {
  dodajDoKolejki, pozycjeDoWziecia, zplDlaPozycji, oznaczWydrukowano, oznaczBladDruku,
  porzucPozycje, ostatniaPozycjaDlaPrzesylki,
} from '../../../src/moduly/wysylka/db/kolejka-druku.js';
import { SUFIT_ODROCZENIA_MS } from '../../../src/domena/kolejka-druku-stan.js';

const zmapowane = {
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '212.90', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [],
};

let db;
let przesylkaId;

beforeEach(() => {
  db = openOmsDb(':memory:');
  const zamowienieId = zapiszZamowienie(db, 'pro', zmapowane, {});
  const p = rozpocznijPrzesylke(db, zamowienieId, 'dpd');
  zakonczPrzesylke(db, p.id, {
    numerListu: '1000000000001U', etykietaSciezka: '/e/1.pdf', etykietaZplSciezka: '/e/1.zpl', surowa: '<xml/>',
  });
  przesylkaId = p.id;
});

describe('dodajDoKolejki', () => {
  it('wstawia pozycję ze statusem „oczekuje" i zerem prób', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    expect(w.status).toBe('oczekuje');
    expect(w.proby).toBe(0);
    expect(w.przesylka_id).toBe(przesylkaId);
    expect(w.utworzone_at).toBeTruthy();
  });

  // Powtórny wydruk jest dozwolony — etykieta może się zaciąć, rozmazać, zgubić. To NIE
  // jest to samo ryzyko co druga paczka: „Drukuj" na już wydrukowanej przesyłce ma tworzyć
  // NOWY wiersz, nie odbijać się od żadnego ograniczenia unikalności.
  it('drugie wywołanie dla TEJ SAMEJ przesyłki tworzy DRUGI wiersz, nie odbija się od żadnej blokady', () => {
    dodajDoKolejki(db, przesylkaId);
    dodajDoKolejki(db, przesylkaId);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku WHERE przesylka_id = ?').get(przesylkaId).c).toBe(2);
  });
});

describe('pozycjeDoWziecia', () => {
  it('oddaje id, numerListu i numer zamówienia — dokładnie pola, których czekacz oczekuje', () => {
    dodajDoKolejki(db, przesylkaId);
    const pozycje = pozycjeDoWziecia(db);
    expect(pozycje).toHaveLength(1);
    expect(pozycje[0]).toMatchObject({ numerListu: '1000000000001U', zamowienie: '1301' });
    expect(typeof pozycje[0].id).toBe('number');
  });

  it('pusta kolejka → pusta lista, nie wyjątek', () => {
    expect(pozycjeDoWziecia(db)).toEqual([]);
  });

  // MUTACJA OBOWIĄZKOWA z briefu: gdyby ta funkcja oddawała też pozycje 'wydrukowano',
  // czuwacz drukowałby tę samą etykietę w kółko co 5 sekund.
  it('NIE oddaje pozycji ze statusem „wydrukowano"', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    oznaczWydrukowano(db, w.id);
    expect(pozycjeDoWziecia(db)).toEqual([]);
  });

  it('NIE oddaje pozycji ze statusem „porzucone"', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    porzucPozycje(db, w.id);
    expect(pozycjeDoWziecia(db)).toEqual([]);
  });

  it('pozycja z odroczoną kolejną próbą w przyszłości NIE jest oddawana', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    oznaczBladDruku(db, w.id, 'drukarka offline');
    expect(pozycjeDoWziecia(db)).toEqual([]);
  });

  it('pozycja z odroczeniem, które już minęło, WRACA do kolejki', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    oznaczBladDruku(db, w.id, 'drukarka offline');
    const zaGodzine = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(pozycjeDoWziecia(db, zaGodzine)).toHaveLength(1);
  });
});

describe('zplDlaPozycji', () => {
  it('oddaje ścieżkę do pliku ZPL przypisanej przesyłki', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    expect(zplDlaPozycji(db, w.id).sciezka).toBe('/e/1.zpl');
  });

  it('nieistniejąca pozycja → null, nie wyjątek', () => {
    expect(zplDlaPozycji(db, 999999)).toBeNull();
  });
});

describe('oznaczWydrukowano', () => {
  it('ustawia status i znacznik czasu', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    oznaczWydrukowano(db, w.id);
    const wiersz = db.prepare('SELECT * FROM kolejka_druku WHERE id = ?').get(w.id);
    expect(wiersz.status).toBe('wydrukowano');
    expect(wiersz.wydrukowane_at).toBeTruthy();
  });

  it('nieistniejąca pozycja → czytelny błąd operatora', () => {
    expect(() => oznaczWydrukowano(db, 999999)).toThrow(/nie ma/i);
  });
});

// Serce odporności czuwacza — patrz domain/kolejka-druku-stan.js.
describe('oznaczBladDruku', () => {
  it('zwiększa licznik prób i zapisuje powód', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    oznaczBladDruku(db, w.id, 'drukarka offline');
    const wiersz = db.prepare('SELECT * FROM kolejka_druku WHERE id = ?').get(w.id);
    expect(wiersz.proby).toBe(1);
    expect(wiersz.ostatni_blad).toBe('drukarka offline');
    expect(wiersz.status).toBe('oczekuje');
  });

  // MUTACJA OBOWIĄZKOWA z briefu: bez odsunięcia nastepna_proba_at pozycja wraca
  // natychmiast i czuwacz próbuje ją drukować przy KAŻDYM cyklu (co 5 s).
  it('odsuwa kolejną próbę w przyszłość — pozycja NIE wraca natychmiast', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    const przed = Date.now();
    oznaczBladDruku(db, w.id, 'drukarka offline');
    const wiersz = db.prepare('SELECT * FROM kolejka_druku WHERE id = ?').get(w.id);
    expect(wiersz.nastepna_proba_at).toBeTruthy();
    expect(Date.parse(wiersz.nastepna_proba_at)).toBeGreaterThan(przed);
  });

  // MUTACJA OBOWIĄZKOWA z briefu: sufit 15 minut. Nawet po wielu awariach pod rząd,
  // kolejna próba nie może być odsunięta dalej niż o SUFIT_ODROCZENIA_MS.
  it('powtarzające się awarie NIE odsuwają kolejnej próby dalej niż o sufit 15 minut', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    for (let i = 0; i < 10; i += 1) oznaczBladDruku(db, w.id, `awaria ${i}`);
    const wiersz = db.prepare('SELECT * FROM kolejka_druku WHERE id = ?').get(w.id);
    const odroczenie = Date.parse(wiersz.nastepna_proba_at) - Date.now();
    expect(odroczenie).toBeLessThanOrEqual(SUFIT_ODROCZENIA_MS + 1000); // +1s luzu na czas testu
    expect(odroczenie).toBeGreaterThan(SUFIT_ODROCZENIA_MS - 5000);
  });

  it('nieistniejąca pozycja → czytelny błąd operatora', () => {
    expect(() => oznaczBladDruku(db, 999999, 'x')).toThrow(/nie ma/i);
  });
});

describe('porzucPozycje', () => {
  it('ustawia status „porzucone"', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    oznaczBladDruku(db, w.id, 'drukarka offline');
    porzucPozycje(db, w.id);
    expect(db.prepare('SELECT status FROM kolejka_druku WHERE id = ?').get(w.id).status).toBe('porzucone');
  });

  it('porzucona pozycja znika z listy do wzięcia przez czuwacza', () => {
    const w = dodajDoKolejki(db, przesylkaId);
    porzucPozycje(db, w.id);
    expect(pozycjeDoWziecia(db)).toEqual([]);
  });

  it('nieistniejąca pozycja → czytelny błąd operatora', () => {
    expect(() => porzucPozycje(db, 999999)).toThrow(/nie ma/i);
  });
});

describe('ostatniaPozycjaDlaPrzesylki', () => {
  it('brak wierszy → null', () => {
    expect(ostatniaPozycjaDlaPrzesylki(db, przesylkaId)).toBeNull();
  });

  it('oddaje NAJNOWSZY wiersz, nie pierwszy — reprint tworzy nowy wiersz na wierzchu', async () => {
    const pierwszy = dodajDoKolejki(db, przesylkaId);
    oznaczWydrukowano(db, pierwszy.id);
    const drugi = dodajDoKolejki(db, przesylkaId);
    const ostatnia = ostatniaPozycjaDlaPrzesylki(db, przesylkaId);
    expect(ostatnia.id).toBe(drugi.id);
    expect(ostatnia.status).toBe('oczekuje');
  });
});

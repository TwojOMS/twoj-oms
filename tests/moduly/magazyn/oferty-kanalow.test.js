import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaDiagnostykiAllegro } from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { migracjaOfertKanalow } from '../../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import {
  STANY_OFERTY,
  wstawOferte,
  ofertaPoId,
  ofertaPoIdZewnetrznym,
  ofertyKarty,
  zmienOferte,
  ustawieniaOfertKonta,
  zapiszUstawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';

// Warstwa dostępu do rejestru ofert i ustawień ofert konta kanału.
// Dane zmyślone: „Pracownia Półcień”, SKU LMP-*.

const T0 = '2026-11-13T10:00:00.000Z';
const T1 = '2026-11-13T10:05:00.000Z';
let db;

beforeEach(() => {
  db = openOmsDb(':memory:', {
    moduly: [
      modulRdzen,
      { nazwa: 'kanaly', migracje: [migracjaKanalowSprzedazy, migracjaDiagnostykiAllegro, migracjaTypuKanaluISklepow] },
      { nazwa: 'magazyn', migracje: [migracjaOfertKanalow] },
    ],
  });
  const karta = db.prepare(
    `INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)`,
  );
  karta.run(501, 'LMP-501', 'Lampa Półcień mała', T0, T0);
  karta.run(502, 'LMP-502', 'Lampa Półcień duża', T0, T0);
});
afterEach(() => db.close());

describe('rejestr ofert — wstawianie i unikalność (D8)', () => {
  it('nowa oferta z OMS: szkic, tryb zarządzana, zero prób, znaczniki czasu', () => {
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(o).toMatchObject({
      kartaId: 501,
      kanal: 'erli_polcien',
      idZewnetrzne: 'QX7P2M-K501',
      pochodzenie: 'oms',
      tryb: 'zarzadzana',
      stan: 'szkic',
      liczbaProb: 0,
      nastepnaProbaAt: null,
      blad: null,
      problemy: [],
      wyslanePola: null,
      wyslanaIlosc: null,
      wyslanaCenaGr: null,
      cenaDoPotwierdzeniaGr: null,
      utworzonoAt: T0,
      zmienionoAt: T0,
    });
    expect(ofertaPoId(db, o.id)).toEqual(o);
    expect(ofertaPoIdZewnetrznym(db, 'erli_polcien', 'QX7P2M-K501')).toEqual(o);
  });

  it('przejęta oferta startuje jako obserwowana (D23)', () => {
    const o = wstawOferte(
      db,
      { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'stara-oferta-77', pochodzenie: 'przejeta' },
      { teraz: T0 },
    );
    expect(o).toMatchObject({ pochodzenie: 'przejeta', tryb: 'obserwowana' });
  });

  it('drugi wiersz z tym samym (kanał, id zewnętrzne) → błąd; ten sam id na innym koncie → wolno', () => {
    wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(() =>
      wstawOferte(
        db,
        { kartaId: 502, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501', pochodzenie: 'przejeta' },
        { teraz: T0 },
      ),
    ).toThrow(/UNIQUE/);
    const inne = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien_2', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(inne.kanal).toBe('erli_polcien_2');
    expect(db.prepare('SELECT count(*) AS n FROM oferty_kanalow').get()).toEqual({ n: 2 });
  });

  it('OMS wystawia najwyżej jedną ofertę na kartę i konto; kolejne tylko przez przejęcie', () => {
    wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(() =>
      wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501-b' }, { teraz: T0 }),
    ).toThrow(/UNIQUE/);
    wstawOferte(
      db,
      { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'stara-oferta-77', pochodzenie: 'przejeta' },
      { teraz: T0 },
    );
    expect(ofertyKarty(db, 501).map((o) => o.idZewnetrzne)).toEqual(['QX7P2M-K501', 'stara-oferta-77']);
  });

  it('oferta musi wskazywać istniejącą kartę i mieć niepusty kanał oraz id', () => {
    expect(() =>
      wstawOferte(db, { kartaId: 999, kanal: 'erli_polcien', idZewnetrzne: 'X-K999' }, { teraz: T0 }),
    ).toThrow(/FOREIGN KEY/);
    expect(() => wstawOferte(db, { kartaId: 501, kanal: ' ', idZewnetrzne: 'X' }, { teraz: T0 })).toThrow();
    expect(() => wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: '' }, { teraz: T0 })).toThrow();
    expect(() =>
      wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'X', pochodzenie: 'obca' }, { teraz: T0 }),
    ).toThrow();
  });
});

describe('rejestr ofert — zmiana stanu i pól pętli', () => {
  it('zna dokładnie osiem stanów', () => {
    expect(STANY_OFERTY).toEqual([
      'szkic',
      'do_wyslania',
      'wyslana',
      'sprawdzana',
      'aktywna',
      'nieaktywna',
      'problem',
      'blad',
    ]);
  });

  it('zmiana stanu, prób, terminu, błędu, wysłanych pól, problemów i ceny do potwierdzenia', () => {
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    const po = zmienOferte(
      db,
      o.id,
      {
        stan: 'blad',
        liczbaProb: 2,
        nastepnaProbaAt: '2026-11-13T10:20:00.000Z',
        blad: 'Kanał nie odpowiada (503)',
        wyslanePola: { name: 'Lampa Półcień mała', stock: 3 },
        wyslanySkrot: 'abc123',
        wyslanaIlosc: 3,
        wyslanaCenaGr: 6490,
        wyslanoAt: T1,
        problemy: ['missingImages'],
        cenaDoPotwierdzeniaGr: 9900,
      },
      { teraz: T1 },
    );
    expect(po).toMatchObject({
      stan: 'blad',
      liczbaProb: 2,
      nastepnaProbaAt: '2026-11-13T10:20:00.000Z',
      blad: 'Kanał nie odpowiada (503)',
      wyslanePola: { name: 'Lampa Półcień mała', stock: 3 },
      wyslanySkrot: 'abc123',
      wyslanaIlosc: 3,
      wyslanaCenaGr: 6490,
      wyslanoAt: T1,
      problemy: ['missingImages'],
      cenaDoPotwierdzeniaGr: 9900,
      utworzonoAt: T0,
      zmienionoAt: T1,
    });
    const odczyt = zmienOferte(
      db,
      o.id,
      {
        stan: 'aktywna',
        odczytIlosc: 3,
        odczytCenaGr: 6490,
        odczytStatus: 'active',
        odczytZamrozone: ['price'],
        odczytZarchiwizowana: false,
        odczytanoAt: T1,
        tryb: 'obserwowana',
        blad: null,
        nastepnaProbaAt: null,
      },
      { teraz: T1 },
    );
    expect(odczyt).toMatchObject({
      stan: 'aktywna',
      odczytIlosc: 3,
      odczytCenaGr: 6490,
      odczytStatus: 'active',
      odczytZamrozone: ['price'],
      odczytZarchiwizowana: false,
      tryb: 'obserwowana',
      blad: null,
      nastepnaProbaAt: null,
    });
  });

  it('odrzuca nieznany stan, nieznane pole, ułamkowe grosze i ujemną liczbę prób', () => {
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(() => zmienOferte(db, o.id, { stan: 'opublikowana' }, { teraz: T1 })).toThrow(/stan/i);
    expect(() => zmienOferte(db, o.id, { kartaId: 502 }, { teraz: T1 })).toThrow(/kartaId/);
    expect(() => zmienOferte(db, o.id, { wyslanaCenaGr: 64.9 }, { teraz: T1 })).toThrow(/grosz/i);
    expect(() => zmienOferte(db, o.id, { liczbaProb: -1 }, { teraz: T1 })).toThrow();
    expect(() => db.prepare("UPDATE oferty_kanalow SET stan = 'opublikowana' WHERE id = ?").run(o.id)).toThrow(/CHECK/);
    expect(ofertaPoId(db, o.id)).toMatchObject({ stan: 'szkic', zmienionoAt: T0 });
  });

  it('zmiana nieistniejącej oferty zwraca null', () => {
    expect(zmienOferte(db, 4242, { stan: 'aktywna' }, { teraz: T1 })).toBeNull();
    expect(ofertaPoId(db, 4242)).toBeNull();
  });
});

describe('ustawienia ofert konta kanału (D13, D13a, D14, D15, D24, D28)', () => {
  it('nowe konto bez zapisu: oferty wstrzymane, stała ilość nieustawiona, narzut 0, próg 20%', () => {
    expect(ustawieniaOfertKonta(db, 'erli_polcien')).toEqual({
      klucz: 'erli_polcien',
      zapisane: false,
      czynne: false,
      narzutProcent: 0,
      narzutBp: 0,
      progPotwierdzeniaProcent: 20,
      progPotwierdzeniaBp: 2000,
      stalaIlosc: null,
      czasWysylkiDni: null,
      cennikDostaw: null,
      stawkaVat: null,
      producentId: null,
      osobaOdpowiedzialnaId: null,
      zwrotyId: null,
      reklamacjeId: null,
      gwarancjaId: null,
      lokalizacja: null,
      aktywujPoSprawdzeniu: false,
      bezpieczenstwoDomyslne: null,
      slowniki: null,
      cenniki: [],
      buforSzt: 0,
      progSkokuSzt: 5,
      zmienionoAt: null,
      aktorLogin: null,
    });
  });

  it('zapis samego narzutu 12,5% nie włącza ofert i nie ustawia stałej ilości', () => {
    const u = zapiszUstawieniaOfertKonta(
      db,
      'erli_polcien',
      { narzutProcent: 12.5 },
      { teraz: T0, aktor: 'administrator' },
    );
    expect(u).toMatchObject({
      zapisane: true,
      czynne: false,
      narzutProcent: 12.5,
      narzutBp: 1250,
      stalaIlosc: null,
      zmienionoAt: T0,
      aktorLogin: 'administrator',
    });
    expect(
      db
        .prepare(
          "SELECT narzut_bp, oferty_czynne, stala_ilosc FROM oferty_ustawienia_kont WHERE klucz = 'erli_polcien'",
        )
        .get(),
    ).toEqual({ narzut_bp: 1250, oferty_czynne: 0, stala_ilosc: null });
  });

  it('zapis częściowy zachowuje pozostałe pola; ustawienia jednego konta nie dotykają drugiego', () => {
    zapiszUstawieniaOfertKonta(
      db,
      'erli_polcien',
      {
        czynne: true,
        stalaIlosc: 5,
        czasWysylkiDni: 2,
        cennikDostaw: '*',
        stawkaVat: '23',
        producentId: 'prod-17',
        osobaOdpowiedzialnaId: 'osoba-4',
      },
      { teraz: T0 },
    );
    const u = zapiszUstawieniaOfertKonta(db, 'erli_polcien', { narzutProcent: 7 }, { teraz: T1 });
    expect(u).toMatchObject({
      czynne: true,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: '*',
      stawkaVat: '23',
      producentId: 'prod-17',
      osobaOdpowiedzialnaId: 'osoba-4',
      narzutProcent: 7,
      zmienionoAt: T1,
    });
    expect(ustawieniaOfertKonta(db, 'erli_polcien_2')).toMatchObject({
      zapisane: false,
      czynne: false,
      stalaIlosc: null,
    });
    const bezIlosci = zapiszUstawieniaOfertKonta(
      db,
      'erli_polcien',
      { stalaIlosc: null, czynne: false },
      { teraz: T1 },
    );
    expect(bezIlosci).toMatchObject({ czynne: false, stalaIlosc: null, narzutProcent: 7 });
  });

  it('odrzuca złe wartości i nie zapisuje niczego', () => {
    const zle = [
      [{ narzutProcent: -1 }, /narzut/i],
      [{ narzutProcent: 12.345 }, /narzut/i],
      [{ narzutProcent: 1001 }, /narzut/i],
      [{ progPotwierdzeniaProcent: 0 }, /próg/i],
      [{ stalaIlosc: 0 }, /ilość/i],
      [{ stalaIlosc: 2.5 }, /ilość/i],
      [{ czasWysylkiDni: -1 }, /wysyłk/i],
      [{ stawkaVat: '7' }, /VAT/],
      [{ czynne: 'tak' }, /czynne/i],
      [{ cenaZaDarmo: 1 }, /cenaZaDarmo/],
    ];
    for (const [zmiany, wzor] of zle) {
      expect(() => zapiszUstawieniaOfertKonta(db, 'erli_polcien', zmiany, { teraz: T0 })).toThrow(wzor);
    }
    expect(db.prepare('SELECT count(*) AS n FROM oferty_ustawienia_kont').get()).toEqual({ n: 0 });
  });

  it('VAT domyślny przyjmuje stawki OMS-u razem ze „zw”', () => {
    for (const s of ['23', '8', '5', '0', 'zw']) {
      expect(zapiszUstawieniaOfertKonta(db, 'erli_polcien', { stawkaVat: s }, { teraz: T0 }).stawkaVat).toBe(s);
    }
  });
});

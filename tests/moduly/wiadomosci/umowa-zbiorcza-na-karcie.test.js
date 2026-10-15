import {
  describe, it, expect, beforeEach,
} from 'vitest';

import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  dopiszKlienta, klientPoNip, wgrajUmowyZbiorczeZKonfiguracji,
} from '../../../src/oms/db/klienci.js';
import { znormalizujKlienta } from '../../../src/domena/klient-staly.js';
import { dopiszKlientaZbiorczego } from '../faktury/_klient-zbiorczy-pomocniki.js';

// WARUNKI UMOWY ZBIORCZEJ NA KARCIE KLIENTA (24.08.2026) — przeniesienie z `.env`.
//
// Do tej daty klucz, nazwa, NIP, rabat, prog i dwie oplaty stały w JEDNYM ciagu
// `OMS_KLIENCI_ZBIORCZY`, a cztery z tych siedmiu pol RÓWNOLEGLE w tabeli `klienci`.

const NIP = '1000001017';
const WPIS_ENV = { OMS_KLIENCI_ZBIORCZY: `zetaklient:PHU Ewa Zieliński:${NIP}:40:500:4:19` };

const naglowek = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const config = { auth: { user: 'adam', pass: 'x' } };

/** Klient stały BEZ umowy zbiorczej — dokładnie taki, jaki leżał w bazie przed migracją. */
const dopiszZwyklego = (db, nadpisania = {}) => dopiszKlienta(db, {
  klucz: 'zetaklient', nazwa: 'Zetaklient Drogowe', nip: NIP, b2b: 1, rabat_procent: 40,
  chce_fakture: 1, metoda_wysylki: 'dpd', aktywny: 1, koszt_dostawy_brutto: '0.00',
  platnosc: 'przelew', termin_platnosci: null, komentarz: null, ...nadpisania,
});

describe('migracja warunków umowy z OMS_KLIENCI_ZBIORCZY', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  it('przenosi próg i obie opłaty na kartę klienta dopasowanego po NIP-ie', () => {
    dopiszZwyklego(db);
    const wynik = wgrajUmowyZbiorczeZKonfiguracji(db, WPIS_ENV);

    expect(wynik).toMatchObject({ wgranych: 1, bezKlienta: [] });
    const k = klientPoNip(db, NIP);
    expect(k.rozliczenie_zbiorcze).toBe(1);
    expect(k.prog_darmowej_dostawy_gr).toBe(50000);
    expect(k.oplata_obslugi_gr).toBe(400);
    expect(k.oplata_kurierska_gr).toBe(1900);
  });

  // ⚠️ NIP z myslnikami w `.env` ma trafic w tego samego klienta — w tabeli lezy
  // znormalizowany, a porownanie napisow wprost nie znalazloby niczego i migracja
  // zameldowalaby „brak w bazie" o kliencie, ktory tam jest.
  it('dopasowuje po cyfrach NIP-u, nie po napisie', () => {
    dopiszZwyklego(db);
    wgrajUmowyZbiorczeZKonfiguracji(db, {
      OMS_KLIENCI_ZBIORCZY: 'zetaklient:PHU Ewa Zieliński:100-000-10-17:40:500:4:19',
    });
    expect(klientPoNip(db, NIP).rozliczenie_zbiorcze).toBe(1);
  });

  // ⚠️⚠️ SEDNO ZNACZNIKA. Migracje chodza przy KAZDYM starcie kontenera, wiec bez wpisu
  // w `migracje_jednorazowe` najblizsze wdrozenie cofneloby stawke poprawiona reka —
  // po cichu i dokladnie wtedy, gdy nikt tego nie obserwuje.
  it('drugi przebieg NIE cofa kwoty poprawionej ręcznie na karcie', () => {
    dopiszZwyklego(db);
    wgrajUmowyZbiorczeZKonfiguracji(db, WPIS_ENV);
    db.prepare('UPDATE klienci SET oplata_kurierska_gr = 2500 WHERE nip = ?').run(NIP);

    const drugi = wgrajUmowyZbiorczeZKonfiguracji(db, WPIS_ENV);

    expect(drugi.pominieta).toBe(true);
    expect(klientPoNip(db, NIP).oplata_kurierska_gr).toBe(2500);
  });

  // ⚠️ Siedmiopolowy ciag nie niesie ani adresu, ani danych do faktury — klient zalozony
  // z niego bylby wydmuszka, z ktorej nie da sie wystawic dokumentu.
  it('NIP spoza bazy NIE zakłada klienta — melduje go w logu', () => {
    const log = [];
    const wynik = wgrajUmowyZbiorczeZKonfiguracji(db, WPIS_ENV, (t) => log.push(t));

    expect(wynik.wgranych).toBe(0);
    expect(wynik.bezKlienta).toEqual([`zetaklient (NIP ${NIP})`]);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM klienci').get().ile).toBe(0);
    expect(log.join(' ')).toMatch(/OMS_KLIENCI_ZBIORCZY/);
  });

  // ⚠️ Baza jest zrodlem stawki rabatu od 23.08 (przewodnik 4.52), a liczba w `.env` bywa
  // nieaktualna. Przenosimy WYLACZNIE to, czego baza jeszcze nie ma.
  it('nie rusza rabatu, który już stoi na karcie', () => {
    dopiszZwyklego(db, { rabat_procent: 25 });
    wgrajUmowyZbiorczeZKonfiguracji(db, WPIS_ENV);
    expect(klientPoNip(db, NIP).rabat_procent).toBe(25);
  });

  it('brak zmiennej to poprawny stan, nie awaria startu', () => {
    expect(() => wgrajUmowyZbiorczeZKonfiguracji(db, {})).not.toThrow();
    expect(wgrajUmowyZbiorczeZKonfiguracji(db, {}).wgranych).toBe(0);
  });

  // ⚠️⚠️ USLUGA WSTAJACA RAZ ZANIM KLIENT TRAFI DO BAZY nie ma prawa odhaczyc przeniesienia,
  // ktorego nie bylo — inaczej warunki umowy trzeba by potem wklepac recznie, nie wiedzac
  // nawet, ze trzeba.
  it('nieudane dopasowanie NIE zamyka migracji — kolejny start ją dokańcza', () => {
    const pierwszy = wgrajUmowyZbiorczeZKonfiguracji(db, WPIS_ENV);
    expect(pierwszy.bezKlienta).toHaveLength(1);

    dopiszZwyklego(db);
    const drugi = wgrajUmowyZbiorczeZKonfiguracji(db, WPIS_ENV);

    expect(drugi.pominieta).toBe(false);
    expect(drugi.wgranych).toBe(1);
    expect(klientPoNip(db, NIP).oplata_kurierska_gr).toBe(1900);
  });

  // ⚠️ Straz na WIERSZU, niezalezna od znacznika: karta juz ustawiona jest nietykalna takze
  // w przebiegu, ktory z innego powodu nie postawil jeszcze znacznika.
  it('karty już ustawionej nie rusza nawet przy nieodhaczonej migracji', () => {
    dopiszKlientaZbiorczego(db, { oplata_kurierska_gr: 2500 });
    const wynik = wgrajUmowyZbiorczeZKonfiguracji(db, {
      OMS_KLIENCI_ZBIORCZY: `zetaklient:PHU:${NIP}:40:500:4:19,obcy:Obcy:5252248481:0:0:0:0`,
    });
    expect(wynik.nietkniete).toEqual(['zetaklient']);
    expect(klientPoNip(db, NIP).oplata_kurierska_gr).toBe(2500);
  });
});

describe('formularz karty klienta — warunki umowy', () => {
  const pola = {
    nazwa: 'Zetaklient Drogowe', nip: NIP, metoda_wysylki: 'dpd', platnosc: 'przelew',
  };

  it('przełącznik z kompletem kwot zapisuje je w groszach', () => {
    const d = znormalizujKlienta({
      ...pola,
      rozliczenie_zbiorcze: 'on',
      prog_darmowej_dostawy: '500',
      oplata_obslugi: '4,00',
      oplata_kurierska: '19,00',
    });
    expect(d).toMatchObject({
      rozliczenie_zbiorcze: 1,
      prog_darmowej_dostawy_gr: 50000,
      oplata_obslugi_gr: 400,
      oplata_kurierska_gr: 1900,
    });
  });

  // ⚠️ Grosze, nie zlotowki — pomylka o 100× jest tu roznica miedzy 4 zl a 400 zl na fakturze.
  it('kwota z groszami przelicza się co do grosza', () => {
    const d = znormalizujKlienta({
      ...pola,
      rozliczenie_zbiorcze: 'on',
      prog_darmowej_dostawy: '499,99',
      oplata_obslugi: '4,05',
      oplata_kurierska: '19',
    });
    expect(d.prog_darmowej_dostawy_gr).toBe(49999);
    expect(d.oplata_obslugi_gr).toBe(405);
    expect(d.oplata_kurierska_gr).toBe(1900);
  });

  // ⚠️⚠️ PUSTE POLE TO NIE „ZERO ZLOTYCH". `Number('')` oddaje 0, wiec bez odrzucenia pustki
  // PRZED konwersja klient zbiorczy dostalby prog 0 zl (kazda wysylka za darmo) albo oplate
  // 0 zl (nie pobieramy) — jedno i drugie wyglada w bazie poprawnie i kosztuje pieniadze.
  //
  // ⚠️⚠️ ASERCJA CELUJE W ZDANIE TEGO STRAZNIKA, A NIE W SAMA NAZWE POLA — i to jest
  // poprawka po mutacji (24.08.2026). Wzorzec `/próg darmowej dostawy/` przechodzil TAKZE
  // po wylaczeniu strazy: pustke lapal wtedy `grosze()` i rzucal „Brak kwoty: próg darmowej
  // dostawy. Faktury nie da się wystawić bez ceny." — nazwa pola sie zgadzala, wiec test byl
  // zielony, mimo ze chroniony warunek nie istnial. Roznica nie jest kosmetyczna: tamto
  // zdanie mowi o fakturze, ktorej na karcie klienta nie ma, i zostawia operatora bez
  // wskazowki, co ma zrobic.
  it.each([
    ['prog_darmowej_dostawy', /rozliczany zbiorczo musi mieć ustalony próg darmowej dostawy — bez niego/],
    ['oplata_obslugi', /rozliczany zbiorczo musi mieć ustaloną opłatę za obsługę — bez niej/],
    ['oplata_kurierska', /rozliczany zbiorczo musi mieć ustaloną opłatę kurierską — bez niej/],
  ])('pusta kwota %s przy włączonym przełączniku to ODMOWA', (puste, opis) => {
    const body = {
      ...pola,
      rozliczenie_zbiorcze: 'on',
      prog_darmowej_dostawy: '500',
      oplata_obslugi: '4',
      oplata_kurierska: '19',
      [puste]: '   ',
    };
    expect(() => znormalizujKlienta(body)).toThrow(opis);
  });

  it('literówka w kwocie to odmowa, a nie ciche zero', () => {
    expect(() => znormalizujKlienta({
      ...pola,
      rozliczenie_zbiorcze: 'on',
      prog_darmowej_dostawy: 'piecset',
      oplata_obslugi: '4',
      oplata_kurierska: '19',
    })).toThrow(/Nie umiem odczytać kwoty/);
  });

  // ⚠️ Wylaczony przelacznik kasuje kwoty do NULL, a nie do zer. Zero znaczyloby „ustalone
  // na 0 zl" i po ponownym wlaczeniu klient dostawalby darmowa wysylke od zera zlotych.
  it('wyłączony przełącznik zostawia kwoty jako NULL, nie jako zera', () => {
    const d = znormalizujKlienta({ ...pola, prog_darmowej_dostawy: '500', oplata_obslugi: '4' });
    expect(d).toMatchObject({
      rozliczenie_zbiorcze: 0,
      prog_darmowej_dostawy_gr: null,
      oplata_obslugi_gr: null,
      oplata_kurierska_gr: null,
    });
  });
});

describe('ekrany karty klienta', () => {
  let db;
  let app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config });
    await app.ready();
  });

  it('formularz ma sekcję rozliczenia zbiorczego z trzema kwotami', async () => {
    const r = await app.inject({ method: 'GET', url: '/klienci?nowy', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="rozliczenie_zbiorcze"');
    expect(r.body).toContain('name="prog_darmowej_dostawy"');
    expect(r.body).toContain('name="oplata_obslugi"');
    expect(r.body).toContain('name="oplata_kurierska"');
  });

  // ⚠️ Od 24.08 to JEDYNE miejsce, w ktorym w ogole widac warunki umowy — wczesniej lezaly
  // w pliku `.env` na NAS-ie, poza zasiegiem kogokolwiek przy ekranie.
  it('karta klienta zbiorczego wymienia próg i obie opłaty', async () => {
    const id = dopiszKlientaZbiorczego(db);
    const r = await app.inject({ method: 'GET', url: `/klienci/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/od 500\.00 zł/);
    expect(r.body).toMatch(/obsługa 4\.00 zł/);
    expect(r.body).toMatch(/usługa kurierska 19\.00 zł/);
  });

  // Trzy puste kwoty u zwyklego klienta bylyby pytaniem, na ktore nie ma odpowiedzi.
  it('karta zwykłego klienta nie pokazuje warunków, których nie ma', async () => {
    const id = dopiszZwyklego(db);
    const r = await app.inject({ method: 'GET', url: `/klienci/${id}`, headers: naglowek });
    expect(r.body).not.toMatch(/Darmowa dostawa/);
  });

  // Pelna droga: formularz → baza → ekran. Mutacja gubiaca kolumny w `POLA` (db/klienci.js)
  // nie ma jak wpasc na testy domeny wyzej — tam kwoty nigdy nie dotykaja SQL-a.
  it('zapis formularza dojeżdża do bazy i wraca na kartę', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/klienci',
      headers: naglowek,
      payload: {
        nazwa: 'Zetaklient Drogowe',
        nip: NIP,
        metoda_wysylki: 'dpd',
        platnosc: 'przelew',
        rozliczenie_zbiorcze: 'on',
        prog_darmowej_dostawy: '500,00',
        oplata_obslugi: '4,00',
        oplata_kurierska: '19,00',
      },
    });
    expect(r.statusCode).toBe(302);
    const k = klientPoNip(db, NIP);
    expect(k.rozliczenie_zbiorcze).toBe(1);
    expect(k.oplata_kurierska_gr).toBe(1900);
  });

  it('odmowa przy braku kwoty zostawia formularz otwarty z komunikatem', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/klienci',
      headers: naglowek,
      payload: {
        nazwa: 'Zetaklient Drogowe',
        nip: NIP,
        metoda_wysylki: 'dpd',
        platnosc: 'przelew',
        rozliczenie_zbiorcze: 'on',
        prog_darmowej_dostawy: '500,00',
        oplata_obslugi: '',
        oplata_kurierska: '19,00',
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/musi mieć ustaloną opłatę za obsługę/);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM klienci').get().ile).toBe(0);
  });
});

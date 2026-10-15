// tests/oms/czuwacz-formulki.test.js
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { zapiszWatek, dowody, zapiszDowod, oznaczWyslane, zamknijWatek } from '../../../src/oms/db/allegro-watki.js';
import { KLUCZE } from '../../../src/domena/ustawienia-formulki.js';
import { createCzuwaczFormulki, MAKS_FORMULEK_NA_GODZINE } from '../../../src/moduly/wiadomosci/services/czuwacz-formulki.js';

// 2026-08-28 22:00Z = piatek 00:00 w Warszawie -> sobota. Uzywamy okna 18-8 i wszystkich dni.
const TERAZ = new Date('2026-08-28T21:00:00Z'); // 23:00 Warszawa, piatek
const teraz = () => TERAZ;

function baza({ wlaczona = '1', dni = '0,1,2,3,4,5,6', karencja = '10' } = {}) {
  const db = openOmsDb(':memory:');
  zapiszUstawienia(db, {
    [KLUCZE.wlaczony]: wlaczona, [KLUCZE.tresc]: 'Dziękujemy, odpiszemy rano.',
    [KLUCZE.od]: '18', [KLUCZE.do]: '8', [KLUCZE.dni]: dni, [KLUCZE.karencja]: karencja,
  }, TERAZ.toISOString());
  return db;
}

// Wiadomosc sprzed 30 minut — karencja 10 min juz minela.
const DAWNO = '2026-08-28T20:30:00Z';
const PRZED_CHWILA = '2026-08-28T20:57:00Z'; // 3 minuty temu

function dodajWatek(db, nadpisz = {}) {
  zapiszWatek(db, {
    kanal: 'allegro_szkicownia', threadId: 't1', interlocutorLogin: 'kup',
    lastMessageDateTime: DAWNO, typ: 'COMMON', przeczytany: 0,
    ostatniaOdKupujacego: 1, ostatniaTresc: 'pytanie', pobranyAt: DAWNO, ...nadpisz,
  });
}

function klientSzpieg(zachowanie = async () => ({ id: 'm1' })) {
  const wyslane = [];
  return {
    wyslane,
    wyslijWiadomosc: async (threadId, tekst) => { wyslane.push({ threadId, tekst }); return zachowanie(); },
  };
}

const czuwacz = (db, klient) => createCzuwaczFormulki({
  db, klienci: { allegro_szkicownia: klient }, teraz,
});

describe('autoresponder — czuwacz formulki', () => {
  it('wysyla formulke, gdy wszystkie warunki sa spelnione', async () => {
    const db = baza(); dodajWatek(db);
    const k = klientSzpieg();
    const wynik = await czuwacz(db, k).przebieg();

    expect(k.wyslane).toEqual([{ threadId: 't1', tekst: 'Dziękujemy, odpiszemy rano.' }]);
    expect(wynik.wyslane).toBe(1);
  });

  it('NIE wysyla, gdy autoresponder jest wylaczony', async () => {
    const db = baza({ wlaczona: '0' }); dodajWatek(db);
    const k = klientSzpieg();
    await czuwacz(db, k).przebieg();
    expect(k.wyslane).toEqual([]);
  });

  it('NIE wysyla, gdy ostatnia wiadomosc jest NASZA', async () => {
    const db = baza(); dodajWatek(db, { ostatniaOdKupujacego: 0 });
    const k = klientSzpieg();
    await czuwacz(db, k).przebieg();
    expect(k.wyslane).toEqual([]);
  });

  it('NIE wysyla, gdy wiadomosc PRZYSZLA poza oknem godzin', async () => {
    // 10:00 Warszawy — poza oknem 18-8, mimo ze czuwacz chodzi o 23:00.
    const db = baza(); dodajWatek(db, { lastMessageDateTime: '2026-08-28T08:00:00Z' });
    const k = klientSzpieg();
    await czuwacz(db, k).przebieg();
    expect(k.wyslane).toEqual([]);
  });

  it('NIE wysyla przed uplywem karencji', async () => {
    const db = baza(); dodajWatek(db, { lastMessageDateTime: PRZED_CHWILA });
    const k = klientSzpieg();
    await czuwacz(db, k).przebieg();
    expect(k.wyslane).toEqual([]);
  });

  it('NIE wysyla na watek POST_PURCHASE_ISSUE — formulka nigdy nie idzie na spor', async () => {
    const db = baza(); dodajWatek(db, { typ: 'POST_PURCHASE_ISSUE' });
    const k = klientSzpieg();
    await czuwacz(db, k).przebieg();
    expect(k.wyslane).toEqual([]);
  });

  it('NIE wysyla drugi raz w tym samym watku — raz na watek, nigdy wiecej', async () => {
    const db = baza(); dodajWatek(db);
    const { id } = zapiszDowod(db, { kanal: 'allegro_szkicownia', threadId: 't1', rodzaj: 'formulka', tresc: 'stara' }, DAWNO);
    oznaczWyslane(db, id, DAWNO);
    const k = klientSzpieg();
    await czuwacz(db, k).przebieg();
    expect(k.wyslane).toEqual([]);
  });

  it('NIE wysyla drugi raz nawet po NIEUDANEJ probie — dowod zostaje', async () => {
    // ⚠️ To jest cala stawka bezpiecznika: przy zerwaniu po wyslaniu nie wiemy, czy doszlo.
    const db = baza(); dodajWatek(db);
    const padajacy = klientSzpieg(async () => { throw new Error('Allegro: HTTP 500 przy /messaging'); });
    await czuwacz(db, padajacy).przebieg();
    expect(padajacy.wyslane).toHaveLength(1);

    const drugi = klientSzpieg();
    await czuwacz(db, drugi).przebieg();
    expect(drugi.wyslane).toEqual([]);
  });

  it('dowod powstaje PRZED strzalem do Allegro', async () => {
    const db = baza(); dodajWatek(db);
    let bylDowodPrzedWyslaniem = false;
    const k = {
      wyslijWiadomosc: async () => {
        bylDowodPrzedWyslaniem = dowody(db, 'allegro_szkicownia', 't1').length === 1;
        return { id: 'm1' };
      },
    };
    await czuwacz(db, k).przebieg();
    expect(bylDowodPrzedWyslaniem).toBe(true);
  });

  it('nieudana wysylka zapisuje blad przy dowodzie', async () => {
    const db = baza(); dodajWatek(db);
    const k = klientSzpieg(async () => { throw new Error('Allegro: HTTP 500 przy /messaging'); });
    const wynik = await czuwacz(db, k).przebieg();
    expect(dowody(db, 'allegro_szkicownia', 't1')[0].blad).toContain('HTTP 500');
    expect(wynik.bledy).toHaveLength(1);
  });

  it('BEZPIECZNIK: po pieciu formulkach w godzine czuwacz sie wstrzymuje', async () => {
    const db = baza();
    for (let i = 0; i < MAKS_FORMULEK_NA_GODZINE; i += 1) {
      const { id } = zapiszDowod(db, { kanal: 'allegro_szkicownia', threadId: `stary${i}`, rodzaj: 'formulka', tresc: 'x' }, '2026-08-28T20:50:00Z');
      oznaczWyslane(db, id, '2026-08-28T20:50:00Z');
    }
    dodajWatek(db);
    const k = klientSzpieg();
    const wynik = await czuwacz(db, k).przebieg();

    expect(k.wyslane).toEqual([]);
    expect(wynik.wstrzymany).toBe(true);
  });

  it('drugi przebieg w trakcie pierwszego jest POMINIETY', async () => {
    const db = baza(); dodajWatek(db);
    let zwolnij;
    const k = { wyslijWiadomosc: () => new Promise((res) => { zwolnij = () => res({ id: 'm' }); }) };
    const c = czuwacz(db, k);
    const pierwszy = c.przebieg();
    expect(await c.przebieg()).toEqual({ pominiety: true });
    zwolnij();
    await pierwszy;
  });
});

// ⚠️⚠️ GORNA GRANICA WIEKU — decyzja wlasciciela z 29.08.2026 (24 godziny).
//
// Powod: 29.08 wyszlo, ze poller bral ZLA wiadomosc jako ostatnia (Allegro oddaje od
// najnowszej), przez co WSZYSTKIE 18 watkow szkicownia kwalifikowalo sie do formulki — w tym
// rozmowy z maja i lipca. Sama poprawka kolejnosci to naprawila, ale przy okazji wyszlo,
// ze czuwacz NIE MIAL ZADNEJ granicy wieku: okno godzin sprawdza wylacznie GODZINE I DZIEN
// TYGODNIA nadejscia, a karencja jest minimum, nie maksimum.
//
// Przy oknie „po godzinach" (18-8) stare watki nie lapia sie PRZYPADKIEM — bo przyszly
// w srodku dnia. To zbieg okolicznosci, nie zabezpieczenie: przy oknie calodobowym
// (`odGodziny === doGodziny`) formulka „nie ma nas teraz przy komputerze, odpiszemy rano"
// poleciala by na wiadomosc sprzed miesiecy.
describe('czuwacz formulki — gorna granica wieku wiadomosci', () => {
  // Okno 18-8 Warszawa, TERAZ = piatek 23:00 Warszawa. Wszystkie trzy chwile ponizej sa
  // W OKNIE i po karencji — jedyne, co je rozroznia, to WIEK.
  const STARA_25H = '2026-08-27T20:00:00Z';   // czw 22:00 Warszawa — 25 h temu
  const ROWNO_24H = '2026-08-27T21:00:00Z';   // czw 23:00 Warszawa — dokladnie 24 h temu
  const SWIEZA_23H = '2026-08-27T22:00:00Z';  // pt  00:00 Warszawa — 23 h temu

  it('NIE wysyla formulki na wiadomosc starsza niz doba', async () => {
    const db = baza();
    dodajWatek(db, { lastMessageDateTime: STARA_25H, pobranyAt: STARA_25H });
    const klient = klientSzpieg();
    const c = createCzuwaczFormulki({ db, klienci: { allegro_szkicownia: klient }, teraz });

    const wynik = await c.przebieg();

    expect(wynik.wyslane).toBe(0);
    expect(klient.wyslane).toEqual([]);
    // ⚠️ Watek zostaje NIETKNIETY — bez dowodu, ktory przy regule „raz na watek"
    // zablokowalby formulke na zawsze, gdyby kupujacy napisal ponownie.
    expect(dowody(db, 'allegro_szkicownia', 't1')).toEqual([]);
  });

  it('granica jest OSTRA: rowno doba to juz za stara', async () => {
    const db = baza();
    dodajWatek(db, { lastMessageDateTime: ROWNO_24H, pobranyAt: ROWNO_24H });
    const klient = klientSzpieg();
    const c = createCzuwaczFormulki({ db, klienci: { allegro_szkicownia: klient }, teraz });

    expect((await c.przebieg()).wyslane).toBe(0);
  });

  it('wiadomosc z ostatniej doby DALEJ dostaje formulke', async () => {
    const db = baza();
    dodajWatek(db, { lastMessageDateTime: SWIEZA_23H, pobranyAt: SWIEZA_23H });
    const klient = klientSzpieg();
    const c = createCzuwaczFormulki({ db, klienci: { allegro_szkicownia: klient }, teraz });

    // Gdyby granica byla za ciasna, autoresponder milczalby tam, gdzie ma odpowiadac —
    // a cisza autorespondera wyglada jak brak pytan, nie jak usterka.
    expect((await c.przebieg()).wyslane).toBe(1);
  });
});

// ⚠️⚠️ RECZNE „ZALATWIONE" MUSI ZATRZYMAC FORMULKE. Watek zamkniety przez czlowieka dalej ma
// `ostatnia_od_kupujacego = 1` w lustrze — bo kupujacy NAPRAWDE pisal ostatni („Dziekuje").
// Gdyby czuwacz patrzyl na sama te flage, wyslalby formulke do kogos, kto wlasnie podziekowal
// i komu czlowiek swiadomie zamknal temat. Dlatego warunek jest JEDEN i wspolny z ekranem:
// `czyjRuch(w) === 'czeka'`.
describe('czuwacz formulki — wątek zamknięty ręcznie', () => {
  const SWIEZA = '2026-08-28T20:30:00Z'; // 30 min temu, w oknie, po karencji

  it('NIE wysyła formułki do wątku oznaczonego jako załatwiony', async () => {
    const db = baza();
    dodajWatek(db, { lastMessageDateTime: SWIEZA, pobranyAt: SWIEZA });
    zamknijWatek(db, 'allegro_szkicownia', 't1', SWIEZA, '2026-08-28T20:45:00Z');
    const klient = klientSzpieg();
    const c = createCzuwaczFormulki({ db, klienci: { allegro_szkicownia: klient }, teraz });

    expect((await c.przebieg()).wyslane).toBe(0);
    expect(klient.wyslane).toEqual([]);
  });

  it('⚠️ ale NOWA wiadomość po zamknięciu formułkę PRZYWRACA', async () => {
    const db = baza();
    dodajWatek(db, { lastMessageDateTime: SWIEZA, pobranyAt: SWIEZA });
    // Zamkniete na stanie STARSZYM niz obecna ostatnia wiadomosc — czyli kupujacy wrocil.
    zamknijWatek(db, 'allegro_szkicownia', 't1', '2026-08-28T19:00:00Z', '2026-08-28T19:10:00Z');
    const klient = klientSzpieg();
    const c = createCzuwaczFormulki({ db, klienci: { allegro_szkicownia: klient }, teraz });

    // Inaczej jedno klikniecie uciszaloby watek na zawsze.
    expect((await c.przebieg()).wyslane).toBe(1);
  });
});

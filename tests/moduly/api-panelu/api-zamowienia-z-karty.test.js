import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { parsujZamowienieZKarty } from '../../../src/domena/zamowienie-z-karty.js';
import { NAZWA_KURIERA } from '../../../src/domena/oplata-obslugi.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { dopiszKlientaZbiorczego } from '../faktury/_klient-zbiorczy-pomocniki.js';

const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

// Klient rozliczany ZBIORCZO — ten sam wpis, co w tests/oms/usluga-zamowienie-reczne.test.js.
// Prog 500 zl, wiec towar za 250 zl jest PONIZEJ niego i „Usługa kurierska" 19 zl by sie
// nalezala — dokladnie ten uklad, w ktorym zamowienie z karty dostawalo doklejone 19 zl.
// ⚠️ Od 24.08.2026 warunki umowy stoja na KARCIE KLIENTA, wiec test wstawia go do bazy.
const KLIENT_ZBIORCZY = {
  klucz: 'przykladowa', nazwa: 'Pracownia Przykładowa sp. z o.o.', nip: '1234500011',
  rabat_procent: 0, prog_darmowej_dostawy_gr: 50000,
  oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
};
const configZbiorczy = { ...config };
// Basic Auth jak w kazdym tescie trasy. `origin` jest KONIECZNE: straznik CSRF
// (src/security/csrf.js) odrzuca kazdy POST bez Origin/Referer — takze serwerowy.
const naglowki = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  origin: 'http://localhost',
  host: 'localhost',
};

const cialo = {
  kartaId: 'karta-abc',
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'jan@example.com', phone: '500900008' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Długa 45', postcode: '30-001', city: 'Kraków' },
  nip: null, chceFakture: false,
  kosztDostawyBrutto: '19.00',
  pozycje: [{ nazwa: 'Lampa wisząca — Kopuła 40x60cm', ilosc: 1, cena_brutto: '250.00' }],
  uwagi: 'Zamówienie indywidualne — karta karta-abc',
};

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config });
  await app.ready();
});

describe('POST /api/zamowienia-z-karty', () => {
  it('zaklada zamowienie reczne oznaczone jako indywidualne', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
    expect(res.statusCode).toBe(201);
    const { id, numer } = res.json();
    expect(numer).toMatch(/^R\/2026\/\d+$/);
    const z = pobierzZamowienie(db, id);
    expect(z.indywidualne).toBe(1);
    expect(z.karta_id).toBe('karta-abc');
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.pobranie).toBe(0);
    expect(z.kwota_brutto).toBe('269.00');
  });

  // ⚠️ NIP KLIENTA ZBIORCZEGO JEST TU WARUNKIEM SENSU TESTU. `doklejOplate` wychodzi na
  // `null` juz w drugiej linijce, gdy NIP nie trafia na nikogo z OMS_KLIENCI_ZBIORCZY —
  // wiec test z NIP-em spoza listy (albo bez NIP-u, jak reszta pliku) przeszedlby takze
  // przy CALKOWICIE zepsutej trasie. Kwota sprawdzana CO DO GROSZA: 250 (towar) + 19
  // (dostawa) = 269,00. Z doklejona „Usługą kurierską" wychodzilo 288,00 — faktura wyzsza
  // niz zaakceptowana oferta, a przede wszystkim wplata 269 zl uznana za NIEPELNA:
  // `oplacone` wymaga pokrycia CALEJ kwoty, wiec poller panelu nigdy nie ustawilby
  // `paid_at` i ETAP IV nie odpalilby sie NIGDY, po cichu.
  it('zamowienie z karty NIE dostaje oplaty za obsluge, choc NIP jest klientem zbiorczym', async () => {
    dopiszKlientaZbiorczego(db, KLIENT_ZBIORCZY);
    const zApp = buildOmsServer({ db, config: configZbiorczy });
    await zApp.ready();
    const res = await zApp.inject({
      method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki,
      payload: { ...cialo, nip: KLIENT_ZBIORCZY.nip, chceFakture: true },
    });
    expect(res.statusCode).toBe(201);
    const z = pobierzZamowienie(db, res.json().id);
    expect(z.pozycje.map((p) => p.nazwa)).not.toContain(NAZWA_KURIERA);
    expect(z.pozycje).toHaveLength(1);
    expect(z.kwota_brutto).toBe('269.00');

    // ⚠️ POLOWA KONTROLNA — bez niej nie wiadomo, czy oplaty nie ma DLATEGO, ze trasa jej
    // nie nalicza, czy DLATEGO, ze i tak by sie nie naliczyla. Te same dane i ta sama
    // konfiguracja, ale DOMYSLNYM wejsciem uslugi (tak wola trasa formularza): oplata
    // sie doklej a i kwota rosnie do 288,00. Roznica miedzy polowkami to dokladnie
    // `naliczajOplate`.
    const kontrolne = zalozZamowienieReczne({
      db,
      dane: parsujZamowienieZKarty({ ...cialo, kartaId: 'karta-kontrolna', nip: KLIENT_ZBIORCZY.nip, chceFakture: true }),
      znacznik: new Date().toISOString(),
      okresId: null,
    });
    const k = pobierzZamowienie(db, kontrolne.id);
    expect(k.pozycje.map((p) => p.nazwa)).toContain(NAZWA_KURIERA);
    expect(k.kwota_brutto).toBe('288.00');
  });

  it('drugie zadanie z ta sama karta oddaje 409 z numerem PIERWSZEGO zamowienia', async () => {
    const pierwsze = (await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo })).json();
    const res = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ id: pierwsze.id, numer: pierwsze.numer });
    expect(db.prepare('SELECT COUNT(*) c FROM zamowienia').get().c).toBe(1);
  });

  it('pozycja bez ceny dostaje odmowe operatorska i NIE zaklada zamowienia', async () => {
    // ⚠️ NAJPIERW WKLADAMY DO BAZY ZAMOWIENIE Z INNEJ KARTY. Bez niego asercja konczyla sie
    // na `COUNT(*) = 0` w SWIEZEJ bazie — a zero przechodzi takze wtedy, gdy trasa nie robi
    // nic z zupelnie innego powodu (nie ma trasy, padla autoryzacja, wysypal sie serwer).
    // Licznik, ktory ma ZOSTAC na 1, dowodzi tego, o co chodzi: odmowa niczego nie zapisala
    // i niczego nie skasowala.
    await app.inject({
      method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki,
      payload: { ...cialo, kartaId: 'karta-inna' },
    });
    expect(db.prepare('SELECT COUNT(*) c FROM zamowienia').get().c).toBe(1);

    const zle = { ...cialo, pozycje: [{ nazwa: 'Lampa', ilosc: 1 }] };
    const res = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: zle });
    expect(res.statusCode).toBe(400);
    expect(res.json().powod).toMatch(/cen/i);
    expect(db.prepare('SELECT COUNT(*) c FROM zamowienia').get().c).toBe(1);
  });

  it('zadanie bez Origin odbija sie od ochrony CSRF', async () => {
    const { origin, ...bezOrigin } = naglowki;
    const res = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: bezOrigin, payload: cialo });
    expect(res.statusCode).toBe(403);
    expect(origin).toBe('http://localhost');
  });

  // ⚠️ Kryterium akceptacji nr 6 ze specu. Kanal MUSI byc znany konsumentowi raportu
  // (KANALY_OMS w repo raporty), inaczej pierwszy tygodniowy raport po wdrozeniu
  // PRZERWIE SIE na nieznanej nazwie. `SKLEP_INDYWIDUALNE` jest tam od 2026-08-04.
  it('zamowienie z karty wychodzi z /api/sprzedaz jako SKLEP_INDYWIDUALNE', async () => {
    await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
    // ⚠️ „DZISIAJ" PO WARSZAWSKU, TA SAMA FUNKCJA CO W APLIKACJI — patrz bliźniaczy
    // komentarz w tests/oms/web-platnosci.test.js. `toISOString()` daje dzien w UTC,
    // a `/api/sprzedaz` filtruje po dacie warszawskiej: miedzy polnoca a druga w nocy
    // okno `od`/`do` wskazywalo DZIEN POPRZEDNI i zamowienie z niego wypadalo.
    const dzis = dzienWarszawa(new Date().toISOString());
    const res = await app.inject({
      method: 'GET',
      url: `/api/sprzedaz?od=${dzis}&do=${dzis}`,
      headers: { authorization: naglowki.authorization, host: 'localhost' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().zamowienia.map((z) => z.kanal)).toEqual(['SKLEP_INDYWIDUALNE']);
  });

  // ⚠️ AWARIA PO NADANIU NUMERU. `zalozZamowienieReczne` domyka wlasna transakcje przy
  // INSERCIE zamowienia, wiec blad na dalszym kroku (tutaj: brak tabeli `pozycje`) zostawia
  // zamowienie POL-ZALOZONE — z numerem, bez pozycji i bez kwoty. Numeru nie da sie zwolnic,
  // wiec odpowiedz MUSI go niesc: panel zapisze `powod` w logu karty i to jedyny slad,
  // po ktorym czlowiek znajdzie tamto zamowienie zamiast zakladac drugie.
  //
  // ⚠️ TO NIE MOZE WYJSC JAKO 409. Zamowienie z ta karta owszem, istnieje — ale zalozylo je
  // WLASNIE TO zadanie i jest ono niedokonczone. 409 znaczy dla panelu „juz zrobione, nic nie
  // rob", wiec karta zostalaby oznaczona jako przeniesiona do OMS-u, a w OMS-ie wisialoby
  // zamowienie za 0 zl, o ktorym nikt by sie nie dowiedzial.
  it('blad PO nadaniu numeru oddaje 500 z numerem pol-zalozonego zamowienia', async () => {
    // Awaria wymuszona dokladnie POMIEDZY nadaniem numeru a reszta sekwencji: zapis pozycji
    // odmawia na poziomie bazy (to samo, co SQLITE_BUSY albo pelny dysk w polowie zapisu).
    // Wyzwalacz, a nie `DROP TABLE pozycje` — schemat zostaje NIETKNIETY, odmowa jest w jednym
    // punkcie i przezyje dolozenie widoku czy klucza obcego na tej tabeli.
    db.exec("CREATE TRIGGER pozycje_odmowa BEFORE INSERT ON pozycje BEGIN SELECT RAISE(ABORT, 'dysk pełny'); END");
    const res = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
    expect(res.statusCode).toBe(500);

    const z = db.prepare('SELECT id, numer FROM zamowienia').get();
    expect(res.json().powod).toContain(z.numer);
    // ⚠️ STRAZ NA WYCIEK TRESCI WYJATKU. Do panelu (i dalej do logu karty, ktory ogląda
    // czlowiek) idzie komunikat dla operatora, NIGDY tekst od sterownika bazy — blad
    // techniczny niesie szczegoly infrastruktury. Surowy `e.message` ma prawo byc wylacznie
    // w dzienniku, sprawdzanym nizej.
    expect(res.json().powod).toContain('błąd techniczny panelu');
    expect(res.json().powod).not.toContain('dysk pełny');
    // Wpis w dzienniku przypiety do TEGO zamowienia — inaczej wisialby luzem i karta
    // w OMS-ie nie pokazalaby, co sie stalo.
    const wpis = db.prepare("SELECT zamowienie_id, wynik FROM log WHERE akcja = 'zamowienie.z-karty' ORDER BY id DESC").get();
    expect(wpis.zamowienie_id).toBe(z.id);
    expect(wpis.wynik).toContain('dysk pełny');
  });

  // ⚠️ TA SAMA AWARIA, ALE ZE ZNACZNIKIEM ZGUBIONYM PO DRODZE. `zalozZamowienieReczne` dokleja
  // `e.zamowienieId` tylko do wartosci, ktora jest obiektem I daje sie dopisac — przy wartosci
  // zamrozonej (albo `throw 'tekst'` / `throw null`) znacznik ginie, a do trasy dolatuje
  // wyjatek bez niego. Wtedy trasa znajduje w bazie WLASNY, pol-zalozony wiersz i musi
  // rozstrzygnac, ze zalozylo go TO zadanie — po `utworzone_at` rownym znacznikowi zadania,
  // a NIE po tym, czy wiersz „wyglada na kompletny" (zamowienie bez pozycji, wycenione sama
  // dostawa, jest stanem dozwolonym). Bez tego rozstrzygniecia wyszloby 409, czyli dla panelu
  // „juz zrobione, nic nie rob" — i zamowienie za 0 zl zostaloby w OMS-ie niezauwazone.
  it('awaria BEZ znacznika w wyjatku (wartosc zamrozona) tez oddaje 500, nie 409', async () => {
    const prepare = db.prepare.bind(db);
    // Zapis pozycji rzuca wartoscia ZAMROZONA: doklejenie do niej `zamowienieId` w trybie
    // scislym samo rzuca TypeError, wiec do trasy dolatuje wyjatek bez znacznika. Baza jest
    // tworzona na nowo w `beforeEach`, wiec podmiany nie trzeba cofac.
    db.prepare = (sql) => {
      if (/INSERT INTO pozycje/i.test(sql)) {
        return { run: () => { throw Object.freeze(new Error('dysk pełny')); } };
      }
      return prepare(sql);
    };

    const res = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
    expect(res.statusCode).toBe(500);

    const z = prepare('SELECT id, numer FROM zamowienia').get();
    expect(res.json().powod).toContain(z.numer);
    expect(res.json().powod).not.toContain('dysk pełny');
    const wpis = prepare("SELECT zamowienie_id FROM log WHERE akcja = 'zamowienie.z-karty' ORDER BY id DESC").get();
    expect(wpis.zamowienie_id).toBe(z.id);
  });
});

describe('GET /api/zamowienia-z-karty/:kartaId', () => {
  // ⚠️ Basic Auth WYSTARCZY. GET jest metoda bezpieczna, wiec ochrona CSRF
  // (src/security/csrf.js) jej nie dotyczy — inaczej niz przy POST wyzej, tu NIE podajemy
  // `origin` (tak samo, jak istniejace testy /api/sprzedaz).
  const naglowkiGet = { authorization: naglowki.authorization, host: 'localhost' };

  // ⚠️ WPLATA IDZIE PRZEZ dodajWplateReczna (tabela `platnosci`), NIE przez UPDATE surowej
  // kolumny `zamowienia.oplacone_at`. Zamowienie zalozone z karty ma `sklep = 'reczne'` —
  // zaden poller WooCommerce go nie dotyka, wiec jedyna PRAWDZIWA droga do oznaczenia
  // platnosci to reczna wplata operatora z ekranu zamowienia w OMS-ie (patrz komentarz
  // w trasie). Test na surowej kolumnie zaliczylby sie zielono, mimo ze trasa nigdy nie
  // widzialaby oplaty zaksiegowanej w prawdziwym OMS-ie — bo pobierzZamowienie liczy
  // `oplacone_at` z listy wplat, a nie z tej kolumny.
  it('oddaje numer i stan wplaty', async () => {
    const { id } = (await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo })).json();
    dodajWplateReczna(db, id, { kwota: '269.00', data: '2026-08-05' });
    const res = await app.inject({ method: 'GET', url: '/api/zamowienia-z-karty/karta-abc', headers: naglowkiGet });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, oplacone: true, anulowane: false, kwotaBrutto: '269.00' });
  });

  it('nieoplacone zamowienie oddaje oplacone:false', async () => {
    await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
    const res = await app.inject({ method: 'GET', url: '/api/zamowienia-z-karty/karta-abc', headers: naglowkiGet });
    expect(res.json().oplacone).toBe(false);
  });

  // ⚠️ TO JEST SEDNO CALEGO ODCZYTU. `oplacone` ma byc `true` DOPIERO, gdy wplaty pokrywaja
  // CALA kwote zamowienia — nie „sa jakiekolwiek wplaty". Trzy testy wyzej przeszlyby takze
  // przy blednej implementacji typu `Boolean(z.platnosci?.length)`, bo albo nie ma zadnej
  // wplaty, albo (test opłacone:true wyzej) wplata od razu domyka cala kwote. Ten test
  // rozroznia te dwa ksztalty: wplata CZESCIOWA (100 zl na 269 zl) musi dawac `false`,
  // dopiero dopłata reszty (169 zl) daje `true`. Wplaty ida przez `dodajWplateReczna` — ta
  // sama droga, co reszta pliku (patrz komentarz przy tescie „oddaje numer i stan wplaty").
  it('wplata czesciowa oddaje oplacone:false, dopiero dopłata reszty oplacone:true', async () => {
    const { id } = (await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo })).json();

    dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-08-05' });
    const czesciowa = await app.inject({ method: 'GET', url: '/api/zamowienia-z-karty/karta-abc', headers: naglowkiGet });
    expect(czesciowa.json().oplacone).toBe(false);

    dodajWplateReczna(db, id, { kwota: '169.00', data: '2026-08-05' });
    const dopelnione = await app.inject({ method: 'GET', url: '/api/zamowienia-z-karty/karta-abc', headers: naglowkiGet });
    expect(dopelnione.json().oplacone).toBe(true);
  });

  it('karta bez zamowienia dostaje 404 z komunikatem, ze karta nie ma zamowienia w OMS-ie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/zamowienia-z-karty/karta-nieznana', headers: naglowkiGet });
    expect(res.statusCode).toBe(404);
    // ⚠️ Kryterium akceptacji: `statusCode === 404` sam z siebie NIE GRYZIE — to domyslna
    // odpowiedz Fastify dla kazdej nieistniejacej trasy, przeszlaby takze wtedy, gdyby ta
    // trasa w ogole nie byla zarejestrowana. Konwencja treści bledu jest ta sama, co przy
    // teście z `COUNT(*)` wyzej: sam kod statusu nie dowodzi, ze zadzialala WLASCIWA logika.
    expect(res.json().powod).toMatch(/karta.*nie ma zamówienia w OMS-ie/i);
  });
});

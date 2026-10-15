import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, zapiszNadpisaniaWysylki, zapiszNadpisaniaFaktury } from '../../../src/oms/db/zamowienia.js';
import { utworzZamowienieReczne } from '../../../src/oms/db/zamowienia-reczne.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { adresOdbiorcy } from '../../../src/domena/adres-odbiorcy.js';
import { daneFaktury, chceFakture } from '../../../src/domena/dane-faktury.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1501, numer: '1501',
  klient: {
    first_name: 'Jan', last_name: 'Kowalski', company: 'ACME sp. z o.o.', email: 'j@k.pl',
    phone: '+48500600700', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL',
  },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', company: '', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1000001201',
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
  ...nad,
});

// Komplet pol formularza adresu — przegladarka odsyla WSZYSTKIE, nie tylko zmienione.
// To wlasnie dlatego trasa musi sama policzyc roznice wobec sklepu (patrz roznice()).
const FORMULARZ_WYSYLKI = {
  // Pole `company` niesie firme z bloku PLATNOSCI: sklep zostawia shipping.company puste,
  // a panel podstawia wtedy firme z platnosci (ten sam adres) — i to ona stoi w formularzu
  // na karcie, dopoki nikt go nie tknal. Formularz w tescie ma byc tym, co wysyla karta.
  nazwa: 'Jan Kowalski', company: 'ACME sp. z o.o.', ulica: 'Polna 1', kod: '00-650',
  miasto: 'Pęki', phone: '+48500600700', email: 'j@k.pl',
};
const FORMULARZ_FAKTURY = {
  firma: 'ACME sp. z o.o.', nip: '1000001201', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki',
  chce_fakture: 'on',
};

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

// `query` bierze się stąd, że część ostrzeżeń pokazuje się WYŁĄCZNIE w trybie edycji
// (`?edytuj=wysylka`) — patrz „panel mówi prawdę o tym, czego edycja NIE naprawia".
const karta = (id, query = '') => app.inject({ method: 'GET', url: `/zamowienia/${id}${query}`, headers: naglowek });
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

describe('blok „Szczegóły zamówienia" na karcie', () => {
  it('pokazuje numer, numer w sklepie, datę, kanał, status, metodę wysyłki i płatność', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await karta(id);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Szczegóły zamówienia');
    expect(r.body).toContain('1501');
    // Zadanie „strona główna", punkt C: data ZE SKLEPU (bez oznaczenia strefy) jest już
    // czasem lokalnym — fmtDataCzas ją TYLKO przeformatowuje (spacja zamiast „T"), bez
    // przesunięcia — patrz src/oms/domain/format-daty.js.
    expect(r.body).toContain('2026-07-29 13:19:52');
    expect(r.body).not.toContain('2026-07-29T13:19:52');
    expect(r.body).toContain('pro');
    expect(r.body).toContain('Metoda wysyłki');
    // Od 2026-08-01 metoda pokazuje sie NAZWA ZE SLOWNIKA (domain/wysylka.js), a nie surowa
    // wartoscia kolumny — to jest pole, w ktorym operator sprawdza metode, wiec ma nazywac
    // rzeczy po imieniu (patrz blad I5 przy odbiorze osobistym).
    const i = r.body.indexOf('<span>Metoda wysyłki</span>');
    expect(r.body.slice(i, r.body.indexOf('</div>', i))).toContain('DPD');
    expect(r.body).toContain('Status płatności');
  });

  it('opłacone zamówienie pokazuje datę wpłaty', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ oplacone_at: '2026-07-30T09:00:00' }), {});
    expect((await karta(id)).body).toContain('2026-07-30 09:00:00');
  });

  // Zadanie D: uwagi klienta (customer_note) — TYLKO DO ODCZYTU, bo to zapis tego, co
  // napisal klient, nie notatka operatora. Sprawdzone na produkcji, zamowienie 1267.
  it('zamówienie z uwagami klienta pokazuje je w bloku szczegółów', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ uwagi: 'moje uwagi' }), {});
    const r = await karta(id);
    expect(r.body).toContain('Uwagi klienta');
    expect(r.body).toContain('moje uwagi');
  });

  // Gdy klient nic nie napisal, wiersz w ogole nie ma prawa sie pokazac — pusta linijka
  // „Uwagi klienta:" bez tresci wygladalaby jak usterka, nie jak informacja.
  it('zamówienie bez uwag NIE pokazuje pustego wiersza', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ uwagi: null }), {});
    expect((await karta(id)).body).not.toContain('Uwagi klienta');
  });
});

// Zadanie A: „Dane do wysyłki" i „Dane do faktury" w JEDNYM rzędzie, dwóch kolumnach —
// zwykły flex/grid, bez frameworka, zwijające się jedna pod drugą na wąskim ekranie
// (patrz .kolumny-dane w layout-oms.ejs).
describe('układ dwóch kolumn na karcie (dane do wysyłki / dane do faktury)', () => {
  it('oba bloki są owinięte wspólnym kontenerem układu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const body = (await karta(id)).body;
    const start = body.indexOf('class="metryczka"'); // przebudowa 2026-07-31: kontener ma teraz TRZY kolumny i stoi NAD pozycjami
    expect(start).toBeGreaterThanOrEqual(0);
    const dalej = body.slice(start);
    // Oba nagłówki muszą leżeć WEWNĄTRZ tego samego kontenera — w przeciwnym razie
    // „w jednym rzędzie" jest tylko deklaracją w komentarzu, a nie prawdą w HTML-u.
    expect(dalej.indexOf('Dane do wysyłki')).toBeGreaterThan(-1);
    expect(dalej.indexOf('Dane do faktury')).toBeGreaterThan(dalej.indexOf('Dane do wysyłki'));
  });
});

// Zadanie B: karta ma być domyślnie TYLKO DO ODCZYTU, a formularz ma się pojawiać dopiero
// po kliknięciu „Edytuj" — osobno dla wysyłki, osobno dla faktury, przez parametr adresu
// (?edytuj=wysylka / ?edytuj=faktura), bez JavaScriptu.
describe('tryb edycji danych klienta (?edytuj=wysylka / ?edytuj=faktura)', () => {
  it('domyślnie (bez ?edytuj) karta NIE pokazuje żadnego formularza danych klienta', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const body = (await karta(id)).body;
    expect(body).not.toContain(`action="/zamowienia/${id}/dane/wysylka"`);
    expect(body).not.toContain(`action="/zamowienia/${id}/dane/faktura"`);
    // Dane mimo to są widoczne, tylko jako tekst — karta ma pokazywać wartości, nie je ukrywać.
    expect(body).toContain('Jan Kowalski');
    expect(body).toContain('ACME sp. z o.o.');
  });

  it('domyślny widok ma osobne linki „Edytuj” dla wysyłki i dla faktury', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const body = (await karta(id)).body;
    expect(body).toContain('href="?edytuj=wysylka"');
    expect(body).toContain('href="?edytuj=faktura"');
  });

  it('?edytuj=wysylka pokazuje formularz WYŁĄCZNIE dla wysyłki, faktura zostaje tekstem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=wysylka`, headers: naglowek });
    expect(r.body).toContain(`action="/zamowienia/${id}/dane/wysylka"`);
    expect(r.body).not.toContain(`action="/zamowienia/${id}/dane/faktura"`);
  });

  it('?edytuj=faktura pokazuje formularz WYŁĄCZNIE dla faktury, wysyłka zostaje tekstem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=faktura`, headers: naglowek });
    expect(r.body).toContain(`action="/zamowienia/${id}/dane/faktura"`);
    expect(r.body).not.toContain(`action="/zamowienia/${id}/dane/wysylka"`);
  });

  it('nieznana wartość ?edytuj nie otwiera żadnego formularza', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=cokolwiek`, headers: naglowek });
    expect(r.body).not.toContain(`action="/zamowienia/${id}/dane/wysylka"`);
    expect(r.body).not.toContain(`action="/zamowienia/${id}/dane/faktura"`);
  });

  // Po zapisaniu wracamy do widoku odczytu — trasy POST już dziś przekierowują na
  // /zamowienia/:id (bez ?edytuj), więc wystarczy sprawdzić, że to przekierowanie zostaje.
  it('po zapisaniu formularza wysyłki wracamy na widok odczytu (przekierowanie bez ?edytuj)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await wyslij(`/zamowienia/${id}/dane/wysylka`, { ...FORMULARZ_WYSYLKI, kod: '00-651' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
  });

  // Oznaczenie „zmienione ręcznie" i nadpisanie mają działać identycznie w obu trybach —
  // to jest ten sam fragment `dane.wysylka`/`dane.wysylkaReczne`, którego czyta i tryb
  // odczytu, i formularz edycji.
  it('ręczne nadpisanie jest widoczne i oznaczone TAKŻE w widoku odczytu (bez ?edytuj)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { miasto: 'Nowa Wieś' });
    const body = (await karta(id)).body;
    expect(body).toContain('Nowa Wieś');
    expect(body).toContain('zmienione ręcznie');
  });

  it('ręczne nadpisanie jest widoczne i oznaczone TAKŻE w trybie edycji tej samej sekcji', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { miasto: 'Nowa Wieś' });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=wysylka`, headers: naglowek });
    expect(r.body).toContain('value="Nowa Wieś"');
    expect(r.body).toContain('zmienione ręcznie');
  });

  // „Przywróć dane ze sklepu" ma działać niezależnie od trybu — przycisk siedzi POZA
  // formularzem edycji (patrz zamowienie.ejs), więc musi być widoczny w obu.
  it('„Przywróć dane ze sklepu" jest dostępne zarówno w odczycie, jak i w edycji', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    expect((await karta(id)).body).toContain('Przywróć dane ze sklepu');
    const wEdycji = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=wysylka`, headers: naglowek });
    expect(wEdycji.body).toContain('Przywróć dane ze sklepu');
  });
});

// Zadanie „strona główna", punkt D: przełącznik „Klient chce fakturę" wraca na sam
// POCZĄTEK bloku „Dane do faktury" — to pytanie ROZSTRZYGAJĄCE, czy reszta pól (firma, NIP,
// adres) ma w ogóle znaczenie, więc ma stać PRZED nimi, nie po. Poprzednia wersja (Zadanie C
// z poprzedniej iteracji) trzymała go na końcu — właściciel po obejrzeniu panelu zażądał
// odwrócenia kolejności. Zachowanie przełącznika (ręczne „0" wygrywa ze sklepowym NIP-em)
// zostaje bez zmian — sprawdza to osobny opis niżej.
describe('„Klient chce fakturę" jako PIERWSZA pozycja bloku „Dane do faktury"', () => {
  // ⚠️ Kotwiczymy na SAMYM NAGŁÓWKU (`<h2>Dane do faktury</h2>`), nie na gołej frazie:
  // layout-oms.ejs ma w <style> komentarz CSS, który zawiera dokładnie tekst „Dane do
  // faktury" (opisuje układ dwóch kolumn) — `body.indexOf('Dane do faktury')” złapałby
  // WCZEŚNIEJ ten komentarz w <head> i wciągnąłby do bloku całą kolumnę „Dane do wysyłki"
  // (z jej własnym wierszem „Miasto") sprzed właściwego nagłówka faktury.
  // Wycinamy DOSŁOWNIE pierwszy <tr>...</tr> tabeli faktury i sprawdzamy, co w nim jest —
  // silniejsze niż samo „przed Miastem": złapie też mutację, która przestawia „Klient chce
  // fakturę" na DRUGĄ pozycję (np. za „Nazwę firmy"), a wciąż przed „Miastem".
  function pierwszyWierszTabeli(html) {
    const blok = html.slice(html.indexOf('<h2>Dane do faktury</h2>'));
    const idxTabela = 0; // blok faktury to teraz <dl> (odczyt) albo lista <label> (edycja), nie <table>
    expect(idxTabela).toBeGreaterThan(-1);
    const idxKoniec = Math.min(...[blok.indexOf('</dd>'), blok.indexOf('</label>')].filter((i) => i > -1));
    expect(idxKoniec).toBeGreaterThan(-1);
    return blok.slice(idxTabela, idxKoniec);
  }

  it('w widoku odczytu przełącznik jest PIERWSZYM wierszem tabeli faktury', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const body = (await karta(id)).body;
    expect(pierwszyWierszTabeli(body)).toContain('Klient chce fakturę');
  });

  it('w trybie edycji przełącznik jest PIERWSZYM wierszem tabeli faktury', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=faktura`, headers: naglowek });
    expect(pierwszyWierszTabeli(r.body)).toContain('Klient chce fakturę');
  });
});

// Zadanie Z3d/Z3b (plan „ekran nadania", 04.08): gdy klient NIE chce faktury, reszta
// bloku (Nazwa, NIP, Adres, E-mail do faktury, „Skopiuj do wysyłki") jest szumem, który
// operator i tak nigdy nie potrzebuje — zwija się w <details>, WYŁĄCZNIE w trybie odczytu.
describe('zwijanie sekcji „Dane do faktury", gdy klient nie chce faktury', () => {
  it('gdy klient NIE chce faktury, w odczycie widać wyłącznie wiersz „Klient chce fakturę: Nie"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ chce_fakture: 0, nip: null }), {});
    const body = (await karta(id)).body;
    const blok = body.slice(body.indexOf('<h2>Dane do faktury</h2>'), body.indexOf('</section>', body.indexOf('<h2>Dane do faktury</h2>')));
    expect(blok).toContain('Klient chce fakturę');
    expect(blok).toContain('Nie');
    expect(blok).toContain('<details');
    // Reszta danych jest DALEJ w HTML-u (details nie usuwa treści), ale wewnątrz <details>.
    const idxDetails = blok.indexOf('<details');
    expect(blok.indexOf('NIP')).toBeGreaterThan(idxDetails);
    expect(blok.indexOf('Skopiuj do wysyłki')).toBeGreaterThan(idxDetails);
  });

  it('gdy klient NIE chce faktury, ale sekcja jest w trybie edycji, formularz jest rozwinięty od razu (bez <details>)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ chce_fakture: 0, nip: null }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=faktura`, headers: naglowek });
    const blok = r.body.slice(r.body.indexOf('<h2>Dane do faktury</h2>'), r.body.indexOf('</section>', r.body.indexOf('<h2>Dane do faktury</h2>')));
    expect(blok).not.toContain('<details');
    expect(blok).toContain(`action="/zamowienia/${id}/dane/faktura"`);
  });

  it('gdy klient CHCE faktury, sekcja wygląda dokładnie jak dziś — bez <details>', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {}); // domyślnie chce_fakture: 1
    const body = (await karta(id)).body;
    const blok = body.slice(body.indexOf('<h2>Dane do faktury</h2>'), body.indexOf('</section>', body.indexOf('<h2>Dane do faktury</h2>')));
    expect(blok).not.toContain('<details');
    expect(blok).toContain('NIP');
    expect(blok).toContain('Skopiuj do wysyłki');
  });

  // Znacznik „zmienione ręcznie" przy przełączniku musi zostać widoczny NAWET gdy reszta
  // sekcji jest zwinięta — to jedyny ślad, że „Nie" nie jest wartością ze sklepu.
  it('znacznik „zmienione ręcznie" przy przełączniku zostaje widoczny mimo zwinięcia', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ chce_fakture: 1 }), {});
    const { chce_fakture, ...bezPrzelacznika } = FORMULARZ_FAKTURY;
    await wyslij(`/zamowienia/${id}/dane/faktura`, bezPrzelacznika);
    const body = (await karta(id)).body;
    const blok = body.slice(body.indexOf('<h2>Dane do faktury</h2>'), body.indexOf('</section>', body.indexOf('<h2>Dane do faktury</h2>')));
    const idxDetails = blok.indexOf('<details');
    expect(idxDetails === -1 ? Infinity : idxDetails).toBeGreaterThan(blok.indexOf('Klient chce fakturę'));
    expect(blok.slice(0, idxDetails === -1 ? blok.length : idxDetails)).toContain('zmienione ręcznie');
  });

  // Komunikat z GUS-u i pasek „już wystawionej faktury" to ostrzeżenia, nie dane nabywcy —
  // zostają NAD zwijanym blokiem, widoczne zawsze.
  it('pasek „faktura już wystawiona" zostaje widoczny NAD zwiniętym blokiem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ chce_fakture: 0, nip: null }), {});
    db.prepare(
      "INSERT INTO faktury (zamowienie_id, ksef_status, numer, infakt_uuid, utworzona_at) VALUES (?, NULL, 'FV/1/2026', 'uuid-1', ?)",
    ).run(id, new Date().toISOString());
    const body = (await karta(id)).body;
    const idxUwaga = body.indexOf('JUŻ WYSTAWIONEJ');
    const idxDetails = body.indexOf('<details', body.indexOf('<h2>Dane do faktury</h2>'));
    expect(idxUwaga).toBeGreaterThan(-1);
    expect(idxUwaga).toBeLessThan(idxDetails);
  });
});

describe('POST /zamowienia/:id/dane/wysylka', () => {
  it('zapisuje WYŁĄCZNIE pole zmienione wobec sklepu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await wyslij(`/zamowienia/${id}/dane/wysylka`, { ...FORMULARZ_WYSYLKI, kod: '00-651' });
    expect(r.statusCode).toBe(302);
    const w = db.prepare('SELECT dostawa_reczna_json FROM zamowienia WHERE id = ?').get(id);
    expect(JSON.parse(w.dostawa_reczna_json)).toEqual({ kod: '00-651' });
  });

  it('formularz identyczny ze sklepem nie zostawia żadnego nadpisania', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await wyslij(`/zamowienia/${id}/dane/wysylka`, FORMULARZ_WYSYLKI);
    expect(db.prepare('SELECT dostawa_reczna_json FROM zamowienia WHERE id = ?').get(id).dostawa_reczna_json).toBeNull();
  });

  it('poprawka jest widoczna na karcie i oznaczona jako zmieniona ręcznie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await wyslij(`/zamowienia/${id}/dane/wysylka`, { ...FORMULARZ_WYSYLKI, miasto: 'Nowa Wieś' });
    const body = (await karta(id)).body;
    expect(body).toContain('Nowa Wieś');
    expect(body).toContain('zmienione ręcznie');
  });

  // Oznaczenie pokazywane ZAWSZE byloby tak samo bezuzyteczne jak niepokazywane nigdy.
  it('bez poprawek karta NIE pokazuje oznaczenia „zmienione ręcznie"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    expect((await karta(id)).body).not.toContain('zmienione ręcznie');
  });

  it('zapisuje ślad w logu zamówienia', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await wyslij(`/zamowienia/${id}/dane/wysylka`, { ...FORMULARZ_WYSYLKI, kod: '00-651' });
    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
    expect(wpisy.some((w) => w.akcja === 'dane.wysylka' && String(w.wynik).includes('kod'))).toBe(true);
  });

  // Urwane zadanie NIE MOZE wygladac jak „operator wyczyscil wszystkie pola" — bez tej
  // odmowy jeden pusty POST kasowalby caly adres zamowienia.
  it('żądanie bez ani jednego pola formularza → 400 i zero zmian w bazie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await wyslij(`/zamowienia/${id}/dane/wysylka`, { cokolwiek: '1' });
    expect(r.statusCode).toBe(400);
    expect(db.prepare('SELECT dostawa_reczna_json FROM zamowienia WHERE id = ?').get(id).dostawa_reczna_json).toBeNull();
  });

  // ...ale RECZNE wyczyszczenie pola ma sie zapisac: formularz odsyla wtedy klucze, tylko
  // puste. Inaczej nie dalo by sie w ogole usunac blednego telefonu.
  it('wyczyszczenie pola w formularzu zapisuje się jako nadpisanie na puste', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await wyslij(`/zamowienia/${id}/dane/wysylka`, { ...FORMULARZ_WYSYLKI, phone: '' });
    expect(adresOdbiorcy(pobierzZamowienie(db, id)).phone).toBeNull();
  });

  // Granica miedzy „urwane zadanie" a „decyzja operatora" biegnie po OBECNOSCI kluczy,
  // nie po ich wartosciach: formularz z wyczyszczonymi WSZYSTKIMI polami to nadal decyzja
  // czlowieka (adres byl smieciem) i ma sie zapisac. Ekran nadania i tak odmowi nadania
  // bez ulicy/kodu/miasta, a „Przywroc dane ze sklepu" jest droga powrotna.
  it('wyczyszczenie WSZYSTKICH pól to decyzja operatora, nie urwane żądanie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const puste = Object.fromEntries(Object.keys(FORMULARZ_WYSYLKI).map((k) => [k, '']));
    const r = await wyslij(`/zamowienia/${id}/dane/wysylka`, puste);
    expect(r.statusCode).toBe(302);
    expect(adresOdbiorcy(pobierzZamowienie(db, id)).ulica).toBeNull();
  });

  it('nieistniejące zamówienie → 404', async () => {
    expect((await wyslij('/zamowienia/999/dane/wysylka', FORMULARZ_WYSYLKI)).statusCode).toBe(404);
  });

  it('bez nagłówka Origin → 403 (ochrona CSRF)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/dane/wysylka`, payload: FORMULARZ_WYSYLKI,
      headers: { authorization: naglowek.authorization },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('POST /zamowienia/:id/dane/faktura', () => {
  it('zapisuje wyłącznie zmieniony NIP', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await wyslij(`/zamowienia/${id}/dane/faktura`, { ...FORMULARZ_FAKTURY, nip: '5252445556' });
    const w = db.prepare('SELECT klient_reczny_json FROM zamowienia WHERE id = ?').get(id);
    expect(JSON.parse(w.klient_reczny_json)).toEqual({ nip: '5252445556' });
  });

  it('odznaczenie „klient chce fakturę" zapisuje nadpisanie 0', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const bezZnacznika = { ...FORMULARZ_FAKTURY };
    delete bezZnacznika.chce_fakture;
    await wyslij(`/zamowienia/${id}/dane/faktura`, bezZnacznika);
    expect(chceFakture(pobierzZamowienie(db, id))).toBe(false);
  });

  it('zaznaczenie zgodne ze sklepem nie zostawia nadpisania przełącznika', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await wyslij(`/zamowienia/${id}/dane/faktura`, FORMULARZ_FAKTURY);
    expect(db.prepare('SELECT chce_fakture_reczne FROM zamowienia WHERE id = ?').get(id).chce_fakture_reczne).toBeNull();
  });
});

describe('POST /zamowienia/:id/dane/przywroc', () => {
  it('kasuje wszystkie nadpisania i zdejmuje oznaczenia z karty', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    zapiszNadpisaniaFaktury(db, id, { nip: '5252445556' }, 0);
    const r = await wyslij(`/zamowienia/${id}/dane/przywroc`, {});
    expect(r.statusCode).toBe(302);
    const z = pobierzZamowienie(db, id);
    expect(adresOdbiorcy(z).kod).toBe('00-650');
    expect(daneFaktury(z).nip).toBe('1000001201');
    expect(chceFakture(z)).toBe(true);
    expect((await karta(id)).body).not.toContain('zmienione ręcznie');
  });

  it('przycisk przywracania pokazuje się TYLKO gdy jest co przywracać', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    expect((await karta(id)).body).not.toContain('Przywróć dane ze sklepu');
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    expect((await karta(id)).body).toContain('Przywróć dane ze sklepu');
  });

  // I6 (recenzja calej galezi): formularz zakladania zamowienia recznego (POST
  // /zamowienia/nowe) NIE zbiera adresu — wiec adres wpisany pozniej w „Edytuj" zawsze
  // ladowal jako nadpisanie (nie mial z czym sie zrownac) i przycisk byl PRAKTYCZNIE
  // ZAWSZE widoczny. Jedno klikniecie „przywracalo dane ze sklepu", ktorych nie ma —
  // czyli czyscilo ulice, kod i miasto do pustki. Nie ma sklepu, do ktorego mozna wrocic.
  it('zamówienie ręczne z wpisanym adresem NIE pokazuje przycisku „Przywróć dane ze sklepu”', async () => {
    const id = utworzZamowienieReczne(db, {
      metoda_wysylki: 'dpd', klient: { first_name: 'Jan', last_name: 'Kowalski' },
    });
    await wyslij(`/zamowienia/${id}/dane/wysylka`, {
      nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki',
    });
    const r = await karta(id);
    // Sedno bledu, ktory mial byc naprawiony: adres MA zostac widoczny na karcie —
    // to WYLACZNIE przycisk „przywroc" ma zniknac, nie sam adres.
    expect(r.body).toContain('Polna 1');
    expect(r.body).not.toContain('Przywróć dane ze sklepu');
  });

  // Ta sama pulapka dla danych do faktury (jeden i ten sam przycisk obsluguje oba
  // komplety — patrz saNadpisania w routes/zamowienia.js).
  it('zamówienie ręczne z wpisanym NIP-em do faktury NIE pokazuje przycisku przywracania', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    await wyslij(`/zamowienia/${id}/dane/faktura`, {
      firma: 'ACME sp. z o.o.', nip: '1000001201', chce_fakture: 'on',
    });
    const r = await karta(id);
    expect(r.body).toContain('1000001201');
    expect(r.body).not.toContain('Przywróć dane ze sklepu');
  });

  // Regresja: zamowienie ZE SKLEPU ma dalej dzialac dokladnie tak, jak dotychczas —
  // I6 nie ma prawa wygasic przycisku tam, gdzie „ze sklepu" naprawde cos znaczy.
  it('zamówienie ze sklepu z tą samą poprawką NADAL pokazuje przycisk (bez regresji)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    expect((await karta(id)).body).toContain('Przywróć dane ze sklepu');
  });
});

describe('panel mówi prawdę o tym, czego edycja NIE naprawia', () => {
  const nadanaPaczka = (id) => db.prepare(
    "INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)"
    + " VALUES (?, 'dpd', 'nadana', '0000123456789A', 1, '2026-07-30T10:00:00')",
  ).run(id);

  // ⚠️ OSTRZEŻENIE PRZENIESIONE DO TRYBU EDYCJI 07.08.2026 (prośba właściciela: „ten tekst
  // może pojawiać się po kliknięciu Edytuj. Wcześniej ukryty"). Mówi o SKUTKU POPRAWKI, więc
  // ma sens dokładnie wtedy, gdy ktoś tę poprawkę robi; na karcie do odczytu był czerwonym
  // paskiem przy każdym nadanym zamówieniu, czyli przy większości. Treść bez zmian.
  it('przy nadanej paczce ostrzega — ale dopiero w trybie edycji', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    nadanaPaczka(id);
    expect((await karta(id)).body, 'karta do odczytu ma być czysta')
      .not.toContain('paczki JUŻ NADANEJ to nie zmienia');
    expect((await karta(id, '?edytuj=wysylka')).body, 'edycja ma ostrzegać')
      .toContain('paczki JUŻ NADANEJ to nie zmienia');
  });

  it('bez nadanej paczki tego ostrzeżenia nie ma nawet w edycji', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    expect((await karta(id, '?edytuj=wysylka')).body).not.toContain('paczki JUŻ NADANEJ to nie zmienia');
  });

  it('przy wystawionej fakturze ostrzega, że treści dokumentu to nie zmienia', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    db.prepare("INSERT INTO faktury (zamowienie_id, numer, infakt_uuid, utworzona_at) VALUES (?, 'FV/1/2026', 'u1', '2026-07-30T10:00:00')").run(id);
    expect((await karta(id)).body).toContain('faktury JUŻ WYSTAWIONEJ to nie zmienia');
  });

  it('bez faktury tego ostrzeżenia nie ma', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    expect((await karta(id)).body).not.toContain('faktury JUŻ WYSTAWIONEJ to nie zmienia');
  });
});

describe('ekran nadania startuje z danych Z KARTY, nie ze sklepu', () => {
  const zNadaniem = () => {
    const nadanie = createNadanie({
      db, kurierzy: { dpd: { nadaj: vi.fn() } }, woo: { dodajNotatke: vi.fn() },
      katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-etykiety-')),
    });
    return buildOmsServer({ db, config, poller, nadanie });
  };

  it('formularz nadania niesie ręcznie poprawiony kod pocztowy', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651', miasto: 'Nowa Wieś' });
    const serwer = zNadaniem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('value="00-651"');
    expect(r.body).toContain('value="Nowa Wieś"');
    expect(r.body).not.toContain('value="00-650"');
  });
});

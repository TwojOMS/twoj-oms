// PRZ-152.G13a (właściciel 05.11): odmowa zapisu pozycji wraca KARTĄ w układzie OMS z paskiem nad tabelą,
// tabelą edycji otwartą i wartościami, które człowiek wpisał — nie gołym tekstem na czarnym tle.
// Tryb odczytu: te same kolumny co edycja, osobna „Cena netto”, kwoty z przecinkiem.
import { it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const headers = { authorization: 'Basic ' + Buffer.from('operator:x').toString('base64'), origin: 'http://localhost' };
let db, app, id;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' } }, poller: { stan: () => ({}) } });
  await app.ready();
  id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 5501, numer: '5501', klient: { first_name: 'Ewa', email: 'ewa@przyklad.invalid' }, dostawa: { city: 'Przykładowo' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '387.00',
    koszt_dostawy_brutto: '29.00', koszt_dostawy_netto: '23.58', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-11-05T09:00:00',
    pozycje: [{ zrodlo_id: 77, nazwa: 'Lampa Półcień', sku: 'LP-77', ilosc: 2, cena_brutto: '179.00', cena_netto: '145.53',
      brutto_linii: '358.00', netto_linii: '291.06', vat: '23' }],
  }, {});
});
afterEach(async () => { await app?.close(); db?.close(); });

const zapisz = (payload, url = `/zamowienia/${id}/pozycje/zapisz`) => app.inject({ method: 'POST', url, headers, payload });
const stan = () => db.prepare('SELECT pozycje_reczne_json, kwota_brutto FROM zamowienia WHERE id = ?').get(id);
const sekcja = (body) => body.slice(body.indexOf('id="pozycje"'), body.indexOf('id="przesylka"'));
// Wiersz sklepowy bez zmian + nowy wiersz z podanymi polami (pola równoległe jak w formularzu).
const zNowym = (nowy) => ({
  klucz: ['s77', 'wysylka', ''], nazwa: ['Lampa Półcień', 'Wysyłka', nowy.nazwa], ilosc: ['5', '1', nowy.ilosc],
  sku: ['', '', nowy.sku ?? ''], cena_netto: ['', '', nowy.cena_netto ?? ''], vat: ['', '', nowy.vat ?? '8'],
  cena_brutto: ['179.00', '29.00', nowy.cena_brutto],
});

function kartaZPaskiem(r, tekst) {
  expect(r.statusCode).toBe(400);
  expect(r.headers['content-type']).toContain('text/html');
  expect(r.body).toContain('<html');
  expect(r.body).toContain('class="oms-sidebar');
  expect(r.body).toContain(`<p class="pasek-blokada" id="blad-dane-pozycje">${tekst}</p>`);
  const s = sekcja(r.body);
  // Tabela edycji otwarta.
  expect(s).toContain(`action="/zamowienia/${id}/pozycje/zapisz"`);
  expect(s).toContain('data-wiersze-pozycji');
  return s;
}

it.each([
  ['brak nazwy', { nazwa: '', ilosc: '3', sku: 'KL-9', cena_brutto: '45,00' },
    'Nie udało się zapisać pozycji: Podaj nazwę pozycji — bez niej nie wiadomo, za co klient płaci.'],
  ['brak ceny', { nazwa: 'Klosz zapasowy', ilosc: '3', sku: 'KL-9', cena_brutto: '' },
    'Nie udało się zapisać pozycji: Podaj cenę brutto za sztukę — bez niej nie ma czego doliczyć.'],
  ['ujemna ilość', { nazwa: 'Klosz zapasowy', ilosc: '-2', sku: 'KL-9', cena_brutto: '45,00' },
    'Nie udało się zapisać pozycji: Ilość musi być większa od zera.'],
  ['zerowa ilość', { nazwa: 'Klosz zapasowy', ilosc: '0', sku: 'KL-9', cena_brutto: '45,00' },
    'Nie udało się zapisać pozycji: Ilość musi być większa od zera.'],
])('zapis tabeli, %s: karta z paskiem, wpisane wartości w polach, baza bez zmian', async (_, nowy, tekst) => {
  const przed = stan();
  const s = kartaZPaskiem(await zapisz(zNowym(nowy)), tekst);
  // Nowy wiersz niesie to, co wpisano.
  const nowyWiersz = s.match(/<tr data-wiersz-pozycji>[\s\S]*?<\/tr>/u)[0];
  expect(nowyWiersz).toContain(`name="ilosc" value="${nowy.ilosc}"`);
  expect(nowyWiersz).toContain(`name="nazwa" value="${nowy.nazwa}"`);
  expect(nowyWiersz).toContain('name="sku" value="KL-9"');
  expect(nowyWiersz).toContain(`name="cena_brutto" value="${nowy.cena_brutto}"`);
  expect(nowyWiersz).toMatch(/<option value="8" selected>/u);
  // Zmieniona ilość wiersza sklepowego (5 zamiast 2) też wraca.
  const sklepowy = s.match(/<tr data-pozycja[^>]*>[\s\S]*?value="s77"[\s\S]*?<\/tr>/u)[0];
  expect(sklepowy).toContain('name="ilosc" value="5"');
  expect(stan()).toEqual(przed);
  expect(pobierzZamowienie(db, id).pozycje.filter((p) => p.reczna)).toHaveLength(0);
});

it('wiersz usunięty „×” (usun_nowy) nie wraca, pozostałe nowe wiersze wracają po kolei', async () => {
  const r = await zapisz({
    klucz: ['s77', '', ''], nazwa: ['Lampa Półcień', 'Do wyrzucenia', ''], ilosc: ['2', '1', '4'],
    sku: ['', '', ''], cena_netto: ['', '', ''], vat: ['', '23', '23'], cena_brutto: ['179.00', '10,00', '12,00'], usun_nowy: '0',
  });
  const s = kartaZPaskiem(r, 'Nie udało się zapisać pozycji: Podaj nazwę pozycji — bez niej nie wiadomo, za co klient płaci.');
  const nowe = [...s.matchAll(/<tr data-wiersz-pozycji>[\s\S]*?<\/tr>/gu)].map((m) => m[0]);
  expect(nowe).toHaveLength(1);
  expect(nowe[0]).toContain('name="ilosc" value="4"');
  expect(nowe[0]).toContain('name="cena_brutto" value="12,00"');
  expect(s).not.toContain('Do wyrzucenia');
});

it('stawka wybrana w istniejącym wierszu ręcznym wraca zaznaczona', async () => {
  dodajPozycjeReczna(db, id, { nazwa: 'Szablon', sku: '', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00', vat: null });
  const klucz = pobierzZamowienie(db, id).pozycje.find((p) => p.reczna).klucz;
  const przed = stan();
  const r = await zapisz({
    klucz: ['s77', klucz], nazwa: ['Lampa Półcień', 'Szablon nowy'], ilosc: ['2', '1'], sku: ['', ''],
    cena_netto: ['', ''], vat: ['', '8'], cena_brutto: ['179.00', ''],
  });
  const s = kartaZPaskiem(r, 'Nie udało się zapisać pozycji: Podaj cenę brutto za sztukę — bez niej nie ma czego doliczyć.');
  const wiersz = s.match(new RegExp(`<tr data-pozycja[^>]*>[\\s\\S]*?value="${klucz}"[\\s\\S]*?</tr>`, 'u'))[0];
  expect(wiersz).toContain('name="nazwa" value="Szablon nowy"');
  expect(wiersz).toContain('name="cena_brutto" value=""');
  expect(wiersz).toMatch(/<option value="8" selected>/u);
  expect(stan()).toEqual(przed);
});

it('dopisanie pojedynczej pozycji bez nazwy: karta z paskiem i wpisanymi wartościami', async () => {
  const przed = stan();
  const r = await zapisz({ nazwa: '', ilosc: '2', cena_brutto: '80,00' }, `/zamowienia/${id}/pozycje`);
  const s = kartaZPaskiem(r, 'Podaj nazwę pozycji — bez niej nie wiadomo, za co klient płaci.');
  const nowyWiersz = s.match(/<tr data-wiersz-pozycji>[\s\S]*?<\/tr>/u)[0];
  expect(nowyWiersz).toContain('name="ilosc" value="2"');
  expect(nowyWiersz).toContain('name="cena_brutto" value="80,00"');
  expect(stan()).toEqual(przed);
});

it('w 390 px tabela edycji i odmowy jedzie w bok we własnym przewijaku (nazwa nie łamie się po literze)', async () => {
  const s = kartaZPaskiem(await zapisz(zNowym({ nazwa: '', ilosc: '3', cena_brutto: '45,00' })),
    'Nie udało się zapisać pozycji: Podaj nazwę pozycji — bez niej nie wiadomo, za co klient płaci.');
  expect(s).toMatch(/<div class="przewijak-tabeli">\s*<table class="tab-pozycje tab-stala" data-wiersze-pozycji>/u);
  expect(s).toContain('.tab-pozycje[data-wiersze-pozycji] { min-width: 48rem; }');
});

it('odczyt: kolumny jak w edycji, osobna komórka netto, kwoty z przecinkiem', async () => {
  const r = await app.inject({ url: `/zamowienia/${id}`, headers });
  const s = sekcja(r.body);
  const tab = s.match(/<table[\s\S]*?<\/table>/u)[0];
  expect([...tab.matchAll(/<th\b[^>]*>(.*?)<\/th>/gu)].map((m) => m[1]))
    .toEqual(['', 'Ilość', 'Nazwa', 'SKU', 'Cena netto', 'Stawka VAT', 'Cena brutto', 'Suma']);
  const wiersz = tab.match(/<tr>[\s\S]*?Lampa Półcień[\s\S]*?<\/tr>/u)[0];
  const komorki = [...wiersz.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)].map((m) => m[1].replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim());
  expect(komorki).toEqual(['', '2×', 'Lampa Półcień', 'LP-77', '145,53 zł', '23%', '179,00 zł', '358,00 zł']);
  expect(tab).not.toContain('netto-cicho');
  expect(tab).not.toMatch(/\d\.\d\d zł/u);
});

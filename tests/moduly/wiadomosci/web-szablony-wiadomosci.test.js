import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';
import { wiadomosciZamowienia } from '../../../src/oms/db/wiadomosci.js';
import { wczytajSzablonyWiadomosci, zmienSzablonyWiadomosci } from '../../../src/oms/db/szablony-wiadomosci.js';
import { zapiszSzablon } from '../../../src/domena/szablony-wiadomosci.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-101.03: Ustawienia → Szablony wiadomości, szablon własny na karcie zamówienia, „Wstaw szablon" w Allegro.
// Poczta to atrapa (lista wysłanych w pamięci) — nic nie wychodzi.

const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [], proforma: { rachunek: '00 1111 2222 3333 4444 5555 6666' } };
const ADRES = '/ustawienia/szablony-wiadomosci';

const zamowienie = (nad = {}) => ({
  zrodlo_id: 6001, numer: '1024',
  klient: { first_name: 'Anna', last_name: 'Nowak', email: 'anna.nowak@example.com' },
  dostawa: { first_name: 'Anna', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '476.00', koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-14T09:15:00',
  pozycje: [{ zrodlo_id: 7001, nazwa: 'Lampa stołowa Grzybek', sku: 'LMP-1', ilosc: 2, cena_brutto: '189.00',
    cena_netto: '153.66', brutto_linii: '378.00', netto_linii: '307.32', vat: null },
  { zrodlo_id: 7002, nazwa: 'Klosz lniany', sku: 'KLS-1', ilosc: 1, cena_brutto: '79.00',
    cena_netto: '64.23', brutto_linii: '79.00', netto_linii: '64.23', vat: null }],
  ...nad,
});

let db; let app; let wyslane; let idZ;
const atrapaPoczty = () => ({ sendMail: async (m) => { wyslane.push(m); return { messageId: 't' }; } });
const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers: naglowek, payload });

beforeEach(async () => {
  db = openOmsDb(':memory:');
  wyslane = [];
  idZ = zapiszZamowienie(db, 'pro', zamowienie());
  const mailer = atrapaPoczty();
  const teraz = () => '2026-10-18T10:00:00.000Z';
  app = buildOmsServer({
    db, config, poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
    wiadomosci: createWiadomosci({ db, mailer, config, teraz, potwierdzenie: createPotwierdzenie({ db, mailer, teraz }) }),
    klienciWiadomosci: { allegro_polcien: { wyslijWiadomosc: async () => ({ id: 'm1' }) } },
  });
  await app.ready();
});

describe('ekran Ustawienia → Szablony wiadomości', () => {
  // PRZ-102.21: piąty mail wbudowany „Zamówienie wysłane" — zmiana zachowania listy (było 4 + 2).
  it('lista: pięć maili wbudowanych jako domyślne, zero własnych, przycisk dodawania', async () => {
    const r = await get(ADRES);
    expect(r.statusCode).toBe(200);
    for (const n of ['Potwierdzenie przyjęcia zamówienia', 'Proforma', 'Faktura', 'Przypomnienie o płatności', 'Zamówienie wysłane']) expect(r.body).toContain(`<td>${n}</td>`);
    // PRZ-101.06: dwa maile do zespołu w osobnej sekcji — tu liczymy tylko maile do klienta.
    const klient = r.body.slice(r.body.indexOf('id="szablony-wbudowane"'), r.body.indexOf('id="szablony-wlasne"'));
    expect(klient.match(/<td>domyślna<\/td>/g)).toHaveLength(5);
    expect(r.body.match(/<td>domyślna<\/td>/g)).toHaveLength(7);
    expect(r.body).toContain('href="/ustawienia/szablony-wiadomosci/nowy"');
    expect(r.body).toContain('Szablony wiadomości');
  });

  it('edytor potwierdzenia pokazuje domyślną treść i listę pól z opisem', async () => {
    const r = await get(`${ADRES}/potwierdzenie`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('potwierdzamy przyjęcie zamówienia nr {numer_zamowienia} z dnia {data_zamowienia}.');
    expect(r.body).toContain('<code>{imie}</code>');
    expect(r.body).toContain('<code>{pozycje}</code>');
    expect(r.body).not.toContain('<code>{dane_platnosci}</code>');
  });

  it('edytor przypomnienia oznacza {dane_platnosci} jako obowiązkowe', async () => {
    const r = await get(`${ADRES}/przypomnienie`);
    expect(r.body).toMatch(/<code>\{dane_platnosci\}<\/code> <span class="szw-znacznik">blok<\/span> <span class="szw-znacznik szw-znacznik--wymagane">obowiązkowe<\/span>/);
  });

  it('podgląd (GET) pokazuje mail na przykładowym zamówieniu i niczego nie zapisuje', async () => {
    const q = new URLSearchParams({ podglad: '1', temat: 'Mamy zamówienie {numer_zamowienia}', tresc: 'Dzień dobry {imie},\n\n{pozycje}\n\n{podpis}' });
    const r = await get(`${ADRES}/potwierdzenie?${q}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Mamy zamówienie 1024');
    expect(r.body).toContain('Dzień dobry Anna,');
    expect(r.body).toContain('Lampa stołowa Grzybek 30 cm');
    expect(wczytajSzablonyWiadomosci(db).wbudowane).toEqual({});
  });

  it('odmowa: nieznane pole — 400 z nazwą pola, wpisany tekst zostaje, nic nie zapisane', async () => {
    const r = await post(`${ADRES}/potwierdzenie`, { temat: 'Zamówienie {numer_zamowienia}', tresc: 'Dzień dobry {Imie},\n{podpis}' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('{Imie}');
    expect(r.body).toContain('Dzień dobry {Imie},');
    expect(wczytajSzablonyWiadomosci(db).wbudowane).toEqual({});
  });

  it('odmowa: szablon płatniczy bez {dane_platnosci}', async () => {
    const r = await post(`${ADRES}/proforma`, { temat: 'Proforma {numer_dokumentu}', tresc: 'Prosimy o wpłatę {kwota}.\n\n{podpis}' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('{dane_platnosci}');
    expect(wczytajSzablonyWiadomosci(db).wbudowane.proforma).toBeUndefined();
  });

  it('odmowa: przypomnienie bez {zamkniecie} (przy pobraniu to zdanie mówi o kurierze)', async () => {
    const r = await post(`${ADRES}/przypomnienie`, { temat: 'Przypomnienie {numer_zamowienia}', tresc: 'Dzień dobry,\n\n{dane_platnosci}\n\n{podpis}' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('{zamkniecie}');
    expect(wczytajSzablonyWiadomosci(db).wbudowane.przypomnienie).toBeUndefined();
    expect((await get(`${ADRES}/przypomnienie`)).body)
      .toMatch(/<code>\{zamkniecie\}<\/code> <span class="szw-znacznik szw-znacznik--wymagane">obowiązkowe<\/span>/);
  });

  it('odmowa: pusta nazwa szablonu własnego', async () => {
    const r = await post(`${ADRES}/nowy`, { nazwa: ' ', temat: 'T', tresc: 'Treść' });
    expect(r.statusCode).toBe(400);
    expect(wczytajSzablonyWiadomosci(db).wlasne).toEqual([]);
  });

  it('odmowa: 31. szablon własny', async () => {
    for (let i = 1; i <= 30; i += 1) {
      zmienSzablonyWiadomosci(db, (s) => zapiszSzablon(s, 'nowy', { nazwa: `S${i}`, temat: 'T', tresc: 'x' }, 't'));
    }
    const r = await post(`${ADRES}/nowy`, { nazwa: 'Opóźnienie wysyłki', temat: 'T', tresc: 'x' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('najwyżej 30');
    expect(wczytajSzablonyWiadomosci(db).wlasne).toHaveLength(30);
    expect((await get(ADRES)).body).not.toContain('href="/ustawienia/szablony-wiadomosci/nowy"');
  });
});

describe('edycja potwierdzenia działa w prawdziwym mailu', () => {
  it('nowy temat i treść z podstawionymi polami — w podglądzie karty i w wysłanym mailu; „Przywróć domyślny" wraca', async () => {
    const zapis = await post(`${ADRES}/potwierdzenie`, {
      temat: 'Mamy Twoje zamówienie {numer_zamowienia}',
      tresc: 'Cześć {imie},\n\ndziękujemy za zamówienie na {kwota}.\n\n{pozycje}\n\nOdezwiemy się, gdy paczka wyjedzie.\n\n{podpis}',
    });
    expect(zapis.statusCode).toBe(303);
    expect(zapis.headers.location).toBe(`${ADRES}/potwierdzenie?zapisano=1`);

    const karta = await get(`/zamowienia/${idZ}?wiadomosc=potwierdzenie`);
    expect(karta.body).toContain('Mamy Twoje zamówienie 1024');

    const wysylka = await post(`/zamowienia/${idZ}/wiadomosc/potwierdzenie`);
    expect(wysylka.statusCode).toBe(302);
    expect(wyslane).toHaveLength(1);
    expect(wyslane[0].subject).toBe('Mamy Twoje zamówienie 1024');
    expect(wyslane[0].text).toContain('Cześć Anna,\n\ndziękujemy za zamówienie na 476,00 zł.');
    expect(wyslane[0].text).toContain('ZAMÓWIENIE\n  2 × Lampa stołowa Grzybek');
    expect(wyslane[0].text).not.toMatch(/[{}]/);
    expect(wyslane[0].html).toContain('Cześć Anna,');
    expect(wyslane[0].html).toContain('Lampa stołowa Grzybek');
    expect(wiadomosciZamowienia(db, idZ)).toHaveLength(1);

    const przywroc = await post(`${ADRES}/potwierdzenie/usun`);
    expect(przywroc.statusCode).toBe(303);
    await post(`/zamowienia/${idZ}/wiadomosc/potwierdzenie`);
    expect(wyslane[1].subject).toBe('Potwierdzenie przyjęcia zamówienia nr 1024');
    expect(wyslane[1].text).toContain('potwierdzamy przyjęcie zamówienia nr 1024');
  });
});

describe('szablon własny na karcie zamówienia', () => {
  async function dodajOpoznienie() {
    const r = await post(`${ADRES}/nowy`, {
      nazwa: 'Opóźnienie wysyłki', temat: 'Zamówienie {numer_zamowienia} — wysyłka później',
      tresc: 'Dzień dobry {imie},\n\nzamówienie nr {numer_zamowienia} wyślemy kilka dni później, niż planowaliśmy.\n\n{podpis}',
    });
    expect(r.statusCode).toBe(303);
    return r.headers.location.split('/').pop().split('?')[0];
  }

  it('pojawia się w wyborze tematu, ma podgląd i idzie atrapą poczty z wpisem w rejestrze', async () => {
    const id = await dodajOpoznienie();
    expect(id).toBe('wlasny-1');

    const wybor = await get(`/zamowienia/${idZ}?wiadomosc=nowa`);
    expect(wybor.body).toContain('Szablony własne');
    expect(wybor.body).toContain('<span class="temat-nazwa">Opóźnienie wysyłki</span>');

    const podglad = await get(`/zamowienia/${idZ}?wiadomosc=${id}`);
    expect(podglad.body).toContain('Zamówienie 1024 — wysyłka później');
    expect(podglad.body).toContain(`action="/zamowienia/${idZ}/wiadomosc/${id}"`);

    const r = await post(`/zamowienia/${idZ}/wiadomosc/${id}`);
    expect(r.statusCode).toBe(302);
    expect(wyslane).toHaveLength(1);
    expect(wyslane[0]).toMatchObject({ to: 'anna.nowak@example.com', subject: 'Zamówienie 1024 — wysyłka później' });
    expect(wyslane[0].text).toContain('Dzień dobry Anna,');
    expect(wyslane[0].attachments).toBeUndefined();
    expect(wiadomosciZamowienia(db, idZ)).toEqual([expect.objectContaining({ temat_id: id, adresat: 'anna.nowak@example.com' })]);
    const log = db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(idZ);
    expect(log.at(-1).wynik).toContain('„Opóźnienie wysyłki" wysłane na anna.nowak@example.com');

    // Ta sama ochrona przed podwójnym wysłaniem, co przy mailach wbudowanych.
    const ponownie = await get(`/zamowienia/${idZ}?wiadomosc=${id}`);
    expect(ponownie.body).toContain('Ta wiadomość poszła już');
    expect(ponownie.body).toContain('Wyślij ponownie');
  });

  it('usunięty szablon znika z wyboru, a POST na niego niczego nie wysyła', async () => {
    const id = await dodajOpoznienie();
    expect((await post(`${ADRES}/${id}/usun`)).statusCode).toBe(303);
    expect((await get(`/zamowienia/${idZ}?wiadomosc=nowa`)).body).not.toContain('Opóźnienie wysyłki');
    const r = await post(`/zamowienia/${idZ}/wiadomosc/${id}`);
    expect(r.statusCode).toBe(400);
    expect(wyslane).toHaveLength(0);
  });
});

describe('„Wstaw szablon" w wątku Allegro', () => {
  const watek = (nad = {}) => ({
    kanal: 'allegro_polcien', threadId: 't1', interlocutorLogin: 'anna_now', lastMessageDateTime: '2026-10-18T08:00:00Z',
    typ: 'COMMON', przeczytany: 0, ostatniaOdKupujacego: 1, ostatniaTresc: 'Kiedy wysyłka?', pobranyAt: '2026-10-18T08:01:00Z', ...nad,
  });
  const TRESC = 'Dzień dobry {imie},\n\nzamówienie nr {numer_zamowienia} na {kwota} wyślemy jutro.\n\n{pozycje}\n\n{podpis}';

  beforeEach(async () => {
    zmienSzablonyWiadomosci(db, (s) => zapiszSzablon(s, 'nowy', { nazwa: 'Opóźnienie wysyłki', temat: 'T', tresc: TRESC }, 't'));
    zapiszWatek(db, watek());
  });

  it('?szablon= wypełnia pole odpowiedzi polami zamówienia tego kupującego', async () => {
    zapiszZamowienie(db, 'allegro_polcien', zamowienie({ zrodlo_id: 9001, numer: 'A-77', klient: { first_name: 'Anna', last_name: 'Nowak', email: 'x@allegromail.pl', login: 'anna_now' } }));
    const r = await get('/wiadomosci/allegro_polcien/t1?szablon=wlasny-1');
    expect(r.statusCode).toBe(200);
    const pole = /<textarea id="m-reply"[^>]*>([\s\S]*?)<\/textarea>/.exec(r.body)[1];
    expect(pole).toContain('Dzień dobry Anna,');
    expect(pole).toContain('zamówienie nr A-77 na 476,00 zł wyślemy jutro.');
    expect(pole).toContain('ZAMÓWIENIE');
    expect(pole).not.toMatch(/[{}]/);
    expect(r.body).toContain('Pola z zamówienia nr A-77');
    expect(r.body).toContain('<template data-szablon="wlasny-1">');
  });

  it('wątek bez zamówienia: pola puste, bloki zamówienia znikają, zostaje podpis — bez {…}', async () => {
    const r = await get('/wiadomosci/allegro_polcien/t1?szablon=wlasny-1');
    const pole = /<textarea id="m-reply"[^>]*>([\s\S]*?)<\/textarea>/.exec(r.body)[1];
    expect(pole).toContain('Dzień dobry,\n');
    expect(pole).toContain('zamówienie nr  na  wyślemy jutro.');
    expect(pole).not.toContain('ZAMÓWIENIE');
    expect(pole).toContain('Pozdrawiamy,');
    expect(pole).not.toMatch(/[{}]/);
    expect(r.body).toContain('Nie znaleziono zamówienia tego kupującego');
  });

  it('bez szablonów własnych nie ma listy „Wstaw szablon"', async () => {
    zmienSzablonyWiadomosci(db, (s) => ({ ok: true, stan: { ...s, wlasne: [] } }));
    expect((await get('/wiadomosci/allegro_polcien/t1')).body).not.toContain('Wstaw szablon');
  });
});

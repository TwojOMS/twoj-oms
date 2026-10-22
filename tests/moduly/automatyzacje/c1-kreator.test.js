// PRZ-108.08 (zmiana C1 planu automatyzacji, test 9 i ekran): kreator z PRAWDZIWYM rejestrem modułu — zdarzenia
// „Paczka nadana” i „Status zmienił się na”, akcja „mail do kupującego”, warunki w chwili wykonania; podgląd 30 dni
// z podglądem maila; reguła ze statusem albo szablonem, którego już nie ma; ostrzeżenie na stronie głównej; stary adres
// zapisu automatu KSeF z sekcją reguł. Prawdziwy serwer i moduły; poczta to atrapa (nic nie wychodzi).
import { describe, it, expect, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, zapiszFaktyStatusu, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { faktyDlaStatusu } from '../../../src/domena/status-reczny.js';
import { zapiszStatusy } from '../../../src/oms/db/statusy.js';
import { domyslneStatusy } from '../../../src/domena/statusy-konfiguracja.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { utworzRegule, wlaczRegule } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { createSilnikAutomatyzacji } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { ZDARZENIA } from '../../../src/moduly/automatyzacje/zdarzenia/index.js';
import { utworzAkcje } from '../../../src/moduly/automatyzacje/akcje/index.js';
import { sprawdzanieWarunkow } from '../../../src/moduly/automatyzacje/services/warunki.js';

const EKRAN = '/ustawienia/automatyzacje';
const NOWA = `${EKRAN}/nowa`;
const otwarte = [];
afterEach(async () => { for (const p of otwarte.splice(0)) { await p.app.close(); p.db.close(); } });

function panel() {
  const listy = [];
  // Usługa wiadomości z atrapą poczty na tej samej bazie (nic nie wychodzi naprawdę).
  const db = openOmsDb(':memory:');
  const usluga = { ...createWiadomosci({ db, mailer: { sendMail: async (m) => { listy.push(m); } },
    config: { klienciZbiorczy: [], oprawaPoczty: { podpis: 'Pracownia Przykładowa', footer: 'Stopka' } } }), gotowe: () => true };
  const p = nowyPanel({ db, wiadomosci: usluga });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'ustawienia']);
  const wynik = { ...p, listy, usluga, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
  otwarte.push(wynik);
  return wynik;
}
function zWlasnymStatusemISzablonem(db) {
  zapiszStatusy(db, [...domyslneStatusy(), { klucz: 'w_klosz', etykieta: 'Czeka na klosz', kolor: domyslneStatusy()[0].kolor, jak: 'w_realizacji' }]);
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('szablony.wiadomosci', ?, '2026-10-21')")
    .run(JSON.stringify({ wbudowane: {}, wlasne: [{ id: 'wlasny-1', nazwa: 'Paczka w drodze', temat: 'Paczka', tresc: 'Jedzie.\n\n{podpis}' }], licznik: 1 }));
}
let nr = 0;
function zamowienieWyslane(db, { sklep = 'pro', email = 'kupujacy@example.invalid', numer = null } = {}) {
  nr += 1;
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: 8000 + nr, numer: `K-${nr}`, klient: { first_name: 'Ewa', last_name: 'Lis', email, phone: '' },
    dostawa: { first_name: 'Ewa', last_name: 'Lis', address_1: 'Polna 1', postcode: '00-001', city: 'Kraków' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '99.00',
    koszt_dostawy_brutto: '10.00', koszt_dostawy_netto: '8.13', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: new Date(Date.now() - 864e5).toISOString(), /* wczoraj: starsze niż 14 dni przed włączeniem = historia (recenzja 08) */ pozycje: [{ zrodlo_id: 9500 + nr, nazwa: 'Klosz lniany 40 cm', sku: 'KLS-LEN-40', ilosc: 1,
      cena_brutto: '89.00', cena_netto: '72.36', brutto_linii: '89.00', netto_linii: '72.36', vat: null }],
  });
  if (numer) {
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'nadana', ?, 1, ?)")
      .run(id, numer, new Date().toISOString());
  }
  zapiszFaktyStatusu(db, id, { ...faktyDlaStatusu(pobierzZamowienie(db, id), 'wyslane'), kto: 'adam' });
  return id;
}
const FORM = { nazwa: 'Wysłane — sklep', zdarzenie: 'status_zmieniony', zdarzenie_status: 'wyslane', kanaly: ['pro'],
  opoznienie: '30', status_warunek: 'jeden_z', statusy: ['wyslane'], ma_numer_listu: '1', dostawa: '', pobranie: 'dowolne',
  akcja: 'mail_kupujacy', szablon: 'wyslane', limit: '20' };
const reguly = (db) => db.prepare('SELECT * FROM automatyzacje_reguly ORDER BY id').all();

describe('9. kreator z prawdziwym rejestrem', () => {
  it('krok 1: „Paczka nadana” i „Status zmienił się na” do wyboru; status zdarzenia: W realizacji, Wysłane, własne; Nowe/Zwrot/Anulowane „wkrótce”', async () => {
    const p = panel();
    zWlasnymStatusemISzablonem(p.db);
    const r = await get(p.app, NOWA, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/name="zdarzenie" value="paczka_nadana"/u);
    expect(r.body).toMatch(/name="zdarzenie" value="status_zmieniony"/u);
    expect(r.body).toContain('name="zdarzenie_status"');
    expect(r.body).toMatch(/<option value="wyslane"[^>]*>Wysłane<\/option>/u);
    expect(r.body).toMatch(/<option value="w_realizacji"[^>]*>W realizacji<\/option>/u);
    expect(r.body).toMatch(/<option value="w_klosz"[^>]*>Czeka na klosz \(status własny\)<\/option>/u);
    expect(r.body).toMatch(/<option disabled>Anulowane — wkrótce<\/option>/u);
    expect(r.body).toContain('>Dalej<');
  });
  it('krok 2 (status → Wysłane): opóźnienie 30, warunek „status jest Wysłane” zaznaczony, „ma numer listu” wymuszony szablonem; szablony bez proformy, faktury i przypomnienia', async () => {
    const p = panel();
    zWlasnymStatusemISzablonem(p.db);
    const r = await get(p.app, `${NOWA}?zdarzenie=status_zmieniony&zdarzenie_status=wyslane`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Status zamówienia zmienił się na: Wysłane');
    expect(r.body).toMatch(/name="opoznienie" value="30"/u);
    expect(r.body).toMatch(/name="status_warunek" value="jeden_z" checked/u);
    expect(r.body).toMatch(/name="statusy" value="wyslane" checked/u);
    expect(r.body).toMatch(/name="statusy" value="w_klosz">/u);
    expect(r.body).toMatch(/name="ma_numer_listu" value="1" checked disabled/u);
    expect(r.body).toContain('Wymagane przez szablon „Zamówienie wysłane”');
    expect(r.body).toContain('name="dostawa"');
    expect(r.body).toContain('name="pobranie"');
    expect(r.body).toMatch(/<option value="wyslane" selected>Zamówienie wysłane<\/option>/u);
    expect(r.body).toContain('value="wlasny-1"');
    for (const s of ['proforma', 'faktura', 'przypomnienie', 'potwierdzenie']) expect(r.body).not.toContain(`<option value="${s}"`);
    expect(r.body).toContain('Adres e-mail kupującego z zamówienia');
  });
  it('krok 2 z „paczka nadana”: szablon „Zamówienie wysłane” i własne; status dowolny', async () => {
    const p = panel();
    zWlasnymStatusemISzablonem(p.db);
    const r = await get(p.app, `${NOWA}?zdarzenie=paczka_nadana`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/name="status_warunek" value="dowolny" checked/u);
    expect(r.body).toContain('<option value="wyslane" selected>Zamówienie wysłane</option>');
    expect(r.body).toContain('value="wlasny-1"');
    expect(r.body).not.toContain('<option value="proforma"');
  });
  it('krok 2 ze statusem spoza listy → 400', async () => {
    const p = panel();
    expect((await get(p.app, `${NOWA}?zdarzenie=status_zmieniony&zdarzenie_status=anulowane`, p.admin)).statusCode).toBe(400);
  });
  it('zapis: szablon „Zamówienie wysłane” bez pola „ma numer listu” → warunek wymuszony; jawne „nie” → 400', async () => {
    const p = panel();
    const { ma_numer_listu: _m, ...bez } = FORM;
    expect((await post(p.app, NOWA, p.admin, bez)).statusCode).toBe(303);
    const r = reguly(p.db)[0];
    expect(JSON.parse(r.zdarzenie_json)).toEqual({ status: 'wyslane' });
    expect(JSON.parse(r.warunki_json)).toMatchObject({ kanaly: ['pro'], statusy: ['wyslane'], maNumerListu: true, pobranie: 'dowolne' });
    expect(r.wlaczona).toBe(0);
    const nie = await post(p.app, NOWA, p.admin, { ...FORM, ma_numer_listu: '0' });
    expect(nie.statusCode).toBe(400);
    expect(nie.body).toContain('wymaga warunku');
    expect(reguly(p.db)).toHaveLength(1);
  });
  it.each(['-1', '10081', 'abc'])('opóźnienie %s → 400, nic nie zapisane', async (opoznienie) => {
    const p = panel();
    expect((await post(p.app, NOWA, p.admin, { ...FORM, opoznienie })).statusCode).toBe(400);
    expect(reguly(p.db)).toEqual([]);
  });
  it('„Sprawdź na 30 dniach” na danych: liczby > 0, pominięte z powodami, przykłady z numerem listu i podgląd maila; zero zapisów', async () => {
    const p = panel();
    const z1 = zamowienieWyslane(p.db, { numer: '0000000000119U' });
    zamowienieWyslane(p.db, { email: '', numer: '0000000000120U' });
    zamowienieWyslane(p.db); // bez paczki
    zamowienieWyslane(p.db, { sklep: 'allegro_szkicownia', numer: '0000000000121U' });
    const przed = p.db.prepare('SELECT total_changes() AS n').get().n;
    const r = await post(p.app, `${EKRAN}/sprawdz`, p.admin, FORM);
    expect(p.db.prepare('SELECT total_changes() AS n').get().n).toBe(przed);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/zadziałałaby dla <strong>3 zamówień<\/strong>/u);
    expect(r.body).toMatch(/1 — Wyślij mail do kupującego/u);
    expect(r.body).toContain('bez adresu e-mail');
    expect(r.body).toContain('niespełniony warunek');
    expect(r.body).toContain('Allegro szkicownia_pl (1)');
    expect(r.body).toContain('DPD 0000000000119U'); // ta sama funkcja co stan tematu na karcie (numeryPaczek)
    expect(r.body).toContain('mail na kupujacy@example.invalid');
    expect(r.body).toContain(`Podgląd maila — zamówienie ${pobierzZamowienie(p.db, z1).numer}`);
    expect(r.body).toContain('https://tracktrace.dpd.com.pl/parcelDetails?p1=0000000000119U');
    expect(p.listy).toEqual([]);
  });
});

describe('1. status ustawiony prawdziwymi trasami (karta, zmiana masowa, ręczna rejestracja paczki)', () => {
  it('każda z trzech dróg „Wysłane” daje 1 wykonanie i 1 mail; zamówienie nietknięte — 0', async () => {
    const p = panel();
    const id = utworzRegule(p.db, { nazwa: 'Wysłane — sklep', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'wyslane' },
      warunki: { kanaly: ['pro'], kanalyZnane: ['pro'], statusy: ['wyslane'], maNumerListu: true, metody: [], pobranie: 'dowolne' },
      akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' }, opoznienie_min: 0, limit_na_godzine: 20 }, { login: 'adam' });
    expect((await post(p.app, `${EKRAN}/${id}/wlacz`, p.admin, {})).statusCode).toBe(303);
    const nowe = (numer) => {
      const z = zamowienieWyslane(p.db, { numer });
      zapiszFaktyStatusu(p.db, z, { ...faktyDlaStatusu(pobierzZamowienie(p.db, z), 'w_realizacji'), kto: 't' });
      return z;
    };
    const karta = nowe('0000000000201U');
    const masowa = nowe('0000000000202U');
    const reczna = nowe(null);
    const nietkniete = nowe('0000000000204U');
    expect((await post(p.app, `/zamowienia/${karta}/status`, p.admin, { status: 'wyslane' })).statusCode).toBeLessThan(400);
    expect((await post(p.app, '/zamowienia/masowe/status', p.admin, { id: [String(masowa)], status: 'wyslane' })).statusCode).toBeLessThan(400);
    expect((await post(p.app, `/zamowienia/${reczna}/przesylki/reczna`, p.admin, { numer_listu: '0000000000203U' })).statusCode).toBeLessThan(400);
    const silnik = createSilnikAutomatyzacji({ db: p.db, zdarzenia: ZDARZENIA, akcje: utworzAkcje({ wiadomosci: () => p.usluga }),
      sprawdzWarunki: sprawdzanieWarunkow, pocztaGotowa: () => true });
    await silnik.przebieg();
    const w = p.db.prepare('SELECT zamowienie_id, stan FROM automatyzacje_wykonania ORDER BY zamowienie_id').all();
    expect(w).toEqual([karta, masowa, reczna].map((zamowienie_id) => ({ zamowienie_id, stan: 'wyslane' })));
    expect(p.listy.map((m) => m.text.match(/0000000000\d{3}U/u)[0]).sort()).toEqual(['0000000000201U', '0000000000202U', '0000000000203U']);
    expect(w.some((x) => x.zamowienie_id === nietkniete)).toBe(false);
  });
});

describe('reguła z nieistniejącym statusem albo szablonem', () => {
  it('status własny usunięty z Ustawień → lista i dziennik na czerwono „status nie istnieje”; włączenie → 409', async () => {
    const p = panel();
    const id = utworzRegule(p.db, { nazwa: 'Klosz', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'w_usuniety' },
      warunki: { kanaly: ['pro'], kanalyZnane: ['pro'], statusy: [], maNumerListu: false, metody: [], pobranie: 'dowolne' },
      akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' }, opoznienie_min: 0, limit_na_godzine: 20 }, { login: 'adam' });
    const lista = await get(p.app, EKRAN, p.admin);
    expect(lista.body).toContain('status nie istnieje');
    const d = await get(p.app, `${EKRAN}/${id}`, p.admin);
    expect(d.body).toContain('status nie istnieje');
    expect((await post(p.app, `${EKRAN}/${id}/wlacz`, p.admin, {})).statusCode).toBe(409);
  });
  it('szablon własny usunięty → lista „szablon usunięty”', async () => {
    const p = panel();
    utworzRegule(p.db, { nazwa: 'Własny', zdarzenie: 'paczka_nadana', zdarzenie_json: {},
      warunki: { kanaly: ['pro'], kanalyZnane: ['pro'], statusy: [], maNumerListu: false, metody: [], pobranie: 'dowolne' },
      akcja: 'mail_kupujacy', akcja_json: { szablon: 'wlasny-9' }, opoznienie_min: 0, limit_na_godzine: 20 }, { login: 'adam' });
    expect((await get(p.app, EKRAN, p.admin)).body).toContain('szablon usunięty');
  });
});

describe('ostrzeżenie na stronie głównej (tylko admin)', () => {
  it('reguła wstrzymana i niepewna wysyłka → wiersze dla admina; konto bez admina ich nie widzi', async () => {
    const p = panel();
    const id = utworzRegule(p.db, { nazwa: 'Wysłane — sklep', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'wyslane' },
      warunki: { kanaly: ['pro'], kanalyZnane: ['pro'], statusy: ['wyslane'], maNumerListu: true, metody: [], pobranie: 'dowolne' },
      akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' }, opoznienie_min: 0, limit_na_godzine: 20 }, { login: 'adam' });
    wlaczRegule(p.db, id, { login: 'adam' });
    p.db.prepare("UPDATE automatyzacje_reguly SET wstrzymana_powod = '51 zamówień naraz w jednym sprawdzeniu' WHERE id = ?").run(id);
    const z = zamowienieWyslane(p.db, { numer: '0000000000130U' });
    p.db.prepare(`INSERT INTO automatyzacje_wykonania (regula_id, przedmiot, zamowienie_id, stan, powod, zdarzenie_at, wykryte_at, termin_at, zakonczone_at)
      VALUES (?, ?, ?, 'niepewne', 'zerwane', ?, ?, ?, ?)`).run(id, `zamowienie:${z}`, z, ...Array(4).fill(new Date().toISOString()));
    const admin = await get(p.app, '/', p.admin);
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain('Automatyzacja „Wysłane — sklep” jest wstrzymana');
    expect(admin.body).toContain('nie wiadomo, czy mail wyszedł');
    expect(admin.body).toContain(`href="${EKRAN}/${id}"`);
    const ewa = await get(p.app, '/', p.ewa);
    expect(ewa.statusCode).toBe(200);
    expect(ewa.body).not.toContain('Automatyzacja „Wysłane — sklep”');
  });
});

describe('stary adres zapisu automatu KSeF', () => {
  it('błąd formularza → 400 z ekranem Automatyzacji w wersji z regułami (nie „wkrótce”)', async () => {
    const p = panel();
    const r = await post(p.app, '/ustawienia/integracje/infakt/ksef-automat', p.admin, { wlaczony: '1', godzina: '25:00' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Dodaj automatyzację');
    expect(r.body).not.toMatch(/Reguły <span class="menu-ustawien-wkrotce">wkrótce/u);
  });
});

// PRZ-108.09 (zmiana C2): „Kurier odebrał paczkę” w kreatorze — do wyboru, z opisem, dla jakich paczek działa.
describe('C2: kreator — „Kurier odebrał paczkę”', () => {
  it('krok 1: zdarzenie do wyboru (nie „wkrótce”), opis mówi o DPD i InPost, wyjaśnienie dla Allegro i paczek bez śledzenia', async () => {
    const p = panel();
    const r = await get(p.app, NOWA, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/name="zdarzenie" value="paczka_odebrana"/u);
    expect(r.body).not.toMatch(/Kurier odebrał paczkę<span class="menu-ustawien-wkrotce">/u);
    const fragment = r.body.slice(r.body.indexOf('value="paczka_odebrana"'), r.body.indexOf('value="paczka_doreczona"'));
    expect(fragment).toContain('DPD');
    expect(fragment).toContain('InPost');
    expect(fragment).toMatch(/bez śledzenia/u);
    expect(fragment).toMatch(/Allegro/u);
  });
  it('krok 2 z „kurier odebrał”: szablon „Zamówienie wysłane” do wyboru', async () => {
    const p = panel();
    const r = await get(p.app, `${NOWA}?zdarzenie=paczka_odebrana`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<option value="wyslane" selected>Zamówienie wysłane</option>');
    expect(r.body).not.toContain('<option value="proforma"');
  });
});

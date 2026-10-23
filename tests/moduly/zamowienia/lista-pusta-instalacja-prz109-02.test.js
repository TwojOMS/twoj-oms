// PRZ-109.02: pusta lista zamówień w nowej instalacji. Dopóki w bazie nie ma ŻADNEGO zamówienia, tabela mówiła
// „Nie ma tu nic do zrobienia.” — czyli „wszystko załatwione”, a prawda jest inna: kanał sprzedaży nie jest jeszcze
// podłączony. Zdanie zostaje tam, gdzie jest prawdziwe (zamówienia są, ta zakładka jest pusta). Test sprawdza
// WYRENDEROWANY HTML komórki `pusto` i jej odnośnik do „Sklepy i usługi” (tylko dla roli z prawem do Ustawień).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

const katalogi = [];
afterEach(() => { vi.unstubAllGlobals(); for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true }); });

const NOWE = 'Nie ma jeszcze żadnych zamówień.';
const STARE = 'Nie ma tu nic do zrobienia.';

const zamowienie = (nad = {}) => ({
  zrodlo_id: 9101, numer: '9101', klient: { email: 'anna@przyklad.example', first_name: 'Anna', last_name: 'Lampowska' },
  dostawa: { first_name: 'Anna', last_name: 'Lampowska', address_1: 'Polna 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '120.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-17T13:19:52',
  pozycje: [{ nazwa: 'Lampa stołowa Nova', sku: 'LAMPA-1', ilosc: 1, cena_brutto: '120.00', brutto_linii: '120.00', vat: null }],
  ...nad,
});

/** Stawia OMS na pustej bazie bez kanałów, loguje konto o danej roli i oddaje HTML listy pod `url`. */
async function lista({ rola = 'administrator', url = '/', wBazie = null } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
  const katalog = mkdtempSync(join(tmpdir(), 'oms109-02-')); katalogi.push(katalog);
  const a = await zbudujOms({ env: {
    OMS_TRYB: 'produkcja', OMS_DB_PATH: join(katalog, 'oms.sqlite'), OMS_USER: 'operator', OMS_PASS: 'atrapa',
    OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_KANALY: '[]',
    OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog,
  } });
  try {
    zalozKonto(a.db, { login: 'wlasciciel', imie: 'Właściciel', haslo: 'haslo-testowe-109', rola: 'administrator', admin: true });
    if (rola !== 'administrator') zalozKonto(a.db, { login: 'pracownik', imie: 'Pracownik', haslo: 'haslo-testowe-109', rola });
    if (wBazie) zapiszZamowienie(a.db, 'reczne', wBazie, {});
    const login = await a.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost' },
      payload: { uzytkownik: rola === 'administrator' ? 'wlasciciel' : 'pracownik', haslo: 'haslo-testowe-109', powrot: '/' } });
    expect(login.statusCode, login.body).toBe(302);
    const cookie = [].concat(login.headers['set-cookie']).find(c => c.startsWith(`${NAZWA_CIASTECZKA_OMS}=`)).split(';')[0];
    const r = await a.app.inject({ url, headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    return r.body;
  } finally { await a.app.close(); a.db.close?.(); }
}

/** Zawartość komórki `pusto` (jedyna w tabeli) albo `null`, gdy lista nie jest pusta. */
const komorkaPusta = (html) => {
  const od = html.indexOf('<td class="pusto"');
  if (od === -1) return null;
  return html.slice(od, html.indexOf('</td>', od));
};

describe('PRZ-109.02 pusta lista w nowej instalacji', () => {
  it('baza bez żadnego zamówienia: mówi, że zamówień jeszcze nie ma, i wskazuje kanał oraz ręczne dodanie', async () => {
    const k = komorkaPusta(await lista());
    expect(k).not.toBeNull();
    expect(k).toContain(NOWE);
    expect(k).toContain('sklep WooCommerce albo konto Allegro');
    expect(k).toContain('+ Nowe zamówienie');
    expect(k).not.toContain(STARE);
    // Komórka ma ten sam układ co dotąd: klasa `pusto` i colspan całej tabeli.
    expect(k).toContain('colspan="7"');
  });
  it('administrator dostaje odnośnik do „Sklepy i usługi”', async () => {
    const k = komorkaPusta(await lista());
    expect(k).toContain('<a href="/ustawienia/integracje">');
  });
  it('rola bez prawa do Ustawień widzi ten sam tekst, ale bez odnośnika', async () => {
    const k = komorkaPusta(await lista({ rola: 'sprzedaz' }));
    expect(k).toContain(NOWE);
    expect(k).not.toContain('<a ');
    expect(k).not.toContain('/ustawienia');
  });
  it('„Wszystkie” w pustej bazie mówi to samo (nie ma ani wyszukiwania, ani filtrów)', async () => {
    expect(komorkaPusta(await lista({ url: '/?wszystkie=1' }))).toContain(NOWE);
  });
  it('zamówienia są w bazie, tylko zakładka „Do zrobienia” jest pusta: zostaje stare zdanie', async () => {
    const k = komorkaPusta(await lista({ wBazie: zamowienie({ anulowane: 1 }) }));
    expect(k).not.toBeNull();
    expect(k).toContain(STARE);
    expect(k).not.toContain(NOWE);
    expect(k).not.toContain('/ustawienia');
  });
  it('wyszukiwanie i filtry w pustej bazie zachowują własne komunikaty', async () => {
    expect(komorkaPusta(await lista({ url: '/?szukaj=lampa' }))).toContain('Brak zamówień pasujących do wyszukiwania.');
    expect(komorkaPusta(await lista({ url: '/?od=2026-01-01' }))).toContain('Żadne zamówienie nie mieści się w ustawionych filtrach.');
  });
});

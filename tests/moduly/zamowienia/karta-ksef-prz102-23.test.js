// PRZ-102.23 — „Wyślij do KSeF” z karty zamówienia (właściciel 20.10.2026).
//
// ⚠️ Karta NIE ma własnej ścieżki wysyłki: przycisk prowadzi do TEGO SAMEGO podglądu (`POST /faktury/ksef/podglad`),
// a zatwierdzenie do `POST /faktury/ksef/wyslij`. Bariera (`coWolnoWyslac`), rezerwacja i ślad w logu — bez zmian.
// Test integracyjny składa PRAWDZIWE `createFakturyWidok` i `createWysylkaKsef` na fałszywym inFakcie (bez sieci).
import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { wstrzymajFakture } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { podmienLukiKsef } from '../../../src/oms/db/ostrzezenia.js';
import { zapewnijOkres, zakonczFaktureOkresu, rozpocznijFaktureOkresu } from '../../../src/oms/db/okresy.js';
import { POWOD_KONSUMENCKA, POWOD_KOREKTA, UWAGA_BEZ_NIP_NA_KARCIE } from '../../../src/domena/wysylka-ksef.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

const NIP = '1234563218';
const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}`, origin: 'http://localhost' };
const config = () => ({ auth: { user: 't', pass: 'h' } });

const dok = (uuid, invoice_date, nadpisz = {}) => ({
  uuid, number: `${uuid}/10/2026`, rodzaj: 'vat', invoice_date, sale_date: invoice_date, ksef_number: null,
  client_company_name: 'Pracownia Przykładowa', client_tax_code: NIP, gross_price: 12300, left_to_pay: 0, ...nadpisz,
});

// Fałszywy inFakt: listy filtrowane po polu daty jak w API, wysyłka tylko zapisuje uuid. ⛔ Żadnej sieci.
function falszywyInfakt(dokumenty) {
  const wyslane = [];
  const zakres = (rodzaj) => async ({ od, do: koniec, pole = 'invoice_date' }) => dokumenty
    .filter((d) => d.rodzaj === rodzaj && String(d[pole]) >= od && String(d[pole]) <= koniec).map((d) => ({ ...d }));
  return {
    wyslane,
    listaFaktur: zakres('vat'),
    listaKorekt: zakres('korekta'),
    wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return { invoice_task_reference_number: `ref-${uuid}` }; },
  };
}

// Zamówienie z wystawioną fakturą (wiersz `faktury` jak po udanym wystawieniu z panelu), utworzoną o podanej chwili.
function zamowienieZFaktura(db, { uuid = 'u1', nip = NIP, numer = `${uuid}/10/2026`, utworzona = '2026-10-20T10:00:00.000Z', ksefNumer = null } = {}) {
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${uuid}`, numer: `Z-${uuid}`, klient: { first_name: 'Jan', last_name: 'Przykładowy', company: 'Pracownia Przykładowa' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip, kwota_brutto: '123.00',
    koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [],
    utworzone_at: '2026-10-20T09:00:00',
  }, {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid, numer, ksefStatus: null });
  db.prepare('UPDATE faktury SET utworzona_at = ?, ksef_numer = ? WHERE id = ?').run(utworzona, ksefNumer, f.id);
  return id;
}

const apki = [];
afterEach(async () => { for (const a of apki.splice(0)) await a.close(); });

function panel(dokumenty = [dok('u1', '2026-10-20')]) {
  const db = openOmsDb(':memory:');
  const infakt = falszywyInfakt(dokumenty);
  const fakturyWidok = createFakturyWidok({ db, infakt });
  const wysylkaKsef = createWysylkaKsef({ db, infakt, fakturyWidok, log: () => {} });
  const app = buildOmsServer({ db, config: config(), fakturyWidok, wysylkaKsef });
  apki.push(app);
  return { db, app, infakt };
}

const karta = (app, id) => app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
const PRZYCISK = /<form[^>]*action="\/faktury\/ksef\/podglad"[\s\S]*?Wyślij do KSeF<\/button>\s*<\/form>/;
const ukryte = (html, nazwa) => [...html.matchAll(new RegExp(`name="${nazwa}" value="([^"]*)"`, 'g'))].map((m) => m[1]);

it('PRZ-102.26: włączone B2C — przycisk karty bez fałszywej odmowy, podgląd i wysyłka na atrapie', async () => {
  const { db, app, infakt } = panel([dok('u1', '2026-10-20', { client_tax_code: '' })]);
  const id = zamowienieZFaktura(db, { nip: null });
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('ksef.konsumenckie', '1', '2026-10-20')").run();
  const r = await karta(app, id);
  expect(r.body).toMatch(PRZYCISK);
  expect(r.body).not.toContain(UWAGA_BEZ_NIP_NA_KARCIE);
  const payload = { uuid: 'u1', miesiac: '2026-10', pole: 'invoice_date', powrot: `/zamowienia/${id}` };
  const podglad = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH, payload });
  expect(podglad.statusCode).toBe(200);
  expect(podglad.body).toContain('name="potwierdzam"');
  const wynik = await app.inject({ method: 'POST', url: '/faktury/ksef/wyslij', headers: AUTH, payload: { ...payload, potwierdzam: '1' } });
  expect(wynik.statusCode).toBe(200);
  expect(infakt.wyslane).toEqual(['u1']);
});

describe('PRZ-102.23 przycisk „Wyślij do KSeF” na karcie', () => {
  it('faktura VAT z NIP-em bez KSeF → formularz do podglądu z uuid, miesiącem, polem daty i powrotem na kartę', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db);
    const r = await karta(app, id);
    expect(r.statusCode).toBe(200);
    const formularz = r.body.match(PRZYCISK)?.[0];
    expect(formularz, 'brak przycisku „Wyślij do KSeF”').toBeTruthy();
    expect(ukryte(formularz, 'uuid')).toEqual(['u1']);
    expect(ukryte(formularz, 'miesiac')).toEqual(['2026-10']);
    expect(ukryte(formularz, 'pole')).toEqual(['invoice_date']);
    expect(ukryte(formularz, 'powrot')).toEqual([`/zamowienia/${id}`]);
    // Kotwica powrotu (`#faktura`) ma cel na karcie.
    expect(r.body).toMatch(/id="faktura"/);
    expect(r.body).not.toContain(UWAGA_BEZ_NIP_NA_KARCIE);
  });

  it('miesiąc z daty wystawienia z lustra luk KSeF (faktura z datą wsteczną), nie z dnia wystawienia w panelu', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db, { utworzona: '2026-11-01T08:00:00.000Z' });
    podmienLukiKsef(db, [{ uuid: 'u1', numer: 'u1/10/2026', invoiceDate: '2026-10-31' }]);
    const formularz = (await karta(app, id)).body.match(PRZYCISK)?.[0];
    expect(ukryte(formularz, 'miesiac')).toEqual(['2026-10']);
  });

  it('bez lustra miesiąc liczy się z chwili wystawienia w czasie Warszawy (31.10 23:30 UTC = 1 listopada)', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db, { utworzona: '2026-10-31T23:30:00.000Z' });
    const formularz = (await karta(app, id)).body.match(PRZYCISK)?.[0];
    expect(ukryte(formularz, 'miesiac')).toEqual(['2026-11']);
  });

  // Poprawka po recenzji: „konsumencka” rozstrzyga dokument w inFakcie, nie bieżące dane karty.
  it('faktura wystawiona z NIP-em, potem NIP usunięty z danych karty → przycisk jest (lista Faktur by ją wysłała)', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db);
    const zapis = await app.inject({ method: 'POST', url: `/zamowienia/${id}/dane/faktura`, headers: AUTH,
      payload: { nip: '', chce_fakture: '1' } });
    expect(zapis.statusCode).toBe(302);
    const r = await karta(app, id);
    expect(r.body, 'NIP zniknął z danych karty — inaczej test niczego nie sprawdza').not.toContain(NIP);
    expect(r.body).toMatch(PRZYCISK);
    expect(r.body).toContain(UWAGA_BEZ_NIP_NA_KARCIE);
    expect(r.body).not.toContain(POWOD_KONSUMENCKA);
  });

  it('bez NIP-u na karcie i konsumencka w inFakcie → przycisk z dopiskiem, a podgląd odbija ją z powodem bariery', async () => {
    const { db, app } = panel([dok('u1', '2026-10-20', { client_tax_code: '' })]);
    const id = zamowienieZFaktura(db, { nip: null });
    const r = await karta(app, id);
    const formularz = r.body.match(PRZYCISK)?.[0];
    expect(formularz).toBeTruthy();
    expect(r.body).toContain(UWAGA_BEZ_NIP_NA_KARCIE);
    const podglad = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
      payload: { uuid: 'u1', miesiac: ukryte(formularz, 'miesiac')[0], pole: 'invoice_date', powrot: `/zamowienia/${id}` } });
    expect(podglad.body).toContain(POWOD_KONSUMENCKA);
    expect(podglad.body).not.toContain('name="potwierdzam"');
  });

  it('dokument z rezerwacją („nie wiadomo”) → bez przycisku, zdanie „panel już zlecił”', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db);
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: '2026-10-20T18:00:00.000Z' });
    const r = await karta(app, id);
    expect(r.body).not.toMatch(PRZYCISK);
    expect(r.body).toContain('Panel już zlecił wysyłkę tego dokumentu do KSeF (2026-10-20T18:00:00.000Z)');
    // Kolumna stanu mówi to samo, co lista Faktur — nie „jeszcze nie wysłana” obok „panel już zlecił”.
    expect(r.body).toContain('zlecona z panelu — czeka na numer KSeF');
    expect(r.body).not.toContain('jeszcze nie wysłana do KSeF');
  });

  it('dokument z numerem KSeF → bez przycisku, stan mówi numer', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db, { ksefNumer: '1234563218-20261020-ABCDEF-01' });
    const r = await karta(app, id);
    expect(r.body).not.toMatch(PRZYCISK);
    expect(r.body).toContain('1234563218-20261020-ABCDEF-01');
  });

  it('korekta w tabeli dokumentów → w kolumnie stanu zdanie z bariery, przycisku nie ma', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db, { ksefNumer: 'KSEF-FAKTURY' });
    db.prepare(`INSERT INTO zwroty (zamowienie_id, data, kwota, korekta_numer, korekta_uuid, utworzony_at) VALUES (?, '2026-10-20', '12.30', 'KOR/1/10/2026', 'k1', '2026-10-20T10:00:00.000Z')`).run(id);
    const r = await karta(app, id);
    expect(r.body).toContain('KOR/1/10/2026');
    expect(r.body).toContain(POWOD_KOREKTA);
    expect(r.body).not.toMatch(PRZYCISK);
  });

  it('faktura wstrzymana przez automat → przycisk jest (ręczna wysyłka to droga wyjścia)', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db);
    wstrzymajFakture(db, { uuid: 'u1', numer: 'u1/10/2026', dzien: '2026-10-19', powod: 'inFakt odrzucił (422)' });
    expect((await karta(app, id)).body).toMatch(PRZYCISK);
  });

  it('zamówienie w okresie z fakturą zbiorczą → bez przycisku, odesłanie na listę Faktur', async () => {
    const { db, app } = panel();
    const id = zapiszZamowienie(db, 'pro', {
      zrodlo_id: 'w-okres', numer: 'Z-okres', klient: { first_name: 'Jan' }, dostawa: {}, metoda_wysylki: 'dpd',
      kwota_pobrania: null, chce_fakture: 1, nip: NIP, kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
      status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [], utworzone_at: '2026-10-05T09:00:00',
    }, {});
    const okres = zapewnijOkres(db, { klientKlucz: NIP, rok: 2026, miesiac: 10 });
    const okresId = okres?.id ?? okres;
    db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = ? WHERE id = ?').run(okresId, id);
    rozpocznijFaktureOkresu(db, okresId);
    zakonczFaktureOkresu(db, okresId, { uuid: 'okres-u', numer: 'FZ/1/10/2026', ksefStatus: null });
    const r = await karta(app, id);
    expect(r.body).not.toMatch(PRZYCISK);
    expect(r.body).toMatch(/do KSeF wysyłasz ją z zakładki <a href="\/faktury[^"]*">Faktury<\/a>/);
  });
});

describe('PRZ-102.23 prawo do Faktur', () => {
  it('konto bez prawa „faktury” (Produkcja) → bez przycisku; administrator na tej samej bazie — z przyciskiem', async () => {
    const db = openOmsDb(':memory:');
    const infakt = falszywyInfakt([dok('u1', '2026-10-20')]);
    const fakturyWidok = createFakturyWidok({ db, infakt });
    const p = nowyPanel({ db, fakturyWidok, wysylkaKsef: createWysylkaKsef({ db, infakt, fakturyWidok, log: () => {} }) });
    apki.push(p.app);
    zalozKonto(db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'pakowacz-test', imie: 'Pakowacz', haslo: 'h', rola: 'produkcja' });
    const id = zamowienieZFaktura(db);
    const produkcja = await get(p.app, `/zamowienia/${id}`, jako(db, 'pakowacz-test'));
    expect(produkcja.statusCode).toBe(200);
    expect(produkcja.body).not.toMatch(PRZYCISK);
    expect((await get(p.app, '/faktury', jako(db, 'pakowacz-test'))).statusCode).toBe(403);
    expect((await get(p.app, `/zamowienia/${id}`, jako(db, 'admin-test'))).body).toMatch(PRZYCISK);
  });
});

describe('PRZ-102.23 dwa kroki i powrót na kartę', () => {
  it('karta → podgląd (nic nie wysyła) → zatwierdzenie → wynik; „Wróć” prowadzi na kartę zamówienia', async () => {
    const { db, app, infakt } = panel();
    const id = zamowienieZFaktura(db);
    const formularz = (await karta(app, id)).body.match(PRZYCISK)[0];
    const payload = { uuid: 'u1', miesiac: ukryte(formularz, 'miesiac')[0], pole: ukryte(formularz, 'pole')[0], powrot: ukryte(formularz, 'powrot')[0] };

    const podglad = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH, payload });
    expect(podglad.statusCode).toBe(200);
    expect(infakt.wyslane).toEqual([]);
    expect(podglad.body).toContain('Poleci do KSeF — 1');
    expect(podglad.body).toContain(`href="/zamowienia/${id}#faktura"`);
    expect(podglad.body).toContain('Wróć do zamówienia');
    const zatwierdz = podglad.body.match(/<form method="post" action="\/faktury\/ksef\/wyslij">[\s\S]*?<\/form>/)[0];
    expect(ukryte(zatwierdz, 'powrot')).toEqual([`/zamowienia/${id}`]);

    const wynik = await app.inject({ method: 'POST', url: '/faktury/ksef/wyslij', headers: AUTH,
      payload: { uuid: ukryte(zatwierdz, 'uuid'), miesiac: ukryte(zatwierdz, 'miesiac')[0], pole: ukryte(zatwierdz, 'pole')[0], powrot: ukryte(zatwierdz, 'powrot')[0], potwierdzam: 'wyslij' } });
    expect(wynik.statusCode).toBe(200);
    expect(infakt.wyslane).toEqual(['u1']);
    expect(wynik.body).toContain(`href="/zamowienia/${id}#faktura"`);
    expect(wynik.body).toContain('Wróć do zamówienia');
    expect(wynik.body).not.toContain('href="/faktury?miesiac=');

    // Po wysyłce karta stoi na rezerwacji: zdanie „panel już zlecił”, przycisku drugi raz nie ma.
    const poWysylce = await karta(app, id);
    expect(poWysylce.body).not.toMatch(PRZYCISK);
    expect(poWysylce.body).toContain('Panel już zlecił wysyłkę tego dokumentu do KSeF');
  });

  it('obcy adres powrotu → domyślny powrót na listę Faktur, a obcego adresu nie ma na ekranie', async () => {
    const { db, app } = panel();
    zamowienieZFaktura(db);
    for (const powrot of ['//obcy.example/zamowienia/1', 'https://obcy.example/', '/zamowienia/1/../../ustawienia']) {
      const r = await app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: AUTH,
        payload: { uuid: 'u1', miesiac: '2026-10', pole: 'invoice_date', powrot } });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('href="/faktury?miesiac=2026-10&amp;pole=invoice_date"');
      expect(r.body).not.toContain('obcy.example');
      expect(r.body).not.toContain('/zamowienia/1/..');
      // Formularz zatwierdzenia nie niesie odrzuconego adresu dalej (pole `powrot` ma też menu motywu w układzie).
      const zatwierdz = r.body.match(/<form method="post" action="\/faktury\/ksef\/wyslij">[\s\S]*?<\/form>/)[0];
      expect(zatwierdz).not.toContain('name="powrot"');
    }
  });
});

// PRZ-152.G10b1 — kontekst sekcji „Faktura” karty zamówienia: kwota faktury i korekt z dokumentu programu,
// krótka data. PRZ-152.G10p: proforma bez stanów „aktualna / nieaktualna / rozliczona” (decyzja właściciela 05.11). Widok sekcji przychodzi w G10b2, więc test
// czyta to, co trasa podaje do `zamowienie.ejs` (dane renderu `zamowienie.ejs`), i sprawdza, że karta oddaje 200.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ejs from 'ejs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { programInfakt } from '../../../src/integracje/programy/infakt.ts';
import { sumaListy, stopkaRazem } from '../../../src/domena/lista-faktur.js';
import { dodajFaktureDoKolejki } from '../../../src/moduly/faktury/db/kolejka-druku-faktur.js';

const NAGLOWEK = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64') };

/** Dokument w kształcie inFaktu (kwoty w groszach), jak oddaje go atrapa deploy/proba/atrapy/infakt.mjs. */
const dokumentInfaktu = (o = {}) => ({
  uuid: 'dok-pc-1', number: 'FV/12/10/2026', currency: 'PLN',
  gross_price: 44900, net_price: 36504, tax_price: 8396, ...o,
});

async function karta({ program, faktura = {}, proformy = [], zwroty = [], drukarka = false, kolejka = false, pobranie = false }) {
  const db = openOmsDb(':memory:');
  // Kwota zamówienia celowo INNA niż kwota dokumentu: karta ma pokazać kwotę z programu.
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 'PC-152', numer: 'PC-152', kwota_brutto: '100.00', chce_fakture: 1,
    pozycje: [{ nazwa: 'Przykładowa lampa', sku: 'LAMPA-TEST', ilosc: 1, cena_brutto: '100.00', vat: 23 }],
    klient: { first_name: 'Jan', company: 'Pracownia Półcień', email: 'jan@example.test' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: pobranie ? '100.00' : null, nip: '1234563218',
    status_woo: null, oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T08:00:00',
  }, {});
  if (pobranie) db.prepare('UPDATE zamowienia SET pobranie = 1 WHERE id = ?').run(id);
  const f = { program: 'infakt', dokument_id: 'dok-pc-1', numer: 'FV/12/10/2026', utworzona_at: '2026-10-21T10:00:00Z', ...faktura };
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?,?)')
    .run(id, f.dokument_id, f.program, f.dokument_id, f.numer, f.utworzona_at);
  db.prepare('UPDATE faktury SET ksef_numer = ? WHERE zamowienie_id = ?').run(f.ksef_numer ?? null, id);
  if (drukarka) db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('druk.faktury.stanowiska', ?, ?)")
    .run(JSON.stringify({ 'TEST-152': new Date().toISOString() }), new Date().toISOString());
  if (kolejka) dodajFaktureDoKolejki(db, db.prepare('SELECT id FROM faktury WHERE zamowienie_id = ?').get(id).id);
  const idProform = proformy.map((p) => db.prepare(
    'INSERT INTO proformy (zamowienie_id, numer, rok, miesiac, kolejny, kwota_brutto, utworzona_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, p.numer, 2026, 10, p.kolejny, '449.00', p.utworzona_at).lastInsertRowid);
  proformy.forEach((p, i) => {
    if (p.uniewazniona) db.prepare('UPDATE proformy SET uniewazniona_at = ? WHERE id = ?').run('2026-10-30T10:00:00Z', idProform[i]);
  });
  for (const w of zwroty) {
    const zlecona = w.uuid ? '2026-10-25T08:00:00Z' : null;
    db.prepare(`INSERT INTO zwroty (zamowienie_id, data, kwota, kwota_dostawy, korekta_uuid, korekta_numer, korekta_zlecona_at, utworzony_at)
      VALUES (?, '2026-10-25', '50.00', ?, ?, ?, ?, '2026-10-25T08:00:00Z')`).run(id, w.dostawa ?? null, w.uuid ?? null, w.numer ?? null, zlecona);
  }
  if (faktura === null) db.prepare('DELETE FROM faktury WHERE zamowienie_id = ?').run(id);
  const app = buildOmsServer({ db, infakt: program, proforma: {}, wysylkaKsef: { korekty: true }, config: { auth: { user: 'operator', pass: 'test' } } });
  let kontekst = null;
  // Adapter HTTP jest już złożony (bez addHook), więc łapiemy dane strony w chwili renderu EJS: `@fastify/view`
  // kompiluje szablon przez `ejs.compile` i woła wynik z kontekstem karty (rozpoznanym po `proformaAktualnaId`).
  const kompiluj = ejs.compile;
  const szpieg = vi.spyOn(ejs, 'compile').mockImplementation(function (...a) {
    const fn = kompiluj.apply(this, a);
    return function (dane, ...reszta) {
      if (dane && Object.hasOwn(dane, 'proformaAktualnaId')) kontekst = dane;
      return fn.call(this, dane, ...reszta);
    };
  });
  try {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: NAGLOWEK });
    const zwrotyId = db.prepare('SELECT id, korekta_uuid FROM zwroty WHERE zamowienie_id = ?').all(id);
    return { r, kontekst, idProform, zwrotyId };
  } finally { szpieg.mockRestore(); await app.close(); db.close(); }
}

const programTwojeFaktury = (bruttoGr) => ({
  opis: { ...programInfakt({}).opis, id: 'twojefaktury', wbudowany: true, zdolnosci: [] },
  przygotujNabywce: vi.fn(),
  stanDokumentu: vi.fn(async (dokumentId) => ({ dokumentId, otwarty: false, zamknieta: 'ksef', czekaNaKsef: false, ksef: 'jest', bruttoGr })),
  pobierzFakture: vi.fn(async () => null),
});

const sekcjaFaktury = (r) => {
  expect(r.statusCode).toBe(200);
  return r.body.match(/<section class="panel" id="faktura">[\s\S]*?<\/section>/u)[0];
};
const proforma = (o = {}) => ({ numer: 'PF/1/10/2026', kolejny: 1, utworzona_at: '2026-10-29T08:00:00Z', ...o });
const infaktKarty = () => programInfakt({ pobierzFakture: vi.fn(async () => dokumentInfaktu()), przygotujNabywce: vi.fn() });

// PRZ-152.G10e (właściciel 05.11: „to pole jeszcze do uporządkowania”): tabela → wiersz akcji → podpowiedzi.
const bezSpacji = (s) => s.replace(/\s+/gu, ' ');
const OPIS_PROFORMY = 'Proforma: data dzisiejsza, bez terminu płatności. Numer z serii PF/ trafia klientowi do tytułu przelewu, a poprzednia proforma zostanie unieważniona.';
const DRUK_WYLACZONY = 'Drukowanie wyłączone — brak komputera z drukarką. <a href="/ustawienia/druk#faktury">Ustawienia → Druk i etykiety</a>';
const wierszAkcji = (html) => html.match(/<div class="stopka-edycji[^"]*">[\s\S]*?<\/div>/u)?.[0];

describe('PRZ-152.G10e układ sekcji Faktura', () => {
  it('sama ważna proforma: bez kolumny Stan (nagłówek i komórki), PDF w kolumnie akcji', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: null, proformy: [proforma()] })).r);
    expect(html).not.toContain('<th>Stan</th>');
    expect(html).toContain('<thead><tr><th>Dokument</th><th>Numer</th><th>Data</th><th>Kwota</th><th class="kol-akcje"></th></tr></thead>');
    const [wiersz] = wierszeProform(html);
    expect(wiersz.match(/<td\b/gu)).toHaveLength(5);
    expect(wiersz).toMatch(/<td class="kol-akcje"><a class="btn btn--maly" href="\/proformy\/\d+\/pdf"/u);
  });

  it('kolumna Stan wraca przy unieważnionej proformie i przy fakturze', async () => {
    const uniewazniona = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: null,
      proformy: [proforma({ uniewazniona: true }), proforma({ kolejny: 2, numer: 'PF/2/10/2026' })] })).r);
    expect(uniewazniona).toContain('<th>Stan</th>');
    for (const w of wierszeProform(uniewazniona)) expect(w.match(/<td\b/gu)).toHaveLength(6);
    const zFaktura = sekcjaFaktury((await karta({ program: infaktKarty(), proformy: [proforma()] })).r);
    expect(zFaktura).toContain('<th>Stan</th>');
    for (const w of wierszeProform(zFaktura)) expect(w.match(/<td\b/gu)).toHaveLength(6);
  });

  it('kolejność: tabela → jeden wiersz akcji (faktura i proforma obok siebie) → podpowiedzi; napisy bez zmian', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: null, proformy: [proforma()] })).r);
    const akcje = wierszAkcji(html);
    expect(akcje).toMatch(/<button class="btn btn--glowny" form="wystaw-fakture"[^>]*>Wystaw fakturę<\/button>\s*<form method="post" action="\/zamowienia\/1\/proforma" class="w-linii">/u);
    expect(akcje).toContain('<button class="btn">Wystaw proformę</button>');
    expect(akcje).not.toContain('<p');
    expect(akcje).not.toContain('wyjasnienie');
    const tekst = bezSpacji(html);
    expect(tekst).toContain(`<p class="wyjasnienie">${OPIS_PROFORMY}</p>`);
    expect(html).toContain(`<p class="wyjasnienie">${DRUK_WYLACZONY}</p>`);
    const kolejnosc = ['</table>', 'Wystaw fakturę</button>', 'Wystaw proformę</button>', 'id="powod-wystawienia-faktury"',
      'Proforma: data dzisiejsza', 'Drukowanie wyłączone'].map((s) => html.indexOf(s));
    expect(kolejnosc.every((i) => i >= 0)).toBe(true);
    expect([...kolejnosc].sort((a, b) => a - b)).toEqual(kolejnosc);
  });

  it('bez dokumentów: brak tabeli i brak kreski nad wierszem akcji; z tabelą kreska zostaje', async () => {
    const bez = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: null })).r);
    expect(bez).not.toContain('<table');
    expect(wierszAkcji(bez)).toMatch(/^<div class="stopka-edycji akcje-bez-kreski">/u);
    expect(bez).toMatch(/#faktura \.akcje-bez-kreski \{[^}]*border-top: 0/u);
    const z = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: null, proformy: [proforma()] })).r);
    expect(wierszAkcji(z)).toMatch(/^<div class="stopka-edycji">/u);
  });
});

describe('PRZ-152.G10c stopka i pobranie', () => {
  it('z fakturą proforma jest zwykłym przyciskiem we własnym formularzu w menu nagłówka', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty() })).r);
    const glowa = html.match(/<div class="panel-glowa">[\s\S]*?<\/details>/u)[0];
    expect(glowa).toContain('<details class="wydruki">');
    expect(glowa).toContain('<summary class="btn btn--maly">⋯ Więcej</summary>');
    expect(glowa).toMatch(/<\/summary>\s*<div class="wydruki-menu">\s*<form method="post" action="\/zamowienia\/1\/proforma">/u);
    expect(glowa).toMatch(/<form method="post" action="\/zamowienia\/1\/proforma">[\s\S]*?<button class="btn">Wystaw proformę<\/button>[\s\S]*?<\/form>/u);
    expect(html.slice(html.indexOf('class="stopka-edycji"'))).not.toContain('Wystaw proformę');
  });

  it('bez faktury główna jest faktura, a proforma ma class="btn"', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: null })).r);
    expect(html).toMatch(/class="btn btn--glowny" form="wystaw-fakture"[^>]*>Wystaw fakturę/u);
    expect(html).toContain('<button class="btn">Wystaw proformę</button>');
    expect(html).not.toContain('⋯ Więcej');
  });

  it.each([false, true])('pobranie: faktura=%s — jedna szara linia tylko bez faktury', async (jestFaktura) => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: jestFaktura ? {} : null, pobranie: true })).r);
    const zdanie = 'Zamówienie za pobraniem — proforma zwykle niepotrzebna.';
    if (jestFaktura) expect(html).not.toContain(zdanie);
    else {
      expect(html).toContain(`<p class="wyjasnienie">${zdanie}</p>`);
      expect(html.indexOf('class="stopka-edycji')).toBeGreaterThan(0);
      expect(html.indexOf(zdanie)).toBeGreaterThan(html.indexOf('class="stopka-edycji'));
    }
    expect(html).not.toContain('zwykle znaczy pomyłkę');
  });
});

const wierszeProform = (html) => html.match(/<tr[^>]*>\s*<td>Proforma<\/td>[\s\S]*?<\/tr>/gu) ?? [];
// PRZ-152.G10p (właściciel 05.11: „proforma nie musi być rozliczona ani aktualna. usuń te opcje. po prostu jest proforma.”)
const bezStanowProformy = (wiersze) => {
  expect(wiersze.length).toBeGreaterThan(0);
  for (const w of wiersze) {
    expect(w).not.toContain('aktualna');
    expect(w).not.toContain('rozliczona fakturą');
    expect(w).not.toContain('przygaszony');
    expect(w).toContain('>PDF</a>');
  }
};

describe('PRZ-152.G10b2 tabela dokumentów — HTML karty', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  it('sama proforma też pokazuje stan drukarki', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), faktura: null, proformy: [proforma()] })).r);
    expect(html).toContain('Drukowanie wyłączone — brak komputera z drukarką.');
    expect(html).not.toMatch(/\/proformy\/\d+\/drukuj/u);
    bezStanowProformy(wierszeProform(html));
  });
  it('TwojeFaktury po proformie: bez rozliczenia, kwoty dokumentów, krótka data i KSeF do skopiowania', async () => {
    const html = sekcjaFaktury((await karta({
      program: programTwojeFaktury(44900),
      faktura: { program: 'twojefaktury', dokument_id: 'tf-1', utworzona_at: '2026-10-29T10:00:00Z', ksef_numer: 'KSEF-TEST-152' },
      proformy: [proforma()],
    })).r);
    expect(html).toContain('<th>Kwota</th>');
    expect(html.match(/449,00 zł/gu)).toHaveLength(2);
    expect(html).toMatch(/<td title="[^"]+">29\.10<\/td>/u);
    expect(html).toContain('<summary class="waga waga--ok" title="KSEF-TEST-152">KSeF przyjęty</summary>');
    expect(html).toContain('<input readonly class="ksef-numer" value="KSEF-TEST-152" size="40">');
    const wiersz = html.match(/<tr[^>]*>\s*<td>Proforma<\/td>[\s\S]*?<\/tr>/u)[0];
    bezStanowProformy([wiersz]);
    expect(wiersz).toContain('>PDF</a>');
    expect(wiersz).not.toContain('drukuj');
  });

  it('bez drukarki: brak formularza druku, jedna informacja także przy kolejce i kilku dokumentach', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), kolejka: true,
      proformy: [proforma(), proforma({ kolejny: 2, numer: 'PF/2/10/2026' })] })).r);
    expect(html).not.toContain('/faktura/drukuj');
    expect(html).not.toMatch(/\/proformy\/\d+\/drukuj/u);
    expect(html.match(/Drukowanie wyłączone — brak komputera z drukarką\./gu)).toHaveLength(1);
    expect(html.match(/href="\/ustawienia\/druk#faktury"/gu)).toHaveLength(1);
    expect(html.indexOf('Drukowanie wyłączone')).toBeGreaterThan(html.indexOf('</table>'));
    expect(html).not.toContain('.btn:disabled');
  });

  it('z drukarką: formularz faktury i ikona SVG; proforma ma tylko PDF', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), drukarka: true, proformy: [proforma()] })).r);
    expect(html).toMatch(/<form method="post" action="\/zamowienia\/\d+\/faktura\/drukuj"/u);
    expect(html).toMatch(/<button[^>]*aria-label="Drukuj"[^>]*title="Drukuj na komputerze z drukarką"[^>]*>\s*<svg/u);
    expect(html).not.toMatch(/\/proformy\/\d+\/drukuj/u);
    expect(html).not.toContain('Drukowanie wyłączone');
  });

  it('proforma unieważniona nie ma druku nawet z drukarką; ważne proformy bez stanu', async () => {
    const html = sekcjaFaktury((await karta({ program: infaktKarty(), drukarka: true,
      proformy: [proforma({ uniewazniona: true }), proforma({ kolejny: 2, numer: 'PF/2/10/2026' }),
        proforma({ kolejny: 3, numer: 'PF/3/10/2026', utworzona_at: '2026-10-30T08:00:00Z' })] })).r);
    const wiersz = html.match(/<tr[^>]*>\s*<td>Proforma<\/td>[\s\S]*?unieważniona[\s\S]*?<\/tr>/u)[0];
    expect(wiersz).not.toContain('aria-label="Drukuj"');
    expect(wiersz).not.toContain('/drukuj');
    expect(wiersz).toContain('class="waga waga--blokada">unieważniona</span>');
    const wiersze = wierszeProform(html);
    expect(wiersze).toHaveLength(3);
    bezStanowProformy(wiersze.filter((w) => !w.includes('unieważniona')));
    expect(wiersze.filter((w) => !w.includes('unieważniona'))).toHaveLength(2);
  });

  it('brak kwoty dokumentu daje kreskę w kolumnie Kwota', async () => {
    const html = sekcjaFaktury((await karta({ program: programTwojeFaktury(null),
      faktura: { program: 'twojefaktury', dokument_id: 'tf-1' } })).r);
    expect(html).toMatch(/<th>Kwota<\/th>/u);
    expect(html).toMatch(/<td>—<\/td>/u);
  });

  it.each(['KSEF-KOR-152', ''])('korekta inFaktu: kwota z dokumentu i stan KSeF %s', async (numerKsef) => {
    const program = programInfakt({
      pobierzFakture: vi.fn(async () => dokumentInfaktu()), przygotujNabywce: vi.fn(),
      pobierzKorekte: vi.fn(async () => ({ invoice_date: '2026-10-25', ksef_number: numerKsef, gross_price: -5000 })),
    });
    const html = sekcjaFaktury((await karta({ program, faktura: { ksef_numer: 'KSEF-FV-152' },
      zwroty: [{ uuid: 'kor-1', numer: '1/KOR/10/2026' }] })).r);
    const wiersz = html.match(/<tr>\s*<td>Korekta<\/td>[\s\S]*?<\/tr>/u)[0];
    expect(wiersz).toContain('<td>-50,00 zł</td>');
    expect(wiersz).toContain('>25.10</td>');
    expect(wiersz).toContain('href="/faktury/kor-1/pdf?rodzaj=korekta');
    if (numerKsef) {
      expect(wiersz).toContain('title="KSEF-KOR-152">KSeF przyjęty</summary>');
      expect(wiersz).toContain('value="KSEF-KOR-152"');
      expect(wiersz).not.toContain('Wyślij do KSeF');
    } else {
      expect(wiersz).toContain('jeszcze nie wysłana do KSeF');
      expect(wiersz).toContain('Wyślij do KSeF');
      expect(wiersz).toContain('name="uuid" value="kor-1"');
      expect(wiersz).toContain('name="miesiac" value="2026-10"');
      expect(wiersz).toContain('name="pole" value="invoice_date"');
    }
  });
});

describe('PRZ-152.G10b1 kontekst sekcji „Faktura”', () => {
  it('TwojeFaktury: kwota faktury z dokumentu programu (449,00 zł), nie z zamówienia', async () => {
    const program = programTwojeFaktury(44900);
    const { r, kontekst } = await karta({ program, faktura: { program: 'twojefaktury', dokument_id: 'tf-1' } });
    expect(r.statusCode).toBe(200);
    expect(kontekst.kwotaFaktury).toBe('449,00 zł');
    expect(program.stanDokumentu).toHaveBeenCalledTimes(1);
    expect(program.stanDokumentu).toHaveBeenCalledWith('tf-1');
    expect(typeof kontekst.fmtDzien).toBe('function');
    expect(kontekst.fmtDzien('2026-10-21T10:00:00Z')).toMatch(/^21\.10/u);
    expect(typeof kontekst.zlotowki).toBe('function');
  });

  it('TwojeFaktury bez kwoty w dokumencie → null', async () => {
    const { kontekst } = await karta({ program: programTwojeFaktury(null), faktura: { program: 'twojefaktury', dokument_id: 'tf-1' } });
    expect(kontekst.kwotaFaktury).toBeNull();
  });

  it('inFakt: kwota z `gross_price` = kolumna Brutto listy FAKTURY dla tego dokumentu; jeden odczyt na kartę', async () => {
    const dok = dokumentInfaktu();
    const pobierzFakture = vi.fn(async () => dok);
    const { r, kontekst } = await karta({ program: programInfakt({ pobierzFakture, przygotujNabywce: vi.fn() }) });
    expect(r.statusCode).toBe(200);
    const [liniaListy] = stopkaRazem(sumaListy([dok]));
    expect(kontekst.kwotaFaktury).toBe(liniaListy.brutto);
    expect(kontekst.kwotaFaktury).toBe('449,00 zł');
    expect(pobierzFakture).toHaveBeenCalledTimes(1);
    expect(pobierzFakture).toHaveBeenCalledWith('dok-pc-1');
  });

  it('inFakt: błąd odczytu → kwotaFaktury null, karta 200', async () => {
    const pobierzFakture = vi.fn(async () => { throw new Error('Awaria atrapy'); });
    const { r, kontekst } = await karta({ program: programInfakt({ pobierzFakture, przygotujNabywce: vi.fn() }) });
    expect(r.statusCode).toBe(200);
    expect(kontekst.kwotaFaktury).toBeNull();
    expect(pobierzFakture).toHaveBeenCalledTimes(1);
  });

  it('inFakt: odczyt dłuższy niż termin podglądu (2,5 s) nie trzyma karty — kwota null, karta 200', async () => {
    const pobierzFakture = vi.fn(() => new Promise((ok) => { setTimeout(() => ok(dokumentInfaktu()), 8000).unref(); }));
    const start = Date.now();
    const { r, kontekst } = await karta({ program: programInfakt({ pobierzFakture, przygotujNabywce: vi.fn() }) });
    expect(r.statusCode).toBe(200);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(kontekst.kwotaFaktury).toBeNull();
    expect(pobierzFakture).toHaveBeenCalledTimes(1);
  }, 10000);

  it('inFakt: zwrot z dostawą bez korekty — dokument czytany raz (podgląd korekty), kwota z niego', async () => {
    const pobierzFakture = vi.fn(async () => dokumentInfaktu());
    const { r, kontekst } = await karta({
      program: programInfakt({ pobierzFakture, przygotujNabywce: vi.fn() }), zwroty: [{ dostawa: '15.00' }],
    });
    expect(r.statusCode).toBe(200);
    expect(kontekst.kwotaFaktury).toBe('449,00 zł');
    expect(pobierzFakture).toHaveBeenCalledTimes(1);
  });

  it('dokument innego programu niż bieżący → bez odczytu, kwota null', async () => {
    const pobierzFakture = vi.fn(async () => dokumentInfaktu());
    const { r, kontekst } = await karta({
      program: programInfakt({ pobierzFakture, przygotujNabywce: vi.fn() }), faktura: { program: 'twojefaktury', dokument_id: 'tf-9' },
    });
    expect(r.statusCode).toBe(200);
    expect(kontekst.kwotaFaktury).toBeNull();
    expect(pobierzFakture).not.toHaveBeenCalled();
  });

  it('inFakt: kwota korekty z odczytanej korekty (`gross_price`), bez dodatkowego zapytania', async () => {
    const pobierzKorekte = vi.fn(async () => ({ invoice_date: '2026-10-25', ksef_number: '', gross_price: -5000 }));
    const pobierzFakture = vi.fn(async () => dokumentInfaktu());
    const program = programInfakt({ pobierzFakture, pobierzKorekte, przygotujNabywce: vi.fn() });
    const { kontekst, zwrotyId } = await karta({ program, zwroty: [{ uuid: 'kor-1', numer: '1/KOR/10/2026' }] });
    const [zw] = zwrotyId;
    const [liniaListy] = stopkaRazem(sumaListy([{ gross_price: -5000, net_price: -4065, tax_price: -935 }]));
    expect(kontekst.kwotyKorekt[zw.id]).toBe(liniaListy.brutto);
    expect(kontekst.kwotyKorekt[zw.id]).toBe('-50,00 zł');
    expect(pobierzKorekte).toHaveBeenCalledTimes(1);
  });

  it('kontekst nie podaje już rozliczenia proformy (PRZ-152.G10p)', async () => {
    const { kontekst } = await karta({
      program: programInfakt({ pobierzFakture: vi.fn(async () => dokumentInfaktu()), przygotujNabywce: vi.fn() }),
      proformy: [{ numer: 'PF/1/10/2026', kolejny: 1, utworzona_at: '2026-10-19T09:00:00Z' }],
    });
    expect(kontekst).not.toHaveProperty('rozliczonaProforma');
  });
});

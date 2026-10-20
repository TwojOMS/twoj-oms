// PRZ-102.12 — automat wysyłki do KSeF o ustalonej godzinie.
//
// ⚠️ Automat ma wysłać DOKŁADNIE to, co przycisk po „zaznacz wszystkie” na ekranie Faktur, i nic więcej. Dlatego
// test składa PRAWDZIWE `createFakturyWidok` i `createWysylkaKsef` (barierę `coWolnoWyslac`, rezerwację w bazie,
// ślad w logu zamówienia) na fałszywym inFakcie i prawdziwej bazie. Czas wstrzykiwany, sieci brak.
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { createAutomatKsef } from '../../../src/moduly/faktury/services/ksef-automat.js';
import { wczytajAutomatKsef, zapiszUstawieniaAutomatu, zapiszWynikAutomatu } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { ostrzezeniaAutomatuKsef } from '../../../src/domena/ostrzezenia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const NIP = '1234563218';
const dok = (uuid, invoice_date, nadpisz = {}) => ({
  uuid, number: `${uuid}/2026`, rodzaj: 'vat', invoice_date, sale_date: invoice_date, ksef_number: null,
  client_company_name: `Firma ${uuid}`, client_tax_code: NIP, gross_price: 12300, left_to_pay: 0, ...nadpisz,
});

// Fałszywy inFakt: listy filtrowane po polu daty jak w API, wysyłka zapisuje identyfikator. `ksef_number` się NIE
// pojawia — inFakt nadaje go po ~70 s, więc przed drugą wysyłką chroni wyłącznie rezerwacja w bazie.
function falszywyInfakt(dokumenty, { wyslij } = {}) {
  const wyslane = [];
  const zakres = (rodzaj) => async ({ od, do: koniec, pole = 'invoice_date' }) => dokumenty
    .filter((d) => d.rodzaj === rodzaj && String(d[pole]) >= od && String(d[pole]) <= koniec).map((d) => ({ ...d }));
  return {
    dokumenty, wyslane,
    listaFaktur: zakres('vat'),
    listaKorekt: zakres('korekta'),
    wyslijDokumentDoKsef: async (uuid) => {
      wyslane.push(uuid);
      if (wyslij) return wyslij(uuid, wyslane.length);
      return { odpowiedzInfaktu: { ok: true, uuid } };
    },
  };
}

function zamowienieZFaktura(db, uuid, numer) {
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${uuid}`, numer: `Z-${uuid}`, klient: { first_name: 'Jan', last_name: 'Przykładowy' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '123.00',
    koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [],
  }, {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid, numer, ksefStatus: null });
  return id;
}

// Październik 2026: A (bieżący), B (31.09 — poprzedni), H (WDT, numer VAT UE) mają polecieć. Reszta nie:
// C już w KSeF, D korekta, E konsumencka (bez NIP-u), F zarezerwowana wcześniej, G sprzed dwóch miesięcy.
function zestaw({ wyslij } = {}) {
  const db = openOmsDb(':memory:');
  const dokumenty = [
    dok('A', '2026-10-19'), dok('B', '2026-09-30'), dok('H', '2026-10-05', { client_tax_code: 'SK1098765431' }),
    dok('C', '2026-10-02', { ksef_number: '1234563218-20261002-AAAAAA-01' }),
    dok('D', '2026-10-03', { rodzaj: 'korekta' }),
    dok('E', '2026-10-04', { client_tax_code: '' }),
    dok('F', '2026-10-06'),
    dok('G', '2026-08-15'),
  ];
  zajmijWysylkeKsef(db, 'F', { numer: 'F/2026', kiedy: '2026-10-19T10:00:00.000Z' });
  const idA = zamowienieZFaktura(db, 'A', 'A/2026');
  const infakt = falszywyInfakt(dokumenty, { wyslij });
  const fakturyWidok = createFakturyWidok({ db, infakt });
  const logi = [];
  const wysylkaKsef = createWysylkaKsef({ db, infakt, fakturyWidok, log: () => {} });
  const automat = (teraz, o = {}) => createAutomatKsef({ db, fakturyWidok, wysylkaKsef, teraz: () => new Date(teraz),
    log: (...t) => logi.push(t.join(' ')), ...o });
  return { db, infakt, fakturyWidok, wysylkaKsef, automat, idA, logi };
}
const wlacz = (db, godzina = '20:00') => zapiszUstawieniaAutomatu(db, { wlaczony: true, godzina, ostatniPrzebieg: null, login: 'adam' });

it('PRZ-102.26: firmowe B2C działa bez restartu na liście, w podglądzie, wysyłce i automacie', async () => {
  const z = zestaw();
  const app = buildOmsServer({ db: z.db, config: { auth: { user: 't', pass: 'h' } }, fakturyWidok: z.fakturyWidok });
  const args = { uuids: ['E'], miesiac: '2026-10', pole: 'invoice_date' };
  const headers = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
  try {
    expect((await z.wysylkaKsef.podglad(args)).doWyslania).toEqual([]);
    z.db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('ksef.konsumenckie', '1', '2026-10-20')").run();
    const r = await app.inject({ url: '/faktury?miesiac=2026-10&zaznacz=1', headers });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/name="uuid" value="E" checked/);
    expect(r.body).not.toContain('dobrowolny, więc panel go nie wysyła');
    expect(r.body).not.toContain('panel nie wysyła w ogóle');
    expect((await z.wysylkaKsef.podglad(args)).doWyslania.map((d) => d.uuid)).toEqual(['E']);
    z.db.prepare("UPDATE ustawienia SET wartosc = '0' WHERE klucz = 'ksef.konsumenckie'").run();
    expect((await z.wysylkaKsef.wyslij(args, 'test')).wyslane).toEqual([]);
    z.db.prepare("UPDATE ustawienia SET wartosc = '1' WHERE klucz = 'ksef.konsumenckie'").run();
    wlacz(z.db);
    await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect([...z.infakt.wyslane].sort()).toEqual(['A', 'B', 'E', 'H']);
  } finally { await app.close(); z.db.close(); }
});

describe('PRZ-102.12 automat KSeF — kiedy wysyła', () => {
  it('wyłączony (domyślnie) — tyknięcie po godzinie nic nie wysyła', async () => {
    const z = zestaw();
    expect(wczytajAutomatKsef(z.db)).toMatchObject({ wlaczony: false, godzina: '20:00', ostatniPrzebieg: null, wynik: null });
    const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(w.pominiety).toBe(true);
    expect(z.infakt.wyslane).toEqual([]);
  });

  it('włączony na 20:00, teraz 19:59 — nic', async () => {
    const z = zestaw();
    wlacz(z.db);
    await z.automat('2026-10-20T17:59:00Z').przebieg();
    expect(z.infakt.wyslane).toEqual([]);
    expect(wczytajAutomatKsef(z.db).ostatniPrzebieg).toBeNull();
  });

  it('20:01 — jedna wysyłka zbioru „zaznacz wszystkie” z bieżącego i poprzedniego miesiąca, ślad „automat KSeF”', async () => {
    const z = zestaw();
    wlacz(z.db);
    const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect([...z.infakt.wyslane].sort()).toEqual(['A', 'B', 'H']);
    expect(w.stan).toBe('ok');
    const stan = wczytajAutomatKsef(z.db);
    expect(stan.ostatniPrzebieg).toBe('2026-10-20');
    expect(stan.wynik.wyslane.map((x) => x.numer).sort()).toEqual(['A/2026', 'B/2026', 'H/2026']);
    expect(stan.wynik.niepewne).toEqual([]);
    // Korekta i konsumencka bez KSeF są w wyniku jako „nie wysyłane z zasady”, z powodem z bariery.
    expect(stan.wynik.poZasadzie.map((x) => x.numer).sort()).toEqual(['D/2026', 'E/2026']);
    expect(stan.wynik.poZasadzie.find((x) => x.numer === 'E/2026').powod).toContain('konsumencka');
    const wpisy = z.db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'ksef'").all(z.idA).map((r) => r.wynik);
    expect(wpisy.some((t) => t.startsWith('(automat KSeF) zlecono wysyłkę do KSeF'))).toBe(true);
    expect(z.logi.some((t) => t.includes('automat KSeF') && t.includes('wysłano 3'))).toBe(true);
  });

  it('zbiór automatu dla miesiąca = pola zaznaczone przez „zaznacz wszystkie” na ekranie Faktur', async () => {
    const z = zestaw();
    const app = buildOmsServer({ db: z.db, config: { auth: { user: 't', pass: 'h' } }, fakturyWidok: z.fakturyWidok });
    const r = await app.inject({ method: 'GET', url: '/faktury?miesiac=2026-10&pole=invoice_date&zaznacz=1',
      headers: { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` } });
    expect(r.statusCode).toBe(200);
    const zaznaczone = [...r.body.matchAll(/name="uuid" value="([^"]+)" checked/g)].map((m) => m[1]).sort();
    await app.close();
    wlacz(z.db);
    await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(zaznaczone).toEqual(['A', 'H']);
    expect(z.infakt.wyslane.filter((u) => z.infakt.dokumenty.find((d) => d.uuid === u).invoice_date.startsWith('2026-10')).sort())
      .toEqual(zaznaczone);
  });

  it('bariera liczona od nowa przy wysyłce: faktura zmieniona w inFakcie po wyborze kandydatów (konsumencka, już w KSeF) nie leci', async () => {
    const z = zestaw();
    // Pierwszy odczyt listy (wybór kandydatów) widzi A i H jako zwykłe faktury z NIP-em; każdy następny
    // (przeliczenie w usłudze tuż przed wysyłką) — A bez NIP-u, H już z numerem KSeF nadanym ręcznie w inFakcie.
    const oryginalna = z.infakt.listaFaktur;
    let odczyt = 0;
    z.infakt.listaFaktur = async (p) => {
      const lista = await oryginalna(p);
      if (p.od !== '2026-10-01') return lista;
      odczyt += 1;
      if (odczyt === 1) return lista;
      return lista.map((d) => (d.uuid === 'A' ? { ...d, client_tax_code: '' }
        : d.uuid === 'H' ? { ...d, ksef_number: 'SK-20261005-RECZNIE' } : d));
    };
    wlacz(z.db);
    const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(z.infakt.wyslane).toEqual(['B']);
    expect(w.pominiete.map((p) => p.numer).sort()).toEqual(['A/2026', 'H/2026']);
    expect(w.pominiete.find((p) => p.numer === 'A/2026').powod).toContain('konsumencka');
    expect(ostrzezeniaAutomatuKsef({ wynik: wczytajAutomatKsef(z.db).wynik })[0].tekst).toContain('pominięte: ');
  });

  it('dzień „ostatniego przebiegu” jest zapisany, ZANIM pierwszy dokument poleci', async () => {
    let wDniuWysylki = 'nie wołano';
    const z = zestaw({ wyslij: () => { wDniuWysylki = wczytajAutomatKsef(z.db).ostatniPrzebieg; return { ok: true }; } });
    wlacz(z.db);
    await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(wDniuWysylki).toBe('2026-10-20');
  });

  it('drugie tyknięcie tego dnia — nic, nawet gdy w międzyczasie doszła nowa faktura', async () => {
    const z = zestaw();
    wlacz(z.db);
    const a = z.automat('2026-10-20T18:01:00Z');
    await a.przebieg();
    z.infakt.dokumenty.push(dok('N', '2026-10-20'));
    const w = await z.automat('2026-10-20T18:02:00Z').przebieg();
    expect(w.pominiety).toBe(true);
    expect([...z.infakt.wyslane].sort()).toEqual(['A', 'B', 'H']);
    // Jutro nowa faktura leci, a wysłane wczoraj nie lecą drugi raz (rezerwacja).
    await z.automat('2026-10-21T18:01:00Z').przebieg();
    expect([...z.infakt.wyslane].sort()).toEqual(['A', 'B', 'H', 'N']);
  });

  it('restart panelu po godzinie: dziś bez przebiegu — jedna próba; drugi restart — nic', async () => {
    const z = zestaw();
    wlacz(z.db);
    await z.automat('2026-10-20T19:30:00Z').przebieg(); // pierwszy start o 21:30
    expect(z.infakt.wyslane).toHaveLength(3);
    await z.automat('2026-10-20T19:31:00Z').przebieg(); // nowa instancja, ta sama baza
    expect(z.infakt.wyslane).toHaveLength(3);
  });

  it('zmiana czasu 25.10.2026: 20:00 CET to 19:00 UTC — o 18:30 UTC jeszcze nic', async () => {
    const z = zestaw();
    z.infakt.dokumenty.push(dok('P', '2026-10-24'));
    wlacz(z.db);
    await z.automat('2026-10-25T18:30:00Z').przebieg();
    expect(z.infakt.wyslane).toEqual([]);
    await z.automat('2026-10-25T19:01:00Z').przebieg();
    expect([...z.infakt.wyslane].sort()).toEqual(['A', 'B', 'H', 'P']);
  });

  it('przestawienie przełącznika na „wyłączone” działa od razu — także między dokumentami jednego przebiegu', async () => {
    const z = zestaw({ wyslij: () => {
      zapiszUstawieniaAutomatu(z.db, { wlaczony: false, godzina: '20:00', ostatniPrzebieg: '2026-10-20', login: 'adam' });
      return { ok: true };
    } });
    wlacz(z.db);
    const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(z.infakt.wyslane).toHaveLength(1);
    expect(w.stan).toBe('wylaczony');
  });

  it('inFakt odłączony do restartu — tyknięcie nic nie robi', async () => {
    const z = zestaw();
    wlacz(z.db);
    const w = await z.automat('2026-10-20T18:01:00Z', { dostepny: () => false }).przebieg();
    expect(w.pominiety).toBe(true);
    expect(z.infakt.wyslane).toEqual([]);
    expect(wczytajAutomatKsef(z.db).ostatniPrzebieg).toBeNull();
  });
});

describe('PRZ-102.12 automat KSeF — awaria', () => {
  it('awaria inFaktu przy pierwszym dokumencie: stop, dokument „nie wiadomo”, wiersz ostrzeżenia, bez ponowienia', async () => {
    const z = zestaw({ wyslij: () => { throw Object.assign(new Error('inFakt nie odpowiedział w 30 s'), { dlaOperatora: true }); } });
    wlacz(z.db);
    const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(z.infakt.wyslane).toHaveLength(1);
    expect(w.stan).toBe('blad');
    const pierwszy = z.infakt.wyslane[0];
    const stan = wczytajAutomatKsef(z.db);
    expect(stan.wynik.niepewne.map((x) => x.uuid)).toEqual([pierwszy]);
    expect(stan.wynik.blad).toContain('30 s');
    const wiersze = ostrzezeniaAutomatuKsef({ wynik: stan.wynik });
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0]).toMatchObject({ klucz: 'faktura-ksef:automat:2026-10-20', typ: 'faktura-ksef',
      przycisk: { href: '/faktury/ksef/automat' } });
    expect(wiersze[0].tekst).toContain(`${pierwszy}/2026`);
    // Kolejne tyknięcie tego dnia — nic. Następnego dnia lecą pozostałe, a „nie wiadomo” NIE (rezerwacja trzyma).
    await z.automat('2026-10-20T18:05:00Z').przebieg();
    expect(z.infakt.wyslane).toHaveLength(1);
  });

  it('następnego dnia dokument „nie wiadomo” nie leci drugi raz, reszta leci', async () => {
    let pierwszyRaz = true;
    const z = zestaw({ wyslij: () => {
      if (pierwszyRaz) { pierwszyRaz = false; throw new Error('zerwane połączenie'); }
      return { ok: true };
    } });
    wlacz(z.db);
    await z.automat('2026-10-20T18:01:00Z').przebieg();
    const niepewny = z.infakt.wyslane[0];
    await z.automat('2026-10-21T18:01:00Z').przebieg();
    expect(z.infakt.wyslane.filter((u) => u === niepewny)).toHaveLength(1);
    expect([...new Set(z.infakt.wyslane)].sort()).toEqual(['A', 'B', 'H']);
  });

  it('lista faktur niedostępna — błąd w wyniku, nic nie poszło, bez wyjątku z zegara', async () => {
    const z = zestaw();
    z.infakt.listaFaktur = async () => { throw new Error('inFakt 503'); };
    wlacz(z.db);
    const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(w.stan).toBe('blad');
    expect(z.infakt.wyslane).toEqual([]);
    expect(ostrzezeniaAutomatuKsef({ wynik: wczytajAutomatKsef(z.db).wynik })).toHaveLength(1);
  });

  it('przebieg przerwany restartem (wynik „trwa” w bazie) — przy starcie staje się „przerwany” i ostrzega', () => {
    const z = zestaw();
    zapiszWynikAutomatu(z.db, { dzien: '2026-10-20', startAt: '2026-10-20T18:01:00.000Z', stan: 'trwa',
      wyslane: [{ uuid: 'A', numer: 'A/2026' }], niepewne: [], pominiete: [], poZasadzie: [], blad: null });
    z.automat('2026-10-20T18:10:00Z');
    const { wynik } = wczytajAutomatKsef(z.db);
    expect(wynik.stan).toBe('przerwany');
    expect(ostrzezeniaAutomatuKsef({ wynik })[0].tekst).toContain('przerwany');
  });

  // Poprawka po recenzji (WAŻNE 1): odmowa 4xx zdejmuje rezerwację (usługa — słusznie, dokumentu u organu nie ma),
  // więc bez pamięci automatu ta sama faktura stawałaby pierwsza każdego dnia i blokowała resztę stopem na błędzie.
  it('odmowa inFaktu (4xx) dnia 1 — faktura wstrzymana: dnia 2 nie leci, reszta leci; ostrzeżenie mówi, co zrobić', async () => {
    const odmowa = () => Object.assign(new Error('inFakt odrzucił wysyłkę do KSeF (422): brak adresu nabywcy'),
      { dlaOperatora: true, status: 422 });
    const z = zestaw({ wyslij: (uuid) => { if (uuid === 'B') throw odmowa(); return { ok: true }; } });
    wlacz(z.db);
    const w1 = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(z.infakt.wyslane).toEqual(['B']); // poprzedni miesiąc pierwszy, stop na odmowie
    expect(w1.stan).toBe('blad');
    const stan1 = wczytajAutomatKsef(z.db);
    expect(stan1.wstrzymane.map((x) => x.uuid)).toEqual(['B']);
    expect(stan1.wstrzymane[0]).toMatchObject({ numer: 'B/2026', dzien: '2026-10-20' });
    expect(stan1.wstrzymane[0].powod).toContain('brak adresu nabywcy');
    const wiersze = ostrzezeniaAutomatuKsef({ wynik: stan1.wynik, wstrzymane: stan1.wstrzymane });
    const wiersz = wiersze.find((x) => x.klucz === 'faktura-ksef:automat-wstrzymana:B');
    expect(wiersz.tekst).toContain('Faktura B/2026 wstrzymana — automat jej nie wyśle');
    expect(wiersz.tekst).toContain('popraw w inFakcie i wyślij ręcznie albo zwolnij');

    await z.automat('2026-10-21T18:01:00Z').przebieg();
    expect(z.infakt.wyslane.filter((u) => u === 'B')).toHaveLength(1);
    expect([...z.infakt.wyslane].sort()).toEqual(['A', 'B', 'H']);
    expect(wczytajAutomatKsef(z.db).wynik.wstrzymane.map((x) => x.numer)).toEqual(['B/2026']);
  });

  it('wstrzymana faktura z numerem KSeF (wysłana ręcznie) znika z listy wstrzymanych', async () => {
    const z = zestaw({ wyslij: (uuid) => {
      if (uuid === 'B') throw Object.assign(new Error('odmowa 422'), { dlaOperatora: true, status: 422 });
      return { ok: true };
    } });
    wlacz(z.db);
    await z.automat('2026-10-20T18:01:00Z').przebieg();
    z.infakt.dokumenty.find((d) => d.uuid === 'B').ksef_number = 'K-RECZNIE-B';
    await z.automat('2026-10-21T18:01:00Z').przebieg();
    expect(wczytajAutomatKsef(z.db).wstrzymane).toEqual([]);
  });

  it('przed każdą wysyłką wynik niesie dokument „w trakcie”; po przerwaniu ostrzeżenie każe go sprawdzić', async () => {
    const widziane = [];
    const z = zestaw({ wyslij: (uuid) => { widziane.push([uuid, wczytajAutomatKsef(z.db).wynik.wTrakcie]); return { ok: true }; } });
    wlacz(z.db);
    await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(widziane).toEqual([['B', { uuid: 'B', numer: 'B/2026' }], ['A', { uuid: 'A', numer: 'A/2026' }],
      ['H', { uuid: 'H', numer: 'H/2026' }]]);
    expect(wczytajAutomatKsef(z.db).wynik.wTrakcie).toBeNull();
    zapiszWynikAutomatu(z.db, { dzien: '2026-10-21', startAt: '2026-10-21T18:01:00.000Z', stan: 'trwa', wTrakcie: { uuid: 'N', numer: 'N/2026' },
      wyslane: [], niepewne: [], pominiete: [], poZasadzie: [], blad: null });
    z.automat('2026-10-21T18:10:00Z');
    const tekst = ostrzezeniaAutomatuKsef({ wynik: wczytajAutomatKsef(z.db).wynik })[0].tekst;
    expect(tekst).toContain('N/2026');
    expect(tekst).toContain('sprawdź w inFakcie, czy ma numer KSeF');
  });

  it('automat zatrzymany PO udanej wysyłce: ekran wyniku nie pisze „Nic nie poszło”, tylko ile i co wysłał', async () => {
    const z = zestaw();
    // Lista poprzedniego miesiąca działa; przy przeliczeniu bieżącego (druga wysyłka) inFakt oddaje 503.
    const oryginalna = z.infakt.listaFaktur;
    let pazdziernik = 0;
    z.infakt.listaFaktur = async (p) => {
      if (p.od === '2026-10-01' && ++pazdziernik > 1) throw Object.assign(new Error('inFakt odpowiedział 503'), { dlaOperatora: true, status: 503 });
      return oryginalna(p);
    };
    wlacz(z.db);
    const w = await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(w.stan).toBe('blad');
    expect(w.wyslane.map((x) => x.numer)).toEqual(['B/2026']);
    const app = buildOmsServer({ db: z.db, config: { auth: { user: 't', pass: 'h' } } });
    const r = await app.inject({ method: 'GET', url: '/faktury/ksef/automat',
      headers: { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` } });
    await app.close();
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Nic nie poszło');
    expect(r.body).toContain('Automat zatrzymał się po wysłaniu 1 dokumentu');
    expect(r.body).toContain('inFakt odpowiedział 503');
  });

  it('udany przebieg nie daje ostrzeżenia', async () => {
    const z = zestaw();
    wlacz(z.db);
    await z.automat('2026-10-20T18:01:00Z').przebieg();
    expect(ostrzezeniaAutomatuKsef({ wynik: wczytajAutomatKsef(z.db).wynik })).toEqual([]);
    expect(ostrzezeniaAutomatuKsef({ wynik: null })).toEqual([]);
  });
});

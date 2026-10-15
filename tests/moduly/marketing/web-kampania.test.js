import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszPolaczenie, zapiszDni, zapiszTransakcje, zapiszStan, zapiszMetaKampanie } from '../../../src/oms/db/reklamy.js';

// Zakladka /kampania (Etap 0). Jawna neutralna fixture testowa tworzy kampanię promo-test.
//
// ⚠️ Kazde zadanie idzie z `?dzien=` — bez tego trasa liczy od prawdziwego zegara
// i te testy zaczelyby padac 8 września, w dniu, w ktorym kampania sie skonczy.

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-25T12:00:00', ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '150.72',
  status_woo: 'processing', oplacone_at: '2026-08-25T17:43:27Z', anulowane: 0,
  utworzone_at: '2026-08-25T17:42:45Z',
  pozycje: [], kupony: [{ kod: 'promo-test', rabat: '58.17' }], ...nad,
});

function wstawKampanieTestowa(db) {
  db.prepare(`INSERT INTO kampanie (kod,nazwa,od_dnia,do_dnia,sklep,cel_uzyc,ga4_wlasciwosc,ga4_sciezka,fale_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('promo-test','Kampania testowa','2026-08-24','2026-09-07','sklep-test',10,
    '123456789','/promocja-test',JSON.stringify([
      {od:'2026-08-26',napis:'start reklam'}, {od:'2026-08-30',napis:'fala 2'}, {od:'2026-09-04',napis:'fala 3'}
    ]));
}

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  wstawKampanieTestowa(db);
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const pobierzReklamy = (url) => app.inject({ method: 'GET', url, headers: naglowek });
// Historyczne asercje poniżej dotyczą szczegółu konkretnej promocji.
const pobierz = (url) => pobierzReklamy(url.startsWith('/kampania?dzien=')
  ? url.replace('/kampania?', '/kampania?kampania=promo-test&') : url);

describe('trasa /kampania', () => {
  it('bez uwierzytelnienia oddaje 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/kampania' });
    expect(r.statusCode).toBe(401);
  });

  it('pokazuje kampanię startową z seedu: kod, okno i dzień kampanii', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('promo-test');
    expect(r.body).toContain('2026-08-24 – 2026-09-07');
    expect(r.body).toContain('dzień 2 z 15');
    expect(r.body).toContain('cel: 10');
  });

  it('liczy zamówienie z kodem do kafli i pokazuje je w tabeli z linkiem do karty', async () => {
    const id = zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('150.72 zł');
    expect(r.body).toContain('-58.17 zł');
    expect(r.body).toContain(`href="/zamowienia/${id}"`);
  });

  it('anulowane zamówienie stoi w tabeli ze statusem, ale kafel użyć go nie liczy', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {});
    zapiszZamowienie(db, 'sklep-test', zmapowane(28225, { anulowane: 1 }), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('+ 1 anulowanych');
    expect(r.body).toContain('28225');
  });

  it('użycie kodu w innym sklepie ląduje w „poza zasięgiem", nie w kaflach', async () => {
    zapiszZamowienie(db, 'pro', zmapowane(1290), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('Poza zasięgiem kampanii: 1');
  });

  it('nieznany kod kampanii mówi o tym wprost, bez cichej podmiany', async () => {
    const r = await pobierz('/kampania?kampania=nie-ma&dzien=2026-08-25');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Nie ma kampanii o kodzie');
  });

  it('sekcja „Wszystkie kupony" pokazuje też kody spoza kampanii (free50 na PRO)', async () => {
    zapiszZamowienie(db, 'pro', zmapowane(1275, {
      kupony: [{ kod: 'free50', rabat: '14.95' }], kwota_brutto: '14.95',
    }), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('free50');
    expect(r.body).toContain('-14.95 zł');
  });

  it('przed startem kampanii ekran mówi, od kiedy kod działa', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-20');
    expect(r.body).toContain('jeszcze nie wystartowała');
    expect(r.body).toContain('kod zacznie działać 2026-08-24');
  });

  it('zepsuty parametr dnia nie wywala trasy (spada na dziś)', async () => {
    const r = await pobierz('/kampania?dzien=2026-02-30');
    expect(r.statusCode).toBe(200);
  });
});

describe('bieżący ekran Reklamy', () => {
  it('porównuje GA4 z netto produktów OMS i oddzielnie podpisuje brutto z dostawą', async () => {
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: 'property-pro', kanal: 'pro', waluta: 'PLN' });
    zapiszDni(db, { typ: 'ga4', polaczenieId: p.id, pobranoAt: '2026-09-23T09:00:00Z', wiersze: [
      { dzien: '2026-09-22', kampaniaId: 'produktowa', koszt: '10.00', waluta: 'PLN' },
    ] });
    zapiszTransakcje(db, { polaczenieId: p.id, pobranoAt: '2026-09-23T09:00:00Z', wiersze: [
      { dzien: '2026-09-22', kampaniaId: 'produktowa', transactionId: '1451', przychod: '97.40', waluta: 'PLN' },
    ] });
    const order = db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,kwota_brutto,koszt_dostawy_brutto,
      utworzone_at) VALUES ('pro',1451,'1451','144.80','25.00','2026-09-22T12:00:00Z') RETURNING id`).get();
    db.prepare(`INSERT INTO pozycje (zamowienie_id,nazwa,ilosc,cena_brutto,netto_linii,zrodlo)
      VALUES (?,?,1,'119.80','97.40','sklep')`).run(order.id, 'Produkt');
    const r = await pobierzReklamy('/kampania?widok=google&dzien=2026-09-23');
    expect(r.body).toContain('Potwierdzone w OMS · produkty netto bez dostawy</small><strong>97.40 PLN');
    expect(r.body).toContain('Całe zamówienia brutto z dostawą: 144.80 PLN');
    expect(r.body).toContain('ROAS: 9.74×');
  });

  it('brak netto pozycji zostawia konwersję OMS, ale ukrywa niepełny przychód i ROAS', async () => {
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: 'property-pro', kanal: 'pro', waluta: 'PLN' });
    zapiszDni(db, { typ: 'ga4', polaczenieId: p.id, pobranoAt: '2026-09-23T09:00:00Z', wiersze: [
      { dzien: '2026-09-22', kampaniaId: 'produktowa', koszt: '10.00', waluta: 'PLN' },
    ] });
    zapiszTransakcje(db, { polaczenieId: p.id, pobranoAt: '2026-09-23T09:00:00Z', wiersze: [
      { dzien: '2026-09-22', kampaniaId: 'produktowa', transactionId: '1451', przychod: '97.40', waluta: 'PLN' },
    ] });
    const order = db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,kwota_brutto,utworzone_at)
      VALUES ('pro',1451,'1451','144.80','2026-09-22T12:00:00Z') RETURNING id`).get();
    db.prepare(`INSERT INTO pozycje (zamowienie_id,nazwa,ilosc,cena_brutto,netto_linii,zrodlo)
      VALUES (?,?,1,'119.80',NULL,'sklep')`).run(order.id, 'Produkt');
    const r = await pobierzReklamy('/kampania?widok=google&dzien=2026-09-23');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Całe zamówienia brutto z dostawą: 144.80 PLN');
    expect(r.body).toContain('Potwierdzone w OMS · produkty netto bez dostawy</small><strong>—');
    expect(r.body).toContain('brakuje netto pozycji');
  });

  it('bez połączeń pokazuje cztery karty i instrukcje bez zmyślonych wyników', async () => {
    const r = await pobierzReklamy('/kampania?dzien=2026-09-23');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('>Podsumowanie<');
    expect(r.body).toContain('>Google<');
    expect(r.body).toContain('>Meta<');
    expect(r.body).toContain('>Kampanie<');
    expect(r.body).toContain('Niepodłączone');
    expect(r.body).toContain('/ustawienia/integracje/reklamy');
    expect(r.body).not.toContain('>Kampanie — archiwum<');
    expect(r.body).not.toContain('0.00 PLN');
  });

  it('zakończona promocja trafia do archiwum, a link zachowuje pełny historyczny widok', async () => {
    const lista = await pobierzReklamy('/kampania?widok=kampanie&dzien=2026-09-23');
    expect(lista.statusCode).toBe(200);
    expect(lista.body).toContain('Archiwum');
    expect(lista.body).toContain('href="/kampania?kampania=promo-test"');
    const szczegol = await pobierz('/kampania?kampania=promo-test&dzien=2026-08-25');
    expect(szczegol.statusCode).toBe(200);
    expect(szczegol.body).toContain('dzień 2 z 15');
  });

  it('Google pokazuje prawdziwy koszt, walutę i ostatni sukces bez referencji do sekretu', async () => {
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: 'moja-wlasciwosc', kanal: 'pro',
      waluta: 'PLN', strefa: 'Europe/Warsaw', sekretRef: 'ukryta-referencja' });
    zapiszDni(db, { typ: 'ga4', polaczenieId: p.id, pobranoAt: '2026-09-23T09:00:00Z', wiersze: [{
      dzien: '2026-09-22', kampaniaId: 'moj-test', nazwa: 'Moja kampania',
      koszt: '12.34', klikniecia: 7, wyswietlenia: 100, waluta: 'PLN',
    }] });
    zapiszStan(db, { polaczenieId: p.id, ostatniaProbaAt: '2026-09-23T09:00:00Z',
      ostatniSukcesAt: '2026-09-23T09:00:00Z' });
    const r = await pobierzReklamy('/kampania?widok=google&dzien=2026-09-23');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('12.34 PLN');
    expect(r.body).toContain('Moja kampania');
    expect(r.body).toContain('2026-09-23T09:00:00Z');
    expect(r.body).not.toContain('ukryta-referencja');
    const suma = await pobierzReklamy('/kampania?widok=podsumowanie&dzien=2026-09-23');
    expect(suma.body).toContain('Ostatni udany pobór GA4: 2026-09-23T09:00:00Z');
    expect(suma.body).toContain('aria-label="Dzienny koszt reklam Google i Meta');
    expect(r.body).toContain('aria-label="Koszt według kampanii"');
  });

  it('odświeża bieżące reklamy na żądanie bez przejścia na stary raport kampanii', async () => {
    const czuwaczReklam = { przebieg: vi.fn(async () => ({ sukcesy: 1, bledy: 0 })) };
    const serwer = buildOmsServer({ db, config, poller, czuwaczReklam });
    const ekran = await serwer.inject({ method: 'GET', url: '/kampania', headers: naglowek });
    expect(ekran.body).toContain('action="/kampania/odswiez-reklamy"');
    const r = await serwer.inject({ method: 'POST', url: '/kampania/odswiez-reklamy', headers: naglowek, payload: {} });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/kampania');
    expect(czuwaczReklam.przebieg).toHaveBeenCalledOnce();
    await serwer.close();
  });

  it('błąd Meta nie zasłania poprawnego Google i nie udaje zerowego wyniku Meta', async () => {
    const g = zapiszPolaczenie(db, { typ: 'ga4', kontoId: 'moja-wlasciwosc', kanal: 'pro', waluta: 'PLN' });
    zapiszDni(db, { typ: 'ga4', polaczenieId: g.id, pobranoAt: '2026-09-23T09:00:00Z', wiersze: [{
      dzien: '2026-09-22', kampaniaId: 'moj-test', koszt: '12.34', klikniecia: 7, wyswietlenia: 100,
    }] });
    const m = zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_moje', kanal: 'pro', waluta: 'PLN' });
    zapiszStan(db, { polaczenieId: m.id, ostatniaProbaAt: '2026-09-23T09:00:00Z', kodBledu: 'BRAK_UPRAWNIEN' });
    const google = await pobierzReklamy('/kampania?widok=google&dzien=2026-09-23');
    const meta = await pobierzReklamy('/kampania?widok=meta&dzien=2026-09-23');
    expect(google.body).toContain('12.34 PLN');
    expect(meta.body).toContain('Brak uprawnień');
    expect(meta.body).toContain('Brak danych w wybranym okresie');
    expect(meta.body).not.toContain('0.00 PLN');
  });

  it('bez potwierdzonej waluty OMS nie pokazuje zerowych konwersji OMS', async () => {
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: 'property-eur', kanal: 'pro', waluta: 'EUR' });
    zapiszDni(db, { typ: 'ga4', polaczenieId: p.id, pobranoAt: '2026-09-23T09:00:00Z', wiersze: [{
      dzien: '2026-09-22', kampaniaId: 'eur', koszt: '10.00', waluta: 'EUR',
    }] });
    const r = await pobierzReklamy('/kampania?widok=google&dzien=2026-09-23');
    expect(r.body).toContain('10.00 EUR');
    expect(r.body).toContain('Potwierdzone w OMS · produkty netto bez dostawy</small><strong>—');
  });

  it('ACTIVE Meta bez insights jest widoczna bez fałszywej emisji i zerowego kosztu', async () => {
    const m = zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_moje', kanal: 'pro', waluta: 'PLN' });
    zapiszMetaKampanie(db, { polaczenieId: m.id, pobranoAt: '2026-09-23T09:00:00Z', kampanie: [{
      id: 'moja-aktywna', nazwa: 'Aktywna w panelu Meta', effectiveStatus: 'ACTIVE',
      budzety: [{ poziom: 'zestawy', typ: 'dzienny', kwotaMinor: '2000' }], waluta: 'PLN',
    }] });
    zapiszStan(db, { polaczenieId: m.id, ostatniaProbaAt: '2026-09-23T09:00:00Z',
      ostatniSukcesAt: '2026-09-23T09:00:00Z' });
    const r = await pobierzReklamy('/kampania?widok=meta&dzien=2026-09-23');
    expect(r.body).toContain('Brak kampanii z emisją w wybranym okresie.');
    expect(r.body).toContain('Kampanie bez emisji w wybranym okresie (1)');
    expect(r.body).toMatch(/<details[^>]*><summary>Kampanie bez emisji/);
    expect(r.body).toContain('Aktywna w panelu Meta');
    expect(r.body).toContain('Brak potwierdzonej emisji');
    expect(r.body).toContain('Budżet dzienny (zestawy): 20,00');
    expect(r.body).not.toContain('0.00 PLN');
    expect(r.body).not.toContain('>Emituje<');
  });
});

describe('wejście do zakładki', () => {
  it('kontekst Analiz ma nazwane wejście do /kampania', async () => {
    const r = await pobierz('/raporty');
    expect(r.body).toContain('href="/kampania"');
    expect(r.body).toContain('>Reklamy<');
  });
});

// ——— SEKCJE ZRODEL ZEWNETRZNYCH (Etapy 1-2) ————————————————————————————————————————
//
// ⚠️ TRZY STANY, KTORE W BAZIE WYGLADAJA IDENTYCZNIE (brak wierszy): zrodlo niepodlaczone,
// awaria pobierania, jeszcze nie pobrano. Ekran ma nazwac KTORY — inaczej operator
// widzi puste miejsce i nie wie, czy czekac, czy poprawiac konfiguracje.

const zKonfiguracja = async (zrodla) => {
  const serwer = buildOmsServer({ db, config: { ...config, ...zrodla }, poller });
  await serwer.ready();
  return (await serwer.inject({ method: 'GET', url: '/kampania?kampania=promo-test&dzien=2026-08-25', headers: naglowek })).body;
};

const metaWiersz = (nad = {}) => ({
  dzien: '2026-08-24', wydatek: '50.00', wyswietlenia: 1600, zasieg: 800,
  klikniecia: 60, klikniecia_linku: 20, ...nad,
});

const wstawMete = (w) => db.prepare(
  `INSERT INTO kampania_meta_dni (kod, dzien, wydatek, wyswietlenia, zasieg, klikniecia, klikniecia_linku, pobrane_at)
   VALUES ('promo-test',?,?,?,?,?,?,'2026-08-25T08:00:00Z')`,
).run(w.dzien, w.wydatek, w.wyswietlenia, w.zasieg, w.klikniecia, w.klikniecia_linku);

const wstawGa4 = (dzien, sesje, sesjeMeta, odslony) => db.prepare(
  `INSERT INTO kampania_ga4_dni (kod, dzien, sesje, uzytkownicy, sesje_meta, odslony_promo, pobrane_at)
   VALUES ('promo-test',?,?,?,?,?,'2026-08-25T08:00:00Z')`,
).run(dzien, sesje, sesje, sesjeMeta, odslony);

describe('sekcja Reklama (Meta)', () => {
  it('bez konfiguracji mówi, czego brakuje — a nie pokazuje zer', async () => {
    const body = await zKonfiguracja({});
    expect(body).toContain('Panel nie ma dostępu do Meta');
    expect(body).toContain('META_TOKEN');
  });

  it('podłączona, ale bez danych: mówi, że czeka — nie udaje zerowego wydatku', async () => {
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] } });
    expect(body).toContain('Brak danych o wydatkach');
    expect(body).not.toContain('Panel nie ma dostępu do Meta');
  });

  it('z danymi pokazuje wydatek, koszt użycia kodu, CPC z punktem odniesienia i ROAS', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {});
    wstawMete(metaWiersz());
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] } });

    expect(body).toContain('50.00 zł');       // wydatek
    expect(body).toContain('0.83 zł');        // CPC = 50 zl / 60 klikniec
    expect(body).toContain('dotąd 0,125 zł'); // punkt odniesienia z kampanii ruchowej
    expect(body).toContain('3.0×');           // ROAS = 150,72 / 50,00
  });

  // ⚠️⚠️ Zera przy padnietym kluczu wygladaja jak zera przy reklamie, ktora nie chodzi.
  it('błąd pobierania stoi NAD liczbami, razem z datą ostatniego udanego pobrania', async () => {
    wstawMete(metaWiersz());
    db.prepare(
      `INSERT INTO kampania_zrodla (zrodlo, ostatnia_proba_at, ostatni_sukces_at, ostatni_blad)
       VALUES ('meta','2026-08-25T09:00:00Z','2026-08-25T06:00:00Z','Meta odmówiła (OAuthException): token wygasł')`,
    ).run();
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] } });

    expect(body).toContain('Ostatnie pobranie z Meta się nie udało');
    expect(body).toContain('token wygasł');
    expect(body).toContain('50.00 zł'); // liczby ZOSTAJA — dalej są prawdą o tym, co było
  });

  // ⚠️ Zasieg to liczba OSOB — sumy nie ma i ekran ma o tym mowic.
  it('mówi wprost, że zasięgu nie sumuje', async () => {
    wstawMete(metaWiersz());
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] } });
    expect(body).toMatch(/zasięgu nie sumujemy/);
  });
});

describe('sekcja Ruch w sklepie (GA4)', () => {
  it('bez konfiguracji mówi, czego brakuje', async () => {
    const body = await zKonfiguracja({});
    expect(body).toContain('Panel nie ma dostępu do GA4');
  });

  it('kampania bez wskazanej właściwości: mówi, że panel o ruch nie pyta', async () => {
    db.prepare("UPDATE kampanie SET ga4_wlasciwosc = NULL WHERE kod = 'promo-test'").run();
    const body = await zKonfiguracja({ ga4: { sciezkaKlucza: '/data-oms/sa.json' } });
    expect(body).toContain('nie ma wskazanej właściwości GA4');
  });

  it('z danymi pokazuje sesje, sesje z Mety i odsłony strony warunków', async () => {
    wstawGa4('2026-08-24', 28, 5, 3);
    wstawGa4('2026-08-25', 12, 2, 1);
    const body = await zKonfiguracja({ ga4: { sciezkaKlucza: '/data-oms/sa.json' } });

    expect(body).toContain('Sesje w sklepie');
    expect(body).toContain('Sesje z Mety');
    expect(body).toContain('/promocja-test');
  });

  // Zmierzony rozjazd dziesieciokrotny (20.08.2026) — ekran ma o nim mowic sam.
  it('ostrzega, że kliknięć Mety i sesji GA4 nie porównuje się wprost', async () => {
    wstawGa4('2026-08-24', 28, 5, 3);
    const body = await zKonfiguracja({ ga4: { sciezkaKlucza: '/data-oms/sa.json' } });
    expect(body).toMatch(/nie porównujemy wprost/);
  });
});

// ——— LEJEK REKLAMY (v2.1, 2026-08-28) — w miejsce dawnego wykresu uzyc+wydatku ————————
// Zgloszenie właściciela: dwa wykresy pokazywaly wydatek i mylily sie ze soba. Ten pokazuje
// teraz MASZYNE (wyswietlenia → klikniecia w link → zamowienia kampanijne), a pieniadze
// zostaly wylacznie w „Pieniadze dzien po dniu".
describe('lejek reklamy: od wyświetlenia do zamówienia', () => {
  // ⚠️ ASERCJA PO PELNYM ATRYBUCIE `class="..."`, nie po golej nazwie klasy — gola trafia
  // w arkusz stylow szkieletu, ktory niesie kazda z tych klas (pulapka nr 1, rozdz. 10).
  it('tory Mety pojawiają się dopiero przy danych z Mety; tor zamówień jest zawsze', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {});
    const bezMety = await zKonfiguracja({});
    expect(bezMety).toContain('Od wyświetlenia do zamówienia');
    expect(bezMety).toContain('class="dzien-tor dzien-tor--zamowienia"');
    expect(bezMety).not.toContain('class="dzien-tor dzien-tor--wyswietlenia"');
    expect(bezMety).not.toContain('class="dzien-tor dzien-tor--klik"');

    wstawMete(metaWiersz());
    const zMeta = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] } });
    expect(zMeta).toContain('class="dzien-tor dzien-tor--wyswietlenia"');
    expect(zMeta).toContain('class="dzien-tor dzien-tor--klik"');
    expect(zMeta).toContain('tu jest maszyna, tam wynik');
  });

  it('opis dnia niesie pełny lejek: zamówienia, wyświetlenia i kliknięcia w link', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {});
    wstawMete(metaWiersz({ dzien: '2026-08-25' }));
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] } });
    expect(body).toContain('title="2026-08-25 (wt) · 1 zamówienie kampanijne · 1600 wyświetleń · 20 kliknięć w link"');
  });

  // Tor zamowien liczy UNIE w kolorach serii wykresu pieniedzy — zamowienie z utm bez
  // kodu dostaje wlasny (pomaranczowy) kawalek slupka.
  it('zamówienie z reklam bez kodu wchodzi do toru zamówień własnym kolorem', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28226, {
      kupony: [], kwota_brutto: '64.79',
      atrybucja: { typ: 'utm', zrodlo: 'facebook', medium: 'cpc', kampania: 'promo-test' },
    }), {});
    const body = await zKonfiguracja({});
    expect(body).toContain('class="dzien-slupek dzien-slupek--utm"');
    expect(body).toContain('w tym 1 z reklam bez kodu');
  });
});

describe('Odśwież teraz', () => {
  // ⚠️ Zegar chodzi co godzine — bez tego przycisku pierwsze liczby po wdrozeniu albo po
  // poprawieniu klucza pojawialyby sie dopiero za godzine.
  it('przycisk pokazuje się tylko wtedy, gdy jest co odświeżać', async () => {
    const bez = await zKonfiguracja({});
    expect(bez).not.toContain('action="/kampania/odswiez"');

    const serwer = buildOmsServer({ db, config, poller, czuwaczKampanii: { przebieg: async () => ({}) } });
    await serwer.ready();
    const body = (await serwer.inject({ method: 'GET', url: '/kampania?kampania=promo-test&dzien=2026-08-25', headers: naglowek })).body;
    expect(body).toContain('action="/kampania/odswiez"');
  });

  it('kliknięcie uruchamia przebieg i wraca na zakładkę (303)', async () => {
    const przebieg = vi.fn(async () => ({}));
    const serwer = buildOmsServer({ db, config, poller, czuwaczKampanii: { przebieg } });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: '/kampania/odswiez', headers: naglowek, payload: { kampania: 'promo-test' },
    });

    expect(przebieg).toHaveBeenCalledTimes(1);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/kampania?kampania=promo-test');
  });

  // ⚠️ Awaria zrodla NIE gasi ekranu: powod jest juz zapisany w `kampania_zrodla`,
  // wiec sekcja go pokaze — a klikniecie ma wrocic na ekran, nie oddac 500.
  it('awaria przebiegu nie wywala trasy — wraca na ekran', async () => {
    const serwer = buildOmsServer({
      db, config, poller, czuwaczKampanii: { przebieg: async () => { throw new Error('Meta padła'); } },
    });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: '/kampania/odswiez', headers: naglowek, payload: {} });
    expect(r.statusCode).toBe(303);
  });

  it('bez podpiętych źródeł trasa odmawia czytelnie, a nie 500', async () => {
    const r = await app.inject({ method: 'POST', url: '/kampania/odswiez', headers: naglowek, payload: {} });
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/ani Mety, ani GA4/);
  });
});

// ——— ZAMOWIENIA Z REKLAM (utm) + ALERTY + MIARY (2026-08-27) ————————————————————————
//
// Drugi licznik kampanii: zamowienia z utm_campaign w atrybucji, takze bez kodu.
// Kod mierzy cala promocje (baner tez go rozdaje), utm mierzy klikniecia w reklame.

describe('sekcja Zamówienia z reklam', () => {
  it('zamówienie z utm kampanii BEZ kodu stoi w sekcji z liczbami i linkiem do karty', async () => {
    const id = zapiszZamowienie(db, 'sklep-test', zmapowane(28226, {
      kupony: [], kwota_brutto: '64.79',
      atrybucja: { typ: 'utm', zrodlo: 'facebook', medium: 'cpc', kampania: 'promo-test', urzadzenie: 'Mobile' },
    }), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');

    expect(r.body).toContain('Zamówienia z reklam');
    expect(r.body).toContain('z kodem 0 · bez kodu 1');
    expect(r.body).toContain('facebook — link z tagiem');
    expect(r.body).toContain(`href="/zamowienia/${id}"`);
  });

  it('bez ani jednego zamówienia z utm sekcja mówi, co się tu liczy — a nie pokazuje zer', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('Żadne zamówienie nie przyszło jeszcze z kliknięcia w reklamę');
    expect(r.body).toContain('utm_campaign=promo-test');
  });

  // ⚠️ Zamowienie z reklam I z kodem NIE moze stac w dwoch tabelach — w tabeli utm stoja
  // wylacznie te bez kodu, reszte niesie rozbicie kafla.
  it('zamówienie z utm I kodem liczy się w rozbiciu, ale tabela utm go nie dubluje', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224, {
      atrybucja: { typ: 'utm', zrodlo: 'facebook', medium: 'cpc', kampania: 'promo-test' },
    }), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('z kodem 1 · bez kodu 0');
  });
});

describe('alerty kontrolne na zakładce', () => {
  it('wydatek idzie, a GA4 nie widzi sesji z Mety → pasek o znacznikach utm', async () => {
    wstawMete(metaWiersz());
    wstawGa4('2026-08-24', 28, 0, 3);
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] }, ga4: { sciezkaKlucza: '/x.json' } });
    expect(body).toContain('ani jednej sesji z Mety');
  });

  it('bez powodów do alarmu paska nie ma', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).not.toContain('ani jednej sesji z Mety');
    expect(r.body).not.toContain('po końcu kampanii');
  });
});

describe('układ strony kampanii', () => {
  it('kampania zachowuje ciemną treść we wspólnej ramie OMS', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('class="strona-kampania"');
    expect(r.body.match(/<!doctype html>/gi) ?? []).toHaveLength(1);
    // PRZ-071: wspólna rama OMS od PRZ-065 to oms-shell z bocznym menu (dawniej rama-oms + kolumna-boczna).
    expect(r.body).toContain('class="oms-shell"');
    expect(r.body).toContain('<nav class="oms-menu" aria-label="Główna"');
    expect(r.body).toContain('class="oms-sidebar"');
  });

  it('reszta panelu nie dostaje stylu treści kampanii', async () => {
    const r = await pobierz('/');
    expect(r.body).not.toContain('class="strona-kampania"');
    expect(r.body).toContain('class="oms-shell"');
  });

  it('style kampanii nie zmieniają przycisków ani odnośników wspólnej ramy', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    const stylKampanii = r.body.match(/<style>\s*\.strona-kampania\s*\{[\s\S]*?<\/style>/)?.[0];

    expect(stylKampanii).toBeTruthy();
    expect(stylKampanii).toContain('.strona-kampania .btn {');
    expect(stylKampanii).toContain('.strona-kampania a {');
    expect(stylKampanii).not.toMatch(/\n\s+\.btn\s*\{/);
    expect(stylKampanii).not.toMatch(/\n\s+a\s*\{/);
  });

  // ——— v2 „kokpit" (2026-08-28): jedyny dopuszczony skrypt w OMS-ie ————————————————
  // ⚠️ Progresywne wzbogacenie: skrypt dotyczy WYLACZNIE prezentacji, a strona bez JS
  // jest kompletna — suita nie odpala JS, wiec wszystkie pozostale testy tego pilnuja
  // z samej swojej konstrukcji.
  it('strona niesie skrypt ożywienia, dymek i pierścień dnia kampanii', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('id="kampania-ozywienie"');
    expect(r.body).toContain('id="kampania-dymek"');
    expect(r.body).toContain('class="pierscien-dnia"');
    // Bez JS pierscien MA stac na wartosci docelowej — dzien 2 z 15 → 50.27*(13/15) = 43.57.
    expect(r.body).toContain('stroke-dashoffset: 43.57');
  });

  it('poza oknem kampanii pierścienia nie ma, a skrypt zostaje', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-20');
    expect(r.body).not.toContain('class="pierscien-dnia"');
    expect(r.body).toContain('id="kampania-ozywienie"');
  });

  it('skrypt ożywienia ustępuje przy prefers-reduced-motion (strażnik na początku)', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('prefers-reduced-motion: reduce');
  });
});

describe('wykres Pieniądze dzień po dniu', () => {
  it('rysuje przychód z kodu nad osią i wydatek pod nią, z etykietami maksimów', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {}); // 150.72 z kodem, 25.08
    wstawMete(metaWiersz()); // 50.00 wydatku, 24.08
    const r = await pobierz('/kampania?dzien=2026-08-25');

    expect(r.body).toContain('Pieniądze dzień po dniu');
    expect(r.body).toContain('class="p-slupek p-slupek--kod p-slupek--szczyt"');
    expect(r.body).toContain('class="p-slupek p-slupek--wydatek"');
    expect(r.body).toContain('title="2026-08-25: 150.72 zł z kodem · 0.00 zł z reklam bez kodu · 0.00 zł wydatku"');
    expect(r.body).toContain('>150.72<'); // etykieta maksimum gory
    expect(r.body).toContain('>50.00<');  // etykieta maksimum dolu
    expect(r.body).toContain('start reklam'); // prowadnica wyliczona z pierwszego dnia z wydatkiem
    expect(r.body).toContain('zwrot dotąd');
  });

  it('zamówienie z utm bez kodu dostaje własny kawałek słupka', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28226, {
      kupony: [], kwota_brutto: '64.79',
      atrybucja: { typ: 'utm', zrodlo: 'facebook', medium: 'cpc', kampania: 'promo-test' },
    }), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('class="p-slupek p-slupek--utm"');
    expect(r.body).toContain('title="2026-08-25: 0.00 zł z kodem · 64.79 zł z reklam bez kodu · 0.00 zł wydatku"');
  });

  it('bez ani jednej złotówki w oknie wykres się nie rysuje — zamiast pustych torów', async () => {
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).not.toContain('Pieniądze dzień po dniu');
  });

  // ——— ETAPY (2026-08-28, jak na makiecie): prowadnice fal z kampanie.fale_json ————
  it('rysuje prowadnice etapów z kampanii i strefę „przed reklamami"', async () => {
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {});
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('fala 2</span>');
    expect(r.body).toContain('fala 3</span>');
    expect(r.body).toContain('przed reklamami');
    // ⚠️ Pelny atrybut class, nie gola nazwa — gola trafia w arkusz stylow szkieletu.
    expect(r.body).toContain('class="p-dzien p-dzien--przed"');
  });

  it('bez skonfigurowanych etapów wraca wyliczany „start reklam" z pierwszego dnia z wydatkiem', async () => {
    db.prepare("UPDATE kampanie SET fale_json = NULL WHERE kod = 'promo-test'").run();
    zapiszZamowienie(db, 'sklep-test', zmapowane(28224), {});
    wstawMete(metaWiersz());
    const r = await pobierz('/kampania?dzien=2026-08-25');
    expect(r.body).toContain('start reklam');
    expect(r.body).not.toContain('fala 2');
  });
});

describe('miary przy źródłach: prognoza i pokrycie', () => {
  it('kafel wydatku niesie prognozę z pełnych dni', async () => {
    wstawMete(metaWiersz()); // 2026-08-24, 50 zl — pelny dzien wobec dzien=2026-08-25
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] } });
    // 50 zl + 50 zl/dzien × 14 pozostalych dni (25.08–07.09) = 750 zl.
    expect(body).toContain('przy tym tempie do końca ~750.00 zł');
  });

  it('uwaga pod GA4 nazywa pokrycie pomiaru jedną liczbą', async () => {
    wstawMete(metaWiersz()); // klikniecia_linku 20
    wstawGa4('2026-08-24', 28, 5, 3); // sesje_meta 5 → 25%
    const body = await zKonfiguracja({ meta: { token: 'x', konta: ['act_1'] }, ga4: { sciezkaKlucza: '/x.json' } });
    expect(body).toContain('GA4 widzi ~<strong>25%</strong>');
  });
});

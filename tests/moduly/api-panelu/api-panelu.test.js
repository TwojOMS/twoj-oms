import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { proformyZamowienia } from '../../../src/moduly/faktury/db/proformy.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ---------------------------------------------------------------------------------
// Etap 1 planu 2026-08-18-layout-karty-i-koniec-apilo: DWIE TRASY API, ktorymi panel
// zamowien indywidualnych przestaje potrzebowac Apilo. Testy stoja tutaj, a nie w
// tests/oms/api-zamowienia-z-karty.test.js, bo dotycza innego kontraktu (odszukanie
// zamowienia po numerze SKLEPOWYM i proforma dla panelu), choc kod mieszka w tym samym
// pliku tras.
// ---------------------------------------------------------------------------------

const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

// Basic Auth jak w kazdym tescie trasy OMS-u. `host` jest tu ZAWSZE, bo straznik CSRF
// (src/security/csrf.js) porownuje Origin wlasnie z nim.
const naglowkiGet = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  host: 'localhost',
};
const naglowkiPost = { ...naglowkiGet, origin: 'http://localhost' };

// Zamowienie ze sklepu — ksztalt, ktory `zapiszZamowienie` przyjmuje od pollera
// WooCommerce. 2 x 61,50 = 123,00 zl, bez dostawy.
const zeSklepu = (nad = {}) => ({
  zrodlo_id: 5001,
  numer: '28060',
  klient: {
    first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki',
  },
  dostawa: {},
  metoda_wysylki: 'dpd',
  kwota_pobrania: null,
  chce_fakture: 0,
  nip: null,
  kwota_brutto: '123.00',
  koszt_dostawy_brutto: '0.00',
  status_woo: 'processing',
  metoda_platnosci: 'Przelew tradycyjny',
  indywidualne: 0,
  oplacone_at: null,
  anulowane: 0,
  utworzone_at: '2026-08-18T10:00:00',
  pozycje: [{
    nazwa: 'STOP 70x100', sku: 'PSM-STOP-001', ilosc: 2, cena_brutto: '61.50', vat: null,
  }],
  ...nad,
});

describe('GET /api/zamowienia/po-numerze/:numer', () => {
  let db;
  let app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config });
    await app.ready();
  });

  const pytaj = (numer, zapytanie = '') => app.inject({
    method: 'GET', url: `/api/zamowienia/po-numerze/${numer}${zapytanie}`, headers: naglowkiGet,
  });

  // ⚠️⚠️ TEN TEST JEST O PIENIADZACH I JEST POWODEM ISTNIENIA PARAMETRU `sklep`.
  // NUMER ZAMOWIENIA NIE JEST UNIKALNY MIEDZY SKLEPAMI: szkicownia.pl i pro.szkicownia.pl
  // numeruja NIEZALEZNIE, wiec `28060` istnieje w obu naraz i zadna kolumna w bazie tego
  // nie zabrania. Trasa, ktora bierze „pierwsze trafienie", podpina karte panelu pod CUDZE
  // zamowienie — a wtedy panel czyta cudza zaplate, oznacza karte jako oplacona i ETAP IV
  // rusza za pieniadze, ktorych ten klient nie przelal. To dokladnie ta klasa bledu, ktora
  // zlikwidowalo przejscie z dopasowania po adresie e-mail na numer oferty.
  //
  // Test pyta o TEN SAM numer DWA RAZY, raz o kazdy sklep, i kazde pytanie ma oddac INNE
  // zamowienie. Polowa z jednym pytaniem przechodziłaby takze przy „wez pierwsze z brzegu".
  it('ten sam numer w dwoch sklepach — oddaje zamowienie ze WSKAZANEGO sklepu', async () => {
    const idSzkicownia = zapiszZamowienie(db, 'szkicownia', zeSklepu({ zrodlo_id: 5001 }), {});
    const idPro = zapiszZamowienie(db, 'pro', zeSklepu({
      zrodlo_id: 7002,
      kwota_brutto: '456.00',
      pozycje: [{
        nazwa: 'Szablon PRO', sku: 'PRO-1', ilosc: 1, cena_brutto: '456.00', vat: null,
      }],
    }), {});
    expect(idSzkicownia).not.toBe(idPro);

    const zeSzkicownia = await pytaj('28060', '?sklep=szkicownia');
    expect(zeSzkicownia.statusCode).toBe(200);
    expect(zeSzkicownia.json()).toMatchObject({ id: idSzkicownia, sklep: 'szkicownia', kwotaBrutto: '123.00' });

    const zPro = await pytaj('28060', '?sklep=pro');
    expect(zPro.statusCode).toBe(200);
    expect(zPro.json()).toMatchObject({ id: idPro, sklep: 'pro', kwotaBrutto: '456.00' });
  });

  it('oddaje caly kontrakt pol, ktorego panel oczekuje', async () => {
    const id = zapiszZamowienie(db, 'szkicownia', zeSklepu({
      indywidualne: 1,
      // Zaplata ze sklepu idzie do tabeli `platnosci` (zsynchronizujWplateSklepu), a
      // `oplacone` liczy sie Z NIEJ przy odczycie — tak samo jak w reszcie OMS-u.
      oplacone_at: '2026-08-18T11:00:00',
    }), {});
    const res = await pytaj('28060', '?sklep=szkicownia');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id,
      numer: '28060',
      sklep: 'szkicownia',
      oplacone: true,
      anulowane: false,
      kwotaBrutto: '123.00',
      indywidualne: true,
    });
  });

  // ⚠️ `oplacone` MA SIE LICZYC Z POKRYCIA CALEJ KWOTY, nie z „jest jakas wplata" — ta sama
  // regula, co w siostrzanej trasie /api/zamowienia-z-karty/:kartaId. Zamowienie bez zaplaty
  // ze sklepu musi dac `false`, inaczej poller panelu ustawilby `paid_at` karcie, ktorej
  // klient jeszcze nie oplacil.
  it('zamowienie bez zaplaty oddaje oplacone:false', async () => {
    zapiszZamowienie(db, 'szkicownia', zeSklepu(), {});
    const res = await pytaj('28060', '?sklep=szkicownia');
    expect(res.json().oplacone).toBe(false);
  });

  it('anulowane zamowienie oddaje anulowane:true', async () => {
    zapiszZamowienie(db, 'szkicownia', zeSklepu({ anulowane: 1 }), {});
    const res = await pytaj('28060', '?sklep=szkicownia');
    expect(res.json().anulowane).toBe(true);
  });

  // ⚠️ BRAK `sklep` TO ODMOWA, A NIE „SZUKAJ WSZEDZIE". W bazie lezy DOKLADNIE JEDNO
  // zamowienie o tym numerze — czyli implementacja „bez sklepu bierz jedyne trafienie"
  // oddalaby tu 200 i wygladalaby na poprawna, dopoki drugi sklep nie zalozy zamowienia
  // o tym samym numerze. Wtedy jest juz za pozno: pomylka wiaze karte z cudzym zamowieniem.
  //
  // Polowa kontrolna na koncu dowodzi, ze 400 bierze sie z BRAKU PARAMETRU, a nie z tego,
  // ze trasa i tak nic by nie znalazla.
  it('bez parametru sklep — 400, mimo ze trafienie jest DOKLADNIE JEDNO', async () => {
    const id = zapiszZamowienie(db, 'szkicownia', zeSklepu(), {});
    const res = await pytaj('28060');
    expect(res.statusCode).toBe(400);
    expect(res.json().powod).toMatch(/sklep/i);
    // Zadnych danych zamowienia w odmowie — panel nie ma dostac niczego, co da sie wziac
    // za odpowiedz na pytanie „ktore to zamowienie".
    expect(res.json().id).toBeUndefined();

    const zSklepem = await pytaj('28060', '?sklep=szkicownia');
    expect(zSklepem.statusCode).toBe(200);
    expect(zSklepem.json().id).toBe(id);
  });

  // ⚠️ PUSTY `sklep` TO NAJBARDZIEJ PRAWDOPODOBNA POSTAC TEJ AWARII W PRODUKCJI. Panel
  // sklada adres z wlasnej konfiguracji (`SHOP_SKLEP`); brak tej zmiennej nie znika — wchodzi
  // do adresu jako PUSTY NAPIS. Implementacja sprawdzajaca tylko `undefined` przepuscilaby
  // `?sklep=` i wrocilaby do „szukaj wszedzie", czyli dokladnie tam, przed czym stoi ten
  // parametr. Spacja jest ta sama pomylka po obcieciu.
  it('pusty albo bialy sklep — 400, tak samo jak brak parametru', async () => {
    zapiszZamowienie(db, 'szkicownia', zeSklepu(), {});
    for (const zapytanie of ['?sklep=', '?sklep=%20']) {
      const res = await pytaj('28060', zapytanie);
      expect(res.statusCode, `dla ${zapytanie}`).toBe(400);
      expect(res.json().powod).toMatch(/sklep/i);
    }
  });

  it('numer nieznany — 404 z czytelnym powodem', async () => {
    zapiszZamowienie(db, 'szkicownia', zeSklepu(), {});
    const res = await pytaj('99999', '?sklep=szkicownia');
    expect(res.statusCode).toBe(404);
    // ⚠️ Sam kod 404 NIE GRYZIE — to domyslna odpowiedz Fastify na kazdy nieistniejacy adres,
    // wiec przeszedlby takze wtedy, gdyby trasa w ogole nie byla zarejestrowana. Ta sama
    // konwencja, co w tests/oms/api-zamowienia-z-karty.test.js.
    expect(res.json().powod).toMatch(/nie ma zamówienia/i);
  });

  // ⚠️ TA SAMA STAWKA, CO W TESCIE Z DWOMA SKLEPAMI, TYLKO OD DRUGIEJ STRONY. Numer W BAZIE
  // JEST, ale nalezy do innego sklepu — i to MUSI byc 404 („u ciebie takiego nie ma"), a nie
  // ciche oddanie tamtego zamowienia. Bez tego testu implementacja, ktora filtruje po sklepie
  // tylko wtedy, gdy trafien jest wiecej niz jedno, swiecilaby na zielono.
  it('numer istnieje, ale w INNYM sklepie — 404, nie cudze zamowienie', async () => {
    zapiszZamowienie(db, 'szkicownia', zeSklepu(), {});
    const res = await pytaj('28060', '?sklep=pro');
    expect(res.statusCode).toBe(404);
    expect(res.json().powod).toMatch(/nie ma zamówienia/i);
    expect(res.json().id).toBeUndefined();
  });

  // ⚠️ WIELOZNACZNOSC MIMO PODANEGO SKLEPU = ODMOWA, NIGDY „WEZ PIERWSZE". Kolumna `numer`
  // nie ma globalnego UNIQUE (schema.sql — czesciowy indeks pilnuje wylacznie serii recznej
  // `R/RRRR/NNN`), a do jednej bazy wpada i biezacy poller, i jednorazowy import historii
  // z Apilo. Dwa wiersze o tym samym numerze w tym samym sklepie sa wiec osiagalne — i wtedy
  // jedyna uczciwa odpowiedz brzmi „nie wiem, ktore", bo zgadniecie wiaze karte na stale.
  it('dwa zamowienia o tym samym numerze W TYM SAMYM sklepie — 409, nigdy „wez pierwsze"', async () => {
    const a = zapiszZamowienie(db, 'szkicownia', zeSklepu({ zrodlo_id: 5001 }), {});
    const b = zapiszZamowienie(db, 'szkicownia', zeSklepu({ zrodlo_id: 5002 }), {});
    expect(a).not.toBe(b);

    const res = await pytaj('28060', '?sklep=szkicownia');
    expect(res.statusCode).toBe(409);
    expect(res.json().powod).toMatch(/więcej niż jedn/i);
    // Ani jednego identyfikatora „na wszelki wypadek": panel, ktory dostanie `id`, uzyje go.
    expect(res.json().id).toBeUndefined();
  });

  // Basic Auth stoi PRZED wszystkim (security/straznik.js) — trasa dopisana do modulu
  // dziedziczy go z serwera, ale plan wymaga TESTU, nie zalozenia.
  it('bez Basic Auth — 401, a nie odpowiedz z danymi', async () => {
    zapiszZamowienie(db, 'szkicownia', zeSklepu(), {});
    const res = await app.inject({
      method: 'GET', url: '/api/zamowienia/po-numerze/28060?sklep=szkicownia', headers: { host: 'localhost' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------------
// 1b. PROFORMA DLA PANELU.
//
// ⚠️ ISTNIEJACE TRASY PRZEGLADARKOWE ZOSTAJA NIETKNIETE i jest na to osobny opis nizej:
// POST /zamowienia/:id/proforma oddaje 302 na ekran karty, a GET /proformy/:id/pdf oddaje
// plik z `Content-Disposition: attachment`. Panel nie moze oprzec sie ani o jedno, ani
// o drugie — 302 na HTML nie niesie numeru dokumentu, a `attachment` jest instrukcja dla
// przegladarki, nie dla klienta serwerowego, ktory ma wziac bajty i wpiac je w maila.
// ---------------------------------------------------------------------------------
describe('proforma dla panelu — /api/zamowienia/:id/proforma i /api/proformy/:id/pdf', () => {
  // ⚠️ ZEGAR WSTRZYKNIETY, bo numer proformy niesie MIESIAC I ROK — test na prawdziwym
  // zegarze bylby zielony w sierpniu 2026, a czerwony we wrzesniu (patrz proforma.test.js).
  const ZEGAR = () => new Date('2026-08-18T10:00:00.000Z');

  const NADAWCA = {
    nazwa: 'Lumina Marek Zywiecki',
    ulica: 'ul. 1 Maja 5',
    kod: '00-650',
    miasto: 'Pęki',
    kraj: 'PL',
    phone: '',
  };

  async function zestaw(nad = {}, { zProforma = true } = {}) {
    const db = openOmsDb(':memory:');
    const katalog = join(mkdtempSync(join(tmpdir(), 'oms-api-proformy-')), 'proformy');
    const configProforma = {
      ...config,
      nadawca: NADAWCA,
      proforma: {
        nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Millennium', katalog,
      },
    };
    // ⚠️ DWA ZAMOWIENIA-ATRAPY PRZED TYM WLASCIWYM — I TO NIE JEST BALAST DO SPRZATNIECIA.
    // Bez nich zamowienie dostaje `id = 1` i pierwsza proforma TEZ dostaje `id = 1`, wiec
    // zaden test nie odroznilby odpowiedzi niosacej identyfikator DOKUMENTU od odpowiedzi
    // niosacej identyfikator ZAMOWIENIA. Mutacja `{ id: p.id }` → `{ id }` przechodzila przez
    // cala suite na zielono, a panel sklada z tej wartosci adres pobrania PDF-u: pomylka
    // oznacza zalacznik z CUDZEGO dokumentu albo 404 w mailu do klienta.
    zapiszZamowienie(db, 'szkicownia', zeSklepu({ zrodlo_id: 4001, numer: '28001' }), {});
    zapiszZamowienie(db, 'szkicownia', zeSklepu({ zrodlo_id: 4002, numer: '28002' }), {});
    const id = zapiszZamowienie(db, 'szkicownia', zeSklepu(nad), {});
    const proforma = zProforma ? createProforma({ db, config: configProforma, teraz: ZEGAR }) : null;
    const app = buildOmsServer({ db, config: configProforma, proforma });
    await app.ready();
    return {
      db, id, app, proforma,
    };
  }

  const wystaw = (app, id) => app.inject({
    method: 'POST', url: `/api/zamowienia/${id}/proforma`, headers: naglowkiPost,
  });

  // ⚠️ ODPOWIEDZ MA BYC SAMOWYSTARCZALNA: panel dostaje numer dokumentu (idzie do tresci
  // maila) i ADRES DO BAJTOW (idzie do zalacznika). Sklejanie adresu po stronie panelu
  // z identyfikatora oznaczaloby dwa miejsca wiedzace, jak wyglada ta trasa.
  it('POST oddaje {id, numer, pdfUrl}, a pdfUrl naprawde oddaje ten dokument', async () => {
    const { app, id, db } = await zestaw();
    const res = await wystaw(app, id);
    expect(res.statusCode).toBe(201);

    const { id: proformaId, numer, pdfUrl } = res.json();
    expect(numer).toBe('PF/1/08/2026');
    expect(proformyZamowienia(db, id)).toHaveLength(1);
    // ⚠️ `id` W ODPOWIEDZI TO IDENTYFIKATOR DOKUMENTU, NIE ZAMOWIENIA — cala odpowiedz opisuje
    // proforme, ktora wlasnie powstala, a `pdfUrl` sklada sie wlasnie z niego. Asercja
    // „rozne od id zamowienia" jest tu obowiazkowa: fixture celowo rozjezdza obie numeracje
    // (patrz atrapy w `zestaw`), bo przy `id = 1` po obu stronach pomylka jest niewidoczna.
    expect(proformaId).not.toBe(id);
    expect(proformyZamowienia(db, id)[0].id).toBe(proformaId);
    expect(pdfUrl).toBe(`/api/proformy/${proformaId}/pdf`);

    const pdf = await app.inject({ method: 'GET', url: pdfUrl, headers: naglowkiGet });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  // ⚠️ BEZ `Content-Disposition: attachment` — TO JEST CALA ROZNICA WOBEC TRASY
  // PRZEGLADARKOWEJ. Panel bierze bajty i wklada je do maila jako wlasny zalacznik;
  // `attachment` jest instrukcja dla przegladarki i tutaj niczego nie zalatwia, a przy
  // podgladzie w panelu wymuszalby pobranie pliku zamiast pokazania go.
  it('GET /api/proformy/:id/pdf NIE nakleja naglowka attachment', async () => {
    const { app, id, proforma } = await zestaw();
    const p = proforma.wystaw(id);
    const res = await app.inject({ method: 'GET', url: `/api/proformy/${p.id}/pdf`, headers: naglowkiGet });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  // Odmowa z `czyWolnoWystawic` ma DOJSC NA ZEWNATRZ w calosci — panel wpisuje ja do logu
  // karty i to jedyna rzecz, z ktorej czlowiek dowie sie, czemu dokument nie powstal.
  it('odmowa operatorska wraca jako 400 z czytelnym powodem, nie jako 500', async () => {
    const { app, id, db } = await zestaw({ anulowane: 1 });
    const res = await wystaw(app, id);
    expect(res.statusCode).toBe(400);
    expect(res.json().powod).toMatch(/anulowane/i);
    // Zaden numer z serii nie zostal zuzyty — odmowa liczy sie PRZED nadaniem numeru.
    expect(proformyZamowienia(db, id)).toHaveLength(0);
  });

  it('POST do nieistniejacego zamowienia — 404', async () => {
    const { app } = await zestaw();
    const res = await wystaw(app, 999999);
    expect(res.statusCode).toBe(404);
    expect(res.json().powod).toMatch(/nie ma takiego zamówienia/i);
  });

  it('GET nieistniejacej proformy — 404 z czytelnym powodem', async () => {
    const { app } = await zestaw();
    const res = await app.inject({ method: 'GET', url: '/api/proformy/999999/pdf', headers: naglowkiGet });
    expect(res.statusCode).toBe(404);
    expect(res.json().powod).toMatch(/nie ma takiej proformy/i);
  });

  // ⚠️ PANEL BEZ SEKCJI OMS_PROFORMY_* to tryb POPRAWNY, a nie awaria — trasa ma powiedziec
  // wprost, ze nie ma czym wystawic, zamiast udawac, ze wystawila. Ta sama odpowiedz, co
  // dzis na trasie przegladarkowej.
  it('gdy proformy nie sa skonfigurowane — 503 na obu trasach', async () => {
    const { app, id } = await zestaw({}, { zProforma: false });
    const post = await wystaw(app, id);
    expect(post.statusCode).toBe(503);
    expect(post.json().powod).toMatch(/proform/i);

    const get = await app.inject({ method: 'GET', url: '/api/proformy/1/pdf', headers: naglowkiGet });
    expect(get.statusCode).toBe(503);
    expect(get.json().powod).toMatch(/proform/i);
  });

  // ⚠️ OCHRONA CSRF JEST GLOBALNA (security/csrf.js), ale plan wymaga TESTU, nie zalozenia —
  // ta sama zasada, co przy trasach przegladarkowych w tests/oms/proforma.test.js.
  // Wystawienie proformy zuzywa numer z serii, wiec jest dokladnie tym rodzajem skutku,
  // przed ktorym ta ochrona stoi.
  it('POST bez naglowka Origin odbija sie od ochrony CSRF', async () => {
    const { app, id, db } = await zestaw();
    const res = await app.inject({
      method: 'POST', url: `/api/zamowienia/${id}/proforma`, headers: naglowkiGet,
    });
    expect(res.statusCode).toBe(403);
    expect(proformyZamowienia(db, id)).toHaveLength(0);
  });

  it('POST z obcego zrodla odbija sie od ochrony CSRF', async () => {
    const { app, id, db } = await zestaw();
    const res = await app.inject({
      method: 'POST',
      url: `/api/zamowienia/${id}/proforma`,
      headers: { ...naglowkiGet, origin: 'https://obcy.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(proformyZamowienia(db, id)).toHaveLength(0);
  });

  // ⚠️⚠️ TRASY PRZEGLADARKOWE ZOSTAJA NIETKNIETE — to jest warunek z planu, a nie ozdobnik.
  // Nowe trasy /api/* sa DODATKIEM: karta OMS-u dalej wystawia proforme przyciskiem
  // w formularzu (302 z powrotem na ekran) i dalej pobiera plik jako zalacznik. Gdyby ktos
  // „ujednolicil" stare trasy do ksztaltu API, przycisk na karcie zostawilby operatora
  // z golym JSON-em zamiast wrocic na zamowienie.
  it('stare trasy przegladarkowe dzialaja bez zmian obok nowych', async () => {
    const { app, id, db } = await zestaw();

    const post = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/proforma`, headers: naglowkiPost,
    });
    expect(post.statusCode).toBe(302);
    expect(post.headers.location).toBe(`/zamowienia/${id}`);

    // Identyfikator dokumentu czytamy Z BAZY, a nie wpisujemy „1" — numeracja proform
    // i zamowien to dwie niezalezne serie (patrz atrapy w `zestaw`).
    const [wystawiona] = proformyZamowienia(db, id);
    const pdf = await app.inject({ method: 'GET', url: `/proformy/${wystawiona.id}/pdf`, headers: naglowkiGet });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toContain('attachment');
    expect(pdf.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});

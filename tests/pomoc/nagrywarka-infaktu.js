// PRZ-118.01 — nagrywarka żądań do inFaktu: podstawiany `globalThis.fetch`, który
//  (1) zapisuje KAŻDE żądanie do api.infakt.pl w postaci porównywalnej (metoda, ścieżka z posortowanym
//      zapytaniem, nagłówki bez klucza API, ciało JSON z posortowanymi kluczami),
//  (2) odpowiada encjami z atrapy piaskownicy (deploy/proba/atrapy/infakt.mjs — te same kształty, co
//      prawdziwe API; pilnuje tego tests/instalacja/atrapy-kontrakt.test.js), trzymanej we WŁASNEJ bazie,
//  (3) nie wypuszcza niczego do sieci: VIES dostaje odpowiedź „numer ważny”, każdy inny adres — odmowę.
//
// Nagrywarka siedzi na granicy procesu (fetch), więc nie wie nic o usługach OMS-u: zmiana 02–09 PRZ-118 może
// przebudować wszystko między trasą a klientem inFaktu, a zapis ma zostać ten sam.
//
// Determinizm:
//  • identyfikatory dokumentów atrapa losuje (`randomUUID`, nie da się wstrzyknąć) — nagrywarka nadaje im
//    nazwy U1, U2… w kolejności POWSTANIA dokumentu w atrapie (wystawienia są sekwencyjne, więc kolejność jest
//    stała), a nie pierwszego wystąpienia w żądaniu: dwa równoległe PDF-y nie mogą zamienić się numerami;
//    UUID nieznany atrapie (np. wymyślony przez OMS) dostaje X1, X2… w kolejności pierwszego wystąpienia;
//  • żądania RÓWNOLEGŁE (wysłane, zanim poprzednie dostało odpowiedź — np. lista faktur i lista nieopłaconych
//    na zakładce FAKTURY) tworzą partię, którą zapis porządkuje alfabetycznie: kolejność startu równoległych
//    obietnic to szczegół implementacji, a nie kontrakt z inFaktem. Odpowiedź przychodzi po `setTimeout`,
//    więc wszystko, co wołający odpala w jednym takcie, na pewno się nakłada. Żądania sekwencyjne (VIES →
//    nabywca → seria WDT → wystawienie) zostają w kolejności — to JEST kontrakt;
//  • daty: stały zegar ustawia test (vi.useFakeTimers({ toFake: ['Date'] })), atrapa liczy z tego samego.
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createAtrapaInfaktu } from '../../deploy/proba/atrapy/infakt.mjs';

const HOST_INFAKTU = 'api.infakt.pl';
const HOST_VIES = 'ec.europa.eu';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STRONA = 10;

/** Klucze obiektów posortowane rekurencyjnie — kolejność pól w JSON-ie nie jest treścią żądania. */
export function posortowane(w) {
  if (Array.isArray(w)) return w.map(posortowane);
  if (w && typeof w === 'object') {
    return Object.fromEntries(Object.keys(w).sort().map((k) => [k, posortowane(w[k])]));
  }
  return w;
}

/** Ścieżka z zapytaniem, pary `klucz=wartość` posortowane BEZ przekodowania (bajty zostają jak wysłane). */
function sciezkaZPosortowanymZapytaniem(url) {
  const [bezZapytania, ...reszta] = url.split('?');
  const sciezka = new URL(bezZapytania).pathname;
  const zapytanie = reszta.join('?');
  return zapytanie ? `${sciezka}?${zapytanie.split('&').filter(Boolean).sort().join('&')}` : sciezka;
}

function cialoZapisu(body) {
  if (body === undefined || body === null) return null;
  const tekst = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  try { return posortowane(JSON.parse(tekst)); } catch { return { nieJson: tekst }; }
}

function odpowiedzJson(status, dane) {
  return new Response(JSON.stringify(dane ?? null), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * @param {{ teraz: () => Date, kluczApi: string }} o
 */
export function createNagrywarkaInfaktu({ teraz, kluczApi }) {
  const dbAtrapy = openOmsDb(':memory:');
  const atrapa = createAtrapaInfaktu({ db: dbAtrapy, teraz, log: () => {}, env: { OMS_TRYB: 'proba' } });

  const zapis = [];        // { scenariusz, partia, metoda, sciezka, naglowki, cialo }
  const obce = [];         // żądania spoza inFaktu: { host, metoda, sciezka }
  const bledneKlucze = []; // żądania do inFaktu bez klucza testowego w X-inFakt-ApiKey
  let scenariusz = null;
  let wLocie = 0;
  let partia = 0;

  // U1, U2… w kolejności powstania dokumentu w atrapie (kolumna `kolejnosc`).
  const nazwyUuid = new Map();
  const nazwyObce = new Map();
  const odswiezNazwy = () => {
    for (const { uuid } of dbAtrapy.prepare('SELECT uuid FROM atrapa_infakt_dokumenty ORDER BY kolejnosc').all()) {
      if (!nazwyUuid.has(uuid)) nazwyUuid.set(uuid, `U${nazwyUuid.size + 1}`);
    }
  };

  async function lista(zasob, u) {
    const p = u.searchParams;
    const filtry = {};
    let pole; let od; let doDaty;
    for (const [k, v] of p) {
      const m = /^q\[(\w+?)_(gteq|lteq)\]$/.exec(k);
      if (m) { pole = m[1]; if (m[2] === 'gteq') od = v; else doDaty = v; } else if (k.startsWith('q[')) filtry[k] = v;
    }
    if (filtry['q[number_eq]'] !== undefined) {
      const ile = await atrapa.iluMaNumer(filtry['q[number_eq]']);
      return odpowiedzJson(200, { metainfo: { count: 0, total_count: ile }, entities: [] });
    }
    const zakres = { od, do: doDaty, pole, order: p.get('order') ?? undefined, filtry };
    const wiersze = (zasob === 'invoices' ? await atrapa.listaFaktur(zakres) : await atrapa.listaKorekt(zakres))
      .map(({ rodzaj, ...encja }) => encja);
    const offset = Number(p.get('offset') ?? 0);
    const strona = wiersze.slice(offset, offset + STRONA);
    return odpowiedzJson(200, { metainfo: { count: strona.length, total_count: wiersze.length }, entities: strona });
  }

  /** Router „inFaktu”: ścieżka API → metoda atrapy → surowa odpowiedź jak z prawdziwego API. */
  async function obsluz(metoda, u, cialo) {
    const s = u.pathname.replace(/^\/api/, '');
    let m;
    if (metoda === 'GET' && (m = /^\/v3\/(invoices|corrective_invoices)\.json$/.exec(s))) return lista(m[1], u);
    if (metoda === 'GET' && s === '/v3/clients.json') {
      const id = await atrapa.znajdzKlientaPoNip(u.searchParams.get('q[nip_eq]'));
      return odpowiedzJson(200, { metainfo: { count: id ? 1 : 0, total_count: id ? 1 : 0 }, entities: id ? [{ id }] : [] });
    }
    if (metoda === 'POST' && s === '/v3/clients.json') return odpowiedzJson(201, { id: await atrapa.zalozKlienta(cialo?.client) });
    if (metoda === 'POST' && s === '/v3/invoices.json') {
      const w = await atrapa.wystaw(cialo?.invoice);
      return odpowiedzJson(201, atrapa.surowaEncja(w.uuid));
    }
    if (metoda === 'POST' && s === '/v3/async/corrective_invoices.json') {
      const w = await atrapa.wystawKorekte(cialo ?? {});
      return odpowiedzJson(201, { invoice_task_reference_number: w.referencja, processing_code: 100 });
    }
    if (metoda === 'GET' && (m = /^\/v3\/(invoices|corrective_invoices)\/([^/]+)\/pdf\.json$/.exec(s))) {
      const uuid = decodeURIComponent(m[2]);
      const typ = u.searchParams.get('document_type') ?? undefined;
      const bajty = m[1] === 'invoices' ? await atrapa.pobierzPdf(uuid, typ) : await atrapa.pobierzPdfKorekty(uuid, typ);
      return new Response(bajty, { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    if (metoda === 'POST' && (m = /^\/v3\/async\/invoices\/([^/]+)\/paid\.json$/.exec(s))) {
      const w = await atrapa.oznaczZaplacona(decodeURIComponent(m[1]), { paidDate: cialo?.paid_date });
      return odpowiedzJson(201, { invoice_task_reference_number: w.referencja, processing_code: 100 });
    }
    if (metoda === 'GET' && (m = /^\/v3\/invoices\/([^/]+)\.json$/.exec(s))) {
      const encja = atrapa.surowaEncja(decodeURIComponent(m[1]));
      if (!encja || encja.kind !== 'vat') return odpowiedzJson(404, { error: 'Zasób którego szukasz nie został znaleziony' });
      return odpowiedzJson(200, encja);
    }
    if (metoda === 'POST' && (m = /^\/v3\/ksef2\/documents\/([^/]+)\/send\.json$/.exec(s))) {
      const w = await atrapa.wyslijDokumentDoKsef(decodeURIComponent(m[1]));
      return odpowiedzJson(200, w.odpowiedzInfaktu);
    }
    return odpowiedzJson(404, { error: `nagrywarka: nieznany zasób ${metoda} ${s}` });
  }

  async function fetchNagrywarki(wejscie, init = {}) {
    const url = typeof wejscie === 'string' ? wejscie : wejscie instanceof URL ? wejscie.href : String(wejscie?.url ?? wejscie);
    const u = new URL(url);
    const metoda = String(init.method ?? 'GET').toUpperCase();
    if (u.hostname === HOST_VIES) {
      obce.push({ host: u.hostname, metoda, sciezka: u.pathname });
      return odpowiedzJson(200, { isValid: true, requestDate: teraz().toISOString().slice(0, 10),
        requestIdentifier: 'VIES-NAGRYWARKA', name: 'Kontrahent zmyślony (nagrywarka)', address: 'Erfundene Straße 1' });
    }
    if (u.hostname !== HOST_INFAKTU) {
      obce.push({ host: u.hostname, metoda, sciezka: u.pathname });
      throw new TypeError('fetch failed (nagrywarka inFaktu: sieć zabroniona w teście)');
    }
    const naglowki = {};
    let klucz = null;
    for (const [k, v] of new Headers(init.headers ?? {})) {
      if (k === 'x-infakt-apikey') klucz = v; else naglowki[k] = v;
    }
    if (klucz !== kluczApi) bledneKlucze.push(`${metoda} ${u.pathname}`);
    const cialo = cialoZapisu(init.body);
    if (wLocie === 0) partia += 1;
    zapis.push({ scenariusz, partia, metoda, sciezka: sciezkaZPosortowanymZapytaniem(url), naglowki: posortowane(naglowki), cialo });
    wLocie += 1;
    try {
      let odp;
      try { odp = await obsluz(metoda, u, cialo && !cialo.nieJson ? cialo : null); } catch (e) {
        odp = odpowiedzJson(Number.isInteger(e?.status) ? e.status : 500, { error: e?.message ?? String(e) });
      }
      odswiezNazwy();
      // Odpowiedź dopiero w następnym takcie zegara: żądania odpalone razem na pewno się nakładają (patrz nagłówek).
      await new Promise((r) => { setTimeout(r, 2); });
      return odp;
    } finally {
      wLocie -= 1;
    }
  }

  const nazwij = (tekst) => tekst.replace(UUID, (uuid) => {
    const klucz = uuid.toLowerCase();
    if (nazwyUuid.has(klucz)) return nazwyUuid.get(klucz);
    if (!nazwyObce.has(klucz)) nazwyObce.set(klucz, `X${nazwyObce.size + 1}`);
    return nazwyObce.get(klucz);
  });
  const nazwijGleboko = (w) => {
    if (typeof w === 'string') return nazwij(w);
    if (Array.isArray(w)) return w.map(nazwijGleboko);
    if (w && typeof w === 'object') return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, nazwijGleboko(v)]));
    return w;
  };

  /** Zapis do porównania: { scenariusz: [żądanie, …] } w kolejności scenariuszy; partie równoległe posortowane. */
  function wynik() {
    odswiezNazwy();
    const poScenariuszach = {};
    const partie = new Map();
    for (const z of zapis) {
      const { scenariusz: nazwa, partia: nr, ...zadanie } = z;
      const gotowe = nazwijGleboko(zadanie);
      if (!partie.has(nr)) partie.set(nr, { nazwa, zadania: [] });
      partie.get(nr).zadania.push(gotowe);
    }
    for (const { nazwa, zadania } of partie.values()) {
      const klucz = nazwa ?? '(poza scenariuszem)';
      poScenariuszach[klucz] ??= [];
      const posort = zadania.map((z) => [JSON.stringify(z), z]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, z]) => z);
      poScenariuszach[klucz].push(...posort);
    }
    return poScenariuszach;
  }

  return {
    fetch: fetchNagrywarki,
    atrapa,
    scenariusz: (nazwa) => { scenariusz = nazwa; },
    wynik,
    obce,
    bledneKlucze,
    zamknij: () => dbAtrapy.close(),
  };
}

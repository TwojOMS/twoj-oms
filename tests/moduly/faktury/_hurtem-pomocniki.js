// Pomocniki wspólne dla testów faktur hurtem: tras (faktury-hurtem-trasy.test.js) i widoków
// (faktury-hurtem-widok.test.js). Wyniesione tu, żeby obie kopie budowania serwera testowego
// nie rozjechały się przy pierwszej zmianie kształtu wstrzykiwanych usług — druga kopia
// zaczęłaby testować nieistniejący panel.
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';

export const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
// ⚠️ `origin` jest konieczny przy POST — bez niego ochrona CSRF slusznie odbija zadanie
// (ta sama para naglowkow, co w pozostalych testach tras).
export const POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };

// Adres sprzedawcy uzywany domyslnie przez `serwer()` (Zadanie 8, specyfikacja zamowienia).
// TE SAME wartosci, co w tests/oms/proforma.test.js (NADAWCA) i w domyslnym BDO z config.js
// (OMS_SPRZEDAWCA_BDO) — zeby testy tras hurtu mogly sprawdzic, ze sklad sprzedawcy
// (config.nadawca + config.proforma.nip/bdo) naprawde dociera na dokument PRZEZ TRASE, a nie
// tylko w teście jednostkowym domain/specyfikacja.test.js z ręcznie podanym `sprzedawca`.
export const NADAWCA = {
  nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
};
// ⚠️ CELOWO INNY NIP NIZ NABYWCY (`zamowienie()` nizej wpisuje kazdemu zamowieniu NIP
// '1234563218'). Gdyby oba byly rowne, test sprawdzajacy „NIP sprzedawcy trafil na dokument"
// przechodzilby TAKZE wtedy, gdyby trasa pomylila sprzedawce z nabywca — a to jest dokladnie
// pomylka, ktorej ten test ma dowodzic, ze NIE ma.
export const NIP = '1112223344';
export const BDO = '000123456';

/**
 * Zamowienie z pelnym pokryciem wplat (`oplacone`) albo bez zadnej (`nieoplacone`).
 *
 * `pozycje` jest opcjonalne (domyslnie brak) — dopisane na potrzeby Zadania 8: test PDF-a
 * musi dotknac PRAWDZIWEJ zawartosci dokumentu (nazwa/symbol pozycji), nie tylko naglowka
 * odpowiedzi, a bez tego parametru kazde zamowienie z tej fabryki bylo puste w srodku.
 *
 * `utworzoneAt` jest opcjonalne — bez niego kolejne wywolania w tej samej milisekundzie
 * dostalyby TEN SAM znacznik czasu, a `listaZamowien()` sortuje po nim (`ORDER BY
 * utworzone_at DESC): test kolejnosci stron w PDF-ie hurtem musi miec czym rozroznic
 * zamowienia, wiec podaje ten parametr wprost, zamiast liczyc na zegar.
 */
// ⚠️ DOMYSLNA POZYCJA SUMUJACA SIE DO `kwota_brutto` — od 12.08.2026 (recenzja). Do tego
// dnia domyslne bylo `pozycje: []` przy kwocie '100.00', czyli zamowienie ARYTMETYCZNIE
// NIEMOZLIWE: `sprawdzSumeDokumentu` odmowilaby mu faktury zawsze. Wszystkie testy tras
// hurtu chodzily po takich wierszach — a odkad podglad ma wlasna bariere arytmetyczna
// (domain/masowe.js, `powodRozjazduDokumentu`), taki fixture w ogole nie kwalifikuje sie do
// wystawienia i testy „podglad obiecuje to, co dostaje usluga" testowalyby pusta liste.
export const POZYCJA_100 = {
  nazwa: 'STOP 70x100', sku: 'STOP-70', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null,
};

export function zamowienie(db, {
  numer, zrodlo, oplacone, pozycje = [POZYCJA_100], utworzoneAt = undefined,
}) {
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: zrodlo, numer, klient: { first_name: 'Jan' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1234563218',
    kwota_brutto: '100.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje, utworzone_at: utworzoneAt,
  }, {});
  if (oplacone) dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-08-05' });
  return id;
}

export function serwer({
  wystawWiele = async () => ({ wystawione: [], bledy: [], nietkniete: [] }),
  fakturaHurtem = { wystawWiele },
  config: nadpisaniaConfig = {},
} = {}) {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({
    db,
    config: {
      auth: { user: 't', pass: 'h' }, nadawca: NADAWCA, proforma: { nip: NIP, bdo: BDO }, ...nadpisaniaConfig,
    },
    fakturaHurtem,
  });
  return { app, db };
}

export const cialo = (ids) => ids.map((id) => `id=${id}`).join('&');

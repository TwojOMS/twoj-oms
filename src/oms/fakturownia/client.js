import { transport } from '../../integracje/transport.js';
import { bladOperatora } from '../../domena/bledy.js';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../domena/faktura-stan.js';

// PRZ-119.02 — klient HTTP Fakturowni: sam transport, bez mapowania pól (to adapter
// integracje/programy/fakturownia.ts) i bez decyzji biznesowych (duplikat `oid`, walidacja —
// klient oddaje status i zamaskowaną treść, rozstrzyga adapter). Kształty odpowiedzi
// zmierzone na koncie próbnym 12.11.2026 (docs/plany/PRZ-119-pomiary.md, fixture F1–F17).
//
// ⚠️⚠️ WYSTAWIENIE FAKTURY NIGDY JEJ NIE WYSYŁA DO KSeF — tak samo jak w inFakcie
// (src/oms/infakt/client.js, komentarz na górze): wystawienie i wysyłka to dwie osobne decyzje
// człowieka. W Fakturowni wysyłka to `GET /invoices/{id}.json?send_to_ksef=yes` i mieszka
// WYŁĄCZNIE w `wyslijDokumentDoKsef` na końcu tego pliku. Każde inne żądanie przechodzi przez
// strażnika w `zapytaj`: w adresie nie ma `send_to_ksef` ani `api_token`, a w treści żadnego
// z tych kluczy ani żadnego klucza `gov_*` (pola KSeF Fakturowni są tylko do odczytu; tak
// odpada też parametr wystawienia z wysyłką, którego nazwy nie ma w src/ — strażnik PRZ-118).

// Twardy limit JEDNEGO żądania — ten sam powód co w inFakcie: „rezerwacja starsza od progu”
// musi znaczyć „nic nie leci”, więc żywe wywołanie nie może dociągnąć do progu zawieszonej faktury.
export const LIMIT_ZADANIA_MS = 60 * 1000;

// Zmierzone (F07): lista to GOŁA TABLICA, bez licznika całości — także w nagłówkach. Jedyny
// znak końca to strona krótsza niż `per_page` (strona za ostatnią = `[]`). Fakturownia
// przyjmuje `per_page=100`.
export const STRONA_FAKTUROWNI = 100;

// ⚠️ SUFIT: 6 stron = 600 dokumentów (ten sam rząd co inFakt). Po przekroczeniu ODMAWIAMY —
// cicha część wyniku wygląda dokładnie tak samo jak komplet.
export const SUFIT_STRON = 6;

// Strony idą SEKWENCYJNIE (F08: 30 żądań bez 429, ale bez nagłówków limitu nie ma czego
// zrównoleglać). Najdłuższa lista = sufit + jedna strona kontrolna za sufitem, każda z własnym limitem.
export const NAJDLUZSZA_LISTA_MS = (SUFIT_STRON + 1) * LIMIT_ZADANIA_MS;

if (LIMIT_ZADANIA_MS >= PROG_ZAWIESZONEJ_FAKTURY_MS) {
  throw new Error(
    'Limit żądania do Fakturowni musi być krótszy od progu zawieszonej faktury — inaczej '
    + '„zawieszona” może oznaczać żywe wywołanie, a odblokowanie da drugą fakturę w Fakturowni.',
  );
}

// Domena konta = poddomena `https://<domena>.fakturownia.pl`. Wszystko spoza tego wzoru
// (kropka, ukośnik, `@`) mogłoby skierować token Bearer na cudzy host.
const DOMENA_KONTA = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID_DOKUMENTU = /^[1-9]\d{0,17}$/;

// Adresy odczytu składane WYŁĄCZNIE z tych parametrów. Zmierzone (F16 #5): Fakturownia
// przemilcza nieznany filtr i oddaje listę bez niego — literówka w nazwie filtra rozszerzyłaby
// zapytanie po cichu, więc nieznany klucz to odmowa przed siecią. `page` i `per_page` ustawia klient.
const PARAMETRY_LISTY = new Set([
  'period', 'date_from', 'date_to', 'search_date_type', 'kind', 'kinds[]', 'number', 'oid',
  'include_positions', 'fields[invoice]',
]);
const PARAMETRY_DOKUMENTU = new Set(['fields[invoice]', 'correction_positions']);

const ZAKAZANE_W_ADRESIE = /send_to_ksef|api_token/i;
const ZAKAZANY_KLUCZ = /^(send_to_ksef|api_token|gov_.*)$/i;

function zakazanyKlucz(wartosc, glebokosc = 0) {
  if (!wartosc || typeof wartosc !== 'object' || glebokosc > 8) return null;
  for (const [klucz, w] of Object.entries(wartosc)) {
    if (ZAKAZANY_KLUCZ.test(klucz)) return klucz;
    const glebiej = zakazanyKlucz(w, glebokosc + 1);
    if (glebiej) return glebiej;
  }
  return null;
}

// Format błędu Fakturowni (F02, F10, F11): `message` to napis (401: z adresem konta!) albo
// mapa pole → komunikaty (422: `{"oid":["- zostało już zajęte"]}`); 404 ma `error: "Not Found"`.
// Komunikat pola bez nazwy pola („- zostało już zajęte”) nic nie mówi — łączymy oba.
function powod(dane, status) {
  const m = dane?.message;
  if (m && typeof m === 'object') {
    const tresci = Object.entries(m).flatMap(([pole, w]) => [].concat(w).filter(Boolean).map((t) => `${pole} ${t}`));
    if (tresci.length) return tresci.join('; ');
  }
  if (typeof m === 'string' && m) return m;
  if (typeof dane?.error === 'string' && dane.error) return dane.error;
  return `bez szczegółów (HTTP ${status})`;
}

const odmowaPrzedSiecia = (komunikat) => bladOperatora(komunikat, { status: 400 });

function idDokumentu(id) {
  const czysty = String(id ?? '').trim();
  // `status: 400` celowo, choć nic nie poszło: do Fakturowni nie dotarło NIC, więc odmowa jest
  // jednoznaczna (reguła zwolnienia rezerwacji rozpoznaje jednoznaczność po 4xx — jak w inFakcie).
  if (!ID_DOKUMENTU.test(czysty)) throw odmowaPrzedSiecia('Nieprawidłowy identyfikator dokumentu Fakturowni.');
  return czysty;
}

function zapytanie(parametry, dozwolone) {
  const p = new URLSearchParams();
  for (const [klucz, wartosc] of Object.entries(parametry ?? {})) {
    if (!dozwolone.has(klucz)) {
      throw odmowaPrzedSiecia(`Panel nie wysyła do Fakturowni parametru „${klucz}” — nieznany filtr Fakturownia przemilcza.`);
    }
    if (wartosc == null) continue;
    for (const w of [].concat(wartosc)) p.append(klucz, String(w));
  }
  return p;
}

const zPytajnikiem = (p) => (String(p) ? `?${p}` : '');

/** Data kalendarzowa RRRR-MM-DD, która istnieje (bez 2026-13-01 i 2026-02-30). */
function poprawnaData(wartosc) {
  if (typeof wartosc !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(wartosc)) return false;
  const d = new Date(`${wartosc}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === wartosc;
}

/**
 * Klient Fakturowni. `token` idzie WYŁĄCZNIE w nagłówku `Authorization: Bearer` (F03: działa dla
 * invoices.json, {id}.pdf i clients.json) — nigdy jako `api_token` w adresie, bo adres trafia do logów.
 *
 * ⚠️ Transport składa WYŁĄCZNIE ten klient (`transport({ fetchImpl })`: surowy fetch albo `utworzHttp`
 * z `ponowien: 0`). Parametru `http` celowo nie ma i jego podanie to błąd budowy: `wyslijDokumentDoKsef`
 * to GET ze skutkiem ubocznym, a `utworzHttp` z domyślnym `ponowien = 2` ponawia GET przy 429/5xx
 * i limicie czasu — wysłałby dokument do KSeF do trzech razy. `fetchImpl` ma być zwykłym fetch
 * (np. atrapą albo transportem próby), nie owiniętym w ponawianie.
 * @param {{ token: string, domena: string, fetchImpl?: typeof fetch, http?: unknown }} opcje
 */
export function createFakturowniaClient({ token, domena, fetchImpl, http }) {
  if (http !== undefined) {
    throw new Error('Klient Fakturowni nie przyjmuje własnego `http` (ponowienie powtórzyłoby wysyłkę do KSeF) — podaj `fetchImpl`.');
  }
  const wyslijHttp = transport({ fetchImpl, limitCzasuMs: LIMIT_ZADANIA_MS });
  if (!DOMENA_KONTA.test(String(domena ?? ''))) {
    throw new Error('Nieprawidłowa domena konta Fakturowni — tylko małe litery, cyfry i myślnik (część przed .fakturownia.pl).');
  }
  const tokenApi = String(token ?? '');
  if (!tokenApi.trim()) throw new Error('Brak tokenu API Fakturowni.');
  const host = `${domena}.fakturownia.pl`;
  const baseUrl = `https://${host}`;

  // Token w każdej postaci, w jakiej serwer albo pośrednik mógłby go odbić: surowej, zakodowanej
  // w adresie (token Fakturowni ma `/` → `%2F`) i zakodowanej małymi literami. Krótki token nie
  // może zamazać zwykłych słów (jak w inFakcie). Potem adres konta: 401 Fakturowni go niesie (F02).
  const formyTokenu = tokenApi.length >= 8
    ? [...new Set([tokenApi, encodeURIComponent(tokenApi),
      encodeURIComponent(tokenApi).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())])]
    : [];
  const hostWzor = new RegExp(host.replace(/[.-]/g, '\\$&'), 'gi');
  const bezSekretow = (tekst) => {
    let wynik = String(tekst);
    for (const forma of formyTokenu) wynik = wynik.split(forma).join('[token]');
    return wynik.replace(hostWzor, '[konto Fakturowni]');
  };

  // Kopia błędu z zamaskowanym każdym napisem (komunikat, stos, treść odpowiedzi) — wzór
  // `bezpiecznyBlad` z klienta inFaktu, bez surowego `cause`.
  function bezpiecznyBlad(blad, glebokosc = 0, odwiedzone = new WeakMap()) {
    if (typeof blad === 'string') return bezSekretow(blad);
    if (!blad || typeof blad !== 'object') return blad;
    if (odwiedzone.has(blad)) return odwiedzone.get(blad);
    if (glebokosc >= 8) return '[pominięto dalsze szczegóły błędu]';
    const wymagaZwyklegoBledu = blad instanceof DOMException
      || (!Object.hasOwn(blad, 'message') && typeof blad.message === 'string');
    const kopia = wymagaZwyklegoBledu ? new Error(bezSekretow(blad.message))
      : Array.isArray(blad) ? [] : Object.create(Object.getPrototypeOf(blad));
    odwiedzone.set(blad, kopia);
    const nazwy = Reflect.ownKeys(blad);
    if (wymagaZwyklegoBledu) {
      for (const nazwa of ['name', 'code', 'stack']) {
        if (nazwa in blad && !nazwy.includes(nazwa)) nazwy.push(nazwa);
      }
    }
    for (const nazwa of nazwy) {
      if (nazwa === 'cause') continue;
      const opis = Object.getOwnPropertyDescriptor(blad, nazwa);
      let wartosc;
      try { wartosc = blad[nazwa]; }
      catch { wartosc = '[pominięto nieczytelne szczegóły błędu]'; }
      Object.defineProperty(kopia, nazwa, {
        enumerable: opis?.enumerable ?? false, configurable: opis?.configurable ?? true, writable: true,
        value: bezpiecznyBlad(wartosc, glebokosc + 1, odwiedzone),
      });
    }
    return kopia;
  }

  /**
   * Jedno żądanie. Błędy są otagowane dla operatora (`bladOperatora`) i niosą `status` — usługa
   * po nim odróżnia odmowę jednoznaczną (4xx) od niejednoznacznej (brak statusu: zerwane
   * połączenie albo limit czasu — żądanie mogło dojść). `tresc` = odpowiedź Fakturowni (maskowana
   * na wyjściu z klienta), żeby adapter rozpoznał np. duplikat `oid` bez parsowania komunikatu.
   */
  async function zapytaj(sciezka, { method, body, accept = 'application/json', bajty = false, doKsef = false }, coRobimy) {
    // ⚠️ STRAŻNIK ADRESÓW — patrz komentarz na górze pliku.
    if (!doKsef && ZAKAZANE_W_ADRESIE.test(sciezka)) {
      throw odmowaPrzedSiecia('Ten adres Fakturowni wolno wywołać tylko przy wysyłce do KSeF.');
    }
    const klucz = zakazanyKlucz(body);
    if (klucz) {
      throw odmowaPrzedSiecia(`Treść żądania do Fakturowni niesie pole „${klucz}” — wystawienie nie wysyła do KSeF i nie zmienia pól KSeF.`);
    }
    const headers = { Accept: accept, Authorization: `Bearer ${tokenApi}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await wyslijHttp(`${baseUrl}${sciezka}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // Sygnał NARZUCONY (nie domyślny) i nowy na każde żądanie — jak w inFakcie.
        signal: AbortSignal.timeout(LIMIT_ZADANIA_MS),
      });
    } catch (e) {
      const czas = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw bladOperatora(
        `Fakturownia ${czas ? `nie odpowiedziała w ${LIMIT_ZADANIA_MS / 1000} s` : `nieosiągalna (${e?.message ?? 'błąd sieci'})`}`
        + ` przy żądaniu: ${coRobimy} — nie wiadomo, czy żądanie doszło. Sprawdź w Fakturowni, zanim spróbujesz ponownie.`,
      );
    }
    if (res.ok && bajty) return Buffer.from(await res.arrayBuffer());
    let dane = null;
    try { dane = JSON.parse(await res.text()); } catch { dane = null; }
    if (res.ok) return dane;
    const { status } = res;
    // 401 przy złym tokenie i bez tokenu (F02) — rozpoznanie po kodzie. Treść 401 niesie adres
    // konta, więc nie trafia ani do komunikatu, ani do `tresc`.
    if (status === 401 || status === 403) {
      throw bladOperatora(`Fakturownia nie przyjęła tokenu (HTTP ${status}) — sprawdź, czy token jest skopiowany `
        + 'w całości i należy do użytkownika z dostępem do faktur.', { status });
    }
    if (status === 429) {
      const naglowek = res.headers.get('Retry-After')?.trim() ?? '';
      const sekundy = /^\d+$/.test(naglowek) ? Number(naglowek) : undefined;
      throw bladOperatora(`Fakturownia ogranicza liczbę zapytań (HTTP 429) przy żądaniu: ${coRobimy}`
        + `${sekundy !== undefined ? ` — spróbuj ponownie za ${sekundy} s.` : ' — spróbuj ponownie za chwilę.'}`,
      { status, tresc: dane, ...(sekundy !== undefined ? { ponowZaS: sekundy } : {}) });
    }
    throw bladOperatora(`Fakturownia odrzuciła ${coRobimy} (HTTP ${status}): ${powod(dane, status)}`, { status, tresc: dane });
  }

  const odmowaListy = () => bladOperatora(
    'Fakturownia oddała odpowiedź, w której nie rozpoznaję strony listy — panel nie pokaże listy, '
    + 'której nie umie domknąć. Spróbuj ponownie za chwilę.',
  );

  /**
   * Wszystkie strony listy faktur. `parametry` — wyłącznie z PARAMETRY_LISTY (np. `period: 'more'`,
   * `date_from`, `date_to`, `'kinds[]': ['vat', 'wdt']`). `sufitStron` per wywołanie może sufit
   * tylko ZAWĘZIĆ. Koniec = strona krótsza niż STRONA_FAKTUROWNI; przy pełnej stronie na sufitie
   * pytamy o następną — pusta = komplet, niepusta = odmowa (601 dokumentów → odmowa, 600 → komplet).
   */
  async function listaFaktur(parametry = {}, { sufitStron = SUFIT_STRON } = {}) {
    // Zła wartość to błąd wołającego — odmowa, nie ciche przejście na pełny sufit.
    if (!Number.isSafeInteger(sufitStron) || sufitStron < 1) {
      throw odmowaPrzedSiecia('Sufit stron listy Fakturowni musi być liczbą całkowitą od 1.');
    }
    const sufit = Math.min(sufitStron, SUFIT_STRON);
    const filtry = zapytanie(parametry, PARAMETRY_LISTY);
    const wiersze = [];
    for (let strona = 1; ; strona += 1) {
      const p = new URLSearchParams(filtry);
      p.set('per_page', String(STRONA_FAKTUROWNI));
      p.set('page', String(strona));
      const dane = await zapytaj(`/invoices.json?${p}`, { method: 'GET' }, 'listę dokumentów');
      // ⚠️ Bez licznika całości jedynym sygnałem końca jest długość strony. Odpowiedź, która nie
      // jest tablicą (strona pośrednika, obiekt błędu z HTTP 200) albo jest dłuższa niż per_page
      // (Fakturownia zignorowała per_page), nie mówi nic o końcu — odmowa, nie „cichy komplet”.
      if (!Array.isArray(dane) || dane.length > STRONA_FAKTUROWNI) throw odmowaListy();
      if (strona > sufit) {
        if (dane.length) {
          throw bladOperatora(
            `Ten zakres obejmuje więcej dokumentów, niż panel pobiera (najwyżej ${sufit * STRONA_FAKTUROWNI}). `
            + 'Zawęź zakres — niepełna lista wyglądałaby tak samo jak pełna.',
          );
        }
        return wiersze;
      }
      wiersze.push(...dane);
      if (dane.length < STRONA_FAKTUROWNI) return wiersze;
    }
  }

  /** Jeden dokument (surowy obiekt). `parametry` — wyłącznie `fields[invoice]`, `correction_positions`. */
  async function pobierzFakture(id, parametry = {}) {
    const czysty = idDokumentu(id);
    const p = zapytanie(parametry, PARAMETRY_DOKUMENTU);
    return zapytaj(`/invoices/${czysty}.json${zPytajnikiem(p)}`, { method: 'GET' }, 'odczyt dokumentu');
  }

  /** PDF dokumentu jako Buffer; odpowiedź bez sygnatury `%PDF-` (np. strona logowania) → odmowa. */
  async function pobierzPdf(id) {
    const czysty = idDokumentu(id);
    const pdf = await zapytaj(`/invoices/${czysty}.pdf`, { method: 'GET', accept: 'application/pdf', bajty: true }, 'pobranie PDF');
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw bladOperatora('Fakturownia oddała plik, który nie jest PDF-em — spróbuj ponownie za chwilę.');
    }
    return pdf;
  }

  /** Ile dokumentów ma DOKŁADNIE ten numer (F16: `number` + `period=all`, jedna strona `per_page=100`); liczymy tylko równe numery. */
  async function iluMaNumer(numer) {
    const n = String(numer ?? '').trim();
    if (!n) throw odmowaPrzedSiecia('Brak numeru dokumentu do sprawdzenia.');
    const p = zapytanie({ period: 'all', number: n }, PARAMETRY_LISTY);
    p.set('per_page', String(STRONA_FAKTUROWNI));
    const dane = await zapytaj(`/invoices.json?${p}`, { method: 'GET' }, 'sprawdzenie numeru dokumentu');
    if (!Array.isArray(dane) || dane.length > STRONA_FAKTUROWNI) throw odmowaListy();
    // Pełna strona = mogą być następne; liczba z jednej strony byłaby zaniżona.
    if (dane.length === STRONA_FAKTUROWNI) {
      throw bladOperatora(`Fakturownia oddała pełną stronę dokumentów pasujących do numeru „${n}” — nie wiadomo, ile ich jest naprawdę.`);
    }
    return dane.filter((w) => w?.number === n).length;
  }

  /** Klienci kartoteki o tym NIP-ie — surowa tablica; ile ich jest i co z tym zrobić, decyduje adapter. */
  async function znajdzKlientowPoNip(nip) {
    const n = String(nip ?? '').trim();
    if (!n) return [];
    const dane = await zapytaj(`/clients.json?${new URLSearchParams({ tax_no: n })}`, { method: 'GET' }, 'wyszukanie klienta');
    if (!Array.isArray(dane)) throw odmowaListy();
    return dane;
  }

  function sprawdzInvoice(invoice) {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
      throw odmowaPrzedSiecia('Brak treści dokumentu do wystawienia w Fakturowni.');
    }
  }

  /** `POST /invoices.json {invoice}` — surowa odpowiedź (201). NIGDY nie wysyła do KSeF (strażnik w `zapytaj`). */
  async function wystaw(invoice) {
    sprawdzInvoice(invoice);
    return zapytaj('/invoices.json', { method: 'POST', body: { invoice } }, 'wystawienie faktury');
  }

  /** Korekta to ten sam zasób z `kind: 'correction'` (F15), synchronicznie — surowa odpowiedź. */
  async function wystawKorekte(invoice) {
    sprawdzInvoice(invoice);
    if (invoice.kind !== 'correction') throw odmowaPrzedSiecia('Korekta w Fakturowni wymaga rodzaju „correction”.');
    return zapytaj('/invoices.json', { method: 'POST', body: { invoice } }, 'wystawienie korekty');
  }

  /**
   * `POST /invoices/{id}/change_status.json?status=paid` (F09) — surowa odpowiedź. F09: Fakturownia
   * ustawia wtedy `paid_date` na DZIŚ, więc podana data zapłaty (`paidDate`, RRRR-MM-DD) idzie drugim
   * żądaniem `PUT /invoices/{id}.json {invoice:{paid_date}}` — pomiar F9B (12.11): HTTP 200, `paid_date` zapisana,
   * `status`/`paid` bez zmian, także data sprzed daty sprzedaży. Zła data → odmowa przed siecią. Gdy PUT padnie, faktura JEST już opłacona — błąd to mówi
   * (`zaplataOznaczona: true`), żeby nikt nie oznaczał jej drugi raz.
   */
  async function oznaczZaplacona(id, { paidDate } = {}) {
    const czysty = idDokumentu(id);
    if (paidDate !== undefined && paidDate !== null && !poprawnaData(paidDate)) {
      throw odmowaPrzedSiecia('Data zapłaty dla Fakturowni musi mieć postać RRRR-MM-DD.');
    }
    const oznaczenie = await zapytaj(`/invoices/${czysty}/change_status.json?status=paid`, { method: 'POST' }, 'oznaczenie zapłaty');
    if (paidDate === undefined || paidDate === null) return oznaczenie;
    try {
      return await zapytaj(`/invoices/${czysty}.json`, { method: 'PUT', body: { invoice: { paid_date: paidDate } } }, 'zapis daty zapłaty');
    } catch (e) {
      throw bladOperatora(`Faktura ${czysty} jest już oznaczona jako opłacona w Fakturowni, ale Fakturownia nie przyjęła `
        + `daty zapłaty ${paidDate} (${e?.message ?? 'błąd'}) — popraw datę ręcznie w Fakturowni; nie oznaczaj zapłaty ponownie.`,
      { status: e?.status, tresc: e?.tresc, zaplataOznaczona: true });
    }
  }

  /**
   * „Sprawdź połączenie”: jedno `GET /invoices.json?page=1&per_page=1` (F01) — tylko odczyt.
   * Sukces wymaga tablicy: strona pośrednika z HTTP 200 to nie „połączenie działa”.
   */
  async function sprawdzPolaczenie() {
    const dane = await zapytaj('/invoices.json?page=1&per_page=1', { method: 'GET' }, 'sprawdzenie połączenia');
    if (!Array.isArray(dane)) {
      throw bladOperatora('Fakturownia odpowiedziała, ale nie rozpoznaję odpowiedzi — to nie wygląda na API Fakturowni.');
    }
    return { ok: true };
  }

  /**
   * ⚠️⚠️ JEDYNE MIEJSCE, KTÓRE WYSYŁA DO KSeF. Wołane wyłącznie przez adapter z trasy zatwierdzenia
   * (moduly/faktury/services/wysylka-ksef.js) — strażnik PRZ-118 pilnuje, żeby nikt inny.
   *
   * Dokładnie JEDNO `GET /invoices/{id}.json?send_to_ksef=yes` — GET ze skutkiem ubocznym. Bez
   * ponowienia przy limicie czasu, 429 ani 5xx: brak odpowiedzi znaczy „nie wiadomo”, a drugie
   * żądanie mogłoby wysłać drugi raz. Odpowiedź oddajemy SUROWĄ, bez interpretacji — jak inFakt.
   */
  async function wyslijDokumentDoKsef(id) {
    const czysty = idDokumentu(id);
    const odpowiedz = await zapytaj(
      `/invoices/${czysty}.json?send_to_ksef=yes`,
      { method: 'GET', doKsef: true },
      'wysyłkę do KSeF',
    );
    return { odpowiedzFakturowni: odpowiedz ?? null };
  }

  // Jedno wyjście: każda metoda dostaje maskowanie tokenu i adresu konta w błędzie.
  return Object.fromEntries(Object.entries({
    sprawdzPolaczenie, listaFaktur, pobierzFakture, pobierzPdf, iluMaNumer, znajdzKlientowPoNip,
    wystaw, wystawKorekte, oznaczZaplacona, wyslijDokumentDoKsef,
  }).map(([nazwa, metoda]) => [nazwa, async (...args) => {
    try { return await metoda(...args); }
    catch (e) { throw bezpiecznyBlad(e); }
  }]));
}

/** Nazwy metod klienta Fakturowni (atrapa w zmianie 04 wystawia te same). */
export const METODY_FAKTUROWNI = Object.freeze([
  'sprawdzPolaczenie', 'listaFaktur', 'pobierzFakture', 'pobierzPdf', 'iluMaNumer', 'znajdzKlientowPoNip',
  'wystaw', 'wystawKorekte', 'oznaczZaplacona', 'wyslijDokumentDoKsef',
]);

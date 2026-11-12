import { utworzHttp } from '../../core/http.ts';

const STATUSY_SPRZEDAWCY = new Set([
  'created', 'canceled', 'readyToProcess', 'inProgress', 'sent',
  'readyToPickup', 'received', 'returned', 'returningToSender', 'unknown',
]);
const SLOWNIKOWE = new Set(['status', 'vendor', 'typeId', 'pickupType', 'type', 'sortField', 'order', 'field', 'operator']);
const PRZEWOZNICY = new Set([
  'inpost', 'pocztaPolska', 'dhl', 'dpd', 'ups', 'gls', 'orlen', 'pocztex24',
  'ownTransport', 'selfPickup', 'ambroExpress', 'pekaes', 'tntExpress',
  'schenker', 'dsv', 'dts', 'geis', 'fedex', 'jasFBG', 'patronService',
  'raben', 'rhenus', 'rohligSuus', 'hellmann',
]);

// Konto do zwrotu nie jest potrzebne OMS-owi (D7), także w payloadach zmian.
function bezKonta(dane) {
  if (Array.isArray(dane)) return dane.map(bezKonta);
  if (dane && typeof dane === 'object') {
    return Object.fromEntries(Object.entries(dane)
      .filter(([klucz]) => klucz !== 'bankAccount')
      .map(([klucz, wartosc]) => [klucz, bezKonta(wartosc)]));
  }
  return dane;
}

function sprawdzPrzewoznika(dane) {
  if (!PRZEWOZNICY.has(dane?.vendor)) throw new Error('Nieznany przewoźnik przesyłki.');
  if (!['ownTransport', 'selfPickup'].includes(dane.vendor)
    && (typeof dane.trackingNumber !== 'string' || !dane.trackingNumber.trim())) {
    throw new Error('Przewoźnik wymaga numeru śledzenia przesyłki.');
  }
}

function sprawdzPaczki(paczki) {
  if (!Array.isArray(paczki) || paczki.length < 1 || paczki.length > 100) {
    throw new Error('Podaj od 1 do 100 paczek.');
  }
  for (const paczka of paczki) {
    const d = paczka?.dimensions;
    if (!d || ['width', 'height', 'length'].some(pole =>
      !Number.isFinite(d[pole]) || d[pole] < 1 || d[pole] > 2000)) {
      throw new Error('Wymiary paczki są wymagane i muszą mieścić się w zakresie 1–2000 mm.');
    }
    if (!Number.isInteger(d.weight) || d.weight < 10 || d.weight > 700_000) {
      throw new Error('Waga paczki musi mieścić się w zakresie 10–700 000 g.');
    }
  }
}

/** Klient etapu 1. Bez ponowień: 429 rozstrzyga wywołujący poller. */
export function createErliClient({ adresApi, kluczApi, fetchImpl, wersja = '1', log = () => {}, czekaj } = {}) {
  const baza = String(adresApi).replace(/\/+$/, '');
  // Ten sam transport i limit co w integracje/transport.js, także dla atrap fetch.
  // Log transportu zawiera URL, więc na zewnątrz przekazujemy tylko stały komunikat.
  const http = utworzHttp({ fetchImpl, limitCzasuMs: 30_000, ponowien: 0, czekaj,
    log: () => log('ERLI: błąd żądania HTTP') });
  // Klucz idzie tylko do https na hoście API albo erli.pl / erli.dev (etykieta może wskazywać inny serwer).
  const hostApi = (() => { try { return new URL(baza).host; } catch { return null; } })();
  const zaufany = url => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && (u.host === hostApi || /(^|\.)erli\.(pl|dev)$/.test(u.hostname));
    } catch { return false; }
  };
  const identyfikator = id => encodeURIComponent(String(id));
  const adres = (sciezka, query = {}) => {
    const parametry = new URLSearchParams();
    for (const [klucz, wartosc] of Object.entries(query)) {
      if (wartosc !== undefined && wartosc !== null) parametry.set(klucz, String(wartosc));
    }
    return `${baza}${sciezka}${parametry.size ? `?${parametry}` : ''}`;
  };

  async function zapytaj(url, method, body, { zAutoryzacja = true, binarnie = false } = {}) {
    const headers = { 'User-Agent': `TwojOMS/${wersja} (+https://twojoms.pl)`, Accept: binarnie ? 'application/pdf' : 'application/json' };
    if (zAutoryzacja && !kluczApi) throw new Error('ERLI: brak klucza API.');
    if (zAutoryzacja) headers.Authorization = `Bearer ${kluczApi}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let odpowiedz;
    try {
      odpowiedz = await http(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (blad) {
      if (blad.code === 'ERLI_TYLKO_ODCZYT') throw new Error('ERLI: włączono tryb tylko odczyt.');
      const wynik = new Error(blad.name === 'TimeoutError' ? 'ERLI: przekroczono limit czasu 30 s.' : 'ERLI: błąd połączenia.');
      wynik.name = blad.name;
      throw wynik;
    }
    if (odpowiedz.status === 429) {
      const blad = new Error('ERLI: limit żądań (429).');
      blad.kod = 'ERLI_429';
      blad.status = 429;
      const retry = odpowiedz.headers.get('Retry-After')?.trim();
      if (retry && /^\d+$/.test(retry) && Number.isSafeInteger(Number(retry))) blad.retryAfterS = Number(retry);
      throw blad;
    }
    if (!odpowiedz.ok) {
      // Serwer może odbić dane żądania w opisie błędu. Usuwamy klucz i wartości ciała.
      // Krótkie napisy i wartości słownikowe zostają — inaczej „[ukryto]” rozbija zwykłe słowa w opisie (recenzja).
      const wrazliwe = [];
      const zbierz = (wartosc, pole) => {
        if (typeof wartosc === 'string') {
          if (wartosc.length >= 5 && !SLOWNIKOWE.has(pole)) wrazliwe.push(wartosc);
        } else if (wartosc && typeof wartosc === 'object') {
          for (const [klucz, w] of Object.entries(wartosc)) zbierz(w, Array.isArray(wartosc) ? pole : klucz);
        }
      };
      zbierz(body);
      if (kluczApi) wrazliwe.push(kluczApi);
      const ukryj = tekst => {
        for (const wartosc of wrazliwe.sort((a, b) => b.length - a.length)) tekst = tekst.split(wartosc).join('[ukryto]');
        return tekst;
      };
      // Opis: [{errorCode, errorMessage}] ze specyfikacji, potem polishMessage, potem message, potem kod HTTP (rozdz. 2b).
      let opis = `ERLI: błąd HTTP ${odpowiedz.status}.`;
      const bledy = await odpowiedz.json().catch(() => null);
      const tekst = w => (typeof w === 'string' && w.trim() ? w : null);
      if (Array.isArray(bledy)) {
        const komunikaty = bledy.filter(b => b && /^\d+$/.test(String(b.errorCode)) && typeof b.errorMessage === 'string')
          .map(b => `${b.errorCode} — ${ukryj(b.errorMessage)}`);
        if (komunikaty.length) opis = komunikaty.join('; ');
      } else if (bledy && typeof bledy === 'object') {
        const wybrany = tekst(bledy.polishMessage) ?? tekst(bledy.error?.polishMessage) ?? tekst(bledy.message) ?? tekst(bledy.error?.message);
        if (wybrany) opis = `ERLI: ${ukryj(wybrany)} (HTTP ${odpowiedz.status})`;
      }
      const blad = new Error(opis);
      // Status potrzebny wywołującemu: 404 na /orders/changes przełącza poller na /inbox (D1).
      blad.status = odpowiedz.status;
      throw blad;
    }
    if (odpowiedz.status === 204) return undefined;
    try {
      if (binarnie) return Buffer.from(await odpowiedz.arrayBuffer());
      // Zapis może odpowiedzieć 202 bez ciała (rozdz. 2a) — to sukces, nie błąd odczytu.
      const surowe = await odpowiedz.text();
      return surowe.trim() ? bezKonta(JSON.parse(surowe)) : undefined;
    } catch {
      throw new Error('ERLI: nie udało się odczytać odpowiedzi.');
    }
  }

  return {
    mojSklep: () => zapytaj(adres('/me'), 'GET'),
    zmianyZamowien: (dane = {}) => zapytaj(adres('/orders/changes/_search'), 'POST', dane),
    oznaczPrzeczytane: dane => zapytaj(adres('/orders/changes/mark-read'), 'POST', dane),
    // Starsze /inbox — sandbox nie ma /orders/changes (D1, rozdz. 2a).
    inboxSzukaj: (dane = {}) => zapytaj(adres('/inbox/_search'), 'POST', dane),
    inboxOznacz: dane => zapytaj(adres('/inbox/mark-read'), 'POST', dane),
    // Czas wysyłki produktu, gdy pozycja nie ma dispatchTime (D6). Brak produktu → null.
    async pobierzProdukt(externalId) {
      try {
        return await zapytaj(adres(`/products/${identyfikator(externalId)}`), 'GET');
      } catch (blad) {
        if (blad.status === 404) return null;
        throw blad;
      }
    },
    szukajZamowien: (dane = {}) => zapytaj(adres('/orders/_search'), 'POST', dane),
    pobierzZamowienie: id => zapytaj(adres(`/orders/${identyfikator(id)}`), 'GET'),
    async ustawStatusSprzedawcy(id, sellerStatus) {
      if (!STATUSY_SPRZEDAWCY.has(sellerStatus)) throw new Error('Nieznany status sprzedawcy.');
      return zapytaj(adres(`/orders/${identyfikator(id)}/status`), 'PATCH', { status: sellerStatus });
    },
    async utworzPaczkiZewnetrzne(dane) {
      if (!Array.isArray(dane) || !dane.length) throw new Error('Podaj przesyłki zewnętrzne.');
      dane.forEach(sprawdzPrzewoznika);
      return zapytaj(adres('/shipping/external'), 'POST', dane);
    },
    async edytujPaczkeZewnetrzna(id, dane) {
      sprawdzPrzewoznika(dane);
      return zapytaj(adres(`/shipping/external/${identyfikator(id)}`), 'PATCH', dane);
    },
    usunPaczkeZewnetrzna: id => zapytaj(adres(`/shipping/external/${identyfikator(id)}`), 'DELETE'),
    metodyDostawy: (query = {}) => {
      if (query.vendor !== undefined && !PRZEWOZNICY.has(query.vendor) && !['ruch', 'other'].includes(query.vendor)) return Promise.reject(new Error('Nieznany przewoźnik przesyłki.'));
      return zapytaj(adres('/dictionaries/deliveryMethods', query), 'GET');
    },
    metodyErli: query => zapytaj(adres('/dictionaries/shippingMethods', query), 'GET'),
    cennikiDostaw: () => zapytaj(adres('/delivery/priceLists'), 'GET'),
    cennikiDostawSzczegoly: () => zapytaj(adres('/delivery/priceListsDetails'), 'GET'),
    punktyNadania: query => zapytaj(adres('/shipping/postingPoints', query), 'GET'),
    async utworzPaczki(dane) {
      sprawdzPaczki(dane);
      return zapytaj(adres('/shipping/parcels/'), 'POST', dane);
    },
    szukajPaczek: dane => zapytaj(adres('/shipping/parcels/_search'), 'POST', dane),
    anulujPaczke: id => zapytaj(adres(`/shipping/parcels/${identyfikator(id)}`), 'DELETE'),
    protokolyOdbioru: parcelIds => zapytaj(adres('/shipping/pickupProtocols', { parcelIds: Array.isArray(parcelIds) ? parcelIds.join(',') : parcelIds }), 'GET'),
    pobierzEtykiete: (url, { zAutoryzacja = true } = {}) => zapytaj(url, 'GET', undefined, { zAutoryzacja: zAutoryzacja && zaufany(url), binarnie: true }),
  };
}

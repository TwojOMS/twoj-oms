import { transport } from '../../integracje/transport.js';
import { rozbijNipUe } from '../../domena/wdt.js';

// WERYFIKACJA NUMERU VAT-UE W VIES — warunek stawki 0% przy WDT (art. 42 ust. 1 pkt 1
// ustawy o VAT). Publiczne REST API Komisji, bez klucza; kształt odpowiedzi zmierzony
// 26.08.2026 na żywym numerze Alfatrendu.
//
// ⚠️ USŁUGA NIGDY NIE RZUCA i oddaje jeden z TRZECH wyników — a nie dwóch:
//   'wazny'       → isValid true; log zamówienia dostaje nazwę, datę i numer konsultacji.
//   'niewazny'    → isValid false z userError o NUMERZE — jedyna droga do odmowy 0%.
//   'niedostepny' → sieć, 5xx, timeout, albo userError o USŁUDZE (MS_UNAVAILABLE itd.).
// Rozróżnienie „niewazny"/„niedostepny" jest sednem: VIES regularnie pada per państwo
// i wtedy TEŻ oddaje isValid false — odmowa na tej podstawie blokowałaby fakturowanie
// na czas cudzej awarii. Decyzję, co z „niedostepny", podejmuje wołający
// (services/faktura.js: wystawia i zapisuje ostrzeżenie do logu).
//
// ⚠️ `requesterMemberStateCode` + `requesterNumber` (NIP sprzedawcy) idą w zapytaniu
// CELOWO: dopiero z nimi VIES oddaje `requestIdentifier` — urzędowy numer konsultacji,
// który jest DOWODEM weryfikacji na moment transakcji, do logu i dla biura rachunkowego.

const BAZA = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
const LIMIT_MS = 10 * 1000;

// Kody userError mówiące o USŁUDZE, nie o numerze — pełna lista z dokumentacji VIES.
const USTERKI_USLUGI = new Set([
  'MS_UNAVAILABLE', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'GLOBAL_MAX_CONCURRENT_REQ',
  'MS_MAX_CONCURRENT_REQ', 'IP_BLOCKED', 'VAT_BLOCKED',
]);

export function createVies({ fetchImpl, http = transport({ fetchImpl }), nipSprzedawcy, baseUrl = BAZA }) {
  async function sprawdz(nip) {
    const czesci = rozbijNipUe(nip);
    // Numer krajowy (albo śmieć) — nie ma czego pytać; wołający i tak pyta tylko przy WDT.
    if (!czesci) return { wynik: 'niedostepny', nazwa: null, adres: null, dataZapytania: null, numerKonsultacji: null };

    let dane;
    try {
      // PRZ-108.10: NIP może przyjść funkcją (NIP z Ustawień → Firma) — czytany przy każdym zapytaniu, bez restartu.
      const nip = typeof nipSprzedawcy === 'function' ? nipSprzedawcy() : nipSprzedawcy;
      const p = new URLSearchParams({ requesterMemberStateCode: 'PL', requesterNumber: String(nip ?? '') });
      const res = await http(`${baseUrl}/${czesci.kraj}/vat/${czesci.numer}?${p.toString()}`, {
        signal: AbortSignal.timeout(LIMIT_MS),
      });
      if (!res.ok) return { wynik: 'niedostepny', nazwa: null, adres: null, dataZapytania: null, numerKonsultacji: null };
      dane = await res.json();
    } catch {
      return { wynik: 'niedostepny', nazwa: null, adres: null, dataZapytania: null, numerKonsultacji: null };
    }

    const usterkaUslugi = USTERKI_USLUGI.has(String(dane?.userError ?? '').toUpperCase());
    const wynik = dane?.isValid === true ? 'wazny' : usterkaUslugi ? 'niedostepny' : 'niewazny';
    return {
      wynik,
      nazwa: dane?.name ?? null,
      adres: dane?.address ?? null,
      dataZapytania: dane?.requestDate ?? null,
      // Puste `requestIdentifier` sprowadzamy do null — „brak dowodu" ma wyglądać jak brak.
      numerKonsultacji: dane?.requestIdentifier || null,
    };
  }

  return { sprawdz };
}

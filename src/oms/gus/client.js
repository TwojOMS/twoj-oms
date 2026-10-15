import { transport } from '../../integracje/transport.js';
import { bladOperatora } from '../../domena/bledy.js';
import {
  kopertaZaloguj, kopertaSzukajPoNip, firmaZOdpowiedzi, pole, rozpakuj,
} from '../../domena/gus.js';

// Klient GUS BIR1.1 (baza REGON). Sieć i sesja — reguły siedzą w domain/gus.js.
//
// ⚠️ TRZY RZECZY, KTÓRE ROBIĄ TĘ USŁUGĘ INNĄ NIŻ ZWYKŁY REST:
//  1. Trzeba się ZALOGOWAĆ kluczem i dostać identyfikator sesji, który potem jedzie
//     w nagłówku HTTP `sid` przy KAŻDYM żądaniu (nie w kopercie SOAP).
//  2. Sesja wygasa po ok. 60 minutach bezczynności, a wygaśnięcie NIE wygląda jak błąd:
//     usługa odpowiada 200 z pustą treścią. Dlatego jedno ponowienie po przelogowaniu
//     jest wbudowane — bez niego pierwsze kliknięcie po dłuższej przerwie zawsze
//     kończyłoby się „nie znaleziono firmy", co jest komunikatem MYLĄCYM.
//  3. Odpowiedź to XML zagnieżdżony w polu tekstowym XML-a, więc parsuje się dwa razy
//     (rozpakuj + firmaZOdpowiedzi).

// Limit twardy, jak przy DPD: to jest zapytanie robione RĘKĄ operatora, który czeka przed
// ekranem. Usługa GUS potrafi zwolnić, a wtedy lepiej powiedzieć „spróbuj jeszcze raz"
// niż trzymać otwarte żądanie w nieskończoność.
export const LIMIT_ZAPYTANIA_MS = 10_000;

// Sesji NIE trzymamy dłużej niż GUS: 45 minut z sześćdziesięciu, żeby nie trafić w moment
// wygaśnięcia po stronie usługi. Ponowienie i tak jest, ale lepiej z niego nie korzystać.
const ZYWOTNOSC_SESJI_MS = 45 * 60 * 1000;

export function createGusClient({ klucz, url }, { fetchImpl, http = transport({ fetchImpl }), teraz = Date.now } = {}) {
  if (!klucz || !url) throw new Error('GUS: brak klucza albo adresu usługi');
  let sesja = null;

  async function wyslij(koperta, sid) {
    const kontroler = new AbortController();
    const stoper = setTimeout(() => kontroler.abort(), LIMIT_ZAPYTANIA_MS);
    try {
      const odp = await http(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          ...(sid ? { sid } : {}),
        },
        body: koperta,
        signal: kontroler.signal,
      });
      const tresc = await odp.text();
      if (!odp.ok) {
        // Treść odpowiedzi GUS-u bywa całą stroną błędu — do komunikatu bierzemy początek,
        // reszta i tak nie pomaga człowiekowi przed ekranem.
        throw new Error(`GUS odpowiedział ${odp.status}: ${String(tresc).slice(0, 200)}`);
      }
      return tresc;
    } catch (e) {
      if (e.name === 'AbortError') {
        throw bladOperatora('GUS nie odpowiedział w 10 sekund — spróbuj jeszcze raz za chwilę.');
      }
      throw e;
    } finally {
      clearTimeout(stoper);
    }
  }

  async function zaloguj() {
    const tresc = await wyslij(kopertaZaloguj(klucz, url));
    const sid = pole(rozpakuj(tresc), 'ZalogujResult');
    // Zły klucz NIE daje błędu HTTP — usługa oddaje pustą wartość. Bez tej kontroli panel
    // szedłby dalej z pustym `sid` i mówił „nie znaleziono firmy" przy KAŻDYM NIP-ie.
    if (!sid) {
      throw bladOperatora('GUS odrzucił logowanie — sprawdź klucz użytkownika (GUS_KLUCZ).');
    }
    sesja = { sid, do: teraz() + ZYWOTNOSC_SESJI_MS };
    return sid;
  }

  const sesjaAktualna = () => (sesja && sesja.do > teraz() ? sesja.sid : null);

  /**
   * Firma z bazy REGON po NIP-ie (już znormalizowanym — patrz nipDoZapytania).
   * `null` znaczy „GUS nie zna takiej firmy", a NIE „usługa padła" — te dwa przypadki
   * karta pokazuje inaczej, bo pierwszy znaczy „sprawdź NIP", a drugi „spróbuj za chwilę".
   */
  async function firmaPoNip(nip) {
    const sid = sesjaAktualna() ?? await zaloguj();
    const tresc = await wyslij(kopertaSzukajPoNip(nip, url), sid);
    const wynik = pole(rozpakuj(tresc), 'DaneSzukajPodmiotyResult');

    // Pusty wynik = sesja wygasła (usługa odpowiada 200 z niczym). JEDNO ponowienie po
    // przelogowaniu — nie pętla: gdyby przyczyną był zły klucz, pętla dobijałaby GUS.
    if (!wynik) {
      sesja = null;
      const nowySid = await zaloguj();
      const drugaTresc = await wyslij(kopertaSzukajPoNip(nip, url), nowySid);
      const drugiWynik = pole(rozpakuj(drugaTresc), 'DaneSzukajPodmiotyResult');
      return drugiWynik ? firmaZOdpowiedzi(drugiWynik) : null;
    }
    return firmaZOdpowiedzi(wynik);
  }

  return { firmaPoNip, zaloguj, _sesja: () => sesja };
}

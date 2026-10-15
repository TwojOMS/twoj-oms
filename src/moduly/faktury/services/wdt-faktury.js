import { bladOperatora } from '../../../domena/bledy.js';
import { numerWdt } from '../../../domena/wdt.js';
import { zarezerwujNumerWdt, cofnijRezerwacjeWdt } from '../db/wdt-numery.js';

// WSPOLNA GALAZ WDT OBU DROG WYSTAWIANIA — faktury pojedynczej (services/faktura.js,
// obejmuje hurt) i faktury okresu (services/faktura-okresu.js). Istnieje po to, zeby
// regula VIES i regula serii numeracji NIE MIALY drugiej kopii: rozjazd między karta
// a okresem bylby cichy i wyszedlby dopiero na dokumencie.
//
// `dopisz(akcja, wynik)` przychodzi od wolajacego, bo tylko on wie, do KTORYCH zamowien
// pisze log: faktura pojedyncza do jednego, okres do wszystkich zamowien miesiaca.

/**
 * VIES przy WDT: 'niewazny' ODMAWIA (jedyna droga do odmowy — services/vies.js oddaje
 * usterki uslugi jako 'niedostepny', nie 'niewazny'); 'wazny' zapisuje do logu DOWOD
 * weryfikacji na moment transakcji (nazwa, numer konsultacji, data); 'niedostepny'
 * zapisuje polecenie recznej weryfikacji i pozwala wystawic — VIES pada per panstwo
 * i odmowa na czas cudzej awarii blokowalaby fakturowanie w ogole. Brak uslugi
 * (vies = null) = 'niedostepny': panel bez sieci VIES dalej fakturuje.
 */
export async function sprawdzWdtWVies({ vies, nip, dopisz }) {
  const v = vies ? await vies.sprawdz(nip) : { wynik: 'niedostepny' };
  if (v.wynik === 'niewazny') {
    throw bladOperatora(
      `VIES: numer ${nip} jest NIEWAŻNY. Faktury WDT ze stawką 0% nie wolno wystawić — `
      + 'bez ważnego numeru VAT-UE to dostawa krajowa 23% (art. 42 ust. 1 pkt 1 ustawy '
      + 'o VAT). Wyjaśnij numer z klientem albo wystaw dokument krajowy ręcznie w inFakcie.',
    );
  }
  if (v.wynik === 'wazny') {
    dopisz('wdt.vies', (`VIES: numer ${nip} WAŻNY (${v.nazwa ?? 'bez nazwy'}), `
      + `konsultacja ${v.numerKonsultacji ?? 'bez numeru'}, ${v.dataZapytania ?? ''}`).trim());
    return;
  }
  dopisz('wdt.vies', `VIES NIEDOSTĘPNY dla ${nip} — wystawiam bez potwierdzenia numeru. `
    + 'Zweryfikuj numer w VIES i zachowaj dowód (warunek stawki 0%, art. 42 ust. 1 pkt 1).');
}

/**
 * Rezerwuje numer wlasnej serii WDT na dzien wystawienia (`RRRR-MM-DD`) i sprawdza
 * straznikiem duplikatu, czy inFakt juz takiego nie ma (iluMaNumer, q[number_eq]
 * zweryfikowane na zywo 26.08.2026). KAZDA awaria tego kroku zwalnia licznik, zanim
 * poleci wyzej — dokumentu na pewno jeszcze nie ma, wiec nie ma czego chronic.
 */
export async function przygotujSerieWdt({ db, infakt, dzien }) {
  const [rok, miesiac] = String(dzien).split('-').map(Number);
  const kolejny = zarezerwujNumerWdt(db, { rok, miesiac });
  const seria = { rok, miesiac, kolejny, numer: numerWdt(rok, miesiac, kolejny) };
  try {
    if (await infakt.iluMaNumer(seria.numer) > 0) {
      throw bladOperatora(
        `W inFakcie istnieje już dokument o numerze ${seria.numer} — seria WDT panelu `
        + 'rozjechała się z kontem. Sprawdź listę faktur w inFakcie i wyrównaj licznik, '
        + 'zanim wystawisz kolejną fakturę WDT.',
      );
    }
  } catch (e) {
    cofnijRezerwacjeWdt(db, seria);
    throw e;
  }
  return seria;
}

/**
 * Po AWARII wystawienia: jednoznaczna odmowa (4xx — dokumentu na pewno nie ma) zwalnia
 * numer, o ile wciaz jest ostatni; awaria niejednoznaczna zostawia go ZAJETYM, bo
 * nastepna faktura WDT nie moze wyjsc z numerem tej zawieszonej — a slad idzie do logu,
 * zeby dziura w serii byla faktem do wyjasnienia, nie zagadka po miesiacu.
 */
export function seriaWdtPoAwarii({ db, seria, jednoznaczna, dopisz }) {
  if (!seria) return;
  if (jednoznaczna) {
    cofnijRezerwacjeWdt(db, seria);
    return;
  }
  dopisz('wdt.numeracja', `Numer ${seria.numer} zostaje ZAJĘTY po awarii niejednoznacznej — `
    + 'dokument mógł powstać w inFakcie; jeśli go tam nie ma, w serii WDT będzie dziura.');
}

/**
 * Po SUKCESIE wystawienia: prawda o numerze jest ODPOWIEDZ inFaktu, nie nasz zamiar.
 * Rozjazd znaczy, ze pole `number` zostalo odrzucone albo zignorowane (na zywo
 * NIEZWERYFIKOWANE — spec 2026-08-26): dokument JEST wazny (numeracja glowna tez jest
 * legalna), ale osobna numeracja WDT nie dziala i czlowiek ma sie o tym dowiedziec
 * z logu panelu, a nie od ksiegowej klienta. Licznik wraca, zeby seria nie odjezdzala.
 */
export function seriaWdtPoSukcesie({ db, seria, numerZwrocony, dopisz }) {
  if (!seria || numerZwrocony === seria.numer) return;
  cofnijRezerwacjeWdt(db, seria);
  dopisz('wdt.numeracja', `inFakt nadał numer ${numerZwrocony ?? '(bez numeru)'} zamiast `
    + `${seria.numer} — osobna numeracja WDT nie zadziałała. Dokument jest ważny (numeracja `
    + 'główna), ale zgłoś ten rozjazd, zanim wystawisz kolejną fakturę WDT.');
}

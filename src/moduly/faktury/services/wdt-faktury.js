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
//
// PRZ-118.06: program fakturowy (kontrakt ProgramFakturowy) zamiast klienta inFaktu. Komunikaty mowia
// nazwa programu (`program.opis.nazwa`) — dla inFaktu znak w znak to samo co przed zmiana.

/**
 * Odmiana nazwy programu do komunikatow obu drog wystawiania. Usluga bez programu (`zProgramu` oddalo null —
 * tak bylo i przed PRZ-118 z `infakt: null`) nie ma nazwy: wtedy mowimy ogolnie, zamiast wywracac komunikat.
 */
export function nazwaProgramu(program) {
  return program?.opis?.nazwa ?? BEZ_NAZWY;
}
const BEZ_NAZWY = Object.freeze({
  mianownik: 'program fakturowy', dopelniacz: 'programu fakturowego',
  miejscownik: 'programie fakturowym', narzednik: 'programem fakturowym',
});

/**
 * Zdolnosc `numeracjaWlasna` (metoda `iluMaNumer`) — bez niej straznik duplikatu serii WDT nie ma czym
 * sprawdzic, czy numer jest wolny, a numer z serii bez sprawdzenia mogl juz wyjsc na innym dokumencie.
 * Odmowa LOKALNA: wolajacy stawia ja PRZED rezerwacja faktury i przed licznikiem serii (nic do zwalniania).
 */
export function sprawdzNumeracjeWlasna(program) {
  if (typeof program?.iluMaNumer === 'function') return;
  const n = nazwaProgramu(program);
  throw bladOperatora(
    `${n.mianownik} nie umie sprawdzić, czy numer z własnej serii WDT jest wolny (brak numeracji własnej) — `
    + `panel nie wystawi w ${n.miejscownik} faktury WDT z numerem serii. Faktura NIE została wystawiona.`,
  );
}

/**
 * VIES przy WDT: 'niewazny' ODMAWIA (jedyna droga do odmowy — services/vies.js oddaje
 * usterki uslugi jako 'niedostepny', nie 'niewazny'); 'wazny' zapisuje do logu DOWOD
 * weryfikacji na moment transakcji (nazwa, numer konsultacji, data); 'niedostepny'
 * zapisuje polecenie recznej weryfikacji i pozwala wystawic — VIES pada per panstwo
 * i odmowa na czas cudzej awarii blokowalaby fakturowanie w ogole. Brak uslugi
 * (vies = null) = 'niedostepny': panel bez sieci VIES dalej fakturuje.
 */
export async function sprawdzWdtWVies({ vies, nip, dopisz, nazwa = BEZ_NAZWY }) {
  const v = vies ? await vies.sprawdz(nip) : { wynik: 'niedostepny' };
  if (v.wynik === 'niewazny') {
    throw bladOperatora(
      `VIES: numer ${nip} jest NIEWAŻNY. Faktury WDT ze stawką 0% nie wolno wystawić — `
      + 'bez ważnego numeru VAT-UE to dostawa krajowa 23% (art. 42 ust. 1 pkt 1 ustawy '
      + `o VAT). Wyjaśnij numer z klientem albo wystaw dokument krajowy ręcznie w ${nazwa.miejscownik}.`,
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
 * straznikiem duplikatu, czy program juz takiego nie ma (iluMaNumer; w inFakcie q[number_eq]
 * zweryfikowane na zywo 26.08.2026). KAZDA awaria tego kroku zwalnia licznik, zanim
 * poleci wyzej — dokumentu na pewno jeszcze nie ma, wiec nie ma czego chronic.
 * Program bez numeracji wlasnej odmawia PRZED rezerwacja numeru (licznik nietkniety).
 */
export async function przygotujSerieWdt({ db, program, dzien }) {
  sprawdzNumeracjeWlasna(program);
  const n = nazwaProgramu(program);
  const [rok, miesiac] = String(dzien).split('-').map(Number);
  const kolejny = zarezerwujNumerWdt(db, { rok, miesiac });
  const seria = { rok, miesiac, kolejny, numer: numerWdt(rok, miesiac, kolejny) };
  try {
    if (await program.iluMaNumer(seria.numer) > 0) {
      throw bladOperatora(
        `W ${n.miejscownik} istnieje już dokument o numerze ${seria.numer} — seria WDT panelu `
        + `rozjechała się z kontem. Sprawdź listę faktur w ${n.miejscownik} i wyrównaj licznik, `
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
export function seriaWdtPoAwarii({ db, seria, jednoznaczna, dopisz, nazwa = BEZ_NAZWY }) {
  if (!seria) return;
  if (jednoznaczna) {
    cofnijRezerwacjeWdt(db, seria);
    return;
  }
  dopisz('wdt.numeracja', `Numer ${seria.numer} zostaje ZAJĘTY po awarii niejednoznacznej — `
    + `dokument mógł powstać w ${nazwa.miejscownik}; jeśli go tam nie ma, w serii WDT będzie dziura.`);
}

/**
 * Po SUKCESIE wystawienia: prawda o numerze jest ODPOWIEDZ programu, nie nasz zamiar.
 * Rozjazd znaczy, ze pole `number` zostalo odrzucone albo zignorowane (na zywo
 * NIEZWERYFIKOWANE — spec 2026-08-26): dokument JEST wazny (numeracja glowna tez jest
 * legalna), ale osobna numeracja WDT nie dziala i czlowiek ma sie o tym dowiedziec
 * z logu panelu, a nie od ksiegowej klienta. Licznik wraca, zeby seria nie odjezdzala.
 */
export function seriaWdtPoSukcesie({ db, seria, numerZwrocony, dopisz, nazwa = BEZ_NAZWY }) {
  if (!seria || numerZwrocony === seria.numer) return;
  cofnijRezerwacjeWdt(db, seria);
  dopisz('wdt.numeracja', `${nazwa.mianownik} nadał numer ${numerZwrocony ?? '(bez numeru)'} zamiast `
    + `${seria.numer} — osobna numeracja WDT nie zadziałała. Dokument jest ważny (numeracja `
    + 'główna), ale zgłoś ten rozjazd, zanim wystawisz kolejną fakturę WDT.');
}

// ETAP PRZESYLKI — klasa stanu liczona z OPISU zdarzenia kuriera (audyt 22.08; zgoda
// właściciela 23.08: pastylka „w drodze (N dni) / w doręczeniu / doręczona" przy paczce,
// zakladka /przesylki i ostrzezenie „bez ruchu > 3 dni ROBOCZE" — wiekszosc paczek
// dochodzi nastepnego dnia, wiec 3 dni robocze to juz realny zator, a weekend nie
// jest wina kuriera).
//
// ⚠️ ETAP GRUPUJE, NIE TLUMACZY. Surowy opis kuriera zostaje na ekranie ZAWSZE; etap
// sluzy pastylce, filtrom i regule bez ruchu. Nieznany opis z historia zdarzen to
// z definicji paczka W DRODZE — klasa, nie zdanie wypowiedziane za kuriera (odwrotna
// decyzja niz przy tlumaczeniu stanow InPostu, gdzie nieznany kod ma byc widoczny
// wprost — i dalej jest, bo opis pokazujemy obok).
//
// Kolejnosc wzorcow: od stanow koncowych do poczatkowych — dla CZYTELNOSCI, nie z musu.
// Rdzenie sa rozlaczne („doręczon-a/o" vs „doręczeni-e/u"), wiec zamiana kolejnosci tych
// dwoch galezi niczego nie zmienia — sprawdzone mutacja (przezyla jako ROWNOWAZNA, nie
// jako luka; to inna sytuacja niz p24/przelew w metodach platnosci, gdzie wzorzec jeden
// ZAWIERA drugi i kolejnosc jest trescia).
// Wzorce DPD zmierzone sonda na zywym API zdarzen (23.08) i produkcyjna baza; wzorce
// InPost to NASZE etykiety z OPISY_STANOW (kurierzy/inpost.js) — jedno zrodlo slow.

import { dzienWarszawa } from './format-daty.js';

export const PROG_BEZ_RUCHU_DNI_ROBOCZYCH = 3;

const ETYKIETY = {
  nadana: 'Zarejestrowana',
  w_drodze: 'W drodze',
  w_doreczeniu: 'W doręczeniu',
  doreczona: 'Doręczona',
  zwrot: 'Zwrot do nadawcy',
};

/**
 * KODY MASZYNOWE ALLEGRO → etap. Zmierzone sonda na zywym API 25.08.2026
 * (`GET /order/carriers/ALLEGRO/tracking`, konto allegro_a).
 *
 * ⚠️ ISTNIEJE, BO OPIS ALLEGRO JEST TLUMACZENIEM. Zasob oddaje `code` (maszynowy) obok
 * `description` zaleznego od `Accept-Language` — po polsku „Przesyłka została doręczona",
 * po angielsku „Parcel has been delivered". Klasyfikowanie po opisie dzialaloby dzis
 * i zamilkloby PO CICHU przy pierwszej korekcie tekstu u Allegro albo przy zmianie
 * naglowka. To ta sama regula, ktora w domain/allegro-dostawa.js i allegro-wysylka.js
 * kaze mapowac po `delivery.method.id`, a nigdy po nazwie uslugi.
 *
 * ⚠️ NOWY KOD NIE MOZE WPASC TU PO CICHU. Kod spoza mapy schodzi do dopasowania po opisie,
 * a strazniku zupelnosci w tests/oms/etap-przesylki.test.js pilnuje, ze komplet zmierzonych
 * kodow ma jawna decyzje — paczka ZWROCONA sklasyfikowana jako jadaca znikneloby z pola
 * widzenia dokladnie wtedy, gdy wymaga czlowieka.
 */
export const KODY_ALLEGRO = {
  PENDING: 'nadana',
  IN_TRANSIT: 'w_drodze',
  RELEASED_FOR_DELIVERY: 'w_doreczeniu',
  AVAILABLE_FOR_PICKUP: 'w_doreczeniu',
  DELIVERED: 'doreczona',
};

/**
 * @param opis surowy opis zdarzenia kuriera (DPD, InPost — jedyne zrodlo, jakie maja)
 * @param kod  maszynowy `code` Allegro; gdy znany, ROZSTRZYGA i opis go nie rusza
 */
export function etapPrzesylki(opis, kod = null) {
  const zKodu = KODY_ALLEGRO[String(kod ?? '').trim()];
  if (zKodu) return zKodu;
  const s = String(opis ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('zwrot') || s.includes('zwróc')) return 'zwrot';
  if (s.includes('doręczon') || s.includes('odebrana przez klienta') || s.includes('odbiorc')) return 'doreczona';
  if (s.includes('doręczeni') || s.includes('gotowa do odbioru')) return 'w_doreczeniu';
  if (s.includes('zarejestrowan')) return 'nadana';
  return 'w_drodze';
}

// Polska odmiana bez biblioteki: „dziś", „1 dzień", dalej „N dni" — wiecej form nie
// potrzeba, bo dni w drodze nie przekraczaja kilkunastu (14-dniowe okno zegara).
const dniPoPolsku = (n) => {
  if (n <= 0) return 'dziś';
  if (n === 1) return '1 dzień';
  return `${n} dni`;
};

export function etykietaEtapu(etap, dniWDrodze = 0) {
  if (etap === 'w_drodze') return `W drodze (${dniPoPolsku(dniWDrodze)})`;
  return ETYKIETY[etap] ?? null;
}

// Rozłączne kubełki listy /przesylki. Numer listu sam nie dowodzi, że etykieta
// powstała (Allegro potrafi dosłać numer paczki nadanej poza panelem). Natomiast
// PENDING/zarejestrowanie u przewoźnika jest jawnym dowodem przygotowania paczki.
// Po pierwszym skanie plik etykiety nadal istnieje, ale nie może utrzymywać
// przesyłki w „Utworzone”. „Bez ruchu” pozostaje osobnym, przekrojowym alertem.
export function kategoriaPrzesylki(p, etap) {
  if (etap === 'doreczona' || etap === 'zwrot') return 'doreczone';
  if (p?.przejeta_at) return 'w_drodze';
  if (etap === 'nadana') return 'utworzone';
  const jestPlik = [p?.etykieta_sciezka, p?.etykieta_zpl_sciezka]
    .some((sciezka) => typeof sciezka === 'string' && sciezka.trim().length > 0);
  if (etap == null && (jestPlik || p?.etykieta_reczna === 1)) return 'utworzone';
  return 'w_drodze';
}

/**
 * Pelne dni ROBOCZE miedzy dwiema chwilami: dni kalendarzowe PO dniu startu, do dnia
 * konca wlacznie, z pominieciem sobot i niedziel. Dzien liczony PO WARSZAWSKU
 * (dzienWarszawa radzi sobie i z `Z`, i z reszta) — paczka nadana w piatek 23:30
 * naszego czasu ma w poniedzialek rano JEDEN dzien roboczy, nie zero i nie dwa.
 * Odwrotna kolejnosc dat oddaje zero, nigdy liczbe ujemna.
 */
export function dniRoboczeMiedzy(odIso, doIso) {
  const od = dzienWarszawa(odIso);
  const doDnia = dzienWarszawa(doIso);
  if (!od || !doDnia || doDnia <= od) return 0;
  const [ro, mo, dn] = od.split('-').map(Number);
  const koniec = Date.parse(`${doDnia}T00:00:00Z`);
  let dzien = Date.UTC(ro, mo - 1, dn);
  let robocze = 0;
  while (dzien < koniec) {
    dzien += 24 * 3600 * 1000;
    const dowThis = new Date(dzien).getUTCDay();
    if (dowThis !== 0 && dowThis !== 6) robocze += 1;
  }
  return robocze;
}

/**
 * Czy paczka stoi bez ruchu: ponad PROG dni roboczych od OSTATNIEGO ZDARZENIA kuriera
 * (`status_kuriera_at` — znacznik zdarzenia, nie naszej proby), a gdy zdarzen jeszcze
 * nie ma — od nadania (paczka moze zginac przed pierwszym skanem i wlasnie wtedy nikt
 * by jej nie szukal). Doreczona i zwrot nie stoja — doszly.
 */
export function bezRuchu({ etap, statusKurieraAt, nadanaAt, teraz }) {
  if (etap === 'doreczona' || etap === 'zwrot') return false;
  const od = statusKurieraAt || nadanaAt;
  if (!od || !teraz) return false;
  return dniRoboczeMiedzy(od, teraz instanceof Date ? teraz.toISOString() : teraz) > PROG_BEZ_RUCHU_DNI_ROBOCZYCH;
}

// Dni KALENDARZOWE w drodze — do etykiety „W drodze (N dni)". Kalendarzowe, nie robocze:
// etykieta mowi, ile klient realnie czeka; robocze zostaja regula progu bez ruchu.
export function dniKalendarzowe(odIso, doIso) {
  const od = Date.parse(odIso ?? '');
  const doDnia = Date.parse(doIso ?? '');
  if (!Number.isFinite(od) || !Number.isFinite(doDnia) || doDnia <= od) return 0;
  return Math.floor((doDnia - od) / (24 * 3600 * 1000));
}

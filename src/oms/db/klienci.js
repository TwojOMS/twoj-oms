import { bladOperatora } from '../../domena/bledy.js';
import { normalizujNip, parsujKlientowZbiorczych } from '../../domena/klient-zbiorczy.js';

// BAZA STAŁYCH KLIENTÓW — warstwa bazy. Reguły (co wpis znaczy, jak zamienia się w pola
// formularza) mieszkają w domain/klient-staly.js; tutaj jest wyłącznie SQL.
//
// ⚠️ WIERSZ WYCHODZI STĄD JUŻ Z ROZPAKOWANYMI BLOKAMI (`faktura`, `wysylka`), tak samo jak
// zamówienie wychodzi z `klient` i `dostawa` (db/zamowienia.js: zLinii). Gdyby JSON-y
// rozpakowywał każdy czytelnik osobno, pierwsza uszkodzona kolumna wywalałaby ekran zamiast
// pokazać klienta bez adresu.

const teraz = () => new Date().toISOString();

// Uszkodzony JSON znaczy „nie wiemy, co tam było", a nie awarię ekranu. Ta sama ostrożność,
// co przy `tagi_json` w kanałach raportowych i przy `pozycje_reczne_json`.
function blok(surowy) {
  try {
    const wynik = JSON.parse(surowy ?? '{}');
    return wynik && typeof wynik === 'object' ? wynik : {};
  } catch {
    return {};
  }
}

const zWiersza = (w) => (w ? { ...w, faktura: blok(w.faktura_json), wysylka: blok(w.wysylka_json) } : null);

/**
 * Wszyscy klienci do listy i do pola wyboru.
 *
 * ⚠️ NIEAKTYWNI ZOSTAJĄ W BAZIE i wychodzą stąd tylko wtedy, gdy ktoś o nich pyta wprost.
 * Kasowanie wpisu byłoby kuszące i błędne: zamówienia założone z jego danych zostają
 * (są migawką), więc skasowany klient nie naprawia niczego, a odbiera możliwość sprawdzenia,
 * skąd wzięły się dane na fakturze sprzed pół roku.
 */
export function wszyscyKlienci(db, { tylkoAktywni = true } = {}) {
  const gdzie = tylkoAktywni ? 'WHERE aktywny = 1' : '';
  return db.prepare(`SELECT * FROM klienci ${gdzie} ORDER BY aktywny DESC, nazwa`).all().map(zWiersza);
}

export const klientPoKluczu = (db, klucz) => zWiersza(
  db.prepare('SELECT * FROM klienci WHERE klucz = ?').get(String(klucz ?? '').trim()),
);

export const klientPoId = (db, id) => zWiersza(db.prepare('SELECT * FROM klienci WHERE id = ?').get(Number(id)));

/**
 * Klient po NIP-ie — droga, którą działa „Zapamiętaj tego klienta" i podpowiedź na karcie.
 *
 * ⚠️ PO CYFRACH, nie po napisie z kolumny: NIP na zamówieniu bywa wpisany z myślnikami albo
 * z prefiksem „PL", a w tabeli leży znormalizowany. Porównanie napisów wprost nie znalazłoby
 * klienta, którego panel ma w bazie — i operator założyłby go drugi raz, po czym odbiłby się
 * od indeksu unikalnego z komunikatem o duplikacie, którego nie rozumie.
 */
export function klientPoNip(db, nip) {
  const szukany = normalizujNip(nip);
  if (!szukany) return null;
  return zWiersza(db.prepare('SELECT * FROM klienci WHERE nip = ?').get(szukany));
}

const POLA = [
  'klucz', 'nazwa', 'nip', 'b2b', 'rabat_procent', 'chce_fakture', 'metoda_wysylki',
  'koszt_dostawy_brutto', 'platnosc', 'termin_platnosci', 'komentarz', 'aktywny',
  // Warunki umowy zbiorczej (2026-08-24). ⚠️ `?? null` w `wartosci` nizej jest tu ISTOTNE:
  // niewypelniona kwota ma trafic do bazy jako NULL, czyli „nikt tego nie ustawil", a nie
  // jako 0 („wysylka za darmo od zera zlotych").
  'rozliczenie_zbiorcze', 'prog_darmowej_dostawy_gr', 'oplata_obslugi_gr', 'oplata_kurierska_gr',
];

// ⚠️ FLAGI `NOT NULL` MUSZA MIEC TU WARTOSC ZASTEPCZA, bo `?? null` ponizej trafialby
// na nie surowym „NOT NULL constraint failed" — komunikatem, ktory nie mowi ani ktore pole,
// ani co z tym zrobic. Zlapane 24.08.2026 przy dokladaniu `rozliczenie_zbiorcze`: wolajacy,
// ktory buduje `dane` recznie (a nie przez `znormalizujKlienta`), wywracal caly zapis.
//
// ⚠️ `0` jest tu ZDANIEM PRAWDZIWYM, a nie wygodna domyslka: „nikt nie powiedzial, ze ten
// klient jest rozliczany zbiorczo". Trzy KWOTY umowy takiej zastepczej wartosci NIE MAJA
// i miec nie moga — tam `null` znaczy „nie ustalono", a `0` znaczylo by „ustalono na zero".
const ZASTEPCZE = { rozliczenie_zbiorcze: 0 };

const wartosci = (dane) => [
  ...POLA.map((p) => dane[p] ?? ZASTEPCZE[p] ?? null),
  JSON.stringify(dane.faktura ?? {}),
  JSON.stringify(dane.wysylka ?? {}),
];

/**
 * Nowy klient.
 *
 * ⚠️ KOLIZJE ROZSTRZYGA BAZA, a nie sprawdzenie przed zapisem — ta sama zasada, co przy
 * numerze zamówienia ręcznego. Dwa równoczesne „Zapamiętaj tego klienta" (podwójny klik,
 * dwie karty) policzyłyby to samo i oba przeszłyby przez `SELECT ... WHERE nip = ?`;
 * przepuści tylko pierwszy INSERT. Komunikat tłumaczymy tutaj, żeby operator nie zobaczył
 * surowego „UNIQUE constraint failed".
 */
export function dopiszKlienta(db, dane, kiedy = teraz()) {
  const kolumny = [...POLA, 'faktura_json', 'wysylka_json'];
  try {
    const info = db.prepare(
      `INSERT INTO klienci (${kolumny.join(', ')}, utworzone_at, zmienione_at)`
      + ` VALUES (${kolumny.map(() => '?').join(',')},?,?)`,
    ).run(...wartosci(dane), kiedy, kiedy);
    return Number(info.lastInsertRowid);
  } catch (e) {
    throw kolizja(db, e, dane, null);
  }
}

/** Poprawka istniejącego wpisu. `id`, nie klucz — klucz też da się poprawić. */
export function zapiszKlienta(db, id, dane, kiedy = teraz()) {
  const kolumny = [...POLA, 'faktura_json', 'wysylka_json'];
  try {
    const info = db.prepare(
      `UPDATE klienci SET ${kolumny.map((k) => `${k} = ?`).join(', ')}, zmienione_at = ? WHERE id = ?`,
    ).run(...wartosci(dane), kiedy, Number(id));
    if (info.changes === 0) throw bladOperatora('Nie ma takiego klienta w bazie.');
    return Number(id);
  } catch (e) {
    throw kolizja(db, e, dane, Number(id));
  }
}

/**
 * Kolizja unikalności przetłumaczona na zdanie, które mówi, CO ZROBIĆ.
 *
 * ⚠️⚠️ PRZYCZYNY SZUKAMY W BAZIE, A NIE W TREŚCI KOMUNIKATU — i to jest poprawka po pomiarze
 * (21.08.2026, złapane testem). Pierwsza wersja rozpoznawała kolizję NIP-u po nazwie indeksu
 * (`klienci_nip`) w komunikacie SQLite. Zmierzone na node:sqlite: komunikat nazwy indeksu
 * NIE ZAWIERA, więc kolizja NIP-u wpadała do gałęzi zapasowej i panel mówił „Klucz jest już
 * zajęty" — obwiniając pole, które było w porządku, i wskazując operatorowi poprawkę, po
 * której odbiłby się drugi raz. Komunikaty silnika to tekst, który wolno pokazać, a nie
 * dana, na której wolno oprzeć regułę.
 *
 * `pomijajacId` wyłącza z porównania sam poprawiany wiersz: przy edycji własny NIP i własny
 * klucz z definicji „już są w bazie" i nie są kolizją.
 */
// ⚠️⚠️ MIGRACJA JEDNORAZOWA, ZE ZNACZNIKIEM — wzorzec `wgrajDaneStartowe` (db/dane-miesieczne.js).
// Migracje chodza przy KAZDYM starcie kontenera; bez znacznika najblizsze wdrozenie po cichu
// skasowaloby stawke poprawiona reka czlowieka na karcie.
const MIGRACJA_UMOWY = 'klienci/umowa-zbiorcza-z-env';

/**
 * Przenosi warunki umowy zbiorczej z `OMS_KLIENCI_ZBIORCZY` na karty klientow (2026-08-24).
 *
 * ⚠️ DOPASOWANIE PO NIP-IE, nie po kluczu — tak samo jak cala reszta tej tabeli. Klucz
 * w `.env` bywal literowka, NIP jest wlasciwoscia podmiotu.
 *
 * ⚠️ NIP-U SPOZA BAZY MIGRACJA NIE ZAKLADA. Siedmiopolowy ciag z `.env` nie zawiera ani
 * adresu, ani danych do faktury, wiec powstalby klient-wydmuszka, ktory wyglada jak wpis
 * i nie da sie z niego wystawic dokumentu. Taki wpis idzie do logu startowego i czeka
 * na czlowieka.
 *
 * ⚠️ NIE RUSZA `rabat_procent`. Baza jest zrodlem stawki rabatu od 2026-08-23
 * (przewodnik 4.52), a liczba w `.env` bywa nieaktualna — przenosimy WYLACZNIE to,
 * czego baza jeszcze nie ma.
 */
export function wgrajUmowyZbiorczeZKonfiguracji(db, env = process.env, log = () => {}) {
  const juz = db.prepare('SELECT 1 AS x FROM migracje_jednorazowe WHERE nazwa = ?').get(MIGRACJA_UMOWY);
  if (juz) return { pominieta: true, wgranych: 0, nietkniete: [], bezKlienta: [] };

  const wpisy = parsujKlientowZbiorczych(env);
  const bezKlienta = [];
  const nietkniete = [];
  let wgranych = 0;
  for (const wpis of wpisy) {
    const klient = klientPoNip(db, wpis.nip);
    if (!klient) { bezKlienta.push(`${wpis.klucz} (NIP ${wpis.nip})`); continue; }
    // ⚠️ STRAZ NA WIERSZU, NIEZALEZNA OD ZNACZNIKA: karta, ktora KTOKOLWIEK juz ustawil,
    // jest nietykalna. Sam znacznik by nie wystarczyl — przebieg bez znacznika (bo w tej
    // samej rundzie brakowalo innego klienta, patrz nizej) inaczej cofalby poprawke
    // czlowieka przy nastepnym starcie kontenera.
    if (Number(klient.rozliczenie_zbiorcze) === 1) { nietkniete.push(wpis.klucz); continue; }
    db.prepare(
      'UPDATE klienci SET rozliczenie_zbiorcze = 1, prog_darmowej_dostawy_gr = ?,'
      + ' oplata_obslugi_gr = ?, oplata_kurierska_gr = ?, zmienione_at = ? WHERE id = ?',
    ).run(wpis.progDarmowejDostawyGr, wpis.oplataObslugiGr, wpis.oplataKurierskaGr, teraz(), klient.id);
    wgranych += 1;
  }
  if (bezKlienta.length) {
    log(`OMS_KLIENCI_ZBIORCZY: brak w bazie stałych klientów — ${bezKlienta.join(', ')}.`
      + ' Ci klienci NIE mają dziś warunków umowy; załóż ich na ekranie Klienci.');
  }

  // ⚠️⚠️ ZNACZNIK STAWIAMY DOPIERO WTEDY, GDY NIE ZOSTALO NIC DO PRZENIESIENIA — czyli gdy
  // KAZDY wpis z `.env` znalazl swojego klienta. Znacznik postawiony „zawsze" zamykalby
  // migracje takze wtedy, gdy przeniesc sie nie udalo: usluga wstajaca RAZ przed wpisaniem
  // klienta do bazy (albo przed ustawieniem zmiennej) odhaczalaby przeniesienie, ktorego
  // nigdy nie bylo, a warunki umowy trzeba by potem wklepac recznie — nie wiedzac nawet,
  // ze trzeba. Nieodhaczona migracja kosztuje jeden parsing zmiennej na start i krzyczy
  // w logu; odhaczona po pustym przebiegu kosztuje ciche pieniadze.
  //
  // ⚠️ Z TEGO SAMEGO POWODU nie stawiamy go przy PUSTEJ zmiennej: przebieg, ktory nie mial
  // czego przeniesc, niczego nie przeniosl. Usluga podniesiona raz bez `OMS_KLIENCI_ZBIORCZY`
  // (albo z literowka w nazwie zmiennej) zamknelaby wtedy migracje na zawsze.
  if (wpisy.length && !bezKlienta.length) {
    db.prepare('INSERT OR IGNORE INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?,?)')
      .run(MIGRACJA_UMOWY, teraz());
  }
  return {
    pominieta: false, wgranych, nietkniete, bezKlienta,
  };
}

function kolizja(db, e, dane, pomijajacId) {
  if (!String(e?.message ?? '').includes('UNIQUE')) return e;
  const inny = (kolumna, wartosc) => (wartosc == null || wartosc === ''
    ? null
    : db.prepare(`SELECT nazwa FROM klienci WHERE ${kolumna} = ? AND id IS NOT ?`).get(wartosc, pomijajacId));

  const poNip = inny('nip', dane.nip);
  if (poNip) {
    return bladOperatora(
      `NIP ${dane.nip} ma już w bazie innego klienta („${poNip.nazwa}"). Dwa wpisy na jeden `
      + 'podmiot znaczyłyby, że panel musi wybrać jeden z nich przy podpowiadaniu danych — '
      + 'i zrobiłby to po cichu. Popraw tamten wpis zamiast zakładać drugi.',
    );
  }
  if (inny('klucz', dane.klucz)) {
    return bladOperatora(`Klucz „${dane.klucz}" jest już zajęty — wybierz inny.`);
  }
  // Kolizja, której nie umiemy nazwać, ma polecieć dalej NIETKNIĘTA. Zmyślony komunikat
  // wysłałby operatora poprawiać pole, które jest w porządku.
  return e;
}

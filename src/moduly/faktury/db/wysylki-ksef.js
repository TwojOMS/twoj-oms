// ⚠️⚠️ REZERWACJA PRZED WYSŁANIEM DOKUMENTU DO KSeF (przewodnik 4.2). Jedyna bariera przed
// DRUGIM ZGŁOSZENIEM TEGO SAMEGO DOKUMENTU U ORGANU — a duplikatu w KSeF nie da się skasować,
// zostaje wyłącznie korekta.
//
// Dlaczego sam `ksef_number` nie wystarczał: inFakt nadaje ten numer dopiero po ~70 sekundach
// od przyjęcia zlecenia (docblock `wyslijDokumentDoKsef` w infakt/client.js), więc przez te
// siedemdziesiąt sekund przeliczenie zbioru jest ŚLEPE na wysyłkę, którą panel sam przed
// chwilą zlecił. Przycisk zatwierdzenia jest zwykłym formularzem, panel nie ma JavaScriptu
// i celowo nie przekierowuje po wysyłce — dwuklik, back+resubmit i dwie otwarte karty
// podglądu to zwykłe drogi do drugiego, NIEODWRACALNEGO zgłoszenia.
//
// To ten sam wzorzec, co `rozpocznijFakture` i `zajmijWysylkeDoAllegro` (db/faktury.js):
// druga próba odbija się od BAZY, a nie od odczytu sprzed kilkuset milisekund.

const teraz = () => new Date().toISOString();

/** Wiersz rezerwacji albo `undefined` — po nim ekran mówi, KIEDY panel zlecił wysyłkę. */
export function wysylkaKsef(db, uuid) {
  return db.prepare('SELECT * FROM wysylki_ksef WHERE uuid = ?').get(uuid);
}

/**
 * Atomowe zajęcie dokumentu do wysyłki. Oddaje `{ zajete, wiersz }`.
 *
 * ⚠️ SPRAWDZENIE I ZAPIS SĄ JEDNĄ INSTRUKCJĄ — dokładnie jak w `rozpocznijFakture`. Odczyt
 * „czy już wysyłaliśmy?", a po nim osobny INSERT, to ta sama luka, tylko węższa: SQLite
 * serializuje POJEDYNCZY INSERT, więc z dwóch równoległych zatwierdzeń dokładnie jedno
 * dostanie `changes === 1`.
 *
 * ⚠️⚠️ TO NIE JEST DZIERŻAWA — i to jest zasadnicza różnica wobec `zajmijWysylkeDoAllegro`,
 * gdzie zajęcie starsze niż próg zdejmuje się samo. Tam wolno było uznać wiszącą rezerwację
 * za sierotę po restarcie procesu, bo ponowiony `PUT .../file` PODMIENIA plik. Tu nie ma czego
 * podmienić i NIE MA BEZPIECZNEGO SPOSOBU, żeby PO CZASIE stwierdzić, że przyjęte zlecenie nie
 * doszło do organu: zerwane połączenie znaczy „NIE WIADOMO", a dokumenty mogą już być w KSeF
 * nieodwracalnie. Żaden upływ czasu tego wiersza nie zdejmuje, a jedynym poprawnym następnym
 * krokiem jest CZŁOWIEK sprawdzający w inFakcie.
 *
 * Zdejmuje go WYŁĄCZNIE `zwolnijWysylkeKsef` niżej — i tylko wtedy, gdy panel WIE, że
 * dokument do organu nie poszedł.
 */
export function zajmijWysylkeKsef(db, uuid, { numer = null, kiedy = teraz() } = {}) {
  const info = db.prepare(
    'INSERT INTO wysylki_ksef (uuid, zlecona_at, numer) VALUES (?, ?, ?) ON CONFLICT(uuid) DO NOTHING',
  ).run(uuid, kiedy, numer);
  if (Number(info.changes) === 1) return { zajete: true, wiersz: null };
  return { zajete: false, wiersz: wysylkaKsef(db, uuid) ?? null };
}

/**
 * Zdjęcie rezerwacji — WYŁĄCZNIE po awarii JEDNOZNACZNEJ.
 *
 * ⚠️⚠️ TA FUNKCJA ISTNIEJE, ŻEBY PANEL NIE WCHODZIŁ W STAN BEZ WYJŚCIA (niezmiennik 4.9,
 * powracający tryb awarii tego projektu). Rezerwacja trwała przy KAŻDYM wyniku zamykała
 * dokument NA ZAWSZE także wtedy, gdy inFakt zgłoszenie ODRZUCIŁ (4xx) albo gdy do
 * wywołania w ogóle nie doszło: panel odmawiał wysyłki, której organ nigdy nie dostał,
 * a jedynym wyjściem była ręczna wysyłka w inFakcie.
 *
 * ⚠️⚠️ WOLNO JĄ WYWOŁAĆ WYŁĄCZNIE TAM, GDZIE PANEL WIE, ŻE DOKUMENT DO ORGANU NIE POSZEDŁ:
 * inFakt odpowiedział i odmówił (4xx), albo `wyslijDokumentDoKsef` nie zostało w ogóle zawołane.
 * Wynik NIEJEDNOZNACZNY — zerwane połączenie, timeout, 5xx po wysłaniu żądania — NIE JEST
 * dowodem, że zlecenie nie doszło (docblock `wyslijDokumentDoKsef` w infakt/client.js mówi „nie
 * wiadomo", nigdy „nie poszło"). Zwolnienie po nim otwiera drogę do DRUGIEGO zgłoszenia
 * tego samego dokumentu u organu, a duplikatu w KSeF nie da się skasować — zostaje korekta.
 * To dokładnie ta sama granica, co `zwolnijFakture` / `oznaczFaktureDoWyjasnienia`
 * w db/faktury.js.
 *
 * ⚠️ ZWOLNIENIE NIE JEST PONOWIENIEM. Nie woła niczego i niczego nie planuje — otwiera
 * wyłącznie drogę CZŁOWIEKOWI, który poprawi dane i zatwierdzi wysyłkę jeszcze raz.
 */
export function zwolnijWysylkeKsef(db, uuid) {
  db.prepare('DELETE FROM wysylki_ksef WHERE uuid = ?').run(uuid);
}

export function createZapytania(db) {
  return {
    wysylkaKsef: (...args) => wysylkaKsef(db, ...args),
    zajmijWysylkeKsef: (...args) => zajmijWysylkeKsef(db, ...args),
    zwolnijWysylkeKsef: (...args) => zwolnijWysylkeKsef(db, ...args),
  };
}

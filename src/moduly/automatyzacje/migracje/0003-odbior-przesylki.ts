import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-108.09 (zmiana C2 planu automatyzacji) — chwila, w której OMS PIERWSZY RAZ zobaczył dowód, że kurier odebrał paczkę
// (biała lista, domena/dowod-odbioru.js), i kod tego dowodu. Zapisuje je wyłącznie `odswiezStatusKuriera` (czuwacz co
// godzinę i karta), raz — `WHERE odebrana_at IS NULL`.
//
// Dlaczego nowa kolumna, a nie `status_kuriera_at`: tabela trzyma tylko NAJNOWSZY stan kuriera, a jego czas to czas
// zdarzenia u kuriera (DPD bez strefy) — przesuwa się z każdym kolejnym skanem i jest do godziny starszy niż chwila,
// w której OMS go zobaczył. Detektor zdarzenia czyta kursorem `odebrana_at >= od` (nasz zegar, ISO z `Z`) — bez tej
// kolumny kursor gubiłby odbiory zapisane z opóźnieniem, a pominięte wykonanie otwierałoby się przy każdym nowym skanie.
//
// Numer 0003, nie 0002: 0002 (indeksy detektorów C1) dokłada równolegle poprawka recenzji C1 (PRZ-108.08) — kierownik
// pętli 21.10. Luka w numeracji jest dozwolona (core/baza.ts sortuje i sprawdza każdy numer osobno).
// ⚠️ Kolumny tabeli rdzenia w module automatyzacji: czyta je tylko ten moduł (detektor „Kurier odebrał paczkę”), a zapis
// w module wysyłki jest osłonięty (`zapiszLubOdpusc`) — na bazie otwartej bez modułu automatyzacji (testy, skrypty
// samym rdzeniem) zapis cicho się nie odbywa i nic poza nim się nie zmienia.
// Addytywna: dwie kolumny NULL (istniejące paczki — NULL; odbiór sprzed migracji uzupełni najbliższe odświeżenie statusu)
// i zwykły indeks pod kursor. Odporna na ponowne uruchomienie.
export const migracjaOdbioruPrzesylki: Migracja = {
  numer: 3,
  nazwa: 'chwila odbioru przesyłki przez kuriera',
  wykonaj(db) {
    const kolumny = new Set(db.prepare('PRAGMA table_info(przesylki)').all().map((k) => (k as { name: string }).name));
    if (!kolumny.has('odebrana_at')) db.exec('ALTER TABLE przesylki ADD COLUMN odebrana_at TEXT');
    if (!kolumny.has('odebrana_dowod')) db.exec('ALTER TABLE przesylki ADD COLUMN odebrana_dowod TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS przesylki_odebrana_at ON przesylki(odebrana_at)');
  },
};

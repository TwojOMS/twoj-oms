// Wybór dla całej firmy, bez migracji i bez pamięci podręcznej.

const KLUCZ = 'ksef.konsumenckie';

export function czyWysylacKonsumenckie(db) {
  return db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc === '1';
}

export function zapiszKonsumenckie(db, wlaczone) {
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ, wlaczone ? '1' : '0', new Date().toISOString());
}

// Przy TwojeFaktury PDF faktury konsumenckiej dla nabywcy powstaje — jak przy B2B —
// dopiero z numerem KSeF (KOD I). Przy wyłączonym przełączniku konsumencka do KSeF nie idzie, więc numeru nie dostanie.
// Ten sam przełącznik (klucz `ksef.konsumenckie`) stoi na DWÓCH ekranach, zależnie od programu:
// - inFakt: ekran inFaktu (ustawienia-infakt.ejs, id="ksef-konsumenckie"), menu Integracje → Sklepy i usługi → sekcja
//   Faktury; nazwa ekranu ze wspólnej odmiany (strażnik nazw w tests/core/straznik-programu-fakturowego-prz118.test.js);
// - TwojeFaktury: Ustawienia → Faktury i podatki → KSeF (ustawienia-ksef-sprzedazy.ejs,
//   id="ksef-konsumenckie"; zmienia tylko administrator) — zdanie KONSUMENCKIE_POZA_KSEF_TF.
// Zdanie mówi, gdzie włączyć: odmowa pobrania PDF w adapterze TwojeFaktury (wersja TF), podgląd maila „Faktura”
// (treść odmowy adaptera) i ostrzeżenie na ekranie automatu KSeF (wersja TF).
export const KONSUMENCKIE_POZA_KSEF_TF = 'faktury konsumenckie (nabywca bez NIP-u) nie idą teraz do KSeF — PDF dla nabywcy '
  + 'będzie gotowy po włączeniu „Wysyłaj do KSeF także faktury konsumenckie” (Ustawienia → Faktury i podatki → KSeF, sekcja „Faktury konsumenckie w KSeF”) '
  + 'i przyjęciu przez KSeF';

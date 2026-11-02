// PRZ-102.26: wybór właściciela dla całej firmy, bez migracji i bez pamięci podręcznej.
import { NAZWA_ZAPASOWA } from '../../../domena/nazwa-programu.js';

const KLUCZ = 'ksef.konsumenckie';

export function czyWysylacKonsumenckie(db) {
  return db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc === '1';
}

export function zapiszKonsumenckie(db, wlaczone) {
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ, wlaczone ? '1' : '0', new Date().toISOString());
}

// PRZ-122.B2C-QR (decyzja właściciela 28.10): przy TwojeFaktury PDF faktury konsumenckiej dla nabywcy powstaje — jak przy B2B —
// dopiero z numerem KSeF (KOD I). Przy wyłączonym przełączniku konsumencka do KSeF nie idzie, więc numeru nie dostanie.
// Ten sam przełącznik (klucz `ksef.konsumenckie`) stoi na DWÓCH ekranach, zależnie od programu:
// - inFakt: ekran inFaktu (ustawienia-infakt.ejs, id="ksef-konsumenckie"), menu Integracje → Sklepy i usługi → sekcja
//   Faktury; nazwa ekranu ze wspólnej odmiany (strażnik nazw PRZ-118.10) — zdanie KONSUMENCKIE_POZA_KSEF;
// - TwojeFaktury (PRZ-126.C04): Ustawienia → Integracje → Moduł faktur → Wysyłka do KSeF (ustawienia-ksef-sprzedazy.ejs,
//   id="ksef-konsumenckie"; zmienia tylko administrator) — zdanie KONSUMENCKIE_POZA_KSEF_TF.
// Zdanie mówi, gdzie włączyć: odmowa pobrania PDF w adapterze TwojeFaktury (wersja TF), podgląd maila „Faktura”
// (treść odmowy adaptera) i ostrzeżenie na ekranie automatu KSeF (wersja TF — PRZ-126.J01).
export const KONSUMENCKIE_POZA_KSEF = 'faktury konsumenckie (nabywca bez NIP-u) nie idą teraz do KSeF — PDF dla nabywcy '
  + 'będzie gotowy po włączeniu „Wysyłaj do KSeF także faktury konsumenckie” (Ustawienia → Integracje → Sklepy i usługi '
  + `→ ${NAZWA_ZAPASOWA.mianownik}, sekcja „Faktury konsumenckie w KSeF”) i przyjęciu przez KSeF`;
export const KONSUMENCKIE_POZA_KSEF_TF = 'faktury konsumenckie (nabywca bez NIP-u) nie idą teraz do KSeF — PDF dla nabywcy '
  + 'będzie gotowy po włączeniu „Wysyłaj do KSeF także faktury konsumenckie” (Ustawienia → Integracje → Moduł faktur '
  + '→ Wysyłka do KSeF, sekcja „Faktury konsumenckie w KSeF”) i przyjęciu przez KSeF';

// Stan faktury CZYTANY z wiersza rezerwacji. Jedno miejsce, bo tej samej odpowiedzi
// potrzebują trzy niezależne warstwy: baza (komunikat przy kolizji), lista robocza
// (czy zamówienie ma zostać na widoku) i karta (co pokazać i czy dać przycisk).
//
// UWAGA na `f.ksef_status` niżej: kolumna trzyma DWIE różne rzeczy pod jedną nazwą —
// wewnętrzny stan panelu ('w_toku', 'do_wyjasnienia', patrz db/faktury.js) ORAZ, po
// sukcesie, cokolwiek inFakt oddał w polu `ksef_data` (puste, dopóki dokument nie pójdzie
// do KSeF — a panel tam nigdy sam nie wysyła, patrz infakt/client.js). Nazwa kolumny
// ZOSTAJE mimo tego dualizmu (migracja na żywej bazie nie jest tego warta) — nie koliduje,
// bo funkcja niżej sprawdza wewnętrzne stany JAKO PIERWSZE, a wszystko inne (w tym NULL
// z pustego `ksef_data`) czyta jako „wystawiona".
//
// Rezerwacja 'w_toku' powstaje PRZED wywołaniem inFaktu i normalnie żyje sekundy.
// Jeśli proces panelu padnie dokładnie w trakcie tego wywołania, wiersz zostaje
// na zawsze — a panel w nieskończoność odpowiada „właśnie trwa, odśwież za chwilę".
// Po tym progu przestajemy udawać, że coś trwa: to sierota wymagająca decyzji człowieka,
// dokładnie tak samo jak 'do_wyjasnienia'.
//
// Próg z zapasem: pojedyncze wystawienie to trzy żądania HTTP do inFaktu, a KSeF
// potrafi odpowiadać wolno. Pięć minut jest bezpiecznie ponad każdym realnym czasem
// wywołania, a jednocześnie nie skazuje zamówienia na czekanie do końca świata.
export const PROG_ZAWIESZONEJ_FAKTURY_MS = 5 * 60 * 1000;

// 'brak' — nie ma rezerwacji, wolno wystawiać.
// 'w_toku' — wywołanie inFaktu naprawdę trwa; czekamy.
// 'zawieszona' — rezerwacja osierocona (restart procesu w trakcie wywołania).
// 'do_wyjasnienia' — wywołanie inFaktu zerwało się tam, gdzie dokument mógł powstać.
// 'wystawiona' — jest numer/dokument.
export function stanFaktury(f, teraz = Date.now()) {
  if (!f) return 'brak';
  if (f.ksef_status === 'do_wyjasnienia') return 'do_wyjasnienia';
  if (f.ksef_status !== 'w_toku') return 'wystawiona';
  const start = Date.parse(f.utworzona_at ?? '');
  // Nieczytelna data NIE jest dowodem, że wywołanie trwa. Uznanie jej za „trwa"
  // dawałoby dokładnie tę wieczną blokadę, której ten stan ma zapobiegać — a
  // odblokowanie i tak wymaga człowieka, który najpierw sprawdzi inFakt.
  if (!Number.isFinite(start)) return 'zawieszona';
  return teraz - start >= PROG_ZAWIESZONEJ_FAKTURY_MS ? 'zawieszona' : 'w_toku';
}

// Stany, z których panel sam nie wyjdzie: rozstrzyga człowiek po zajrzeniu do inFaktu.
export function fakturaWymagaCzlowieka(f, teraz = Date.now()) {
  return ['do_wyjasnienia', 'zawieszona'].includes(stanFaktury(f, teraz));
}

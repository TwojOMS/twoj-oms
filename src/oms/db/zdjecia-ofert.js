// Pamięć podręczna zdjęć OFERT Allegro (tabela `zdjecia_ofert`).
//
// ⚠️ DLACZEGO OSOBNA TABELA, A NIE KOLUMNA W `pozycje` — uzasadnienie w całości stoi przy
// `CREATE TABLE zdjecia_ofert` w db/schema.sql. W skrócie: poller kasuje i wstawia pozycje
// sklepowe co dwie minuty (przewodnik OMS, 4.7), więc adres zapisany przy pozycji przepadałby
// przy każdej synchronizacji, a panel odpytywałby Allegro o to samo 720 razy na dobę.
// Zdjęcie należy do OFERTY, nie do pozycji zamówienia.

const teraz = () => new Date().toISOString();

// ⚠️ ILE CZEKAMY PRZED PONOWIENIEM NIEUDANEJ PRÓBY. Wiersz z niepustym `blad` znaczy
// „pytaliśmy i się nie udało" — czyli coś zupełnie innego niż brak wiersza („jeszcze nie
// pytaliśmy") i niż wiersz z pustym adresem bez błędu („oferta zdjęcia nie ma").
//
// Doba, a nie „nigdy" i nie „przy każdym przebiegu":
//   * „przy każdym przebiegu" znaczyłoby, że oferta skasowana z Allegro (403/404 na zawsze)
//     kosztuje zapytanie CO DWIE MINUTY, i to bez końca — dokładnie ta klasa awarii, przed
//     którą broni dławik godzinowy przy numerach listów (routes/zamowienia.js);
//   * „nigdy" byłoby gorsze w drugą stronę: jeden timeout albo jedna pięćsetka Allegro
//     zabierałaby zdjęcie tej oferty NA ZAWSZE, bez żadnego wyjścia poza ręcznym DELETE
//     w bazie — czyli wprost naruszenie niezmiennika 4.9 (panel nie wchodzi w stan, z którego
//     nie umie wyjść).
// Doba to jedno zapytanie dziennie na martwą ofertę — koszt niemierzalny, a droga powrotna
// dla awarii przejściowej zostaje otwarta.
export const PONOWIENIE_PO_MS = 24 * 60 * 60 * 1000;

/**
 * Oferty TEGO kanału, o których zdjęcie warto zapytać: nieznane w ogóle albo takie, których
 * poprzednia próba się nie udała i odczekała już `ponowieniePoMs`.
 *
 * ⚠️ ZAWĘŻENIE DO KANAŁU JEST KONIECZNE, a nie porządkowe. `GET /sale/product-offers/{id}`
 * oddaje WŁASNĄ ofertę zalogowanego sprzedawcy — oferta drugiego konta odbiłaby się od
 * Allegro błędem, a my zapisalibyśmy ten błąd jako fakt o ofercie. Kanał bierzemy
 * z `zamowienia.sklep`, czyli z tej samej kolumny, która rozdziela pollery, stan
 * synchronizacji i pary tokenów.
 *
 * ⚠️ `LIMIT` NIE JEST OSTROŻNOŚCIĄ NA ZAPAS. Pierwszy przebieg po wdrożeniu widzi WSZYSTKIE
 * oferty z archiwum naraz; bez ograniczenia jedno tyknięcie zegara zamieniłoby się w setki
 * żądań do Allegro w jednej serii. Produktów są dziesiątki, więc przy takim tempie pamięć
 * i tak zapełnia się w kilku przebiegach, a potem ruch spada prawie do zera — nowa oferta
 * pojawia się tylko razem z nowym produktem.
 */
export function ofertyDoSprawdzenia(db, kanal, { limit, ponowieniePoMs = PONOWIENIE_PO_MS, at = teraz() } = {}) {
  const granica = new Date(new Date(at).getTime() - ponowieniePoMs).toISOString();
  return db.prepare(
    'SELECT DISTINCT p.oferta_id AS oferta_id FROM pozycje p'
    + ' JOIN zamowienia z ON z.id = p.zamowienie_id'
    + ' LEFT JOIN zdjecia_ofert o ON o.oferta_id = p.oferta_id'
    + " WHERE z.sklep = ? AND p.oferta_id IS NOT NULL AND p.oferta_id <> ''"
    // Brak wiersza = jeszcze nie pytaliśmy. Wiersz z błędem wraca dopiero po odczekaniu.
    // Wiersz z adresem ORAZ wiersz „oferta zdjęcia nie ma" (oba pola puste, `blad` NULL)
    // nie wracają NIGDY — i to jest cała różnica między „nie próbowaliśmy" a „próbowaliśmy".
    + '   AND (o.oferta_id IS NULL OR (o.blad IS NOT NULL AND o.sprawdzone_at < ?))'
    // Porządek deterministyczny: przy limicie musi być wiadomo, które oferty wchodzą do tego
    // przebiegu, a które do następnego — inaczej zestaw potrafiłby się zapętlić na tych
    // samych kilku, a reszta nie doczekałaby się nigdy.
    + ' ORDER BY p.oferta_id LIMIT ?',
  ).all(kanal, granica, limit).map((w) => w.oferta_id);
}

/**
 * Zapisuje WYNIK próby — udanej albo nie. Zawsze jeden wiersz na ofertę.
 *
 * ⚠️ ZAPIS IDZIE TAKŻE PRZY BŁĘDZIE i to jest sedno: bez niego nieudana próba byłaby
 * nieodróżnialna od „jeszcze nie pytaliśmy", więc oferta wracałaby do kolejki przy KAŻDYM
 * przebiegu pollera — co dwie minuty, w nieskończoność.
 */
export function zapiszProbeZdjecia(db, ofertaId, { zdjecieUrl = null, blad = null, at = teraz() } = {}) {
  db.prepare(
    'INSERT INTO zdjecia_ofert (oferta_id, zdjecie_url, sprawdzone_at, blad) VALUES (?,?,?,?)'
    + ' ON CONFLICT(oferta_id) DO UPDATE SET zdjecie_url = excluded.zdjecie_url,'
    + ' sprawdzone_at = excluded.sprawdzone_at, blad = excluded.blad',
  ).run(String(ofertaId), zdjecieUrl, at, blad);
}

/**
 * Wiersz pamięci dla jednej oferty — do testów i do diagnozy. Panel czyta zdjęcia
 * ZŁĄCZENIEM przy odczycie pozycji (db/zamowienia.js), a nie tą funkcją: zapytanie na
 * pozycję znaczyłoby kilkadziesiąt zapytań na jedno otwarcie listy.
 */
export function zdjecieOfertyZBazy(db, ofertaId) {
  return db.prepare('SELECT * FROM zdjecia_ofert WHERE oferta_id = ?').get(String(ofertaId)) ?? null;
}

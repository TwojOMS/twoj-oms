import { bladOperatora } from '../../../domena/bledy.js';
import { stanFaktury, fakturaWymagaCzlowieka } from '../../../domena/faktura-stan.js';
import { idDokumentuSql } from '../../../domena/dokument-programu.js';
import { NAZWA_ZAPASOWA } from '../../../domena/nazwa-programu.js';

const teraz = () => new Date().toISOString();

// Kolizja `UNIQUE (zamowienie_id)` na tabeli faktur, rozpoznawana tak samo jak przy
// przesylkach: po PELNEJ sygnaturze kolumnowej, a nie po samym /UNIQUE/i. SQLite podaje
// w komunikacie tabele i kolumny, nigdy nazwy ograniczenia — a dopasowanie do samego
// slowa UNIQUE zaczeloby klamac operatorowi przy kazdym innym ograniczeniu na tej tabeli.
const SYGNATURA_KOLIZJI = 'UNIQUE constraint failed: faktury.zamowienie_id';

function wiersz(db, zamowienieId) {
  return db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(zamowienieId);
}

// PRZ-118.09: `nazwa` = odmiana nazwy programu fakturowego (domyślnie inFakt — domena/nazwa-programu.js).
function opisKolizji(f, nazwa = NAZWA_ZAPASOWA) {
  const stan = stanFaktury(f);
  if (stan === 'do_wyjasnienia') {
    return 'Poprzednia próba wystawienia faktury zerwała się w miejscu, w którym dokument mógł już powstać'
      + `${f.blad_opis ? ` (${f.blad_opis})` : ''}. `
      + `Sprawdź RĘCZNIE w ${nazwa.miejscownik}, czy faktura do tego zamówienia istnieje. Jeśli jej tam nie ma — `
      + 'odblokuj zamówienie przyciskiem na karcie. Jeśli JEST i jeszcze nie poszła do KSeF '
      + '(wysyłkę robi właściciel ręcznie, wieczorem), po prostu ją tam skasuj, dopiero potem odblokuj — '
      + 'panel jej sam nie ponowi, żeby drugie kliknięcie nie dołożyło drugiego dokumentu. '
      + 'Jeśli już poszła do KSeF, została po niej tylko KOREKTA, nie kasowanie.';
  }
  // Rezerwacja starsza niz prog to sierota po restarcie procesu, a nie trwajace wywolanie.
  // Odpowiedz „wlasnie trwa" byla tu wieczna: nic jej nigdy nie zdejmowalo.
  if (stan === 'zawieszona') {
    return `Rezerwacja faktury wisi od ${f.utworzona_at} i żadne wystawianie już nie trwa — `
      + `panel najpewniej został zrestartowany w trakcie wywołania ${nazwa.dopelniacz}. `
      + `Sprawdź RĘCZNIE w ${nazwa.miejscownik}, czy faktura do tego zamówienia powstała; jeśli nie, `
      + 'odblokuj zamówienie przyciskiem na karcie.';
  }
  if (stan === 'w_toku') return 'Wystawianie faktury do tego zamówienia właśnie trwa.';
  return `Faktura do tego zamówienia jest już wystawiona${f.numer ? ` (${f.numer})` : ''}.`;
}

// Wiersz powstaje PRZED wywolaniem inFaktu i to jest cala idempotencja: druga proba
// (dwuklik, dwie karty, dwa zapytania rownolegle) odbija sie od unikalnego indeksu
// w bazie, a nie od odczytu `z.faktura` sprzed kilkuset milisekund.
export function rozpocznijFakture(db, zamowienieId, { nazwa = NAZWA_ZAPASOWA } = {}) {
  try {
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', ?)")
      .run(zamowienieId, teraz());
  } catch (e) {
    const f = String(e.message).includes(SYGNATURA_KOLIZJI) ? wiersz(db, zamowienieId) : null;
    if (f) throw bladOperatora(opisKolizji(f, nazwa));
    throw e;
  }
  return wiersz(db, zamowienieId);
}

// PRZ-118.03 — podwojny zapis identyfikatora: `program` + `dokument_id` zawsze, a `infakt_uuid`
// WYLACZNIE dla inFaktu (obraz sprzed zmiany czyta tylko te kolumne i pyta nia inFakt — cudzy
// identyfikator w niej kazalby mu pytac o nie swoje dokumenty). JEDNA instrukcja: trzy kolumny
// nie rozjada sie przy awarii w polowie. Brak `program` = inFakt (dzisiejsi wolajacy).
export function zakonczFakture(db, id, { uuid, numer, ksefStatus }, { program = 'infakt' } = {}) {
  if (typeof program !== 'string' || !program) throw new Error('zakonczFakture: brak nazwy programu fakturowego');
  db.prepare(
    'UPDATE faktury SET program = ?, dokument_id = ?, infakt_uuid = ?, numer = ?, ksef_status = ?, blad_opis = NULL'
    + ' WHERE id = ?',
  ).run(program, uuid, program === 'infakt' ? uuid : null, numer, ksefStatus, id);
}

// Numer KSeF przeczytany z inFaktu przez czuwacza (services/czuwacz-ksef.js). Panel do KSeF
// NIGDY nie wysyla — robi to wlasciciel recznie, w ciagu dnia; ten zapis wylacznie ODNOTOWUJE
// fakt, ktory czuwacz tam zobaczyl.
//
// ⚠️ `ksef_sprawdzona_at` zapisujemy ZAWSZE, takze gdy numeru nie ma — to jest data PYTANIA,
// nie odpowiedzi. Sama w sobie nie wystarcza jednak do niczego: „pytalismy" nie znaczy
// „dowiedzielismy sie". Druga polowe niesie `ksef_odczyt` ('ok' / 'blad'), i to NA NIEJ stoi
// sprawa „czeka na KSeF" (domain/sprawy-karty.js) — bo niedostepny inFakt nie jest zadnym
// dowodem na to, ze wlasciciel dokumentu nie wyslal.
//
// ⚠️ COALESCE, a nie zwykle przypisanie: przebieg, ktory numeru nie dostal (inFakt jeszcze go
// nie ma), NIE MA PRAWA skasowac numeru zapisanego wczesniej. Numer KSeF jest jedynym dowodem,
// ze dokument naprawde jest w KSeF — a to warunek wyslania faktury do Allegro.
export function zapiszNumerKsef(db, id, { ksefNumer, sprawdzonaAt }) {
  db.prepare(
    "UPDATE faktury SET ksef_numer = COALESCE(?, ksef_numer), ksef_sprawdzona_at = ?,"
    + " ksef_odczyt = 'ok' WHERE id = ?",
  ).run(ksefNumer ?? null, sprawdzonaAt, id);
}

// Odczyt, ktory sie NIE UDAL. Zapisujemy go z tego samego powodu, dla ktorego zapisujemy udany:
// „pytalismy" jest faktem niezaleznym od odpowiedzi. Do 06.08.2026 ten zapis w ogole nie
// istnial (czuwacz wolal `zapiszNumerKsef` WEWNATRZ `try`), wiec faktura z wiecznym 404 miala
// `ksef_sprawdzona_at = NULL` na zawsze — nie do odroznienia od „nigdy nie pytalismy".
//
// ⚠️ NIE DOTYKA `ksef_numer`: nieudany odczyt nie jest dowodem na nic, a numer raz zapisany
// jest jedynym dowodem, ze dokument jest w KSeF.
export function zapiszNieudanyOdczytKsef(db, id, { sprawdzonaAt, odczyt = 'blad' }) {
  db.prepare('UPDATE faktury SET ksef_sprawdzona_at = ?, ksef_odczyt = ? WHERE id = ?')
    .run(sprawdzonaAt, odczyt, id);
}

// ⚠️⚠️ DWA OSOBNE ZAPISY, I TO JEST CALA REZERWACJA PRZED KROKIEM NIEODWRACALNYM.
//
// `zapiszZgloszenieAllegro` idzie NATYCHMIAST po POST-cie do Allegro, ZANIM poleci plik.
// Allegro przyjmuje DO 10 FAKTUR na zamowienie, wiec ponowiony POST NIE ODBIJE SIE OD
// NICZEGO — u kupujacego narastalyby duplikaty tego samego dokumentu, a panel nie ma czym
// ich stamtad zabrac. Od chwili, gdy ta kolumna jest niepusta, wolno WYLACZNIE doslac plik.
//
// Zdalna lista faktur (`GET .../invoices`) jest tylko POMOCNICZA: oddaje dzis 400, wiec
// klient zwraca pusta liste i tamta galaz milczy (notatka 2026-08-05, §2). Ochrona, na
// ktorej naprawde stoimy, to TA kolumna.
//
// `allegro_wyslana_at` zapisujemy dopiero PO pliku, bo dopiero wtedy kupujacy cokolwiek
// dostal. Sklejenie obu zapisow w jeden zabiloby rezerwacje: przerwanie miedzy POST-em
// a PUT-em zostawialoby pusta kolumne i nastepne klikniecie zglaszaloby DRUGA fakture.
export function zapiszZgloszenieAllegro(db, id, invoiceId) {
  db.prepare('UPDATE faktury SET allegro_invoice_id = ? WHERE id = ?').run(invoiceId, id);
}

// ⚠️⚠️ PROG DZIERZAWY WYSYLKI DO ALLEGRO. Najdluzsze mozliwe wywolanie to suma cierpliwosci
// obu klientow: PDF z inFaktu (60 s) + lista faktur z Allegro (5 s) + POST metadanych (30 s)
// + PUT pliku (30 s) = 125 s. Dziesiec minut jest bezpiecznie ponad tym, a jednoczesnie nie
// skazuje zamowienia na czekanie do konca swiata po restarcie procesu.
//
// Ta sama zasada i ta sama liczba rzedow wielkosci, co PROG_ZAWIESZONEJ_FAKTURY_MS
// (domain/faktura-stan.js) — i z tego samego powodu: rezerwacja, ktorej NIC NIGDY NIE ZDEJMUJE,
// zamienia sie w wieczne „wlasnie trwa".
export const PROG_ZAJECIA_WYSYLKI_MS = 10 * 60 * 1000;

// ⚠️⚠️ ATOMOWE ZAJECIE WYSYLKI FAKTURY DO ALLEGRO — BARIERA PRZED DRUGIM DOKUMENTEM
// U KUPUJACEGO (recenzja Partii 3, K1).
//
// Dokladnie ten sam wzorzec, co `rozpocznijFakture` wyzej i z dokladnie tego samego powodu:
// druga proba (dwuklik, dwie karty, back+resubmit, dwa zapytania rownolegle, OBIE TRASY NARAZ)
// ma sie odbic od WARUNKOWEGO UPDATE-u w bazie, a nie od odczytu `z.faktura` sprzed kilkuset
// milisekund. Miedzy tamtym odczytem a POST-em do Allegro stoja DWA `await`-y (PDF z inFaktu,
// lista faktur z Allegro) — zmierzone: dwa rownolegle `wyslij(id)` dawaly 2 POST-y i 2 pliki,
// oba 302, zero ostrzezen, a baza pamietala tylko DRUGI identyfikator. O pierwszym dokumencie
// panel nie dowiedzialby sie NIGDY, bo `GET .../invoices` oddaje dzis 400.
//
// ⚠️ WARUNEK JEST W KLAUZULI `WHERE`, NIE W `if`-ie NAD NIM. Odczyt-i-zapis w dwoch krokach
// to ta sama luka, tyle ze wezsza — SQLite serializuje POJEDYNCZY UPDATE, wiec dokladnie
// jedno z dwoch rownoleglych wywolan dostanie `changes === 1`.
//
// ⚠️ TO JEST DZIERZAWA, NIE WIECZNY ZAMEK. Zajecie starsze niz `PROG_ZAJECIA_WYSYLKI_MS` jest
// SIEROTA po restarcie procesu (nie trwajacym wywolaniem) i zdejmuje sie samo — bez tego panel
// odpowiadalby „wlasnie trwa" NA ZAWSZE, czyli stan bez wyjscia (niezmiennik 4.9), a to jest
// ta sama pulapka, ktora opisuje `opisKolizji` przy stanie 'zawieszona'.
export function zajmijWysylkeDoAllegro(db, id, { teraz = Date.now(), prog = PROG_ZAJECIA_WYSYLKI_MS } = {}) {
  const znacznik = new Date(teraz).toISOString();
  const sierota = new Date(teraz - prog).toISOString();
  // ⚠️ POROWNANIE TEKSTOWE dat ISO — takie samo, jakiego uzywa kursor pollera i podloga
  // czuwacza. Dziala, bo obie strony sa w tym samym formacie i tej samej strefie.
  const info = db.prepare(
    'UPDATE faktury SET allegro_zgloszenie_at = ? WHERE id = ?'
    + ' AND (allegro_zgloszenie_at IS NULL OR allegro_zgloszenie_at < ?)',
  ).run(znacznik, id, sierota);
  return Number(info.changes) === 1;
}

// ⚠️ ZWALNIANE W `finally`, ZAWSZE — tak samo, jak straznik „jeden przebieg naraz" w czuwaczu
// i w pollerze. Dzierzawa zostawiona po bledzie skazywalaby zamowienie na dziesiec minut
// odmowy przy KAZDYM ponowieniu, a ponowienie po zerwanej sieci jest tu normalna droga:
// `allegro_invoice_id` juz mamy, wiec `PUT .../file` PODMIENIA plik i drugiego dokumentu
// u kupujacego NIE ROBI.
export function zwolnijWysylkeDoAllegro(db, id) {
  db.prepare('UPDATE faktury SET allegro_zgloszenie_at = NULL WHERE id = ?').run(id);
}

// ⚠️⚠️ ODNOTOWANIE, ZE CZUWACZ ZAJAL SIE TYM WIERSZEM (recenzja Partii 3, W6). To jest data
// ZAJECIA SIE, a NIE data odpowiedzi — dokladnie ta sama roznica, co przy `ksef_sprawdzona_at`
// wyzej („pytalismy" nie znaczy „dowiedzielismy sie").
//
// ⚠️ ZAPISUJEMY JA ZAWSZE: po sukcesie, po nieudanym odczycie i przy kanale, ktorego panel nie
// zna. Data zapisywana wylacznie po sukcesie zostawialaby jeden trwale padajacy wiersz NA CZELE
// KOLEJKI NA ZAWSZE — czyli te sama usterke, ktora ta kolumna naprawia, tylko wezsza brama.
//
// Na niej stoi porzadek drugiej petli czuwacza (`NULLS FIRST`): bez niej `ORDER BY
// allegro_wyslana_at LIMIT 50` zakladalo, ze obsluzone wiersze WYPADAJA ze zbioru — a dzis
// nie wypadaja, bo `GET .../invoices` oddaje 400 i status zostaje `WAITING`.
export function zapiszPytanieOWeryfikacje(db, id, kiedy) {
  db.prepare('UPDATE faktury SET allegro_pytana_at = ? WHERE id = ?').run(kiedy, id);
}

export function zapiszWysylkeDoAllegro(db, id, { wyslanaAt, weryfikacja }) {
  db.prepare('UPDATE faktury SET allegro_wyslana_at = ?, allegro_weryfikacja = ? WHERE id = ?')
    .run(wyslanaAt, weryfikacja ?? null, id);
}

// Wynik weryfikacji pliku po stronie Allegro, przeczytany przez czuwacza (services/czuwacz-ksef.js).
//
// ⚠️⚠️ BEZ `status` NIE PISZEMY NIC. Brak naszej faktury na liście z Allegro znaczy „NIE WIEM",
// a nie „nie ma": zasób `GET .../invoices` oddaje dziś 400 na każde nasze zamówienie, więc klient
// zwraca PUSTĄ LISTĘ (notatka 2026-08-05, §2). Zapis pustej wartości skasowałby jedyną wiedzę,
// jaką panel ma — tę z odpowiedzi na `PUT .../file`, czyli z chwili, w której plik naprawdę poszedł.
//
// To ta sama klasa usterki, którą recenzja Partii 2 nazwała „kolumną write-only", tylko odwrócona:
// tam kolumna zapisywana bez czytelnika, tu czytelnik kasowany przez zapis bez treści.
export function zapiszWeryfikacjeAllegro(db, id, status) {
  if (!status) return;
  db.prepare('UPDATE faktury SET allegro_weryfikacja = ? WHERE id = ?').run(status, id);
}

// Awaria JEDNOZNACZNA: inFakt odrzucil zadanie (4xx) albo nie doszlo nawet do proby
// wystawienia — dokumentu na pewno NIE MA. Kasujemy rezerwacje, zeby dalo sie poprawic
// dane (np. brakujaca nazwe firmy) i sprobowac ponownie. Zostawienie wiersza skazywaloby
// zamowienie na wieczny brak faktury.
export function zwolnijFakture(db, id) {
  db.prepare('DELETE FROM faktury WHERE id = ?').run(id);
}

// Awaria NIEJEDNOZNACZNA: zerwane polaczenie albo 5xx PO wyslaniu zadania. Dokument
// w inFakcie mogl powstac i nie ma jak tego sprawdzic z panelu. Wiersz ZOSTAJE i blokuje
// ponowienie — bo drugie klikniecie daloby drugi dokument. Panel go sam nie skasuje ani
// nie ponowi: rozstrzyga czlowiek, ktory sprawdzil w inFakcie. Dopoki dokument (jesli
// w ogole powstal) nie pojedzie wieczorem do KSeF, wystarczy go tam skasowac — po tej
// wysylce zostaje juz tylko KOREKTA.
export function oznaczFaktureDoWyjasnienia(db, id, opis) {
  db.prepare("UPDATE faktury SET ksef_status = 'do_wyjasnienia', blad_opis = ? WHERE id = ?").run(opis, id);
}

// JEDYNE wyjscie ze stanu, ktorego panel sam nie rozstrzygnie. Blokada po niejednoznacznej
// awarii jest sluszna — ale bez tej furtki zamowienie zostawalo bez faktury NA ZAWSZE,
// nawet gdy czlowiek sprawdzil w inFakcie i wie, ze dokumentu nie ma. Zostawala reczna
// operacja na pliku SQLite, czyli dokladnie to, przed czym panel ma chronic.
//
// Kasujemy WYLACZNIE stany wymagajace decyzji czlowieka. Wystawiona faktura jest
// nietykalna: skasowanie jej wiersza zdjeloby blokade z dokumentu, ktory NA PEWNO
// istnieje w inFakcie (a wieczorem, w zbiorczej wysylce, pojedzie do KSeF, o ile
// wlasciciel go wczesniej nie usunie recznie), i nastepne klikniecie daloby drugi.
export function odblokujFakture(db, zamowienieId) {
  const f = wiersz(db, zamowienieId);
  if (!f) throw bladOperatora('To zamówienie nie ma zablokowanej faktury — nie ma czego odblokowywać.');
  if (!fakturaWymagaCzlowieka(f)) {
    if (stanFaktury(f) === 'w_toku') {
      throw bladOperatora('Wystawianie faktury właśnie trwa — poczekaj, aż się skończy, zanim cokolwiek odblokujesz.');
    }
    throw bladOperatora(
      `Faktura do tego zamówienia jest wystawiona${f.numer ? ` (${f.numer})` : ''} — odblokowanie zdjęłoby blokadę `
      + 'z dokumentu, który na pewno istnieje w inFakcie, a kolejne kliknięcie wystawiłoby drugi. '
      + 'Chcesz ją anulować? Skasuj ją w inFakcie (albo, jeśli już poszła do KSeF, wystaw korektę) — panel tego za ciebie nie zrobi.',
    );
  }
  db.prepare('DELETE FROM faktury WHERE id = ?').run(f.id);
  return f;
}

// DRUGIE wyjscie ze stanu, ktorego panel sam nie rozstrzygnie — powstalo 2026-07-30, gdy
// zalozenie stojace za `odblokujFakture` (wystawiona faktura ZAWSZE istnieje w inFakcie,
// wiec jej wiersza NIE WOLNO tykac) przestalo byc prawdziwe. Od tego dnia panel wystawia
// faktury BEZ wysylki do KSeF (wlasciciel wysyla je sam, zbiorczo, wieczorem) — a niewyslana
// faktura wolno po prostu skasowac w inFakcie, tak jak sie skasowaloby zwykla pomylke.
// Bez tej funkcji takie zamowienie zostawaloby zablokowane NA ZAWSZE: UNIQUE (zamowienie_id)
// odmawia drugiego wiersza, a `odblokujFakture` CELOWO odmawia dla kazdej faktury
// wystawionej. To jest ta sama luka co przy `do_wyjasnienia`/`zawieszona` — panel wchodzi
// w stan, z ktorego nie umie wyjsc — ale INNA przyczyna, wiec INNA, jawna trasa: nie
// rozluzniamy odmowy w `odblokujFakture`, dokladamy obok niej osobne wyjscie.
//
// Warunki sa scisle WEZSZE niz przy `odblokujFakture` (ktora dziala na stanach wymagajacych
// TYLKO sprawdzenia), bo tu rozstrzyga FAKT nieodwracalny, a nie niepewnosc:
// - dziala WYLACZNIE na fakturze WYSTAWIONEJ (ma numer/UUID) — kazdy inny stan ('w_toku',
//   'do_wyjasnienia'/'zawieszona') ma juz swoje wlasciwe wyjscie i nie jest tym, co ktos
//   naprawde skasowal w inFakcie;
// - dziala WYLACZNIE, gdy `ksef_status` jest PUSTY. Zgodnie z faktura-stan.js kolumna po
//   sukcesie trzyma to, co inFakt oddal w polu `ksef_data` — puste, dopoki dokument nie
//   pojdzie do KSeF. Niepusta wartosc znaczy, ze inFakt zna dokument w KSeF (wlasciciel
//   mogl go wyslac recznie, pojedynczo, przed wieczorna zbiorcza wysylka) — a takiego
//   dokumentu SIE NIE KASUJE, tylko koryguje. Ta granica jest TWARDA i celowo BEZ furtki:
//   w odroznieniu od `do_wyjasnienia`/`zawieszona`, gdzie wystarczy, ze czlowiek sprawdzil
//   i potwierdzil fakt, tu pomylka jest juz NIEODWRACALNA — dokumentu w KSeF nie cofnie
//   zadne sprawdzenie ani zadne klikniecie w panelu.
//
// Panel NIE WOLA inFaktu i niczego tam NIE KASUJE — to WYLACZNIE odnotowanie faktu, ktory
// czlowiek juz stwierdzil poza panelem: kasujemy lokalny wiersz rezerwacji, zeby zwolnic
// zamowienie do ponownego wystawienia. Numer i UUID skasowanego dokumentu zwracamy wywolujacemu
// (routes/zamowienia.js zapisuje je do logu zamowienia) — bez tego sladu po miesiacu nie da
// sie odtworzyc, co sie z ta faktura stalo.
export function fakturaSkasowanaWInfakcie(db, zamowienieId) {
  const f = wiersz(db, zamowienieId);
  if (!f) throw bladOperatora('To zamówienie nie ma zablokowanej faktury — nie ma czego kasować.');
  const stan = stanFaktury(f);
  if (stan !== 'wystawiona') {
    throw bladOperatora(
      stan === 'w_toku'
        ? 'Wystawianie faktury właśnie trwa — to jeszcze nie jest dokument, który dałoby się skasować w inFakcie. Poczekaj, aż się skończy.'
        : 'Ta rezerwacja nie ma jeszcze numeru dokumentu — to nie jest jeszcze to, co dało się skasować w inFakcie. '
          + 'Jeśli sprawdziłeś tam i dokumentu nie ma, użyj przycisku „Sprawdziłem w inFakcie — faktury nie ma, odblokuj".',
    );
  }
  // ⚠️⚠️ TRZECIA PRZESŁANKA (Plan B, Zadanie 11): DOKUMENT JEST JUŻ NA KONCIE KUPUJĄCEGO
  // W ALLEGRO. Skasowanie faktury w inFakcie NIE ZABIERA JEJ KUPUJĄCEMU Z RĄK — leży u niego
  // i panel nie ma czym jej stamtąd zabrać. Zwolnienie rezerwacji pozwoliłoby wystawić DRUGĄ
  // fakturę na to samo zamówienie: kupujący miałby dwa dokumenty na ten sam towar, a księgowość
  // dwa numery na jedną sprzedaż.
  //
  // ⚠️ TA PRZESŁANKA STOI PRZED KSEF-OWĄ I JEST OD NIEJ NIEZALEŻNA. Faktura wysłana świadomą
  // decyzją „bez numeru KSeF" (trasa faktura-allegro-bez-ksef) ma OBIE kolumny KSeF puste,
  // więc tamta odmowa nie odezwałaby się ani słowem — a dokument u kupującego już leży.
  if (f.allegro_wyslana_at) {
    throw bladOperatora(
      `Faktura ${f.numer ? `${f.numer} ` : ''}została wysłana do Allegro ${f.allegro_wyslana_at} `
      + 'i kupujący ma ją na koncie. Skasowanie jej w inFakcie nie zabiera mu dokumentu, '
      + 'więc panel nie zwolni tego zamówienia — kolejne wystawienie dałoby kupującemu drugą '
      + 'fakturę na ten sam towar. Jeśli dokument jest błędny, potrzebna jest KOREKTA.',
    );
  }
  // ⚠️ DOWODEM „JEST W KSEF" SĄ OBIE KOLUMNY, NIE SAMA `ksef_status` (recenzja Partii 2, K3).
  // `ksef_status` niesie to, co inFakt oddał w polu `ksef_data` W CHWILI WYSTAWIENIA — a panel
  // wystawia BEZ wysyłki do KSeF, więc przy ręcznej wysyłce właściciela ta kolumna zostaje
  // PUSTA NA ZAWSZE. Dowód zbiera dopiero czuwacz (services/czuwacz-ksef.js) i zapisuje go do
  // `ksef_numer`. Bez tego warunku panel WIEDZIAŁ, że dokument jest w KSeF, i dalej pozwalał
  // odnotować jego skasowanie — co zwalnia zamówienie do ponownego wystawienia i wysyła do
  // KSeF DRUGI dokument. Po tym zostaje już tylko korekta.
  //
  // To jest ZAOSTRZENIE odmowy o dowód, który panel dopiero teraz zaczął zbierać. Zadanie 11
  // poluzuje inną odmowę (wysyłkę do Allegro bez numeru KSeF) — świadomie i w innym miejscu.
  const wKsef = f.ksef_numer || f.ksef_status;
  if (wKsef) {
    throw bladOperatora(
      `Dokument ${f.numer ? `${f.numer} ` : ''}poszedł już do KSeF (${wKsef}) — `
      + 'takiego dokumentu się nie kasuje, tylko koryguje. Panel tej operacji nie obsługuje.',
    );
  }
  db.prepare('DELETE FROM faktury WHERE id = ?').run(f.id);
  return f;
}

/**
 * Faktury, przy ktorych wolno odnotowac „skasowalem ja w inFakcie" — lista dla zakladki
 * FAKTURY (przeniesienie z karty zamowienia, prosba właściciela 01.09.2026: „na co dzien jest to
 * nieuzywane").
 *
 * ⚠️⚠️ LISTA IDZIE Z NASZEJ BAZY, NIGDY Z inFAKTU — i to jest cala trudnosc tej przeprowadzki.
 * Zakladka FAKTURY pokazuje dokumenty pobrane z inFaktu NA ZYWO, a faktura skasowana
 * w inFakcie z tamtej listy ZNIKA. Akcja postawiona przy wierszu z inFaktu byla by wiec
 * niedostepna dokladnie w jedynej sytuacji, w ktorej jest potrzebna. Tutaj zrodlem jest
 * wiersz REZERWACJI w panelu, ktory po skasowaniu dokumentu zostaje — i to on blokuje
 * zamowienie przed ponownym wystawieniem.
 *
 * ⚠️ TO JEST PODPOWIEDZ, NIE BARIERA. Prawdziwa odmowa siedzi w `fakturaSkasowanaWInfakcie`
 * i sprawdza te same przeslanki jeszcze raz, na swiezym wierszu: dokument u kupujacego
 * w Allegro, obecnosc w KSeF, stan rezerwacji. Rozjazd tych dwoch miejsc konczy sie
 * przyciskiem, ktory oddaje 400 z powodem — a nie skasowaniem czegos, czego nie wolno.
 *
 * Warunki (te same, co w barierze): dokument MA numer (jest co odnotowac) · NIE poszedl do
 * kupujacego w Allegro · nie ma ZADNEGO sladu w KSeF (obie kolumny puste — `ksef_status`
 * z chwili wystawienia i `ksef_numer` od czuwacza).
 */
export function fakturyMozliweDoOdnotowaniaSkasowania(db, { miesiac } = {}) {
  return db.prepare(
    `SELECT f.id, f.zamowienie_id, f.numer, ${idDokumentuSql('f')} AS dokument_id, f.utworzona_at,
            z.numer AS zamowienie_numer
       FROM faktury f
       JOIN zamowienia z ON z.id = f.zamowienie_id
      WHERE f.numer IS NOT NULL
        AND ${idDokumentuSql('f')} IS NOT NULL
        AND f.allegro_wyslana_at IS NULL
        AND f.ksef_numer IS NULL
        AND f.ksef_status IS NULL
        ${miesiac ? 'AND substr(f.utworzona_at, 1, 7) = @miesiac' : ''}
      ORDER BY f.utworzona_at DESC`,
  ).all(miesiac ? { miesiac } : {});
}

/**
 * PRZ-121.04a — dokumenty znane OMS-owi po identyfikatorze w programie: Map identyfikator → LISTA wierszy
 * `{ program, dokument_id }` (kształt dla `programDokumentu`/`czyDokumentProgramu`/`idDokumentuDla`). Wysyłka do KSeF
 * z listy FAKTURY ma sam identyfikator, a program dokumentu zna tylko wiersz faktury zamówienia albo faktury okresu.
 * Lista, nie jeden wiersz: dwa programy mogą nadać ten sam identyfikator (np. „123”), a o tym, czy dokument należy
 * do modułu faktur, rozstrzyga wołający. Identyfikatora bez wiersza w mapie nie ma — dokument wystawiony poza
 * OMS-em przechodzi jak dawniej.
 */
export function dokumentyPoIdentyfikatorach(db, identyfikatory) {
  const lista = [...new Set([].concat(identyfikatory ?? []).filter((x) => x != null && x !== '').map(String))];
  const mapa = new Map();
  if (!lista.length) return mapa;
  const zapytanie = (tabela) => `SELECT program, ${idDokumentuSql()} AS dokument_id FROM ${tabela}
    WHERE ${idDokumentuSql()} IN (SELECT value FROM json_each(?))`;
  for (const tabela of ['faktury', 'okresy_rozliczeniowe']) {
    for (const w of db.prepare(zapytanie(tabela)).all(JSON.stringify(lista))) {
      if (!mapa.has(w.dokument_id)) mapa.set(w.dokument_id, []);
      mapa.get(w.dokument_id).push({ program: w.program, dokument_id: w.dokument_id });
    }
  }
  return mapa;
}

export function createZapytania(db) {
  return {
    rozpocznijFakture: (...args) => rozpocznijFakture(db, ...args),
    zakonczFakture: (...args) => zakonczFakture(db, ...args),
    zapiszNumerKsef: (...args) => zapiszNumerKsef(db, ...args),
    zapiszNieudanyOdczytKsef: (...args) => zapiszNieudanyOdczytKsef(db, ...args),
    zapiszZgloszenieAllegro: (...args) => zapiszZgloszenieAllegro(db, ...args),
    zajmijWysylkeDoAllegro: (...args) => zajmijWysylkeDoAllegro(db, ...args),
    zwolnijWysylkeDoAllegro: (...args) => zwolnijWysylkeDoAllegro(db, ...args),
    zapiszPytanieOWeryfikacje: (...args) => zapiszPytanieOWeryfikacje(db, ...args),
    zapiszWysylkeDoAllegro: (...args) => zapiszWysylkeDoAllegro(db, ...args),
    zapiszWeryfikacjeAllegro: (...args) => zapiszWeryfikacjeAllegro(db, ...args),
    zwolnijFakture: (...args) => zwolnijFakture(db, ...args),
    oznaczFaktureDoWyjasnienia: (...args) => oznaczFaktureDoWyjasnienia(db, ...args),
    odblokujFakture: (...args) => odblokujFakture(db, ...args),
    fakturaSkasowanaWInfakcie: (...args) => fakturaSkasowanaWInfakcie(db, ...args),
    fakturyMozliweDoOdnotowaniaSkasowania: (...args) => fakturyMozliweDoOdnotowaniaSkasowania(db, ...args),
  };
}

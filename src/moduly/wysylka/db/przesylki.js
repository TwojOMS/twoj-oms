import { bladOperatora } from '../../../domena/bledy.js';
import {
  stanPrzesylki, sprawyDoZalatwieniaRecznie, STANY_BLOKUJACE_KOLEJNA, ZRODLO_NUMERU, numerZAllegro,
} from '../../../domena/przesylka-stan.js';

const teraz = () => new Date().toISOString();

// ⚠️ IDENTYFIKATOR KURIERA ZAWSZE JAKO NAPIS — i to nie jest kosmetyka typu.
// ShipX oddaje `id` LICZBA (9993331), a sterownik SQLite wiaze liczby jako zmiennoprzecinkowe;
// w kolumnie TEXT ląduje wtedy „9993331.0". Taki identyfikator NIE ISTNIEJE w ShipX — kazde
// „Sprawdz ponownie" odbiloby sie od 404, a przesylka, ktora naprawde powstala, byla by
// dla panelu nie do odnalezienia. Wylapal to test „awaria etykiety NIE gubi numeru listu
// ani identyfikatora"; jedno miejsce konwersji, zeby nie zalezalo to od pamieci wolajacego.
const naIdentyfikator = (w) => (w == null ? null : String(w));

// Jeden wiersz przesylki po ID. Istnieje po to, zeby usluga nadania (services/nadanie.js)
// nie musiala pisac wlasnego SELECT-a — czytanie tabeli `przesylki` ma zostac w tym module.
export function pobierzPrzesylke(db, id) {
  return db.prepare('SELECT * FROM przesylki WHERE id = ?').get(id);
}

// Kolizja indeksu `przesylki_kolejnosc_zywa` rozpoznawana DWOMA niezaleznymi sprawdzeniami.
//
// Dlaczego nie po samej nazwie indeksu: SQLite w komunikacie o naruszeniu czesciowego
// indeksu unikalnego podaje TABELE I KOLUMNY, a nie nazwe indeksu
// ("UNIQUE constraint failed: przesylki.zamowienie_id, przesylki.kolejnosc"). Nazwa
// `przesylki_kolejnosc_zywa` nigdy sie w tym tekscie nie pojawi, wiec dopasowanie do niej
// milczaco przestaloby dzialac.
//
// Dlaczego nie po samym /UNIQUE/i (stan sprzed poprawki): dolozenie DOWOLNEGO innego
// ograniczenia unikalnego na tej tabeli (np. na numerze listu) sprawiloby, ze panel
// zaczalby klamac operatorowi „to zamowienie ma juz nadana przesylke" przy zupelnie
// innej przyczynie.
//
// Wiec: (1) pelna sygnatura kolumnowa TEGO indeksu, (2) potwierdzenie, ze zywy wiersz
// POD TYM SAMYM NUMEREM KOLEJNYM naprawde istnieje. Cokolwiek innego leci w gore nietkniete.
const SYGNATURA_KOLIZJI = 'UNIQUE constraint failed: przesylki.zamowienie_id, przesylki.kolejnosc';

// Wszystkie ZYWE paczki zamowienia, po numerze kolejnym. „Zywa" znaczy `status <> 'blad'`,
// czyli dokladnie to samo, co warunek indeksu — jedno zrodlo prawdy dla obu.
export function zywePrzesylki(db, zamowienieId) {
  return db.prepare("SELECT * FROM przesylki WHERE zamowienie_id = ? AND status <> 'blad' ORDER BY kolejnosc").all(zamowienieId);
}

// Numer, ktory dostanie NASTEPNA paczka tego zamowienia.
//
// Liczony z paczek ZYWYCH, wiec nieudane nadanie (status 'blad') numeru NIE zajmuje —
// inaczej ponowienie po awarii dostawaloby numer 2 i jechalo do DPD z referencja
// „1267/2", mimo ze zadna pierwsza paczka nigdy nie powstala.
//
// To jest wartosc, ktora ekran nadania wklada do formularza, a trasa POST porownuje
// z przyslana — patrz komentarz przy POST /zamowienia/:id/nadaj.
export function nastepnaKolejnosc(db, zamowienieId) {
  const w = db.prepare("SELECT MAX(kolejnosc) AS max FROM przesylki WHERE zamowienie_id = ? AND status <> 'blad'").get(zamowienieId);
  return (w?.max ?? 0) + 1;
}

function zywaPrzesylkaPod(db, zamowienieId, kolejnosc) {
  return db.prepare("SELECT * FROM przesylki WHERE zamowienie_id = ? AND kolejnosc = ? AND status <> 'blad'")
    .get(zamowienieId, kolejnosc);
}

function opisKolizji(zywa) {
  const stan = stanPrzesylki(zywa);
  // Przesylka istnieje u kuriera i czeka na numer. Wyjscie jest JEDNO i nie jest nim
  // ponowienie: „Sprawdz ponownie" na karcie odpytuje o TE SAMA przesylke, a nadanie
  // od nowa utworzyloby u InPostu druga (referencja go nie odsieje, spec 4.4).
  if (stan === 'tworzona_u_kuriera') {
    return 'Przesyłka do tego zamówienia JUŻ ISTNIEJE u kuriera — czeka tylko na numer listu. '
      + 'Nie nadawaj jej drugi raz: kliknij „Sprawdź ponownie" przy paczce na karcie zamówienia.';
  }
  if (stan === 'do_wyjasnienia') {
    return `To zamówienie ma przesyłkę do wyjaśnienia (list ${zywa.numer_listu}). `
      + 'DPD odrzuci ponowne nadanie z tą samą referencją — sprawdź paczkę w panelu DPD.';
  }
  // Wiersz starszy niz prog to sierota po restarcie procesu, a nie trwajace wywolanie.
  // Odpowiedz „wlasnie trwa" byla tu WIECZNA: nic jej nigdy nie zdejmowalo, a jedynym
  // wyjsciem zostawal reczny UPDATE w pliku SQLite.
  if (stan === 'zawieszona') {
    return `Nadanie tego zamówienia wisi od ${zywa.utworzona_at} i żadne wysyłanie już nie trwa — `
      + 'panel najpewniej został zrestartowany w trakcie wywołania DPD. '
      + 'Sprawdź RĘCZNIE w panelu DPD, czy paczka do tego zamówienia powstała: '
      + 'jeśli ma już numer listu, ponowienie i tak zostanie odrzucone (DUPLICATED_PARCEL_SEARCH_KEY). '
      + 'Decyzję podejmij przyciskiem na karcie zamówienia.';
  }
  if (stan === 'w_trakcie') return 'Nadanie tego zamówienia właśnie trwa.';
  return 'To zamówienie ma już nadaną przesyłkę.';
}

// Wstawienie wiersza 'w_trakcie' PRZED wywolaniem kuriera jest cala idempotencja:
// unikalny indeks czesciowy odrzuca druga probe na poziomie bazy, a nie na poziomie
// ostroznosci programisty. Po dopuszczeniu wielu paczek niezmiennikiem jest PARA
// (zamowienie, numer kolejny) — dlatego `kolejnosc` jest tu argumentem, a nie liczona
// w srodku: wolajacy musi POWIEDZIEC, ktora paczke nadaje.
//
// Domyslne 1 znaczy „pierwsza paczka" i jest dokladnie dawnym zachowaniem: kazde
// wywolanie bez jawnego numeru celuje w to samo miejsce, wiec drugie odbija sie od bazy.
// Zaden kod NIE MA prawa wyliczac tu numeru samodzielnie z bazy — wtedy dwa szybkie
// klikniecia dostawalyby numery 1 i 2 i obie paczki fizycznie by wyjechaly.
export function rozpocznijPrzesylke(db, zamowienieId, kurier, kolejnosc = 1) {
  // Odmowa PRZED wstawieniem, bo indeks jej nie zalatwi: nadanie paczki nr 1 moze wisiec
  // w toku, a paczka nr 2 ma INNY numer kolejny, wiec przeszlaby przez indeks bez oporu.
  // Dopoki nie wiadomo, czy paczka u kuriera powstala, kolejnej nie wolno dokladac.
  // STANY_BLOKUJACE_KOLEJNA (domain/przesylka-stan.js) zamiast listy wpisanej tutaj:
  // ta sama lista rzadzi przyciskiem na karcie (mozliwaKolejnaPaczka), wiec druga kopia
  // rozjechalaby sie przy pierwszym nowym stanie — a rozjazd tutaj znaczy paczke, ktorej
  // karta nie proponowala, albo odwrotnie: przycisk prowadzacy prosto w odmowe.
  const wtoku = zywePrzesylki(db, zamowienieId)
    .find((p) => STANY_BLOKUJACE_KOLEJNA.includes(stanPrzesylki(p)));
  if (wtoku) throw bladOperatora(opisKolizji(wtoku));

  try {
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (?,?, 'w_trakcie', ?, ?)")
      .run(zamowienieId, kurier, kolejnosc, teraz());
  } catch (e) {
    const zywa = String(e.message).includes(SYGNATURA_KOLIZJI) ? zywaPrzesylkaPod(db, zamowienieId, kolejnosc) : null;
    if (zywa) throw bladOperatora(opisKolizji(zywa));
    throw e;
  }
  return zywaPrzesylkaPod(db, zamowienieId, kolejnosc);
}

// PRZESYLKA NADANA POZA PANELEM — wlasciciel nadal paczke w panelu DPD (typowo wtedy, gdy
// panel odmowil powtornego nadania z ta sama referencja) i panel musi umiec sie o tym
// dowiedziec. To takze JEDYNA uczciwa droga do statusu „Wyslane" bez nadawania z panelu:
// status wynika z faktow, a faktem jest istnienie nadanej paczki.
//
// ⚠️ ZERO rozmowy z kurierem — zadnego zadania, zadnej etykiety, zadnego ZPL-a. Paczka JUZ
// istnieje fizycznie, wiec wywolanie DPD zalozyloby DRUGA, prawdziwa. Ta funkcja wylacznie
// odnotowuje fakt, ktory czlowiek stwierdzil sam.
//
// ⚠️ TE SAME SIATKI, co przy nadaniu z panelu, i to nie jest ostroznosc na wyrost: gdyby
// rejestracja reczna je omijala, bylaby po prostu furtka obok nich.
//  (1) odmowa, gdy inna paczka wisi w toku albo zawieszona (dopoki nie wiadomo, czy paczka
//      u kuriera powstala, kolejnej nie wolno dokladac) — ten sam warunek co w
//      rozpocznijPrzesylke, liczony tym samym kodem;
//  (2) indeks unikalny (zamowienie_id, kolejnosc) WHERE status <> 'blad' — wiersz jest
//      wstawiany normalnym INSERT-em, wiec odbija sie od bazy dokladnie tak samo;
//  (3) `kolejnosc` przychodzi Z ZEWNATRZ, nigdy nie jest liczona w srodku — dokladnie jak
//      w rozpocznijPrzesylke, zeby dwa szybkie klikniecia nie dostaly numerow 1 i 2.
//
// JEDEN INSERT, a nie „rozpocznij + zakoncz": miedzy tymi krokami nie ma zadnego wywolania
// zewnetrznego, ktore trzeba by oslonic rezerwacja wiersza, a rozbicie na dwa zapisy
// tworzyloby okno na wiersz 'w_trakcie' bez numeru listu — czyli sztuczna sierote po
// awarii, ktorej ta sciezka w ogole nie ma prawa produkowac.
// ⚠️ `zrodloNumeru` (recenzja calej galezi): 'reka' domyslnie, bo tak wola TRASA — czlowiek
// przepisujacy numer z panelu kuriera. Usluga czytajaca numery z konta Allegro podaje
// 'allegro' JAWNIE (services/przesylki-allegro.js) i to jest jedyna roznica miedzy tymi
// dwoma wolajacymi, ktora widac potem w bazie. Domysl stoi po stronie czlowieka celowo:
// wartosc 'reka' oznacza „w tym numerze MOZE byc literowka" i najgorsze, co robi omylkowo
// postawiona, to dopuszczenie kasowania wiersza, ktory panel i tak odczyta ponownie.
// `carrierAllegro` (domyslnie NULL) — identyfikator PRZEWOZNIKA z odpowiedzi Allegro.
// Podaje go wylacznie services/przesylki-allegro.js, bo tylko tam ta wartosc istnieje;
// wpis reczny czlowieka jej nie ma i nie ma skad wziac. NULL znaczy „nie wiemy, kogo pytac"
// i wtedy panel NIE PYTA (domain/sledzenie-przesylki.js) — nigdy nie podstawia stalej.
export function zarejestrujPrzesylkeReczna(db, zamowienieId, {
  kurier, kolejnosc, numerListu, zrodloNumeru = ZRODLO_NUMERU.REKA, carrierAllegro = null,
}) {
  const numer = String(numerListu ?? '').trim();
  // Bez numeru listu rejestracja bylaby klamstwem: zamowienie wygladaloby na wyslane,
  // a panel nie mialby czego pokazac ani klientowi, ani sobie przy reklamacji. Dokladnie
  // ta sama odmowa, co przy domknieciu przesylki „do wyjasnienia".
  if (!numer) throw bladOperatora('Podaj numer listu przewozowego — bez niego nie ma czego rejestrować.');

  // STANY_BLOKUJACE_KOLEJNA (domain/przesylka-stan.js) zamiast listy wpisanej tutaj:
  // ta sama lista rzadzi przyciskiem na karcie (mozliwaKolejnaPaczka), wiec druga kopia
  // rozjechalaby sie przy pierwszym nowym stanie — a rozjazd tutaj znaczy paczke, ktorej
  // karta nie proponowala, albo odwrotnie: przycisk prowadzacy prosto w odmowe.
  const wtoku = zywePrzesylki(db, zamowienieId)
    .find((p) => STANY_BLOKUJACE_KOLEJNA.includes(stanPrzesylki(p)));
  if (wtoku) throw bladOperatora(opisKolizji(wtoku));

  try {
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, nadana_recznie,'
      + " zrodlo_numeru, carrier_allegro, utworzona_at) VALUES (?,?, 'nadana', ?, ?, 1, ?, ?, ?)",
    ).run(zamowienieId, kurier, numer, kolejnosc, zrodloNumeru, carrierAllegro ?? null, teraz());
  } catch (e) {
    const zywa = String(e.message).includes(SYGNATURA_KOLIZJI) ? zywaPrzesylkaPod(db, zamowienieId, kolejnosc) : null;
    if (zywa) throw bladOperatora(opisKolizji(zywa));
    throw e;
  }
  return zywaPrzesylkaPod(db, zamowienieId, kolejnosc);
}

// `etykietaZplSciezka` jest opcjonalna i domyślnie NULL: DPD mogło nie oddać ZPL-a
// (patrz zplBladOpis w kurierzy/dpd.js) albo zapis pliku mógł się nie udać — dokładnie
// tak samo, jak `etykietaSciezka` bywa NULL przy awarii zapisu PDF-a. Brak ZPL-a NIE
// jest awarią nadania, więc ta funkcja go nie wymaga.
// `adresUzyty` (JSON, domyślnie NULL) — adres odbiorcy faktycznie użyty przy TYM nadaniu
// (Zadanie „adres edytowalny"). Domyślne NULL zostaje wyłącznie dla wywołań, które go nie
// podadzą (nie powinno się to zdarzyć na prawdziwej ścieżce — services/nadanie.js zawsze
// je liczy, patrz tamtejszy komentarz) — ale ta funkcja go nie wymusza, żeby nie stać się
// drugim, konkurencyjnym miejscem walidacji obok nadanie.js.
// `idPrzesylkiKuriera` (InPost `shipment_id`) idzie przez COALESCE i to nie jest kosmetyka:
// przy paczkomacie identyfikator jest zapisany JUZ WCZESNIEJ (patrz oznaczTworzonaUKuriera
// oraz services/nadanie.js), a domkniecie przesylki wolane bez tego argumentu wpisaloby tu
// NULL i skasowalo jedyny slad prowadzacy do przesylki w ShipX. Wartosc, ktora znamy, nie
// ma prawa zniknac przez to, ze wolajacy jej akurat nie przekazal.
/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {import('../nadanie-typy.ts').ZapisPrzesylki} dane
 */
export function zakonczPrzesylke(db, id, {
  numerListu, etykietaSciezka, etykietaZplSciezka = null, surowa, adresUzyty = null, idPrzesylkiKuriera = null,
}) {
  db.prepare(
    "UPDATE przesylki SET status = 'nadana', numer_listu = ?, etykieta_sciezka = ?, etykieta_zpl_sciezka = ?,"
    + ' odpowiedz_surowa = ?, adres_uzyty = ?, id_przesylki_kuriera = COALESCE(?, id_przesylki_kuriera) WHERE id = ?',
  ).run(numerListu, etykietaSciezka, etykietaZplSciezka, surowa, adresUzyty, naIdentyfikator(idPrzesylkiKuriera), id);
}

/**
 * Sam identyfikator przesylki u kuriera — NAJKROTSZY mozliwy zapis, wolany NATYCHMIAST po
 * tym, jak kurier potwierdzi utworzenie przesylki, i PRZED czymkolwiek innym.
 *
 * Osobna funkcja, a nie argument istniejacych: kazda z tamtych coś jeszcze rozstrzyga
 * (status, numer listu, opis bledu), a ta ma robic JEDNA rzecz i nie miec powodu, zeby
 * kiedykolwiek nie zostac wywolana. Nic wiecej nie rusza, wiec wolno ja wywolac na dowolnym
 * etapie, takze wtedy, gdy zaraz potem cos padnie.
 */
export function zapiszIdPrzesylkiKuriera(db, id, idPrzesylkiKuriera) {
  db.prepare('UPDATE przesylki SET id_przesylki_kuriera = ? WHERE id = ?').run(naIdentyfikator(idPrzesylkiKuriera), id);
}

/**
 * ⚠️ PRZESYLKA U KURIERA JUZ ISTNIEJE, NUMERU LISTU JESZCZE NIE MA (InPost, Zadanie 6).
 *
 * Dwa rozne zdarzenia trafiaja tutaj i oba znacza to samo dla bazy:
 *  (a) tworzenie przesylki trwa dluzej niz okno odpytywania (`wTrakcieTworzenia` z klienta),
 *  (b) nadanie padlo PO udanym `POST` — awaria sieci przy odpytywaniu, restart proxy —
 *      ale wyjatek przyniosl `shipmentId`, wiec wiemy, ze przesylka powstala.
 *
 * Status zostaje 'w_trakcie' CELOWO. To NIE jest 'blad': ten zwalnia miejsce w indeksie
 * czesciowym, a zwolnione miejsce przy InPoscie znaczy DRUGA prawdziwa paczke, bo ShipX
 * nie odsiewa duplikatow po referencji (spec, 4.4). To takze nie jest 'do_wyjasnienia':
 * tamten stan wymaga numeru listu (bez niego nie da sie go domknac) i mowi „zajrzyj do
 * panelu kuriera", a tutaj panel umie sprawe dokonczyc sam — jednym kliknieciem
 * „Sprawdz ponownie", ktore wylacznie ODPYTUJE o istniejaca przesylke.
 *
 * `opis` jest opcjonalny: przy (a) nie ma zadnego bledu do opisania, przy (b) jest i musi
 * zostac widoczny na karcie — inaczej operator nie odroznilby spokojnego czekania od awarii.
 */
/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {import('../nadanie-typy.ts').ZapisPrzesylki} dane
 */
export function oznaczTworzonaUKuriera(db, id, { idPrzesylkiKuriera, opis = null, surowa = null, adresUzyty = null }) {
  db.prepare(
    "UPDATE przesylki SET status = 'w_trakcie', id_przesylki_kuriera = ?, blad_opis = ?, odpowiedz_surowa = ?,"
    + ' adres_uzyty = COALESCE(?, adres_uzyty) WHERE id = ?',
  ).run(naIdentyfikator(idPrzesylkiKuriera), opis, surowa, adresUzyty, id);
}

// Blad zwalnia miejsce pod ponowienie — inaczej zamowienie zostaloby bez paczki na zawsze.
// Wolno go uzyc WYLACZNIE gdy DPD nie przydzielilo jeszcze numeru listu (patrz oznaczDoWyjasnienia).
export function oznaczBlad(db, id, opis) {
  db.prepare("UPDATE przesylki SET status = 'blad', blad_opis = ? WHERE id = ?").run(opis, id);
}

// Awaria PO przydzieleniu numeru listu. Status celowo NIE jest 'blad', bo indeks
// czesciowy zwalnia miejsce warunkiem `status <> 'blad'` — a ponowienie tutaj jest
// szkodliwe: DPD odrzuci te sama referencje (DUPLICATED_PARCEL_SEARCH_KEY), a paczka
// u kuriera juz fizycznie istnieje. Numer listu i surowa odpowiedz zapisujemy, bo to
// jedyny slad, z ktorego czlowiek moze dokonczyc sprawe recznie.
//
// `adresUzyty` (JSON, domyslnie NULL) zapisujemy z DOKLADNIE TEGO SAMEGO powodu co
// w zakonczPrzesylke: paczka u kuriera JUZ ISTNIEJE (DPD przydzielilo numer), wiec adres,
// pod ktory fizycznie pojedzie, jest juz przesadzony. Operator mogl go poprawic na ekranie
// nadania tuz przed tym wywolaniem — bez zapisu tutaj panel gubilby ten adres NA ZAWSZE
// (adres w zamowieniu ze sklepu moze byc juz inny), mimo ze paczka fizycznie istnieje
// i pytanie „dokad pojechala" jest tu rownie wazne jak przy udanym nadaniu.
//
// `idPrzesylkiKuriera` przez COALESCE, z tego samego powodu co w zakonczPrzesylke: gdy
// InPost oddal numer listu, ale etykieta padla, identyfikator przesylki jest DRUGIM (obok
// numeru) sladem prowadzacym do niej w ShipX — a czlowiek, ktory ma sprawe dokonczyc,
// szuka jej wlasnie po nim.
/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {import('../nadanie-typy.ts').ZapisPrzesylki} dane
 */
export function oznaczDoWyjasnienia(db, id, { numerListu, opis, surowa = null, adresUzyty = null, idPrzesylkiKuriera = null }) {
  db.prepare(
    "UPDATE przesylki SET status = 'do_wyjasnienia', numer_listu = ?, blad_opis = ?, odpowiedz_surowa = ?,"
    + ' adres_uzyty = ?, id_przesylki_kuriera = COALESCE(?, id_przesylki_kuriera) WHERE id = ?',
  ).run(numerListu, opis, surowa, adresUzyty, naIdentyfikator(idPrzesylkiKuriera), id);
}

// Nieudana synchronizacja ze sklepem musi byc WIDOCZNA, nie tylko zalogowana:
// zaden widok nie renderuje tabeli `log`, wiec bez tej kolumny operator nie ma
// jak sie dowiedziec, ze klient nie dostal numeru listu.
export function zapiszBladSync(db, id, opis) {
  db.prepare('UPDATE przesylki SET sync_woo_blad = ? WHERE id = ?').run(opis, id);
}

// Zadanie 13: ostatni znany status z usługi zdarzeń DPD. `at` to CZAS ZDARZENIA
// zwrócony przez DPD (eventTime), nie czas naszego zapytania.
// ⚠️ OD 28.08.2026 KOLUMNA JEST NOŚNA — stało tu „czysto prezentacyjna, nic od niej nie
// zależy" i przestało to być prawdą. `domain/pobranie-zaplacone.js` czyta ją jako DZIEŃ
// DORĘCZENIA i wysyła go do inFaktu jako datę zapłaty faktury za pobraniem. Zmiana
// znaczenia albo formatu tej wartości zmienia dane księgowe. (Brak wartości jest dalej
// dopuszczalny — tam spadamy na datę wystawienia.)
// ⚠️ `kod` ZAPISYWANY ZAWSZE, TAKZE JAKO NULL. Oddaje go wylacznie Allegro; DPD i InPost
// zostawiaja NULL i wtedy etap liczy sie po opisie, jak dotad. Ale zapis warunkowy
// („pisz kod tylko, gdy jest") zostawialby STARY kod przy nowym opisie: paczka, ktora raz
// oddala DELIVERED, a potem wrocila do ruchu innym kanalem, wisialaby jako doreczona.
// Jedno zdarzenie to jeden komplet — opis, czas i kod ida razem albo wcale.
export function zapiszStatusDpd(db, id, { opis, at, kod = null }) {
  db.prepare('UPDATE przesylki SET status_kuriera = ?, status_kuriera_at = ?, status_kuriera_kod = ? WHERE id = ?')
    .run(opis ?? null, at ?? null, kod ?? null, id);
}

// Znacznik NASZEJ PROBY — i tylko on steruje dlawikiem godzinowym w GET /zamowienia/:id.
//
// Wczesniej dlawik czytal status_kuriera_at, czyli czas ZDARZENIA W DPD, i dla kazdej paczki
// doreczonej dawniej niz godzine temu robil sie PETLA BEZ KONCA: kazde otwarcie karty
// widzialo „starsze niz godzina" -> pytalo DPD -> DPD oddawalo TO SAMO zdarzenie sprzed
// dni -> zapisywalismy te sama stara wartosc -> warunek nadal prawdziwy. Trzy otwarcia
// karty = trzy zapytania do DPD. Dlawik dzialal wylacznie w waskim oknie aktywnego
// doreczania, a wlasnie zamowienia STARE oglada sie najczesciej (reklamacje, faktury).
//
// Zapisujemy ZAWSZE po probie: takze gdy DPD nie oddalo zdarzen (null) i gdy proba padla.
// Inaczej te dwa przypadki nie mialyby dlawika w ogole.
export function zapiszProbeStatusuDpd(db, id, { at, blad = null }) {
  db.prepare('UPDATE przesylki SET status_kuriera_pobrany_at = ?, status_kuriera_blad = ? WHERE id = ?')
    .run(at, blad, id);
}

/**
 * Skasowanie SAMEGO bledu statusu, bez dotykania znacznika proby.
 *
 * ⚠️⚠️ ISTNIEJE, BO POPRAWKA `bezSledzenia` (11.08.2026) ZATKALA ZRODLO, ALE ZOSTAWILA OSAD.
 * Kolumna `status_kuriera_blad` kasowala sie dotad WYLACZNIE „przy najblizszym udanym
 * odswiezeniu" — a u kuriera, ktorego panel z zalozenia NIE PYTA o status, takie odswiezenie
 * nie nastapi NIGDY. Cztery zamowienia z `allegro_wza` zostaly przez to na liscie roboczej
 * z odznaka „status u kuriera niedostepny" bez zadnego wyjscia (zgloszenie wlasciciela
 * 12.08.2026). Niezmiennik 4.9: panel nie moze wchodzic w stan, z ktorego nie umie wyjsc.
 *
 * ⚠️ `status_kuriera_pobrany_at` ZOSTAJE. To znacznik dlawika godzinowego, a nie czesc bledu —
 * skasowany kazalby panelowi pytac od nowa przy KAZDYM otwarciu karty.
 */
export function wyczyscBladStatusu(db, id) {
  return db.prepare('UPDATE przesylki SET status_kuriera_blad = NULL WHERE id = ? AND status_kuriera_blad IS NOT NULL')
    .run(id).changes;
}

/**
 * To samo hurtem, przy starcie panelu — dla kurierow, ktorzy ZADEKLAROWALI brak sledzenia.
 *
 * ⚠️ DLACZEGO HURTEM, A NIE TYLKO PRZY OTWARCIU KARTY: odznaka na liscie roboczej istnieje
 * po to, zeby NIE trzeba bylo otwierac kart. Kasowanie osadu dopiero przy wejsciu w karte
 * zostawialoby zamowienia na liscie do czasu, az ktos wejdzie w kazde z osobna — czyli
 * kazaloby czlowiekowi zrobic dokladnie to, przed czym ta odznaka ma chronic.
 *
 * ⚠️ LISTA KURIEROW JEST ARGUMENTEM, a nie stala w tym pliku. Warstwa bazy nie ma prawa
 * wiedziec, ze „allegro_wza nie ma sledzenia" — to wlasciwosc ADAPTERA (`bezSledzenia`),
 * czytana z mapy zlozonej w bootstrapie. Wpisana tu na sztywno nazwa rozjechalaby sie
 * z prawda przy pierwszym kurierze, ktory sledzenie zyska albo straci.
 */
export function wyczyscBladStatusuBezSledzenia(db, kurierzy = []) {
  const lista = [...new Set((kurierzy ?? []).filter(Boolean))];
  // ⚠️ To wyjscie jest dla CZYTAJACEGO, nie dla poprawnosci: SQLite przyjmuje `IN ()` i oddaje
  // zero zmian, wiec bez tej linii zachowanie jest IDENTYCZNE (sprawdzone, nie zalozone —
  // mutacja usuwajaca ten warunek przezyla i wlasnie dlatego stoi tu ten komentarz).
  // Zostaje, bo „pusta lista niczego nie rusza" ma byc widoczne bez znajomosci dialektu.
  if (!lista.length) return 0;
  const miejsca = lista.map(() => '?').join(', ');
  return db.prepare(
    `UPDATE przesylki SET status_kuriera_blad = NULL
     WHERE status_kuriera_blad IS NOT NULL AND kurier IN (${miejsca})`,
  ).run(...lista).changes;
}

// JEDYNE wyjscie z osieroconego 'w_trakcie'. Odpowiednik odblokujFakture — z jedna
// zasadnicza roznica, ktora decyduje o ksztalcie tej funkcji:
//
// przy fakturze „odblokuj" znaczy ZAWSZE to samo (dokumentu nie ma, kasujemy rezerwacje).
// Przy nadaniu sa DWA rozne swiaty i rozstrzyga je czlowiek, ktory zajrzal do panelu DPD:
//  (a) paczki tam nie ma        -> wiersz idzie na 'blad', indeks czesciowy sie zwalnia,
//                                  panel moze nadac normalnie;
//  (b) paczka MA JUZ numer listu -> wiersz idzie na 'do_wyjasnienia' z tym numerem. Miejsca
//                                  NIE zwalniamy CELOWO: ponowienie wrocilo by z DPD jako
//                                  DUPLICATED_PARCEL_SEARCH_KEY, a paczka fizycznie istnieje.
// Naiwne „odblokuj = pozwol ponowic" daloby w przypadku (b) zamowienie, ktorego panel
// nigdy juz nie nada, i zgubiony numer listu.
//
// Argumentem jest ID PRZESYLKI, a nie zamowienia — i to nie jest kosmetyka. Zamowienie
// moze miec kilka paczek naraz (paczka nr 1 nadana, nr 2 zawieszona), a wybieranie
// „pierwszej z brzegu" znaczyloby, ze operator klika przy paczce nr 2, a panel rozstrzyga
// los paczki nr 1. Przynaleznosc do zamowienia sprawdza trasa (paczkaZadania).
export function odblokujPrzesylke(db, przesylkaId, { numerListu = null, opis } = {}) {
  const p = db.prepare("SELECT * FROM przesylki WHERE id = ? AND status <> 'blad'").get(przesylkaId);
  if (!p) throw bladOperatora('Ta przesyłka nie ma zawieszonego nadania — nie ma czego odblokowywać.');
  const stan = stanPrzesylki(p);
  if (stan !== 'zawieszona') {
    if (stan === 'w_trakcie') {
      throw bladOperatora('Nadanie właśnie trwa — poczekaj, aż się skończy, zanim cokolwiek odblokujesz.');
    }
    // ⚠️ NAJGROZNIEJSZA z tych odmow. Ta przesylka NA PEWNO istnieje u kuriera (mamy jej
    // identyfikator), a odblokowanie bez numeru listu przestawiloby wiersz na 'blad',
    // zwolnilo indeks czesciowy i pozwolilo nadac DRUGA prawdziwa paczke — InPost nie
    // odsieje jej po referencji. Wyjscie jest tu inne i bezpieczne: „Sprawdz ponownie".
    if (stan === 'tworzona_u_kuriera') {
      throw bladOperatora(
        `Ta przesyłka istnieje u kuriera (identyfikator ${p.id_przesylki_kuriera}) i czeka wyłącznie na numer `
        + 'listu — nie ma czego odblokowywać. Kliknij „Sprawdź ponownie": panel dobierze numer i etykiety '
        + 'tej samej przesyłki, zamiast tworzyć drugą.',
      );
    }
    if (stan === 'do_wyjasnienia') {
      throw bladOperatora(
        `Ta przesyłka jest już opisana jako „do wyjaśnienia" (list ${p.numer_listu}) — odblokowywać nie ma czego. `
        + 'Dokończ sprawę w panelu DPD i domknij ją przyciskiem na karcie.',
      );
    }
    throw bladOperatora(
      `Ta przesyłka jest nadana${p.numer_listu ? ` (list ${p.numer_listu})` : ''} — `
      + 'odblokowanie pozwoliłoby nadać drugą paczkę pod TYM SAMYM numerem kolejnym, '
      + 'czyli z tą samą referencją, którą DPD już zna. Kolejną paczkę nadaje się '
      + 'przyciskiem „Nadaj kolejną paczkę" na karcie.',
    );
  }
  const przycietyNumer = String(numerListu ?? '').trim();
  if (przycietyNumer) oznaczDoWyjasnienia(db, p.id, { numerListu: przycietyNumer, opis });
  else oznaczBlad(db, p.id, opis);
  return { ...p, numerListu: przycietyNumer || null };
}

// Domkniecie sprawy przesylki 'do_wyjasnienia' — akcja odlozona SWIADOMIE w Zadaniu 10
// („operator widzi numer i ostrzezenie, ale przestawienie na `nadana` wymaga UPDATE
// w SQLite"). Po dorobieniu wyjscia z zawieszonego nadania ta luka byla juz jedyna
// asymetria: panel umial wejsc w stan, z ktorego nie umial wyjsc.
//
// Nie dotykamy DPD i niczego nie sprawdzamy — paczka jest u kuriera, a jedynym zrodlem
// prawdy jest czlowiek, ktory na nia popatrzyl w panelu DPD.
//
// Argumentem jest ID PRZESYLKI z tego samego powodu co przy odblokujPrzesylke: przy dwoch
// paczkach domykanie „pierwszej z brzegu" domykaloby nie te, ktora operator ma na ekranie.
export function domknijPrzesylke(db, przesylkaId) {
  const p = db.prepare("SELECT * FROM przesylki WHERE id = ? AND status <> 'blad'").get(przesylkaId);
  if (!p) throw bladOperatora('Nie ma takiej przesyłki do domknięcia.');
  if (stanPrzesylki(p) !== 'do_wyjasnienia') {
    throw bladOperatora(
      p.status === 'nadana'
        ? 'Ta przesyłka jest już opisana jako nadana — nie ma czego domykać.'
        : 'Domknąć można wyłącznie przesyłkę „do wyjaśnienia" — nadanie tego zamówienia jeszcze nie doszło do tego stanu.',
    );
  }
  // Bez numeru listu domkniecie bylo by klamstwem: zamowienie wygladaloby na wyslane,
  // a panel nie mialby czego pokazac ani klientowi, ani sobie przy nastepnej reklamacji.
  if (!p.numer_listu) throw bladOperatora('Ta przesyłka nie ma numeru listu — bez niego nie ma czego domykać.');
  db.prepare("UPDATE przesylki SET status = 'nadana' WHERE id = ?").run(p.id);
  return p;
}

// Wada z przegladu calej galezi: `sync_woo_blad` i „brak etykiety" przy przesylce nadanej
// wpychaja zamowienie na liste robocza, a ZADEN z nich nie ma jak zniknac. Typowy przebieg:
// 'do_wyjasnienia' ("DPD nie oddalo etykiety") -> domknijPrzesylke -> przesylka 'nadana'
// BEZ etykiety -> odznaka zostaje na zawsze, bo nic jej nigdy nie zdejmuje.
//
// Ta trasa NIE sprawdza niczego u zrodla (ani w Woo, ani w DPD) — to czlowiek juz to
// zrobil POZA panelem (uzupelnil numer listu w sklepie recznie, ma etykiete z panelu DPD
// albo z maila) i klikniecie jest jego STWIERDZENIEM tego faktu, nie proba automatu.
// Dlatego log ma to zapamietac jako DECYZJE CZLOWIEKA, dokladnie jak przy fakturze
// i domknieciu — a nie jako cichy update.
//
// Status przesylki, numer listu, `kolejnosc` ani indeks `przesylki_kolejnosc_zywa` NIE SA
// tu ruszane: zadnym trybem ta trasa nie otwiera drogi do drugiego nadania ani drugiej
// faktury. `status_kuriera_blad` tez zostaje nietkniety — ten kasuje sie sam przy najblizszym
// udanym odswiezeniu i CELOWO nie jest czescia tej trasy.
//
// Argumentem jest ID PRZESYLKI: przy dwoch paczkach z ta sama sprawa (np. obie bez etykiety)
// zdejmowanie „pierwszej z brzegu" kasowaloby sprawe innej paczki niz ta na ekranie,
// a druga zostawalaby na liscie roboczej bez wyjasnienia, dlaczego klikniecie nic nie dalo.
// WYJSCIE ze stanu, ktorego panel do teraz nie umial opuscic: literowka w numerze listu
// przesylki zarejestrowanej recznie (zarejestrujPrzesylkeReczna) byla TRWALA. Unikalny
// indeks czesciowy `przesylki_kolejnosc_zywa` (zamowienie_id, kolejnosc) WHERE
// status <> 'blad' odbijal kazda kolejna probe zarejestrowania poprawnego numeru pod tym
// samym numerem kolejnym, a jedynym wyjsciem byl reczny DELETE w pliku SQLite. Panel nie
// moze wchodzic w stan, z ktorego nie umie wyjsc (PRZEWODNIK.md 4.9) — ta funkcja jest tym
// wyjsciem, dopisanym w tym samym commicie, co stan.
//
// ⚠️ GRANICA, ktorej NIE WOLNO przekroczyc: WYLACZNIE przesylka zarejestrowana recznie
// (`nadana_recznie` = 1). Przesylka nadana Z PANELU ma numer listu NAPRAWDE przydzielony
// przez DPD — paczka fizycznie istnieje u kuriera. Skasowanie takiego wiersza zwolniloby
// numer kolejny i otworzyloby droge do DRUGIEGO nadania pod TA SAMA referencja, czyli
// DRUGIEJ prawdziwej paczki do tego samego zamowienia. Dlatego sprawdzenie flagi jest
// PIERWSZE i BEZWARUNKOWE — zaden inny argument tej funkcji nie ma prawa go ominac.
//
// DELETE, nie zmiana statusu na 'blad': `status <> 'blad'` jest warunkiem tego samego
// indeksu, ktory ma sie zwolnic, wiec zarowno DELETE, jak i przejscie na 'blad' zwolniloby
// miejsce — ale wiersz 'blad' zostawilby na zawsze slad przesylki, ktorej NIGDY nie bylo
// (panel nie rozmawial z DPD), myloncy operatora przy przegladzie historii zamowienia.
// Zwracamy skasowany wiersz (numer listu, kolejnosc), bo to jedyny material, z ktorego
// wywolujacy moze zlozyc wpis do logu — po DELETE juz go w bazie nie ma.
//
// Argumentem jest ID PRZESYLKI, dokladnie z tego samego powodu co przy odblokujPrzesylke,
// domknijPrzesylke i zalatwPrzesylkeRecznie: zamowienie moze miec kilka paczek naraz.
export function skasujPrzesylkeReczna(db, przesylkaId) {
  const p = db.prepare("SELECT * FROM przesylki WHERE id = ? AND status <> 'blad'").get(przesylkaId);
  if (!p) throw bladOperatora('Nie ma takiej przesyłki — nie ma czego kasować.');
  if (!p.nadana_recznie) {
    throw bladOperatora(
      'Ta przesyłka NIE jest zarejestrowana ręcznie — DPD naprawdę przydzieliło jej numer listu '
      + `${p.numer_listu ? `(${p.numer_listu}) ` : ''}i paczka fizycznie istnieje u kuriera. Skasowanie `
      + 'wiersza otworzyłoby drogę do drugiego nadania pod tą samą referencją. Panel nie kasuje takich przesyłek.',
    );
  }
  // ⚠️ DRUGA GRANICA: NUMER PRZECZYTANY Z KONTA ALLEGRO. Wiersz odczytany z API niesie
  // `nadana_recznie = 1` z powodu CZYSTO TECHNICZNEGO (inaczej wisialaby przy nim wieczna
  // sprawa „brak etykiety" — patrz services/przesylki-allegro.js), wiec sprawdzenie wyzej
  // go PRZEPUSZCZA. Widok przycisku przy nim nie pokazuje, ale POST wprost na te trase juz
  // dziala, a skutek nie jest „mylacy" — jest TRWALY: numer listu przepada.
  //
  // Powod: karta pyta Allegro o przesylki WYLACZNIE dopoki zamowienie nie ma `wyslane_at`.
  // Po oznaczeniu wysylki skasowany wiersz NIE WROCI juz nigdy, a numeru nie ma gdzie
  // odczytac — panel nigdy go nie nadal i nie ma go w zadnej odpowiedzi u siebie. Jedyna
  // przeslanka do kasowania (literowka we wpisanym z reki numerze) tutaj NIE ISTNIEJE:
  // numeru nikt nie przepisywal, przyszedl z API.
  //
  // ⚠️⚠️ DYSKRYMINATOREM JEST ZRODLO NUMERU, A NIE KURIER — i to jest poprawka I-1 z recenzji
  // calej galezi. Do 04.08.2026 stalo tu `p.kurier === 'allegro'`, a `kurierWpisuRecznego`
  // (kurierzy/index.js) oddaje 'allegro' TAKZE dla wiersza, ktory czlowiek WPISAL Z REKI przy
  // zamowieniu z Allegro. Odmowa obejmowala wiec reczny wpis i uzasadniala to zdaniem
  // „numer panel PRZECZYTAL z konta Allegro" — dla takiego wiersza wprost NIEPRAWDA.
  // Literowka w numerze zostawala WTEDY NA ZAWSZE: prawdziwy numer sie nie dociagnie, bo
  // rejestracja reczna USTAWIA `wyslane_at`, a wtedy karta przestaje pytac Allegro. Jedynym
  // wyjsciem byl DELETE w pliku bazy — czyli dokladnie stan zakazany przez niezmiennik 4.9.
  //
  // Odmowa ma bronic numerow PRZECZYTANYCH i broni ich dalej tak samo mocno; zmienil sie
  // wylacznie sposob ich rozpoznania. `kurier` zostaje nietkniety — steruje linkiem do
  // sledzenia i tym, kogo NIE pytac o status, i w obu tych rolach 'allegro' jest poprawne.
  if (numerZAllegro(p)) {
    throw bladOperatora(
      'Ta przesyłka NIE została wpisana ręcznie — jej numer listu '
      + `${p.numer_listu ? `(${p.numer_listu}) ` : ''}panel PRZECZYTAŁ z konta Allegro, więc literówka `
      + 'jest niemożliwa. Skasowany wiersz nie wróci: kartę przestaje odpytywać Allegro, gdy zamówienie '
      + 'ma już datę wysyłki, i numer listu byłby stracony bezpowrotnie. Panel nie kasuje przesyłek z Allegro.',
    );
  }
  db.prepare('DELETE FROM przesylki WHERE id = ?').run(p.id);
  return p;
}

export function zalatwPrzesylkeRecznie(db, przesylkaId) {
  const p = db.prepare("SELECT * FROM przesylki WHERE id = ? AND status <> 'blad'").get(przesylkaId);
  if (!p) throw bladOperatora('Nie ma takiej przesyłki — nie ma czego załatwiać ręcznie.');
  const sprawy = sprawyDoZalatwieniaRecznie(p);
  if (sprawy.length === 0) {
    throw bladOperatora('Ta przesyłka nie ma żadnej sprawy do załatwienia ręcznie.');
  }
  if (sprawy.includes('sync_woo_blad')) {
    db.prepare('UPDATE przesylki SET sync_woo_blad = NULL WHERE id = ?').run(p.id);
  }
  if (sprawy.includes('brak_etykiety')) {
    db.prepare('UPDATE przesylki SET etykieta_reczna = 1 WHERE id = ?').run(p.id);
  }
  return { ...p, sprawy };
}

// KANDYDACI DO ZEGARA SLEDZENIA (services/czuwacz-przesylek.js): przesylki NADANE
// z ostatnich dni, z numerem listu. `SELECT *`, bo wybor „kogo pytac" potrzebuje
// takze `odpowiedz_surowa` (podwykonawca WzA), a filtr po etapie (doreczona/zwrot
// wypadaja) liczy sie z `status_kuriera` w warstwie czystej — nie tutaj, zeby regula
// etapu miala jedno miejsce (domain/etap-przesylki.js).
// UKRYCIE PACZKI Z ZAKLADKI /przesylki (25.08.2026) — dla tych, ktorych zaden status nie
// uratuje: zamowienie testowe, etykieta zrobiona i nigdy przez kuriera niepodjeta.
//
// ⚠️ ZAPIS TYLKO ZNACZNIKA I AUTORA — wiersz zostaje nietkniety w kazdym innym wymiarze.
// Ukrycie NIE JEST kasowaniem: paczka dalej jest odpytywana przez czuwacza, dalej liczy sie
// do zamowienia i dalej wraca na oczy, gdy kurier ja zeskanuje (domain/przesylka-stan.js:
// przesylkaUkryta). Gdyby ta funkcja cokolwiek czyscila, tamten powrot nie mialby z czego
// nastapic.
export function ukryjPrzesylke(db, id, kto) {
  db.prepare('UPDATE przesylki SET ukryta_at = ?, ukryta_przez = ? WHERE id = ?')
    .run(teraz(), String(kto ?? 'operator'), id);
}

// ⚠️ `ukryta_przez` KASOWANE RAZEM ZE ZNACZNIKIEM. Zostawiony autor przy pustej dacie mowilby
// „ktos to ukryl", podczas gdy paczka jest widoczna — slad po decyzji, ktorej juz nie ma.
export function przywrocPrzesylke(db, id) {
  db.prepare('UPDATE przesylki SET ukryta_at = NULL, ukryta_przez = NULL WHERE id = ?').run(id);
}

// ⚠️ `sklep` DOKLADANY Z ZAMOWIENIA, i nie jest to ozdobnik (regresja 31.08.2026).
// Klient sledzenia kanalu Allegro wybiera KONTO po kanale zamowienia, a czuwacz przesylek
// widzi wylacznie wiersz przesylki — wolal wiec `odswiezStatusKuriera` z atrapa `{ id }`
// i kazda paczka kanalu Allegro dostawala `kanal: null`. Skutek byl niemy: zadnego zapisu,
// zadnego bledu, znacznik proby rosl co godzine. Trzy DORECZONE paczki wisialy szesc dni
// w zakladce jako „bez ruchu".
//
// LEFT JOIN, nie INNER: przesylka bez wiersza zamowienia (nie powinno sie zdarzyc, ale
// zapytanie karmi ZEGAR) ma dalej byc sledzona — DPD i InPost kanalu nie potrzebuja.
export function przesylkiDoSledzenia(db, odIso) {
  return db.prepare(`
    SELECT p.*, z.sklep AS sklep
    FROM przesylki p
    LEFT JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE p.status = 'nadana' AND p.numer_listu IS NOT NULL AND p.utworzona_at >= ?
    ORDER BY p.id
  `).all(odIso);
}

// Zapytania wiązane przez moduł do jego kontekstu bazy; istniejące eksporty zachowują parytet testów.
export function createZapytania(db) {
  return {
    pobierzPrzesylke: (...args) => pobierzPrzesylke(db, ...args),
    zywePrzesylki: (...args) => zywePrzesylki(db, ...args),
    nastepnaKolejnosc: (...args) => nastepnaKolejnosc(db, ...args),
    rozpocznijPrzesylke: (...args) => rozpocznijPrzesylke(db, ...args),
    zarejestrujPrzesylkeReczna: (...args) => zarejestrujPrzesylkeReczna(db, ...args),
    zakonczPrzesylke: (...args) => zakonczPrzesylke(db, ...args),
    zapiszIdPrzesylkiKuriera: (...args) => zapiszIdPrzesylkiKuriera(db, ...args),
    oznaczTworzonaUKuriera: (...args) => oznaczTworzonaUKuriera(db, ...args),
    oznaczBlad: (...args) => oznaczBlad(db, ...args),
    oznaczDoWyjasnienia: (...args) => oznaczDoWyjasnienia(db, ...args),
    zapiszBladSync: (...args) => zapiszBladSync(db, ...args),
    zapiszStatusDpd: (...args) => zapiszStatusDpd(db, ...args),
    zapiszProbeStatusuDpd: (...args) => zapiszProbeStatusuDpd(db, ...args),
    wyczyscBladStatusu: (...args) => wyczyscBladStatusu(db, ...args),
    wyczyscBladStatusuBezSledzenia: (...args) => wyczyscBladStatusuBezSledzenia(db, ...args),
    odblokujPrzesylke: (...args) => odblokujPrzesylke(db, ...args),
    domknijPrzesylke: (...args) => domknijPrzesylke(db, ...args),
    skasujPrzesylkeReczna: (...args) => skasujPrzesylkeReczna(db, ...args),
    zalatwPrzesylkeRecznie: (...args) => zalatwPrzesylkeRecznie(db, ...args),
    ukryjPrzesylke: (...args) => ukryjPrzesylke(db, ...args),
    przywrocPrzesylke: (...args) => przywrocPrzesylke(db, ...args),
    przesylkiDoSledzenia: (...args) => przesylkiDoSledzenia(db, ...args),
  };
}

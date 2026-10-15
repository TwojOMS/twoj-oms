import { grosze } from './kwoty.js';

// Paczka dla biura rachunkowego (spec 2026-09-02, Czesc D) — CZYSTA domena: z trzech list
// (sprzedaz z inFaktu, korekty z inFaktu, koszty z bazy) robi wiersze zestawienia, flagi
// „z pogranicza", sumy per waluta i kolejnosc stron. Zadnego I/O, zadnego zapytania.
//
// DOBOR PO DACIE ZROBILY JUZ ZAPYTANIA, NIE TEN MODUL: sprzedaz przychodzi z inFaktu po
// `q[sale_date_*]` (data sprzedazy, bo to ona wyznacza okres VAT — art. 19a ustawy o VAT),
// koszty z `kosztyOtrzymaneWMiesiacu` po dniu OTRZYMANIA (bo prawo do odliczenia powstaje
// nie wczesniej niz w rozliczeniu za okres otrzymania faktury — art. 86 ust. 10b pkt 1).
// Tutaj wylacznie FLAGUJEMY dokumenty, ktorych data WYSTAWIENIA wypada poza miesiacem
// paczki: ksiegowa ma je zobaczyc od razu, bo to sa jedyne wiersze, ktorych obecnosc
// w tej paczce trzeba komukolwiek tlumaczyc.

const dd = (iso) => {
  const s = String(iso ?? '').slice(0, 10);
  return s.length === 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : s;
};
// Kawalek uwagi o dacie: „wystawiona 02.09.2026" ALBO nazwany brak. Bez tego uwaga konczyla
// sie urwanym „wystawiona " — ksiegowa czyta to jako usterke wydruku, a nie jako brak danych.
const czescData = (iso, etykieta, brak) => (dd(iso) === '' ? brak : `${etykieta} ${dd(iso)}`);
// Miesiac wprost z napisu ISO, bez `new Date` — konstruktor przesunalby dzien graniczny
// o strefe czasowa i faktura z 31.08 potrafilaby wyladowac we wrzesniu.
const miesiacZ = (iso) => String(iso ?? '').slice(0, 7);

// Numer inFaktu `n/MM/RRRR` (korekta `n/KOR/MM/RRRR`): porzadek (rok, miesiac, kolejny)
// LICZBOWO — przy porownaniu napisow „10/08/2026" stanelby PRZED „2/08/2026" i zestawienie
// szlo by w kolejnosci, ktorej ksiegowa nie umie sprawdzic z niczym. Serie spoza wzorca
// (WDT/…, wlasne serie) ida na koniec, miedzy soba po napisie — nie zgadujemy, gdzie
// w numeracji glownej mialyby stac.
const KLUCZ = /^(\d+)\/(?:[A-Z]+\/)?(\d{2})\/(\d{4})$/;
export function porownajNumery(a, b) {
  const ma = KLUCZ.exec(String(a ?? ''));
  const mb = KLUCZ.exec(String(b ?? ''));
  if (ma && mb) {
    return (Number(ma[3]) - Number(mb[3])) || (Number(ma[2]) - Number(mb[2])) || (Number(ma[1]) - Number(mb[1]));
  }
  if (ma) return -1;
  if (mb) return 1;
  return String(a ?? '').localeCompare(String(b ?? ''), 'pl');
}

// ⚠️ Kwoty inFaktu SA JUZ w groszach i sa CALKOWITE (ta sama umowa, co w `kwoty.js`, gdzie
// `grosze()` mnozy NASZE napisy w zlotowkach przez 100 — tutaj mnozyc NIE WOLNO).
//
// ⚠️ CO `Math.round` NAPRAWDE ROBI, a czego NIE: broni wylacznie przed ULAMKIEM GROSZA
// (`2300.5` → `2301`), zeby ulamek nie wciagnal calej sumy miesiaca na floaty. NIE JEST
// straznikiem jednostki: gdyby inFakt kiedys oddal kwote w ZLOTOWKACH (`123.4` zamiast
// `12340`), zaokraglenie zrobi z niej `123` grosze — 100x za malo, bez bledu i bez sladu
// w paczce. Takiego bledu ten modul NIE WYKRYJE i wykryc nie moze (kwoty rzedu zlotowek sa
// nieodroznialne od poprawnych kwot groszowych), dlatego umowa „inFakt oddaje calkowite
// grosze" musi byc pilnowana tam, gdzie dane wchodza do panelu, a nie tutaj.
//
// Brak wartosci oddajemy jako `null`, a nie jako 0 — rozroznienie „zero zlotych" od „inFakt
// nie podal kwoty" jest tu roznica miedzy poprawna suma a suma po cichu za mala o fakture.
function groszeZInfaktu(wartosc) {
  if (wartosc === null || wartosc === undefined || String(wartosc).trim() === '') return null;
  const n = Number(wartosc);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Waluta z API bywa mala litera albo ze spacja („pln", " PLN ") — bez normalizacji sumy
// rozpadlyby sie na dwa koszyki, z ktorych zaden nie jest kwota do deklaracji. Pustka
// (i brak pola) znaczy zlotowki, tak jak dotad.
const walutaZ = (w) => String(w ?? '').trim().toUpperCase() || 'PLN';

// Konsument nie ma nazwy firmy — zestawienie ma pokazac czlowieka, nie pusta komorke.
const kontrahentZ = (d) => String(d?.client_company_name ?? '').trim()
  || [d?.client_first_name, d?.client_last_name].filter(Boolean).join(' ').trim();

// Jeden napis, dwa miejsca: uwaga na wierszu i sito, po ktorym paczka zbiera wiersze bez
// kwoty do ostrzezenia zbiorczego. Dwie kopie tego zdania rozjechalyby sie przy pierwszej
// poprawce jezykowej i ostrzezenie paczki po cichu przestaloby sie pojawiac.
const UWAGA_BRAK_KWOTY = 'brak kwoty w inFakcie — sprawdź fakturę';
// Uwaga kosztu wpisanego ręcznie — jedna stała, bo zestawienie kosztów (PRZ-086) ją z wierszy zdejmuje.
const UWAGA_PAPIER = 'dokument papierowy poza KSeF — dołącz oryginał';

function wierszSprzedazy(d, miesiac, numeryPoId) {
  const uwagi = [];
  const netto = groszeZInfaktu(d.net_price);
  const vat = groszeZInfaktu(d.tax_price);
  const brutto = groszeZInfaktu(d.gross_price);
  // Brakujaca kwota NIE wywraca calej paczki (biuro czeka na nia z terminem), ale musi byc
  // widoczna na wierszu — inaczej zestawienie wygladaloby na kompletne, a suma miesiaca
  // bylaby cicho zanizona. Koszty maja tu ostrzejsza regule (`grosze()` rzuca), bo tam kwoty
  // sa NASZYMI napisami w bazie i pusty napis znaczy blad zapisu, a nie brak danych z API.
  if (netto === null || vat === null || brutto === null) uwagi.push(UWAGA_BRAK_KWOTY);
  // Flaga dziala w OBIE strony: i faktura wystawiona po miesiacu (sprzedaz 31.08,
  // faktura 02.09 — art. 106i ust. 1), i wystawiona przed nim (zaliczka, art. 106i ust. 7).
  if (miesiacZ(d.invoice_date) !== miesiac) {
    uwagi.push(czescData(d.invoice_date, 'wystawiona', 'brak daty wystawienia'));
  }
  if (d.rodzaj === 'korekta') {
    // Korekta bez wskazania pierwotnej faktury jest dla ksiegowej bezuzyteczna. Trzy zrodla,
    // w tej kolejnosci:
    // 1. `corrected_invoice_number` — encja korekty inFaktu NIESIE numer faktury pierwotnej
    //    (sprawdzone na zywym koncie 2026-08-14; po tym polu szuka tez services/korekta.js).
    //    Jest pierwsze, bo dziala takze dla korekty do faktury spoza tej paczki.
    // 2. numer z TEJ paczki po `parent_id` — porownanie PO NAPISACH, bo inFakt potrafi oddac
    //    `id` liczba, a `parent_id` napisem; mapa po surowych wartosciach chybialaby po cichu.
    // 3. surowe `id` — sprawdzalne, choc niewygodne; lepsze niz samo „?".
    const wskazany = String(d.corrected_invoice_number ?? '').trim();
    const pierwotna = wskazany || numeryPoId.get(String(d.parent_id ?? ''));
    uwagi.push(pierwotna ? `korekta do ${pierwotna}` : `korekta do faktury id ${d.parent_id ?? '?'}`);
  }
  if (!d.ksef_number) uwagi.push('bez KSeF');
  return {
    rodzaj: d.rodzaj === 'korekta' ? 'korekta' : 'vat',
    uuid: d.uuid,
    numer: String(d.number ?? ''),
    kontrahent: kontrahentZ(d),
    nip: String(d.client_tax_code ?? '').trim(),
    wystawiona: String(d.invoice_date ?? '').slice(0, 10),
    sprzedaz: String(d.sale_date ?? '').slice(0, 10),
    // Korekty przychodza z inFaktu jako roznice ze ZNAKIEM (ujemne przy zmniejszeniu)
    // i tak samo, ze znakiem, wchodza do sum — suma miesiaca ma byc kwota do deklaracji.
    nettoGr: netto ?? 0,
    vatGr: vat ?? 0,
    bruttoGr: brutto ?? 0,
    waluta: walutaZ(d.currency),
    ksef: d.ksef_number ?? '',
    uwagi,
  };
}

function wierszKosztu(k, miesiac) {
  const uwagi = [];
  const reczny = k.zrodlo === 'reczne';
  const otrzymana = String(k.dzien_otrzymania ?? '').slice(0, 10);
  const wystawiona = String(k.data_wystawienia ?? '').slice(0, 10);
  // Przy kosztach obie daty naraz, bo to one tlumacza obecnosc dokumentu w tym miesiacu:
  // wystawiony w lipcu, odebrany w sierpniu = odliczenie sierpniowe. Dla dokumentu recznego
  // ta flaga nie ma sensu — dzien otrzymania JEST tam dniem wystawienia (patrz zapytanie
  // `kosztyOtrzymaneWMiesiacu`), wiec z definicji nigdy by nie zapalila.
  // Pusty dzien otrzymania zapala uwage TAK SAMO jak data z innego miesiaca: bez niego nie
  // wiadomo, dlaczego dokument lezy w tej paczce, a to jest dokladnie pytanie ksiegowej.
  if (!reczny && (miesiacZ(wystawiona) !== miesiac || otrzymana === '')) {
    uwagi.push(`${czescData(wystawiona, 'wystawiona', 'brak daty wystawienia')}, ${czescData(otrzymana, 'otrzymana', 'brak daty otrzymania')}`);
  }
  if (reczny) uwagi.push(UWAGA_PAPIER);
  return {
    klucz: k.ksef_number,
    zrodlo: k.zrodlo,
    numer: String(k.numer_dokumentu ?? ''),
    kontrahent: String(k.sprzedawca_nazwa ?? '').trim(),
    nip: String(k.sprzedawca_nip ?? '').trim(),
    wystawiona,
    otrzymana,
    // ⚠️ Kwoty kosztow leza w bazie jako NAPISY ('123.45') — na grosze przelicza je wylacznie
    // `grosze()`, ktore na pustce i na nie-liczbie RZUCA. Wywrocone skladanie paczki jest tu
    // jedynym dobrym wyjsciem: NaN w JSON-ie staje sie `null`, wiec paczka wygladalaby na
    // kompletna, a suma miesiaca bylaby po cichu o jeden dokument za mala.
    nettoGr: grosze(k.netto, `netto ${k.numer_dokumentu}`),
    vatGr: grosze(k.vat, `VAT ${k.numer_dokumentu}`),
    bruttoGr: grosze(k.brutto, `brutto ${k.numer_dokumentu}`),
    waluta: walutaZ(k.waluta),
    // Rodzaj wprost z KSeF ('Vat'|'Kor'|'Zal'|'Roz'|'Upr') albo 'Reczny'. Korekta kosztowa
    // ('Kor') przychodzi ze znakiem nadanym przez wystawce i tak, ze znakiem, wchodzi do sum.
    rodzaj: k.rodzaj,
    ksef: reczny ? '' : k.ksef_number,
    uwagi,
    // Dokument z KSeF panel umie pokazac jako strone paczki; papierowy trzeba dolozyc recznie.
    maPlik: !reczny,
  };
}

// Sumy WYLACZNIE na liczbach calkowitych i osobno dla kazdej waluty — dodanie EUR do PLN
// dawaloby liczbe, ktorej nie ma w zadnej deklaracji, a przeliczenie kursem nie jest
// zadaniem tego modulu (kurs zalezy od daty i od tego, ktora to deklaracja).
//
// Wiersz, ktoremu inFakt nie podal ktorejkolwiek kwoty, do sum NIE WCHODZI WCALE — takze
// tymi kwotami, ktore podal. Dolozenie samego netto do sumy, gdy brutto jest nieznane,
// dalo by sume, w ktorej netto + VAT nie zgadza sie z brutto: liczbe wygladajaca na
// uzgodniona i nieuzgadnialna z niczym. Suma ma byc kwota z KOMPLETNYCH dokumentow,
// a o niekompletnych mowi ostrzezenie paczki i znacznik `niepelne`.
// ⚠️ SUMA NIE JEST WTEDY SUMA KOLUMNY: wiersz nadal pokazuje kwoty, ktore inFakt podal.
// To jest swiadome — kolumna ma pokazac, co wiemy, a suma tylko to, co da sie zsumowac.
//
// ⚠️ `niepelne` LEZY W TYM SAMYM OBIEKCIE, co koszyki walut, wiec kazdy, kto iteruje
// `Object.entries(sumy.sprzedaz)`, MUSI ten klucz pominac — inaczej wydrukuje kolumne
// waluty „niepelne". Klucza NIE MA, gdy wszystko jest kompletne.
function sumy(wiersze) {
  const s = {};
  let pominiete = 0;
  for (const w of wiersze) {
    if (w.uwagi.includes(UWAGA_BRAK_KWOTY)) { pominiete += 1; continue; }
    s[w.waluta] ??= { nettoGr: 0, vatGr: 0, bruttoGr: 0 };
    s[w.waluta].nettoGr += w.nettoGr;
    s[w.waluta].vatGr += w.vatGr;
    s[w.waluta].bruttoGr += w.bruttoGr;
  }
  if (pominiete > 0) s.niepelne = true;
  return s;
}

// Polska odmiana przez liczebnik — zdanie o kwarantannie czyta czlowiek, wiec „2 dokumenty
// leżą", nie „2 dokument(ów)".
const liczebnik = (n, jeden, kilka, wiele) => {
  const d = n % 10;
  const r = n % 100;
  if (n === 1) return `${n} ${jeden}`;
  return `${n} ${d >= 2 && d <= 4 && (r < 12 || r > 14) ? kilka : wiele}`;
};

/**
 * Zestawienie KOSZTÓW miesiąca w dwóch osobnych częściach (PRZ-086): faktury kosztowe z KSeF
 * i faktury dopisane ręcznie. Zbudowane na `zlozPaczke`, żeby wiersze, uwagi, kryterium daty
 * (dzień otrzymania) i ostrzeżenie o kwarantannie były DOKŁADNIE te same co w pliku kosztowym
 * paczki — dwie definicje „co jest kosztem miesiąca” rozjechałyby się przy pierwszej zmianie.
 *
 * ⚠️ PODZIAŁ PO `zrodlo`, NIE PO NUMERZE KSeF: wiersz ręczny ma zawsze klucz `RECZNY-…`, ale
 * to `zrodlo` jest polem, które baza wymusza (`ksef`|`reczne`); zgadywanie z kształtu numeru
 * wrzuciłoby kiedyś fakturę do złej części, a suma części jest kwotą dla księgowej.
 * ⚠️ `lp` liczy się OD NOWA w każdej części — każda ma własną tabelę na wydruku.
 * ⚠️ `sumy.razem` bierze sumę całej listy z `zlozPaczke`, a nie dodaje dwóch sum części:
 * jedna reguła sumowania (pominięte niepełne wiersze) zamiast dwóch, które mogłyby się rozejść.
 */
export function zlozZestawienieKosztow({ miesiac, koszty = [], kwarantanna = 0 }) {
  const p = zlozPaczke({ miesiac, koszty, kwarantanna });
  const czesc = (reczne) => p.koszty.filter((w) => (w.zrodlo === 'reczne') === reczne)
    .map((w, i) => ({ ...w, lp: i + 1 }));
  const ksef = czesc(false);
  // ⚠️ „dołącz oryginał” znika Z WIERSZY części ręcznej i staje RAZ pod jej nagłówkiem
  // (`opisRecznych`): w osobnej części dotyczy każdego wiersza bez wyjątku, a powtórzone
  // w wąskiej kolumnie Uwagi rozpychało każdy wiersz do czterech linii (piaskownica 15.10).
  const reczne = czesc(true).map((w) => ({ ...w, uwagi: w.uwagi.filter((u) => u !== UWAGA_PAPIER) }));
  return {
    miesiac,
    ksef,
    reczne,
    opisRecznych: 'Dokumenty spoza KSeF (zagraniczne, papierowe) — do zestawienia dołącz ich oryginały.',
    sumy: { ksef: sumy(ksef), reczne: sumy(reczne), razem: p.sumy.koszty },
    // Zdanie o kwarantannie pochodzi z paczki — tu księgowa trzyma ZESTAWIENIE, nie paczkę.
    ostrzezenia: p.ostrzezenia.map((o) => o.replace('w tej paczce', 'w tym zestawieniu')),
  };
}

export function zlozPaczke({
  miesiac, faktury = [], korekty = [], koszty = [], kwarantanna = 0,
}) {
  // Klucze mapy jako NAPISY (i tylko dla dokumentow, ktore id maja) — inFakt potrafi oddac
  // `id` liczba, a `parent_id` napisem; bez tego korekta gubilaby swoja fakture po cichu,
  // a pusty klucz laczylby ze soba wszystkie dokumenty bez id.
  const numeryPoId = new Map(faktury
    .filter((d) => d?.id !== null && d?.id !== undefined)
    .map((d) => [String(d.id), String(d.number ?? '')]));
  // Kopia przed `sort` — `sort` sortuje W MIEJSCU i bez tego modul (czysty z zalozenia)
  // przestawialby liste, ktora dostal od wolajacego.
  const fak = [...faktury].sort((a, b) => porownajNumery(a.number, b.number))
    .map((d) => wierszSprzedazy({ ...d, rodzaj: 'vat' }, miesiac, numeryPoId));
  const kor = [...korekty].sort((a, b) => porownajNumery(a.number, b.number))
    .map((d) => wierszSprzedazy({ ...d, rodzaj: 'korekta' }, miesiac, numeryPoId));
  // Korekty na koncu, po fakturach — inaczej numeracja stron rozjezdzalaby sie z kolejnoscia
  // wydruku, a korekta czytana przed swoja faktura pierwotna nie mowi nic.
  const sprzedaz = [...fak, ...kor].map((w, i) => ({ lp: i + 1, ...w }));
  // Koszty w kolejnosci OTRZYMANIA (tak, jak wpadaly do skrzynki), a przy tym samym dniu
  // po numerze dokumentu — ta sama kolejnosc, ktora oddaje zapytanie z bazy.
  const kosztyW = [...koszty]
    .sort((a, b) => String(a.dzien_otrzymania).localeCompare(String(b.dzien_otrzymania))
      || String(a.numer_dokumentu).localeCompare(String(b.numer_dokumentu), 'pl'))
    .map((k, i) => ({ lp: i + 1, ...wierszKosztu(k, miesiac) }));
  const ostrzezenia = [];
  // ⚠️ Brak kwoty widoczny TAKZE NA POZIOMIE PACZKI, nie tylko na wierszu. Ksiegowa czyta
  // najpierw ostrzezenia i sumy — wiersz z uwaga potrafi utonac wsrod stu innych, a suma
  // miesiaca jest przez ten brak niepelna. Numery ida wprost do ostrzezenia, zeby dalo sie
  // pojsc do inFaktu bez przeszukiwania zestawienia.
  const bezKwoty = sprzedaz.filter((w) => w.uwagi.includes(UWAGA_BRAK_KWOTY));
  if (bezKwoty.length > 0) {
    const ile = liczebnik(bezKwoty.length, 'dokument sprzedażowy', 'dokumenty sprzedażowe', 'dokumentów sprzedażowych');
    ostrzezenia.push(`${ile} bez kwoty w inFakcie — sumy sprzedaży są NIEPEŁNE, sprawdź faktury: ${bezKwoty.map((w) => w.numer).join(', ')}`);
  }
  // Kwarantanna to dokumenty, ktorych panel nie umial zapisac jako koszt. Paczka MUSI o nich
  // powiedziec wprost — milczenie znaczyloby dla ksiegowej „to jest caly miesiac".
  if (kwarantanna > 0) {
    ostrzezenia.push(`${liczebnik(kwarantanna, 'dokument kosztowy leży', 'dokumenty kosztowe leżą', 'dokumentów kosztowych leży')} w kwarantannie panelu i NIE ma ich w tej paczce.`);
  }
  return {
    miesiac,
    sprzedaz,
    koszty: kosztyW,
    sumy: { sprzedaz: sumy(sprzedaz), koszty: sumy(kosztyW) },
    ostrzezenia,
  };
}

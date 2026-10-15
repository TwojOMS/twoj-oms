// Czyste reguly zakladki /kampania (WRZESIEN30, 2026-08-25): wybor kampanii, kafle,
// slupki dzienne i agregat wszystkich kuponow. Wejsciem sa zamowienia PO zLinii
// (anulowane juz efektywne, oplacone_at juz z listy wplat) — zadna regula statusu ani
// platnosci nie ma tu drugiej kopii: status daje wyliczStatus, kwote zamowienia
// podsumowaniePozycji (ta sama miara, co lista i bariera faktury — lekcja z audytu:
// raport liczacy inna miara niz faktura rozjechal sie o 225 zl).
//
// ⚠️ Dzien zamowienia to dzienWarszawa(utworzone_at) — ta sama funkcja, co filtr listy.
// Porownania okna ida po napisach RRRR-MM-DD (kolejnosc leksykalna = kalendarzowa).

import { kuponyZWiersza } from './kupony.js';
import { atrybucjaZWiersza, opisAtrybucji } from './atrybucja.js';
import { dzienWarszawa } from './format-daty.js';
import { grosze, zl } from './kwoty.js';
import { wyliczStatus } from './status.js';
import { podsumowaniePozycji } from './tabela-pozycji.js';

const DZIEN_MS = 86_400_000;
// Okno kampanii dluzsze niz kwartal to niemal na pewno literowka w dacie — ekran mowi
// o tym wprost (bladOkna) zamiast rysowac wykres na setki slupkow.
const MAKS_DNI_OKNA = 120;

// Kwota zamowienia w groszach — NIGDY nie rzuca: kampania ma sie policzyc takze wtedy,
// gdy jedno zamowienie ma uszkodzona kwote (wtedy liczy sie jako 0, a rozjazd i tak
// widac na karcie tego zamowienia).
function kwotaGr(z) {
  const kwota = podsumowaniePozycji(z).oczekiwanaZl ?? z?.kwota_brutto;
  if (!kwota) return 0;
  try { return grosze(kwota, 'kwota zamówienia'); } catch { return 0; }
}

function rabatGr(kupony, kodMalymi) {
  let suma = 0;
  for (const k of kupony) {
    if (String(k.kod).toLowerCase() !== kodMalymi) continue;
    try { suma += grosze(k.rabat, 'rabat kuponu'); } catch { /* uszkodzony rabat = 0 */ }
  }
  return suma;
}

// Kolejne dni kalendarzowe od..do wlacznie. Arytmetyka w UTC na polnocy — zmiana czasu
// letni/zimowy nie ma prawa zgubic ani zdublowac dnia.
function kolejneDni(od, doDnia) {
  const start = Date.parse(`${od}T00:00:00Z`);
  const koniec = Date.parse(`${doDnia}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(koniec) || koniec < start) return null;
  if ((koniec - start) / DZIEN_MS > MAKS_DNI_OKNA) return null;
  const dni = [];
  for (let t = start; t <= koniec; t += DZIEN_MS) dni.push(new Date(t).toISOString().slice(0, 10));
  return dni;
}

/**
 * Ktora kampanie pokazac. Wskazany kod (z adresu) wygrywa zawsze — ale NIEZNANY kod
 * oddaje null, nie cicha podmiane na inna kampanie: adres z literowka ma powiedziec
 * „nie ma takiej", a nie pokazac cudze liczby pod cudzym naglowkiem.
 * Bez wskazania: pierwsza, ktorej okno obejmuje dzis; gdy zadna nie trwa — pierwsza
 * z listy (lista idzie od najnowszej, wiec to ostatnio zaczeta).
 */
export function wybierzKampanie(kampanie, dzis, kod = null) {
  if (kod) {
    const szukany = String(kod).toLowerCase();
    return kampanie.find((k) => k.kod.toLowerCase() === szukany) ?? null;
  }
  return kampanie.find((k) => k.od_dnia <= dzis && dzis <= k.do_dnia) ?? kampanie[0] ?? null;
}

export function stanKampanii({ kampania, zamowienia, dzis }) {
  const kodMalymi = kampania.kod.toLowerCase();

  // Zamowienia z kodem TEJ kampanii — filtr po sparsowanej liscie, nie po LIKE w SQL:
  // kod bedacy przedrostkiem innego (wrzesien30 / wrzesien305) nie ma prawa sie skleic.
  const zKodem = [];
  for (const z of zamowienia) {
    const kupony = kuponyZWiersza(z.kupony_json);
    if (!kupony.some((k) => String(k.kod).toLowerCase() === kodMalymi)) continue;
    zKodem.push({ z, kupony, dzien: dzienWarszawa(z.utworzone_at) });
  }

  // Zasieg kampanii: okno dat (oba konce wlacznie) i sklep, jesli kampania go wskazuje.
  // Uzycie poza zasiegiem (inny sklep, data poza oknem) NIE wchodzi do kafli, ale jest
  // policzone i widoczne — zniknely by inaczej bez sladu, a to dokladnie ten rodzaj
  // rozjazdu, ktory podwaza caly ekran.
  const wZasiegu = [];
  let pozaZasiegiem = 0;
  // Uzycia PO koncu okna osobno: kod, ktory dziala po do_dnia, to niewygaszony kupon
  // w sklepie — alert (alertyKampanii) ma na czym stanac. Reszta „poza zasiegiem"
  // (inny sklep, uzycie przed startem) nie jest niczyja awaria.
  let uzycPoOknie = 0;
  for (const p of zKodem) {
    const wOknie = p.dzien >= kampania.od_dnia && p.dzien <= kampania.do_dnia;
    const sklepOk = !kampania.sklep || p.z.sklep === kampania.sklep;
    if (wOknie && sklepOk) wZasiegu.push(p);
    else {
      pozaZasiegiem += 1;
      if (p.dzien > kampania.do_dnia && sklepOk) uzycPoOknie += 1;
    }
  }

  const aktywne = wZasiegu.filter((p) => !p.z.anulowane);
  const anulowanych = wZasiegu.length - aktywne.length;

  let przychod = 0;
  let oplacone = 0;
  let rabaty = 0;
  const uzyciaWDniu = new Map();
  // Kwota dnia OSOBNO od liczby uzyc — wykres „pieniadze dzien po dniu" rysuje zlotowki,
  // a nie sztuki, i liczy je ta sama miara co kafle (kwotaGr), zeby suma slupkow rownala
  // sie kaflowi przychodu co do grosza.
  const kwotaWDniu = new Map();
  for (const p of aktywne) {
    const kw = kwotaGr(p.z);
    przychod += kw;
    if (p.z.oplacone_at) oplacone += kw;
    rabaty += rabatGr(p.kupony, kodMalymi);
    uzyciaWDniu.set(p.dzien, (uzyciaWDniu.get(p.dzien) ?? 0) + 1);
    kwotaWDniu.set(p.dzien, (kwotaWDniu.get(p.dzien) ?? 0) + kw);
  }

  const dniOkna = kolejneDni(kampania.od_dnia, kampania.do_dnia);
  const dni = (dniOkna ?? []).map((dzien) => ({
    dzien,
    uzycia: uzyciaWDniu.get(dzien) ?? 0,
    kodKwotaZl: zl(kwotaWDniu.get(dzien) ?? 0),
    dzis: dzien === dzis,
  }));

  const faza = dzis < kampania.od_dnia ? 'przed' : (dzis > kampania.do_dnia ? 'po' : 'trwa');

  return {
    uzycia: aktywne.length,
    anulowanych,
    pozaZasiegiem,
    uzycPoOknie,
    przychodZl: zl(przychod),
    oplaconeZl: zl(oplacone),
    doZaplatyZl: zl(przychod - oplacone),
    rabatyZl: zl(rabaty),
    sredniaZl: aktywne.length ? zl(Math.round(przychod / aktywne.length)) : null,
    faza,
    dzienKampanii: faza === 'trwa' && dniOkna ? dniOkna.indexOf(dzis) + 1 : null,
    dniOkna: dniOkna?.length ?? 0,
    dni,
    bladOkna: dniOkna ? null
      : `Okno kampanii ${kampania.od_dnia} – ${kampania.do_dnia} nie jest poprawnym zakresem dni (do ${MAKS_DNI_OKNA} dni) — popraw wiersz w tabeli kampanie.`,
    // Tabela: WSZYSTKIE zamowienia w zasiegu, takze anulowane (oznaczone statusem) —
    // kafle ich nie licza, ale czlowiek ma je widziec, bo „znikniete uzycie" wyglada
    // jak blad panelu. Kolejnosc wejsciowa (najnowsze pierwsze) zostaje.
    wiersze: wZasiegu.map((p) => ({
      id: p.z.id,
      numer: p.z.numer,
      sklep: p.z.sklep,
      utworzone_at: p.z.utworzone_at,
      status: wyliczStatus(p.z),
      kwotaZl: zl(kwotaGr(p.z)),
      rabatZl: zl(rabatGr(p.kupony, kodMalymi)),
      oplacone: Boolean(p.z.oplacone_at),
      // Skad przyszlo TO zamowienie (Etap 3) — gotowy opis, nie surowe pola.
      zrodlo: opisAtrybucji(atrybucjaZWiersza(p.z.atrybucja_json)),
    })),
    // Rozbicie uzyc kodu wg zrodla ruchu — jedyne miejsce, ktore laczy pieniadze
    // z marketingiem po stronie NASZYCH danych (a nie cudzych API).
    zrodla: zrodlaUzyc(aktywne, kodMalymi),
  };
}

/**
 * Uzycia kodu wg zrodla ruchu: ile zamowien i za ile, po kluczu z `opisAtrybucji`.
 *
 * ⚠️ ZAMOWIENIA BEZ ATRYBUCJI DOSTAJA WLASNY WIERSZ („Nie wiadomo"), a nie wpadaja do
 * „Bezpośrednich". To dwie rozne rzeczy: brak danych i wejscie bez zrodla. Zlanie ich
 * w jedno robilo by z luki w danych fakt o zachowaniu klienta.
 */
function zrodlaUzyc(aktywne, kodMalymi) {
  const mapa = new Map();
  for (const p of aktywne) {
    const opis = opisAtrybucji(atrybucjaZWiersza(p.z.atrybucja_json));
    const wpis = mapa.get(opis.klucz) ?? { klucz: opis.klucz, etykieta: opis.etykieta, uzycia: 0, kwotaGr: 0, rabatGr: 0 };
    wpis.uzycia += 1;
    wpis.kwotaGr += kwotaGr(p.z);
    wpis.rabatGr += rabatGr(p.kupony, kodMalymi);
    mapa.set(opis.klucz, wpis);
  }
  return [...mapa.values()]
    .sort((a, b) => b.uzycia - a.uzycia || a.etykieta.localeCompare(b.etykieta))
    .map(({ kwotaGr: k, rabatGr: r, ...reszta }) => ({ ...reszta, kwotaZl: zl(k), rabatZl: zl(r) }));
}

// ——— ZRODLA ZEWNETRZNE: META I GA4 (Etapy 1-2, 2026-08-25) ——————————————————————————
//
// ⚠️ WEJSCIEM SA WIERSZE LUSTRA (kolumny bazy), nie odpowiedzi API — ta domena nie wie,
// ze Meta i GA4 w ogole istnieja poza tabelami. Pobieraniem zajmuje sie czuwacz.

const suma = (wiersze, pole) => wiersze.reduce((s, w) => s + (Number(w[pole]) || 0), 0);

const sumaKwot = (wiersze, pole) => wiersze.reduce((s, w) => {
  try { return s + grosze(w[pole], 'kwota ze źródła'); } catch { return s; }
}, 0);

// Dzielenie, ktore ODMAWIA zamiast zmyslac: brak mianownika to BRAK MIARY, nie zero.
// „Koszt 0,00 zł za użycie kodu" przy zerze użyć wygląda jak fakt i jest nieprawdą.
const iloraz = (licznik, mianownik, miejsca = 2) =>
  (mianownik > 0 ? (licznik / mianownik).toFixed(miejsca) : null);

/**
 * Iloraz PIENIEZNY: licznik jest w GROSZACH, wiec wynik tez — i dopiero `zl` robi z niego
 * napis w zlotowkach.
 *
 * ⚠️ ZLAPANE WLASNYM TESTEM PRZED WDROZENIEM: pierwsza wersja dzielila grosze przez liczbe
 * i oddawala wynik przez `toFixed(2)`, czyli CPC „83.33" tam, gdzie prawda to 0,83 zł —
 * a punktem odniesienia na ekranie jest 0,125 zl. Panel pokazywalby koszt kliknięcia
 * SZESCSETKROTNIE zawyzony i nikt by nie zauwazyl, ze to grosze udajace zlotowki.
 */
const ilorazKwoty = (licznikGr, mianownik) =>
  (mianownik > 0 ? zl(Math.round(licznikGr / mianownik)) : null);

export function dolaczZrodla(stan, { meta = [], ga4 = [], stany = {} }) {
  const wydatekGr = sumaKwot(meta, 'wydatek');
  const klikniecia = suma(meta, 'klikniecia');
  const kliknieciaLinku = suma(meta, 'klikniecia_linku');
  const sesjeMeta = suma(ga4, 'sesje_meta');
  const przychodGr = (() => {
    try { return grosze(stan.przychodZl, 'przychód kampanii'); } catch { return 0; }
  })();

  const sesje = suma(ga4, 'sesje');
  const stanZrodla = (nazwa) => ({
    blad: stany[nazwa]?.ostatni_blad ?? null,
    ostatniSukcesAt: stany[nazwa]?.ostatni_sukces_at ?? null,
  });

  // Dni: liczby ze zrodel doklejone do SLUPKOW UZYC, po dniu. Dzien bez danych dostaje
  // zera i zachowuje uzycia — luka w przebiegu wygladalaby jak przerwa w danych.
  const metaWgDni = new Map(meta.map((w) => [w.dzien, w]));
  const ga4WgDni = new Map(ga4.map((w) => [w.dzien, w]));
  const dni = stan.dni.map((d) => ({
    ...d,
    wydatekZl: metaWgDni.get(d.dzien)?.wydatek ?? '0.00',
    wyswietlenia: Number(metaWgDni.get(d.dzien)?.wyswietlenia ?? 0),
    // Kliknięcia LINKOWE dnia — tor lejka „Od wyświetlenia do zamówienia". Linkowe,
    // nie wszystkie: lejek liczy ruch DO sklepu, a nie polubienia i rozwinięcia tekstu.
    kliknieciaLinku: Number(metaWgDni.get(d.dzien)?.klikniecia_linku ?? 0),
    sesje: Number(ga4WgDni.get(d.dzien)?.sesje ?? 0),
    sesjeMeta: Number(ga4WgDni.get(d.dzien)?.sesje_meta ?? 0),
    odslonyPromo: Number(ga4WgDni.get(d.dzien)?.odslony_promo ?? 0),
  }));

  // Prognoza wydatku do konca okna: pelne dni (przed dzis) z niezerowym wydatkiem daja
  // srednie tempo, a dzien dzisiejszy i kolejne licza sie po tej sredniej — dzisiejszy
  // wydatek jest z natury niepelny, wiec do tempa nie wchodzi. Bez ani jednego pelnego
  // dnia z wydatkiem prognozy NIE MA (jeden niepelny dzien to nie tempo), po koncu okna
  // tez nie (nie ma juz czego prognozowac).
  const indeksDzis = dni.findIndex((d) => d.dzis);
  let prognozaZl = null;
  if (indeksDzis >= 0) {
    const pelneGr = dni.slice(0, indeksDzis)
      .map((d) => { try { return grosze(d.wydatekZl, 'wydatek dnia'); } catch { return 0; } })
      .filter((gr) => gr > 0);
    if (pelneGr.length) {
      const wydanePelne = pelneGr.reduce((s, gr) => s + gr, 0);
      const pozostale = dni.length - indeksDzis; // z dzisiejszym dniem wlacznie
      prognozaZl = zl(Math.round(wydanePelne + (wydanePelne / pelneGr.length) * pozostale));
    }
  }

  return {
    ...stan,
    dni,
    meta: {
      saDane: meta.length > 0,
      wydatekZl: zl(wydatekGr),
      wyswietlenia: suma(meta, 'wyswietlenia'),
      klikniecia,
      kliknieciaLinku,
      prognozaZl,
      // ⚠️⚠️ ZASIEG NIE MA SUMY I MIEC NIE MOZE: to liczba OSOB, wiec dodanie dwoch dni
      // liczy dwa razy kazdego, kto widzial reklame dwa razy. Oddajemy NAJLEPSZY DZIEN —
      // jedyna wartosc zasiegu, ktora jest prawdziwa bez zastrzezen.
      zasiegNajlepszyDzien: meta.length ? Math.max(...meta.map((w) => Number(w.zasieg) || 0)) : 0,
      // CPC liczone z WSZYSTKICH klikniec (nie samych linkowych) — dokladnie ta sama miara,
      // co punkt odniesienia 0,125 zl z kampanii ruchowej VII–VIII.2026. Inna miara
      // zamienilaby porownanie w mylace zestawienie dwoch roznych rzeczy.
      cpcZl: ilorazKwoty(wydatekGr, klikniecia),
      kosztUzyciaZl: wydatekGr > 0 ? ilorazKwoty(wydatekGr, stan.uzycia) : null,
      // Przychod z kodem na zlotowke reklamy — LICZBA, nie kwota (oba czlony w groszach,
      // wiec jednostki sie skracaja). ⚠️ ZERO PRZY NIEZEROWYM WYDATKU ZOSTAJE ZEREM
      // i ma zostac: „wydalismy i nic z tego nie przyszlo" to najwazniejszy sygnal, jaki
      // ten ekran moze dac. Odmawiamy WYLACZNIE przy braku wydatku — wtedy nie ma czego
      // dzielic, a nie „wynik jest zerowy".
      roas: wydatekGr > 0 ? iloraz(przychodGr, wydatekGr, 1) : null,
      ...stanZrodla('meta'),
    },
    ga4: {
      saDane: ga4.length > 0,
      sesje,
      sesjeMeta,
      odslonyPromo: suma(ga4, 'odslony_promo'),
      // Pokrycie pomiaru: ile klikniec linkowych z Mety GA4 w ogole widzi jako sesje.
      // To ILORAZ DWOCH ZRODEL, wiec ma sens wylacznie, gdy OBA cos oddaly — 0% z samego
      // braku danych GA4 wygladaloby jak fakt o zgodach, a jest luka w pomiarze.
      // Zero PRZY DANYCH zostaje zerem: „GA4 nie widzi nic z Mety" to sygnal (alert).
      pokryciePct: ga4.length > 0 && kliknieciaLinku > 0
        ? Math.round((sesjeMeta / kliknieciaLinku) * 100)
        : null,
      // ⚠️ UZYTKOWNIKOW NIE SUMUJEMY — `totalUsers` to liczba unikalnych ludzi w DNIU,
      // wiec suma po dniach liczy dwa razy kazdego, kto wrocil nazajutrz. Ta sama zasada,
      // co przy zasiegu Mety wyzej.
      sesjiNaUzycie: iloraz(sesje, stan.uzycia, 1),
      ...stanZrodla('ga4'),
    },
  };
}

// ——— ZAMOWIENIA Z REKLAM (utm) — drugi licznik kampanii (2026-08-27) ————————————————
//
// Kod mierzy CALA promocje (rozdaje go tez baner na stronie, wiec trafia i do ruchu
// z Google), a znacznik utm_campaign w atrybucji mierzy WYLACZNIE klikniecia w reklame.
// To sa dwa rozne liczniki jednej kampanii: czesc zamowien ma oba znaczniki naraz
// (klikniecie w reklame + wpisany kod), wiec ich sie NIE sumuje i NIE porownuje.
// Bez tego rozdzialu wynik banera zostalby przypisany Mecie — w obie strony.

/**
 * Dokleja do stanu sekcje „zamowienia z reklam": zamowienia, ktorych atrybucja niesie
 * utm_campaign TEJ kampanii — takze (przede wszystkim) te BEZ kodu rabatowego.
 *
 * ⚠️ Wolac PO dolaczZrodla: koszt zamowienia i zwrot licza sie z stan.meta.wydatekZl.
 * Bez danych Mety oba sa null — sekcja pokazuje wtedy same liczby zamowien.
 */
export function dolaczZamowieniaZReklam(stan, { kampania, zamowieniaUtm = [] }) {
  const kodMalymi = kampania.kod.toLowerCase();

  // Dokladne dopasowanie kampanii na SPARSOWANEJ atrybucji — SQL (LIKE) zawezil zbior
  // tylko do „jakakolwiek kampania", a prefiksy (wrzesien30/wrzesien305) rozstrzyga sie
  // tu, ta sama zasada co przy kuponach.
  const trafione = [];
  for (const z of zamowieniaUtm) {
    const atr = atrybucjaZWiersza(z.atrybucja_json);
    if (!atr?.kampania || String(atr.kampania).toLowerCase() !== kodMalymi) continue;
    trafione.push({ z, atr, dzien: dzienWarszawa(z.utworzone_at) });
  }

  // Ten sam zasieg, co przy kodzie (okno dat + sklep) — dwa liczniki jednej kampanii
  // nie moga miec dwoch roznych definicji zasiegu.
  const wZasiegu = [];
  let pozaZasiegiem = 0;
  for (const p of trafione) {
    const wOknie = p.dzien >= kampania.od_dnia && p.dzien <= kampania.do_dnia;
    const sklepOk = !kampania.sklep || p.z.sklep === kampania.sklep;
    if (wOknie && sklepOk) wZasiegu.push(p);
    else pozaZasiegiem += 1;
  }

  const aktywne = wZasiegu.filter((p) => !p.z.anulowane);
  const maKod = (p) => kuponyZWiersza(p.z.kupony_json)
    .some((k) => String(k.kod).toLowerCase() === kodMalymi);

  let kwota = 0;
  let bezKoduKwota = 0;
  let zKodem = 0;
  const wDniu = new Map();
  // Kwota i LICZBA dnia WYLACZNIE z zamowien bez kodu: kawalek „z reklam" dopelnia
  // kawalek „z kodem" do UNII — zamowienie z oboma znacznikami juz siedzi w liczbach
  // kodu (stanKampanii), wiec tu liczyloby sie drugi raz. Ta sama zasada dla wykresu
  // pieniedzy (kwota) i toru zamowien w lejku (liczba).
  const kwotaBezKoduWDniu = new Map();
  const bezKoduWDniu = new Map();
  for (const p of aktywne) {
    const kw = kwotaGr(p.z);
    kwota += kw;
    if (maKod(p)) zKodem += 1;
    else {
      bezKoduKwota += kw;
      kwotaBezKoduWDniu.set(p.dzien, (kwotaBezKoduWDniu.get(p.dzien) ?? 0) + kw);
      bezKoduWDniu.set(p.dzien, (bezKoduWDniu.get(p.dzien) ?? 0) + 1);
    }
    wDniu.set(p.dzien, (wDniu.get(p.dzien) ?? 0) + 1);
  }

  const wydatekGr = (() => {
    if (!stan.meta?.saDane) return 0;
    try { return grosze(stan.meta.wydatekZl, 'wydatek Mety'); } catch { return 0; }
  })();

  return {
    ...stan,
    dni: stan.dni.map((d) => ({
      ...d,
      zReklam: wDniu.get(d.dzien) ?? 0,
      zReklamBezKodu: bezKoduWDniu.get(d.dzien) ?? 0,
      reklamyKwotaZl: zl(kwotaBezKoduWDniu.get(d.dzien) ?? 0),
    })),
    reklamy: {
      liczba: aktywne.length,
      anulowanych: wZasiegu.length - aktywne.length,
      pozaZasiegiem,
      kwotaZl: zl(kwota),
      zKodem,
      bezKodu: aktywne.length - zKodem,
      bezKoduKwotaZl: zl(bezKoduKwota),
      kosztZamowieniaZl: wydatekGr > 0 ? ilorazKwoty(wydatekGr, aktywne.length) : null,
      // Zwrot liczony z zamowien Z REKLAM, nie z kodem — i zero przy wydanych pieniadzach
      // zostaje zerem, z tego samego powodu co roas wyzej: to sygnal, nie brak miary.
      zwrot: wydatekGr > 0 ? iloraz(kwota, wydatekGr, 1) : null,
      // W tabeli WYLACZNIE zamowienia bez kodu (z kodem stoja juz w „Zamowienia z kodem"),
      // ale wszystkie w zasiegu — takze anulowane, ze statusem, jak tam.
      wiersze: wZasiegu.filter((p) => !maKod(p)).map((p) => ({
        id: p.z.id,
        numer: p.z.numer,
        sklep: p.z.sklep,
        utworzone_at: p.z.utworzone_at,
        status: wyliczStatus(p.z),
        kwotaZl: zl(kwotaGr(p.z)),
        oplacone: Boolean(p.z.oplacone_at),
        zrodlo: opisAtrybucji(p.atr),
      })),
    },
  };
}

// ——— ALERTY KONTROLNE (2026-08-27) ——————————————————————————————————————————————————
//
// Warunki liczone przy renderze, z danych, ktore ekran i tak ma — zadnych zapytan na
// zewnatrz. Kazdy alert jest OSTROZNY (bramka na rozbieg, na male probki): falszywy
// alarm uczy ignorowania paska, a wtedy pasek nie chroni niczego.

// Punkt odniesienia CPC z kampanii ruchowej VII–VIII.2026 — TA SAMA liczba, ktora stoi
// w dopisku kafla „Koszt klikniecia" w widoku. Alert bije od dwukrotnosci.
const ODNIESIENIE_CPC_GR = 12.5;
// Ponizej tylu klikniec dzienny CPC to szum jednej drogiej aukcji, nie sygnal.
const MIN_KLIKNIEC_DLA_ALERTU = 20;

export function alertyKampanii({ stan, meta = [], dzis }) {
  const alerty = [];
  const wczoraj = new Date(Date.parse(`${dzis}T00:00:00Z`) - DZIEN_MS).toISOString().slice(0, 10);
  const wierszWczoraj = meta.find((w) => w.dzien === wczoraj);
  const wydatekWczorajGr = (() => {
    try { return grosze(wierszWczoraj?.wydatek, 'wydatek wczoraj'); } catch { return 0; }
  })();
  const wydatekDodatni = (napis) => {
    try { return grosze(napis, 'wydatek dnia') > 0; } catch { return false; }
  };

  // Reklama chodzila, a wczoraj nie wydala NIC — kampania mogla stanac po cichu (limit
  // platnosci, odrzucona reklama). Bramka na rozbieg: bez wczesniejszego dnia z wydatkiem
  // to nie awaria, tylko kampania, ktora jeszcze nie ruszyla.
  const wczorajWOknie = stan.dni.some((d) => d.dzien === wczoraj);
  const wydawalaWczesniej = meta.some((w) => w.dzien < wczoraj && wydatekDodatni(w.wydatek));
  if (stan.faza === 'trwa' && stan.meta?.saDane && wczorajWOknie && wydawalaWczesniej
    && wydatekWczorajGr === 0) {
    alerty.push('Reklama nie wydała wczoraj ani grosza — sprawdź w Menedżerze, czy kampania nadal działa (limit płatności, odrzucona reklama).');
  }

  // Pieniadze ida, a GA4 nie widzi z Mety ANI JEDNEJ sesji — najczesciej znaczy to, ze
  // linki reklam zgubily znaczniki utm (albo pomiar na stronie lezy).
  if (stan.meta?.saDane && wydatekDodatni(stan.meta.wydatekZl)
    && stan.ga4?.saDane && stan.ga4.sesjeMeta === 0) {
    alerty.push('Reklama wydaje, a GA4 nie widzi ani jednej sesji z Mety — sprawdź znaczniki utm w linkach reklam.');
  }

  // Kod zadzialal PO koncu kampanii = kupon w sklepie nie wygasl.
  if (stan.uzycPoOknie > 0) {
    alerty.push(`Kod zadziałał po końcu kampanii (${stan.uzycPoOknie} ×) — sprawdź datę wygaśnięcia kuponu w sklepie.`);
  }

  // Wczorajszy CPC ponad dwukrotnosc odniesienia — ta sama miara (wszystkie klikniecia),
  // co kafel i punkt odniesienia; mala probka nie bije (szum, nie trend). Bramka rozbiegu
  // ta sama, co przy cichym stopie: pierwszy dzien z wydatkiem bywa dniem CZESCIOWYM
  // (start wieczorem), a CPC z trzech godzin rozbiegu to nie tempo — zmierzone na
  // produkcji 27.08: 8,68 zl / 33 klikniecia = 0,26 zl i falszywy alarm pierwszego ranka.
  const klikWczoraj = Number(wierszWczoraj?.klikniecia) || 0;
  if (klikWczoraj >= MIN_KLIKNIEC_DLA_ALERTU && wydawalaWczesniej
    && wydatekWczorajGr / klikWczoraj > 2 * ODNIESIENIE_CPC_GR) {
    alerty.push(`Wczorajszy koszt kliknięcia (${zl(Math.round(wydatekWczorajGr / klikWczoraj))} zł) przekroczył dwukrotność odniesienia (0,125 zł) — sprawdź kreację i grupę odbiorców.`);
  }

  return alerty;
}

/**
 * Etapy kampanii dla wykresu pieniedzy (2026-08-28): parsuje `kampanie.fale_json`,
 * odrzuca wpisy bez daty w oknie albo bez napisu i porzadkuje po dacie. Uszkodzony
 * JSON = brak etapow (wykres wraca do wyliczanej prowadnicy „start reklam"), nigdy
 * wyjatek — ta sama zasada, co przy kazdej kolumnie *_json.
 */
export function faleKampanii(kampania) {
  if (!kampania?.fale_json) return [];
  let dane;
  try { dane = JSON.parse(kampania.fale_json); } catch { return []; }
  if (!Array.isArray(dane)) return [];
  return dane
    .filter((f) => f && typeof f.od === 'string' && typeof f.napis === 'string'
      && f.od >= kampania.od_dnia && f.od <= kampania.do_dnia && f.napis.trim() !== '')
    .sort((a, b) => a.od.localeCompare(b.od))
    .map((f) => ({ od: f.od, napis: f.napis }));
}

/**
 * Wszystkie kupony w historii bazy, per kod: uzycia (bez anulowanych), rabaty i obrot
 * z zamowien nieanulowanych, ostatnie uzycie. Sekcja „pozostale kupony" pod kampania —
 * to z niej widac free50 na PRO i kazdy przyszly kod bez wlasnego wiersza kampanii.
 */
export function agregatKuponow(zamowienia) {
  const mapa = new Map();
  for (const z of zamowienia) {
    const kupony = kuponyZWiersza(z.kupony_json);
    if (!kupony.length) continue;
    const dzien = dzienWarszawa(z.utworzone_at);
    // Kod liczony RAZ na zamowienie, nawet gdyby wystapil w dwoch liniach (Woo tego nie
    // robi, ale uszkodzony wiersz nie ma prawa podwoic uzycia).
    const kodyZamowienia = new Map();
    for (const k of kupony) {
      const klucz = String(k.kod).toLowerCase();
      if (!kodyZamowienia.has(klucz)) kodyZamowienia.set(klucz, k.kod);
    }
    for (const [klucz, kodOryginalny] of kodyZamowienia) {
      const wpis = mapa.get(klucz)
        ?? { kod: kodOryginalny.toLowerCase(), uzycia: 0, anulowane: 0, rabatGr: 0, obrotGr: 0, ostatnio: null };
      if (z.anulowane) {
        wpis.anulowane += 1;
      } else {
        wpis.uzycia += 1;
        wpis.obrotGr += kwotaGr(z);
        wpis.rabatGr += rabatGr(kupony, klucz);
      }
      if (!wpis.ostatnio || dzien > wpis.ostatnio) wpis.ostatnio = dzien;
      mapa.set(klucz, wpis);
    }
  }
  return [...mapa.values()]
    .sort((a, b) => b.uzycia - a.uzycia
      || String(b.ostatnio).localeCompare(String(a.ostatnio))
      || a.kod.localeCompare(b.kod))
    .map(({ rabatGr: r, obrotGr: o, ...reszta }) => ({ ...reszta, rabatyZl: zl(r), obrotZl: zl(o) }));
}

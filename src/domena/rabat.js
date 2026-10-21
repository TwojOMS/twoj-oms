import { bladOperatora } from './bledy.js';
import { grosze, zl } from './kwoty.js';
import { cenaWdtGrosze } from './wdt.js';

// RABAT STAŁEGO KLIENTA (21.08.2026, prośba właściciela: „rabat może być przypisany do
// konkretnego klienta w bazie, z możliwością późniejszej edycji rabatu w karcie zamówienia").
//
// ⚠️⚠️ RABAT WCHODZI W CENĘ POZYCJI, a cena katalogowa zostaje zapisana OBOK. To jest
// najważniejsza decyzja tego modułu i ma dwa powody, oba zmierzone:
//
//  1. Przy zamówieniu ręcznym `kwotaOczekiwanaGrosze` (domain/suma-pozycji.js) oddaje WPROST
//     `kwota_brutto`, a tę utrzymuje `przeliczKwoteRecznego` z sumy pozycji i wysyłki. Cena
//     obniżona w pozycji przechodzi więc JEDNYM ruchem przez sumę na karcie, kwotę pobrania,
//     saldo wpłat, barierę arytmetyczną faktury, `gross_price` wysyłane do inFaktu, mail
//     z potwierdzeniem i raport sprzedaży — bez ani jednej linijki kodu w żadnym z tych
//     miejsc. Warstwa licząca rabat „przy odczycie" musiałaby się z każdym z nich dogadać.
//  2. Osobna pozycja „Rabat −30%" jest zamknięta na poziomie reguły pieniężnej:
//     `parsujCeneBrutto` odrzuca ceny ujemne wprost („po cichu zmniejszałyby kwotę oczekiwaną
//     od klienta"), a ujemny wiersz przesuwałby próg darmowej dostawy liczony przez
//     `wartoscTowaruGrosze`. To nie jest kwestia gustu.
//
// ⚠️ RABAT JEST SPRAWĄ WEWNĘTRZNĄ (decyzja właściciela, 21.08.2026: „tylko niższe ceny").
// Ani mail z potwierdzeniem, ani faktura nie mówią o nim ani słowa — klient widzi kwoty.
// Cena katalogowa i procent są widoczne WYŁĄCZNIE na karcie w panelu. Dlatego ten moduł nie
// eksportuje żadnej funkcji składającej tekst dla klienta: gdyby ją miał, ktoś by jej użył.

/**
 * Górna granica rabatu.
 *
 * ⚠️ ISTNIEJE, BO GDZIE INDZIEJ JEJ ZABRAKŁO. Wpis w `OMS_KLIENCI_ZBIORCZY` przyjmuje dziś
 * rabat 300% bez słowa (znane od 01.08.2026,
 * `.superpowers/sdd/progress-2026-08-01-rozliczenie-zbiorcze.md`) — a rabat powyżej stu
 * procent to cena ujemna, czyli dopłacanie klientowi do zakupu. 90% jest granicą arbitralną,
 * ale po właściwej stronie: rabat głębszy niż dziewięć dziesiątych ceny katalogowej jest
 * literówką częściej niż uzgodnieniem, a gdy naprawdę jest uzgodnieniem — wpisuje się cenę.
 */
export const RABAT_MAX = 90;

/**
 * Procent rabatu z formularza — liczba CAŁKOWITA z zakresu 0..RABAT_MAX.
 *
 * ⚠️ CAŁKOWITA, I TO JEST WARUNEK, NIE UPROSZCZENIE. Cała ta warstwa liczy w groszach na
 * liczbach całkowitych, a bariera arytmetyczna faktury porównuje wynik co do grosza.
 * „7,5%" wymagałoby drugiej reguły zaokrąglania obok tej, którą bariera pilnuje — czyli
 * dokładnie tego rodzaju rozjazdu, który ta bariera ma łapać. Rabat ułamkowy wyraża się
 * wpisaniem ceny, jednym polem niżej.
 *
 * Puste pole to ZERO, nie odmowa: „bez rabatu" jest stanem normalnym i najczęstszym.
 */
export function parsujRabat(surowy) {
  const tekst = String(surowy ?? '').trim();
  if (tekst === '') return 0;
  // Przecinek przyjmujemy wyłącznie po to, żeby móc go ODRZUCIĆ komunikatem o ułamku,
  // a nie komunikatem „to nie jest liczba" — operator ma się dowiedzieć, o co naprawdę chodzi.
  const liczba = Number(tekst.replace(',', '.'));
  if (!Number.isFinite(liczba)) {
    throw bladOperatora(`Rabat „${surowy}" nie jest liczbą procent — wpisz np. 30 albo zostaw puste.`);
  }
  if (!Number.isInteger(liczba)) {
    throw bladOperatora(
      `Rabat musi być pełnym procentem, a jest „${surowy}". Rabat ułamkowy wpisz jako cenę `
      + 'pozycji — panel liczy w groszach na liczbach całkowitych.',
    );
  }
  if (liczba < 0) throw bladOperatora('Rabat nie może być ujemny — to byłaby podwyżka.');
  if (liczba > RABAT_MAX) {
    throw bladOperatora(
      `Rabat ${liczba}% jest większy niż dopuszczalne ${RABAT_MAX}% — jeśli to nie literówka, `
      + 'wpisz uzgodnioną cenę wprost w pozycji.',
    );
  }
  return liczba;
}

/**
 * Cena jednostkowa po rabacie, w groszach.
 *
 * ⚠️ ZAOKRĄGLAMY CENĘ ZA SZTUKĘ, A DOPIERO POTEM MNOŻYMY PRZEZ ILOŚĆ — dokładnie tak, jak
 * robi to dziś `pozycjaZProduktu` (`zl(cenaGr * ilosc)`). Odwrotna kolejność (rabat od sumy
 * linii) dawałaby cenę jednostkową, która pomnożona przez ilość nie daje sumy linii — czyli
 * ten sam rozjazd „33,33 × 3 = 99,99 przy totalu 100,00", o który panel odbijał się na
 * barierze arytmetycznej, zanim `gross_price` zaczęło jechać jako suma linii.
 */
export function cenaPoRabacieGrosze(cenaKatalogowaGr, rabatProcent) {
  if (!Number.isInteger(cenaKatalogowaGr) || cenaKatalogowaGr <= 0) {
    throw bladOperatora(`Cena katalogowa musi być kwotą w groszach większą od zera, a jest „${cenaKatalogowaGr}".`);
  }
  const rabat = parsujRabat(rabatProcent);
  if (rabat === 0) return cenaKatalogowaGr;
  const po = Math.round((cenaKatalogowaGr * (100 - rabat)) / 100);
  // ⚠️ PODŁOGA JEDEN GROSZ. Rabat 90% na pozycji za grosz dałby zero, a cena zero jest
  // w tym panelu ODMOWĄ (`parsujCeneBrutto`) — pozycja gratis wpisuje się jawnie, a nie
  // wypada z zaokrąglenia. Bez tego zamówienie z drobną pozycją nie dałoby się założyć,
  // a komunikat mówiłby o cenie, której operator nigdzie nie wpisał.
  return Math.max(1, po);
}

/** Ta sama cena jako napis „12.34" — postać, w jakiej kwoty leżą w bazie. */
export const cenaPoRabacie = (cenaKatalogowaGr, rabatProcent) => zl(cenaPoRabacieGrosze(cenaKatalogowaGr, rabatProcent));

// Cena, jaką panel SAM wpisuje do pozycji z ceny katalogowej: rabat, a przy zamówieniu WDT
// dodatkowo ÷1,23 na sztuce (cenaWdtGrosze — tam cała wykładnia). JEDNO miejsce, którym
// liczy i rozpoznanie „pozycji panelu", i nowa cena po zmianie rabatu — druga kopia tej
// pary rozjechałaby się przy pierwszej zmianie i przeliczenie pomijałoby własne pozycje.
// PRZ-105: przy WDT dzielimy przez stawkę domyślną z Ustawień (`stawkaDomyslna`), nie przez stałe 1,23.
const cenaPanelowaGrosze = (katalogowaGr, rabatProcent, wdt, stawkaDomyslna) => {
  const po = cenaPoRabacieGrosze(katalogowaGr, rabatProcent);
  return wdt ? cenaWdtGrosze(po, stawkaDomyslna) : po;
};

/**
 * Czy tę pozycję wolno przeliczyć nowym rabatem.
 *
 * ⚠️⚠️ PODMIENIAMY WYŁĄCZNIE TO, CO PANEL SAM WPISAŁ — ta sama reguła i to samo zdanie,
 * co w skrypcie kosztu dostawy (`_skrypt-koszt-dostawy.ejs`: „kwota wystukana przez człowieka
 * ma przeżyć zmianę metody"). Powód jest ten sam i jest o pieniądze: operator, który
 * wynegocjował z klientem inną kwotę na JEDNĄ rzecz, nie ma prawa stracić jej przez automat
 * uruchomiony przy zupełnie innej okazji.
 *
 * Rozpoznanie idzie po WARTOŚCI, nie po znaczniku „ruszane / nieruszane": pozycja jest
 * „nasza", gdy jej dzisiejsza cena równa się cenie katalogowej z rabatem POPRZEDNIO
 * zapisanym na zamówieniu. Znacznik trzeba by utrzymywać przy każdej edycji z osobna —
 * i to on rozjechałby się pierwszy.
 */
export function czyPozycjaPanelu(pozycja, rabatPoprzedni, { wdt = false, stawkaDomyslna } = {}) {
  // Bez ceny katalogowej nie ma od czego liczyć rabatu. To jest pozycja wpisana z ręki przy
  // telefonie, a wpisana z ręki kwota JEST już ceną uzgodnioną — rabat naliczony od niej
  // odjąłby te same procenty drugi raz.
  const katalogowa = String(pozycja?.cena_katalogowa ?? '').trim();
  if (!katalogowa) return false;
  // Pozycji ZE SKLEPU nie zapisuje się wprost (db/zamowienia.js: zapiszPozycjeReczna) —
  // jej poprawka mieszka obok, jako nadpisanie. Przeliczenie takiego wiersza odbiłoby się
  // od bazy w połowie pętli, więc odsiewamy go tutaj, a nie tam.
  if (pozycja?.zrodlo !== 'reczna') return false;
  // Przy zamówieniu WDT „cena panelu" zawiera też ÷1,23 (cenaPanelowaGrosze) — bez tego
  // każda pozycja WDT wyglądałaby na ręcznie wycenioną i zmiana rabatu pomijałaby cały
  // wsad z magazynu, z komunikatem mylącym dokładnie tam, gdzie miał wyjaśniać.
  const oczekiwana = cenaPanelowaGrosze(grosze(katalogowa, `cena katalogowa "${pozycja?.nazwa}"`), rabatPoprzedni, wdt, stawkaDomyslna);
  return grosze(pozycja?.cena_brutto, `pozycja "${pozycja?.nazwa}"`) === oczekiwana;
}

/**
 * Co zrobi zmiana rabatu — POLICZONE, ZANIM COKOLWIEK ZOSTANIE ZAPISANE.
 *
 * Zwraca `{ doZmiany, pominiete }`, gdzie `doZmiany` niesie gotowe wartości do zapisania
 * (`cena_brutto`, `brutto_linii`), a `pominiete` — pozycje z ceną wpisaną ręcznie, o których
 * ekran ma powiedzieć wprost. Cicho pominięta pozycja wyglądałaby jak rabat, który „nie
 * zadziałał", i operator szukałby usterki tam, gdzie jej nie ma.
 *
 * ⚠️ Pozycje BEZ ceny katalogowej nie trafiają do żadnego z dwóch worków i to jest celowe:
 * one nie są „pominięte", tylko spoza zakresu tej operacji. Wymienione na ekranie razem
 * z ręcznie poprawionymi zamieniłyby prawdziwą informację w szum przy każdym zamówieniu
 * mieszanym.
 */
export function przeliczenieRabatu(pozycje, { rabatPoprzedni, rabatNowy, wdt = false, stawkaDomyslna }) {
  const stary = parsujRabat(rabatPoprzedni);
  const nowy = parsujRabat(rabatNowy);
  const doZmiany = [];
  const pominiete = [];

  for (const p of pozycje ?? []) {
    const katalogowa = String(p?.cena_katalogowa ?? '').trim();
    if (!katalogowa || p?.zrodlo !== 'reczna') continue;
    if (!czyPozycjaPanelu(p, stary, { wdt, stawkaDomyslna })) {
      pominiete.push({ id: p.id, nazwa: p.nazwa });
      continue;
    }
    // TA SAMA transformacja, którą rozpoznaliśmy pozycję wyżej — rabat, a przy WDT ÷1,23.
    const cenaGr = cenaPanelowaGrosze(grosze(katalogowa, `cena katalogowa "${p.nazwa}"`), nowy, wdt, stawkaDomyslna);
    const ilosc = Number(p.ilosc) || 1;
    // Pozycja, której cena po zmianie wychodzi TAKA SAMA (rabat 0 → 0, albo zaokrąglenie
    // zbiegło się na groszu), nie jest zmianą i nie ma po co jechać do bazy ani do logu.
    if (cenaGr === grosze(p.cena_brutto, `pozycja "${p.nazwa}"`)) continue;
    doZmiany.push({
      id: p.id,
      nazwa: p.nazwa,
      ilosc,
      cena_brutto: zl(cenaGr),
      brutto_linii: zl(cenaGr * ilosc),
    });
  }
  return { doZmiany, pominiete };
}

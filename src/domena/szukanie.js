import { adresOdbiorcy } from './adres-odbiorcy.js';
import { daneFaktury } from './dane-faktury.js';

// Wyszukiwanie zamowien na liscie. Cala regula siedzi TUTAJ, w warstwie czystej — widok
// dostaje gotowa, przefiltrowana tablice, tak samo jak dostaje gotowy status i gotowe ikony.
//
// ⚠️ Szukamy po danych EFEKTYWNYCH (adresOdbiorcy / daneFaktury / pozycje po nadpisaniach),
// a nie po surowych kolumnach ze sklepu. Powod jest ten sam, dla ktorego karta, ekran nadania
// i klient DPD czytaja adres jedna funkcja: gdyby wyszukiwarka czytala surowy blok `dostawa`,
// operator poprawilby recznie nazwisko klienta, zobaczylby poprawke na karcie — i nie
// znalazlby po niej zamowienia. Szukalby wtedy po wartosci, ktorej panel nigdzie nie pokazuje.

// Skladanie polskich znakow do ASCII: „Pęki" ma sie znalezc po wpisaniu „peki" (i odwrotnie),
// bo nikt nie przelacza ukladu klawiatury w polowie szukania. NFD rozbija litere na znak bazowy
// i znak diakrytyczny, ktory potem kasujemy; „ł" nie ma postaci zlozonej, wiec idzie osobno.
// Wzorzec skladany z ZAPISU KODOWEGO, a nie z wklejonych znakow lacznikowych: znaki
// diakrytyczne sa same w sobie niewidoczne i w edytorze doklejaja sie do sasiedniego
// nawiasu — w tej postaci nikt by ich w kodzie nie przeczytal ani nie poprawil.
const ZNAKI_DIAKRYTYCZNE = new RegExp('[\u0300-\u036f]', 'g');

function bezOgonkow(tekst) {
  return tekst.normalize('NFD').replace(ZNAKI_DIAKRYTYCZNE, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

/** Postac porownywalna: bez ogonkow, malymi literami, bez nadmiarowych spacji. */
export function normalizuj(tekst) {
  return bezOgonkow(String(tekst ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Same cyfry pola — osobna sciezka dla NIP-u, telefonu i numeru listu przewozowego, ktore
// czlowiek przepisuje z myslnikami, spacjami albo prefiksem „+48", a w bazie leza inaczej
// zapisane. Bez tego NIP „676-24-32-556" nie znalazlby zamowienia z NIP-em „6762432556".
const sameCyfry = (tekst) => String(tekst ?? '').replace(/\D+/g, '');

/**
 * Pola, po ktorych wolno szukac — po jednym wpisie na pole, NIGDY sklejone w jeden napis.
 * Rozdzielenie jest istotne dla dopasowania cyfrowego: gdyby wszystkie cyfry zlac w jeden
 * ciag, fraza mogloby „przeskoczyc" granice pol i trafic w polowe kwoty plus polowe numeru.
 */
export function polaSzukania(z) {
  const adres = adresOdbiorcy(z);
  const faktura = daneFaktury(z);
  return [
    z?.numer,
    z?.sklep,
    adres.nazwa, adres.company, adres.email, adres.phone,
    adres.ulica, adres.kod, adres.miasto,
    faktura.firma, faktura.nip,
    ...(z?.pozycje ?? []).flatMap((p) => [p.nazwa, p.sku]),
    ...(z?.przesylki ?? []).map((p) => p.numer_listu),
    z?.faktura?.numer,
  ].filter((w) => w !== null && w !== undefined && String(w).trim() !== '');
}

/**
 * Czy zamowienie pasuje do frazy. Fraza dzieli sie na slowa i KAZDE musi trafic w ktores
 * pole (a nie: wystarczy jedno) — inaczej „kowalski peki" oddawaloby wszystkich Kowalskich
 * z Polski razem ze wszystkimi mieszkancami Kęt, czyli tym wiecej wynikow, im dokladniej
 * ktos opisze, czego szuka.
 */
export function pasujeDoSzukania(z, fraza) {
  if (!normalizuj(fraza)) return true;
  return pasujePola(polaPorownywalne(z), fraza);
}

/**
 * Pola zamówienia w postaci, w której porównuje je fraza — liczone RAZ (PRZ-051). Indeks
 * listy zapisuje je przy zamówieniu, a SQL pyta `pasujePola`, więc reguła dopasowania jest
 * jedna i nie powtarza się jako `LIKE` obok tego pliku.
 */
export function polaPorownywalne(z) {
  const pola = polaSzukania(z);
  return { tekst: pola.map(normalizuj), cyfry: pola.map(sameCyfry).filter(Boolean) };
}

/** Reguła `pasujeDoSzukania` na polach już sprowadzonych do postaci porównywalnej. */
export function pasujePola(pola, fraza) {
  return dopasowanieFrazy(fraza)(pola);
}

/**
 * Ta sama reguła, z frazą rozłożoną RAZ — indeks listy woła ją dla każdego zamówienia w bazie,
 * więc normalizacja frazy przy każdym wierszu była czystym kosztem (recenzja PRZ-051).
 */
export function dopasowanieFrazy(fraza) {
  const slowa = normalizuj(fraza).split(' ').filter(Boolean).map((slowo) => {
    // Sciezka cyfrowa WYLACZNIE dla frazy, ktora jest zapisem liczby (dopuszczamy myslniki,
    // spacje, plusa i nawiasy — czyli to, w czym ludzie zapisuja NIP-y i telefony). Dla
    // krotszych niz trzy cyfry odpuszczamy: „12" trafialoby w polowe kazdego kodu pocztowego.
    const szukaneCyfry = sameCyfry(slowo);
    return { slowo, cyfry: szukaneCyfry.length >= 3 && /^[\d\s+()-]+$/.test(slowo) ? szukaneCyfry : null };
  });
  return ({ tekst, cyfry }) => slowa.every(({ slowo, cyfry: szukaneCyfry }) => {
    if (tekst.some((p) => p.includes(slowo))) return true;
    if (!szukaneCyfry) return false;
    return cyfry.some((p) => p.includes(szukaneCyfry));
  });
}

/** Pusta fraza NIE filtruje niczego — lista zostaje taka, jaka byla. */
export function filtrujSzukaniem(zamowienia, fraza) {
  if (!normalizuj(fraza)) return zamowienia;
  return zamowienia.filter((z) => pasujeDoSzukania(z, fraza));
}

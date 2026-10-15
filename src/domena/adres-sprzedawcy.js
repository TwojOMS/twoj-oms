import { bladOperatora } from './bledy.js';

// Adres sprzedawcy — JEDNO miejsce, z ktorego czytaja WSZYSTKIE dokumenty wystawiane przez
// panel (dzis: proforma i specyfikacja zamowienia do paczki). Nazwa i ulica ida z
// `config.nadawca` — TEGO SAMEGO obiektu, ktorym jada tez paczki DPD/InPost (patrz config.js)
// — bo drugi, osobny zestaw zmiennych na TEN SAM adres juz raz istnial (lipiec 2026,
// nieprefiksowane `NADAWCA_*`) i przeslanial zwalidowany adres pustymi wartosciami
// domyslnymi: KAZDA paczka jechala wtedy z pusta ulica, calkowicie po cichu.
//
// ⚠️ WYCIAGNIETE Z services/proforma.js (Zadanie 8, specyfikacja zamowienia): dawniej
// prywatna `daneSprzedawcy()` tamtego modulu. Druga, niezalezna kopia tej samej reguly
// (nazwa i ulica sa wymagane, inaczej dokument nie ma kogo wskazac jako wystawce) w trasie
// specyfikacji rozjechalaby sie z proforma przy pierwszej zmianie — jedna odmawialaby,
// druga nie, mimo identycznej przyczyny.
export function adresSprzedawcy(config) {
  const n = config?.nadawca;
  if (!n?.nazwa || !n?.ulica) {
    throw bladOperatora(
      'Panel nie zna adresu sprzedawcy (DPD_NADAWCA_*), więc dokument wyszedłby bez nazwy '
      + 'i adresu wystawcy — takiego dokumentu nie da się wysłać klientowi.',
    );
  }
  return {
    nazwa: n.nazwa, ulica: n.ulica, kod: n.kod, miasto: n.miasto, kraj: n.kraj,
  };
}

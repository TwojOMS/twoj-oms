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
//
// PRZ-093.08: adres firmy może stać w pliku (DPD_NADAWCA_*) albo być wpisany w Ustawieniach → Firma.
// Moduły podają wtedy `config.adresFirmy()` — funkcję, a nie gotowy obiekt, bo konfiguracje są kopiowane
// (`{ ...config }`) przy składaniu modułów, a adres z ekranu ma działać od następnego dokumentu, bez restartu.
// Kolejność źródeł rozstrzyga src/oms/db/adres-firmy.js (plik → baza → brak); tu tylko odmowa przy braku.
// `config.nadawca` zostaje dla wołających bez tej funkcji (testy, stare składy).
export function adresSprzedawcy(config) {
  const n = typeof config?.adresFirmy === 'function' ? config.adresFirmy() : config?.nadawca;
  if (!n?.nazwa || !n?.ulica) {
    throw bladOperatora(
      'Panel nie zna adresu sprzedawcy, więc dokument wyszedłby bez nazwy i adresu wystawcy — '
      + 'takiego dokumentu nie da się wysłać klientowi. Wpisz adres firmy w Ustawienia → Firma '
      + '(/ustawienia/firma) albo w pliku konfiguracji (DPD_NADAWCA_*).',
    );
  }
  return {
    nazwa: n.nazwa, ulica: n.ulica, kod: n.kod, miasto: n.miasto, kraj: n.kraj,
  };
}

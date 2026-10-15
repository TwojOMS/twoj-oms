// Harmonogram resetu demo (PRZ-075, od PRZ-079 co N minut). Osobny moduł, żeby test nie uruchamiał start.mjs.
// PRZ-079 (decyzja właściciela 14.10): gość ma czynne przyciski na atrapach (faktury, KSeF, magazyn), a stan jest wspólny
// dla wszystkich gości — stąd reset co godzinę zamiast raz na dobę o 03:00. Każdy reset to ~30 s przerwy i wylogowanie.
// PRZ-082: liczba minut i jej sprawdzenie mieszkają w src/core/demo.ts — stamtąd bierze ją też napis na ekranie logowania.
import { MINUTY_RESETU_DOMYSLNIE, sprawdzMinutyResetu } from '../../src/core/demo.ts';

export { MINUTY_RESETU_DOMYSLNIE };

// Milisekundy od `teraz` do najbliższej wielokrotności `minuty` liczonej od północy na zegarze ściennym
// Europe/Warsaw (co 60 = o pełnych godzinach, co 1440 = o północy). Liczone na zegarze ściennym: w noc zmiany
// czasu jeden reset wypada godzinę wcześniej albo później — świadomie, raz w roku.
export function msDoResetu(teraz, minuty) {
  sprawdzMinutyResetu(minuty);
  const sciana = new Date(teraz.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  sciana.setMilliseconds(teraz.getMilliseconds());
  const polnoc = new Date(sciana);
  polnoc.setHours(0, 0, 0, 0);
  const krok = minuty * 60_000;
  const odPolnocy = sciana.getTime() - polnoc.getTime();
  return krok - (odPolnocy % krok);
}

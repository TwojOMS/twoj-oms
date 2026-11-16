import { zl } from './kwoty.js';
import { sumaZwrotowGrosze, zwrotRozliczony } from './zwrot.js';

// Co karta (i lista) ma pokazac przy zwrocie. `null` znaczy „nie rysuj nic" — i to jest
// cala tresc tego modulu: zwroty sa RZADKIE, wiec karta nie ma prawa rosnac o pusty naglowek
// ani o wyjasnienie przy 99% zamowien (zwroty nie zajmują za dużo miejsca na karcie
// zamówienia).
//
// ⚠️ WIDOK NIE LICZY NICZEGO SAM — ta sama zasada, co przy kazdej innej decyzji domenowej
// na karcie i na liscie (stan przesylki, sprawy do zalatwienia, ikony wiersza). Suma,
// liczba zwrotow i liczba nierozliczonych licza sie TU, jedna funkcja, zeby karta i lista
// (`daneKarty` w moduly/zamowienia/wspolne.js i lista w moduly/zamowienia/kontekst.js)
// nie mogly kiedys odpowiedziec inaczej.
export function podsumowanieZwrotow(z) {
  const lista = z?.zwroty ?? [];
  if (!lista.length) return null;
  return {
    sumaZl: zl(sumaZwrotowGrosze(lista)),
    ile: lista.length,
    nierozliczonych: lista.filter((w) => !zwrotRozliczony(z, w)).length,
  };
}

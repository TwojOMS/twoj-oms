import { komunikatDlaOperatora } from '../../../domena/bledy.js';

// PRZ-108.04: odmowa liczenia raportu (nieznany sklep zamówienia, brak granicy kanału) to zdanie dla człowieka,
// ale oddawane jako goły `text/plain` zostawiało go na białej stronie bez menu i bez drogi dalej — po instalacji
// demo właśnie tak wyglądała pierwsza wizyta w RAPORTACH. Teraz to ekran panelu (layout z menu), nadal z kodem 400.
// Treść bierzemy z `komunikatDlaOperatora`: błąd techniczny dostaje tam zdanie ogólne, a szczegóły zostają w logu.
export function ekranOdmowyRaportu(reply, e, { ekran = 'Raporty', czynnosc = 'policzyć raportu' } = {}) {
  return reply.code(400).view('raporty-odmowa.ejs', {
    title: ekran,
    ekran,
    naglowek: `Nie da się ${czynnosc}`,
    powod: komunikatDlaOperatora(e),
  });
}

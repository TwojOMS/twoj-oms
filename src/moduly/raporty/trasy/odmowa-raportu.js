import { komunikatDlaOperatora } from '../../../domena/bledy.js';

// PRZ-108.04: odmowa liczenia raportu (nieznany sklep zamówienia, brak granicy kanału) to zdanie dla człowieka,
// ale oddawane jako goły `text/plain` zostawiało go na białej stronie bez menu i bez drogi dalej — po instalacji
// demo właśnie tak wyglądała pierwsza wizyta w RAPORTACH. Teraz to ekran panelu (layout z menu), nadal z kodem 400.
// Treść bierzemy z `komunikatDlaOperatora`: błąd techniczny dostaje tam zdanie ogólne, a szczegóły zostają w logu.
export function ekranOdmowyRaportu(reply, e, {
  ekran = 'Raporty', czynnosc = 'policzyć raportu', kod = 400,
  powrot = ekran === 'Finanse' ? '/finanse' : '/raporty',
} = {}) {
  const powod = typeof e === 'string' ? e : komunikatDlaOperatora(e);
  return reply.code(kod).view('raporty-odmowa.ejs', {
    title: ekran,
    ekran,
    naglowek: `Nie da się ${czynnosc}`,
    powod,
    powrot,
    wskazowkaDat: powod.includes('parametr'),
    wskazowkaUstawien: typeof e !== 'string',
  });
}

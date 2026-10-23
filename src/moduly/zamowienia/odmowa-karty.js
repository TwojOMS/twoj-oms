// Powód jest już zdaniem dla operatora przygotowanym przez trasę, nigdy surowym błędem.
// Adres powstaje wyłącznie przez adresPowrotuNaKarte (bez Referer i z walidacją powrotu na listę).
// 404 = zamówienia nie ma, więc powrót na jego kartę skończyłby się tym samym 404 — wtedy lista zamówień.
export function ekranOdmowyKarty(reply, powod, powrot, kod = 400) {
  const bezKarty = kod === 404;
  return reply.code(kod).view('karta-odmowa.ejs', {
    title: 'Zamówienie',
    powod,
    powrot: bezKarty ? '/' : powrot,
    etykietaPowrotu: bezKarty ? 'Wróć do listy zamówień' : 'Wróć do zamówienia',
  });
}

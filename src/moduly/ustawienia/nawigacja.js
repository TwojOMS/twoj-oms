import { podmenuUstawien } from '../../domena/podmenu-ustawien.js';
import { EKRAN_ADRESU_FIRMY } from '../../domena/adres-firmy.js';
// Wydzielone z frozen routes/ustawienia.js. PRZ-068: „Role i uprawnienia” zaraz po „Użytkownicy i uprawnienia”,
// tylko dla administratora; domenowe podmenuUstawien zostaje bez zmian (przypięte testem portu).
export function nawigacjaUstawien(req, reply) {
  // PRZ-083: gość demo w podglądzie widzi też „Użytkownicy i uprawnienia” oraz „Role” (tylko do oglądania).
  const admin = req.konto?.admin === true || req.konto?.podgladDemo === true;
  const czysta = String(req.url).split('?')[0];
  const naRolach = czysta === '/ustawienia/role' || czysta.startsWith('/ustawienia/role/');
  // PRZ-093.08: „Firma” (adres firmy) przed „Zamówienia i wysyłka” — dla każdego z uprawnieniem „ustawienia”, jak reszta podmenu.
  const pozycje = podmenuUstawien(req.url, { admin }).flatMap((p) => (p.klucz === 'konta'
    ? [p, { klucz: 'role', etykieta: 'Role i uprawnienia', href: '/ustawienia/role', aktywna: naRolach }]
    : p.klucz === 'zamowienia-i-wysylka'
      ? [{ klucz: 'firma', etykieta: 'Firma', href: EKRAN_ADRESU_FIRMY, aktywna: czysta === EKRAN_ADRESU_FIRMY }, p]
      : [p]));
  return {
    ...(reply.locals?.nawigacja ?? {}),
    kontekst: { dzial: 'ustawienia', statusy: [], grupy: [{ klucz: 'ustawienia', etykieta: null, pozycje }] },
  };
}

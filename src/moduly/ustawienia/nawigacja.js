import { podmenuUstawien } from '../../domena/podmenu-ustawien.js';
// Wydzielone z frozen routes/ustawienia.js. PRZ-068: „Role i uprawnienia” zaraz po „Użytkownicy i uprawnienia”,
// tylko dla administratora; domenowe podmenuUstawien zostaje bez zmian (przypięte testem portu).
export function nawigacjaUstawien(req, reply) {
  // PRZ-083: gość demo w podglądzie widzi też „Użytkownicy i uprawnienia” oraz „Role” (tylko do oglądania).
  const admin = req.konto?.admin === true || req.konto?.podgladDemo === true;
  const czysta = String(req.url).split('?')[0];
  const naRolach = czysta === '/ustawienia/role' || czysta.startsWith('/ustawienia/role/');
  const pozycje = podmenuUstawien(req.url, { admin }).flatMap((p) => (p.klucz === 'konta'
    ? [p, { klucz: 'role', etykieta: 'Role i uprawnienia', href: '/ustawienia/role', aktywna: naRolach }]
    : [p]));
  return {
    ...(reply.locals?.nawigacja ?? {}),
    kontekst: { dzial: 'ustawienia', statusy: [], grupy: [{ klucz: 'ustawienia', etykieta: null, pozycje }] },
  };
}

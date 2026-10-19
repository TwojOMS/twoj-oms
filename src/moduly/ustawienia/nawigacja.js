import { grupyUstawien } from '../../domena/podmenu-ustawien.js';
// Wydzielone z frozen routes/ustawienia.js. PRZ-101.01: wszystkie pozycje (także „Dane firmy” i „Role i uprawnienia”)
// i ich grupy z domeny — układ renderuje je jako kolumnę z lewej strony treści.
export function nawigacjaUstawien(req, reply) {
  // PRZ-083: gość demo w podglądzie widzi też „Użytkownicy” oraz „Role” (tylko do oglądania).
  const admin = req.konto?.admin === true || req.konto?.podgladDemo === true;
  return {
    ...(reply.locals?.nawigacja ?? {}),
    kontekst: { dzial: 'ustawienia', statusy: [], grupy: grupyUstawien(req.url, { admin }) },
  };
}

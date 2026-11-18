import { modelNawigacjiUstawien, POZYCJA_DANE_DEMO } from '../../domena/podmenu-ustawien.js';
// Wszystkie pozycje (także „Dane firmy” i „Role i uprawnienia”)
// i ich grupy z domeny — układ renderuje je jako kolumnę z lewej strony treści.
export function nawigacjaUstawien(req, reply) {
  // Gość demo w podglądzie widzi też „Użytkownicy” oraz „Role” (tylko do oglądania).
  const admin = req.konto?.admin === true;
  const podgladDemo = req.konto?.podgladDemo === true;
  const daneDemo = Boolean((reply.server ?? req.server)?.findRoute?.({ method: 'GET', url: POZYCJA_DANE_DEMO.href }));
  const model = modelNawigacjiUstawien(req.url, { admin, podgladDemo, daneDemo });
  return {
    ...(reply.locals?.nawigacja ?? {}),
    kontekst: {
      dzial: 'ustawienia',
      statusy: reply.locals?.nawigacja?.kontekstUstawien?.statusy ?? [],
      grupy: [{ klucz: 'dzialy', etykieta: 'Ustawienia', pozycje: model.dzialy }],
      ...model,
    },
  };
}

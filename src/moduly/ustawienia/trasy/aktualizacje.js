// PRZ-099: Ustawienia → Aktualizacje — tylko informacja: bieżąca wersja instalacji i najnowsze wydanie na GitHubie.
// Instalacji z panelu jeszcze nie ma (plan docs/plany/PRZ-095-099-aktualizacje.md) — ekran mówi to wprost.
//
// Tylko administrator (flaga admin, nie ptaszek Ustawień), jak Role. Gość demo ogląda (GET); jego POST „Sprawdź teraz”
// zatrzymuje wcześniej hak core/bezpieczenstwo/podglad-demo.js, więc demo nigdy nie pyta GitHuba.
import { REPO_AKTUALIZACJI, porownajWersje } from '../aktualizacje.ts';
import { fmtDataCzasKrotko, dzienWarszawa } from '../../../domena/format-daty.js';
import { nawigacjaUstawien } from '../nawigacja.js';

const INSTRUKCJA = `https://github.com/${REPO_AKTUALIZACJI}/blob/main/docs/aktualizacja-klienta-v0.md`;

/** Wynik „Sprawdź teraz” zestawiony z bieżącą wersją — gotowy do wypisania. */
function porownanie(wydanie, wynik) {
  if (!wynik) return null;
  if (wynik.stan !== 'jest') return { stan: wynik.stan };
  const dzien = dzienWarszawa(wynik.opublikowano);
  const stan = !wydanie?.wersja ? 'bez-porownania' : porownajWersje(wynik.wersja, wydanie.wersja) > 0 ? 'nowsza' : 'aktualna';
  return { stan, wersja: wynik.wersja, dzien, opis: wynik.opis, adres: wynik.adres };
}

export function registerUstawieniaAktualizacjiRoutes(app, { aktualizacje }) {
  // `wlasnyUklad: true` — brak-dostepu.ejs to samodzielny dokument (patrz tylkoAdmin w trasy/konta.js).
  const tylkoAdmin = (req, reply) => (req.konto?.admin || (req.konto?.podgladDemo && req.method === 'GET') ? null
    : reply.code(403).view('brak-dostepu.ejs', { title: 'Brak dostępu', wlasnyUklad: true }));
  const widok = (req, reply, wynik = null) => {
    const wydanie = aktualizacje.wydanie();
    return reply.view('ustawienia-aktualizacje.ejs', {
      nawigacja: nawigacjaUstawien(req, reply),
      title: 'Aktualizacje',
      wydanie: wydanie && { ...wydanie, krotki: wydanie.commit.slice(0, 12), paczka: fmtDataCzasKrotko(wydanie.utworzono) },
      wynik: porownanie(wydanie, wynik),
      instrukcja: INSTRUKCJA,
    });
  };

  app.get('/ustawienia/aktualizacje', async (req, reply) => tylkoAdmin(req, reply) ?? widok(req, reply));

  // POST, nie GET z parametrem: zapytanie do GitHuba tylko z jawnego kliknięcia, a gościa demo zatrzymuje hak podglądu.
  app.post('/ustawienia/aktualizacje/sprawdz', async (req, reply) => {
    const odmowa = tylkoAdmin(req, reply);
    if (odmowa) return odmowa;
    return widok(req, reply, await aktualizacje.sprawdz());
  });
}

// Sonda izolacji demo. Bezpiecznik w start.mjs: przed startem panelu sprawdza adresy z DEMO_SONDA_CELE
// (oddzielone przecinkami) i odmawia startu, gdy którykolwiek odpowie. OK-ODCIETY = błąd połączenia albo
// przekroczony czas; PRZECIEK = jakakolwiek odpowiedź HTTP.
//
// Izolację sieci demo na własnym serwerze zapewnia instalujący (osobna sieć kontenera bez wyjścia do LAN
// i internetu, reguły zapory). Ta sonda tylko ją sprawdza: wpisz w DEMO_SONDA_CELE adresy, które z demo mają być
// nieosiągalne — panel produkcyjny, router, panel serwera. Bez DEMO_SONDA_CELE (demo na własnym komputerze)
// sprawdzenie jest pomijane z ostrzeżeniem.
//
// Ręcznie: node deploy/demo/sonda.mjs http://10.0.0.10:3001/health http://10.0.0.1/
import { pathToFileURL } from 'node:url';

export async function zbadaj(cele, limitMs = 4000) {
  return Promise.all(cele.map(async (cel) => {
    const t0 = Date.now();
    try {
      const r = await fetch(cel, { signal: AbortSignal.timeout(limitMs), redirect: 'manual' });
      return { cel, przeciek: true, opis: `HTTP ${r.status} po ${Date.now() - t0} ms` };
    } catch (e) {
      return { cel, przeciek: false, opis: `${e.cause?.code ?? e.name} po ${Date.now() - t0} ms` };
    }
  }));
}

// Bezpiecznik start.mjs: jakakolwiek odpowiedź = wyjątek (odmowa startu panelu). Zwraca liczbę sprawdzonych celów.
export async function wymagajIzolacji(cele, badaj = zbadaj) {
  if (!cele.length) {
    console.warn('demo: DEMO_SONDA_CELE puste — izolacji sieci nie sprawdzam (demo publiczne: wpisz adresy, które mają być nieosiągalne)');
    return 0;
  }
  const przecieki = (await badaj(cele, 2500)).filter((w) => w.przeciek);
  if (przecieki.length) {
    throw new Error(`IZOLACJA NIE DZIAŁA — odpowiadają: ${przecieki.map((w) => `${w.cel} (${w.opis})`).join(', ')}`);
  }
  return cele.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cele = process.argv.slice(2);
  if (!cele.length) {
    console.log('Użycie: node deploy/demo/sonda.mjs <adres> [<adres> ...]');
    process.exit(2);
  }
  const wyniki = await zbadaj(cele);
  for (const w of wyniki) console.log(`${w.przeciek ? 'PRZECIEK  ' : 'OK-ODCIETY'} ${w.cel}  ${w.opis}`);
  const n = wyniki.filter((w) => w.przeciek).length;
  console.log(`sonda: ${wyniki.length} celów, przecieków: ${n}`);
  process.exitCode = n ? 1 : 0;
}

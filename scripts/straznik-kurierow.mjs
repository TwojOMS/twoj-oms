import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const listaDozwolonych = {
  'src/core/kontrakty.ts': { liczba: 1, powod: 'typ formularza nadania' },
  'src/domena/dowod-odbioru.js': { liczba: 2, powod: 'źródło dowodu odbioru' },
  'src/domena/gotowosc-nadania.js': { liczba: 1, powod: 'warunek punktu odbioru, do przepięcia na rejestr' },
  'src/domena/kurier-nadania.js': { liczba: 1, powod: 'jawna reguła NADAJEMY_SAMI' },
  'src/domena/mapowanie-wysylki.js': { liczba: 1, powod: 'komentarz historyczny' },
  'src/domena/masowe.js': { liczba: 4, powod: 'rodzaj formularza i komentarze, do przepięcia na rejestr' },
  'src/domena/podjazdy.js': { liczba: 1, powod: 'reguły podjazdu WzA' },
  'src/domena/przejecie-przesylki.js': { liczba: 1, powod: 'źródło przejęcia przesyłki' },
  'src/domena/przewoznicy.ts': { liczba: 9, powod: 'rejestr przewoźników' },
  'src/domena/sledzenie-przesylki.js': { liczba: 1, powod: 'rozpoznanie WzA, do przepięcia na rejestr' },
  'src/moduly/ustawienia/modul.ts': { liczba: 2, powod: 'klucze połączeń, do przepięcia na rejestr' },
  'src/moduly/wiadomosci/szablony.js': { liczba: 2, powod: 'przykład podglądu szablonu' },
  'src/moduly/wysylka/db/podjazdy.js': { liczba: 1, powod: 'zapis podjazdów WzA' },
  'src/moduly/wysylka/modul.ts': { liczba: 2, powod: 'konfiguracja integracji, do przepięcia na rejestr' },
  'src/moduly/wysylka/services/czuwacz-podjazdow.js': { liczba: 1, powod: 'czuwanie nad podjazdami WzA' },
  'src/moduly/wysylka/services/podjazdy.js': { liczba: 1, powod: 'obsługa podjazdów WzA' },
  'src/moduly/wysylka/services/przesylki-allegro.js': { liczba: 3, powod: 'komentarz o przesyłkach Allegro' },
  'src/moduly/wysylka/services/status-kuriera.js': { liczba: 3, powod: 'status i podwykonawca WzA' },
  'src/moduly/wysylka/sprzatanie.js': { liczba: 2, powod: 'sprzątanie śledzenia WzA' },
  'src/moduly/wysylka/trasy/przesylki.js': { liczba: 2, powod: 'obsługa przesyłek WzA' },
  'src/moduly/wysylka/trasy/ustawienia-dpd.js': { liczba: 5, powod: 'konfiguracja DPD' },
  'src/moduly/wysylka/trasy/ustawienia-inpost.js': { liczba: 5, powod: 'konfiguracja InPost' },
  'src/moduly/wysylka/widoki/przesylki-lista.ejs': { liczba: 1, powod: 'komunikat o podjeździe WzA' },
  'src/moduly/zamowienia/widoki/nowe-zamowienie.ejs': { liczba: 2, powod: 'metoda domyślna, do przepięcia na rejestr' },
  'src/moduly/zamowienia/widoki/zamowienie.ejs': { liczba: 2, powod: 'wskazówka pobrania etykiety' },
  'src/moduly/zamowienia/wspolne.js': { liczba: 1, powod: 'komentarz historyczny' },
  'src/oms/db/uzupelnienia-zamowien.js': { liczba: 2, powod: 'historyczne uzupełnienie zamówień' },
  'src/oms/kurierzy/index.js': { liczba: 4, powod: 'komentarze historyczne o metodzie domyślnej' },
};

// PRZ-134 i równoległe przeniesienie konfiguratora w PRZ-135.07b.
const dozwoloneKatalogi = { 'src/moduly/kanaly/': 'kod modułu kanałów' };
const rejestr = 'src/domena/moduly-kurierow.ts';
// Jak strażnik kanałów, skanujemy również komentarze i tekst szablonów.
const wzorzec = /(['"])(?:dpd|inpost|inpost_paczkomat|allegro_wza)\1/g;

export function sprawdz(korzen, lista = listaDozwolonych) {
  const trafienia = {};
  function odwiedz(katalog) {
    for (const wpis of fs.readdirSync(path.join(korzen, katalog), { withFileTypes: true })) {
      const plik = path.posix.join(katalog, wpis.name);
      if (wpis.isDirectory()) odwiedz(plik);
      else if (wpis.isFile() && /\.(?:js|ts|mjs|ejs)$/.test(wpis.name)) {
        const tekst = fs.readFileSync(path.join(korzen, plik), 'utf8');
        const linie = [...tekst.matchAll(wzorzec)].map(m => tekst.slice(0, m.index).split('\n').length);
        if (linie.length && plik !== rejestr && !Object.keys(dozwoloneKatalogi).some(k => plik.startsWith(k))) trafienia[plik] = linie;
      }
    }
  }
  odwiedz('src');
  const bledy = [], podpowiedzi = [];
  for (const plik of new Set([...Object.keys(trafienia), ...Object.keys(lista)])) {
    const linie = trafienia[plik] ?? [];
    const limit = lista[plik]?.liczba ?? 0;
    if (linie.length > limit) bledy.push(`${plik}: ${linie.length}/${limit} (linie: ${linie.join(', ')})`);
    if (linie.length < limit) podpowiedzi.push(`${plik}: ${linie.length}/${limit} — zmniejsz liczbę na liście`);
  }
  return { kod: bledy.length ? 1 : 0, trafienia, bledy, podpowiedzi };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const korzen = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wynik = sprawdz(korzen);
  for (const komunikat of wynik.podpowiedzi) console.log(komunikat);
  if (wynik.kod) console.error('Nadmiar literałów nazw kurierów:\n' + wynik.bledy.join('\n'));
  else console.log('Strażnik kurierów: OK');
  process.exitCode = wynik.kod;
}

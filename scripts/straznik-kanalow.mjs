import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const listaDozwolonych = {
  'src/moduly/kanaly/services/kanal-erli.ts': { liczba: 1, powod: 'lokalny odczyt drogi nadania ERLI na karcie (PRZ-157.07a), używany również przy wysyłaniu numeru (06)' },
  'src/integracje/kanal-modul.ts': { liczba: 2, powod: 'wybór adapterów statusu i numeru ERLI po module (PRZ-157.05–06)' },
  'src/domena/sprawy-karty.js': { liczba: 2, powod: 'ręczne anulowanie oraz konflikt numeru ERLI wymagają sprawy (PRZ-157.05–06)' },
  'src/domena/allegro-faktura.js': { liczba: 1, powod: 'kod modułu Allegro (D4)' },
  'src/domena/allegro-status.js': { liczba: 2, powod: 'kod modułu Allegro (D4)' },
  'src/domena/allegro-wysylka.js': { liczba: 1, powod: 'kod modułu Allegro (D4)' },
  'src/domena/kanaly-raportowe.js': { liczba: 1, powod: 'raport Allegro' },
  'src/domena/magazyn-do-zamowienia.js': { liczba: 2, powod: 'przypisanie magazynu do kanału' },
  'src/domena/moduly-kanalow.ts': { liczba: 2, powod: 'definicja predykatu i wybór modułu' },
  'src/domena/podjazdy.js': { liczba: 1, powod: 'kod modułu Allegro (D4)' },
  'src/domena/statystyki-platnosci.js': { liczba: 1, powod: 'raport płatności Allegro' },
  'src/domena/sync-sklep.js': { liczba: 1, powod: 'strażnik synchronizacji sklepu (D4)' },
  'src/domena/termin-wysylki.js': { liczba: 1, powod: 'termin wysyłki Allegro' },
  'src/moduly/api-panelu/trasy/api-sprzedaz.js': { liczba: 1, powod: 'etykieta API' },
  'src/moduly/kanaly/konfiguracja.ts': { liczba: 5, powod: 'budowa z env, ERLI ma własne klucze i dwa adresy (PRZ-157.11a)' },
  'src/moduly/kanaly/modul.ts': { liczba: 2, powod: 'konfiguracja sklepów Woo i ERLI z env (PRZ-157.11a)' },
  'src/moduly/kanaly/repozytorium-kanalow.ts': { liczba: 5, powod: 'rejestr kont i konfiguracja z env, także ERLI (PRZ-157.11a)' },
  'src/moduly/kanaly/scripts/import-sklep.mjs': { liczba: 1, powod: 'import sklepu Woo' },
  'src/moduly/kanaly/services/kompozycja-kanalow.ts': { liczba: 1, powod: 'łączenie konfiguracji kanałów bez powielania definicji env (PRZ-157.11a)' },
  'src/moduly/kanaly/services/rejestr-kanalow.ts': { liczba: 3, powod: 'transport i rejestr kanałów, blokada zapisów ERLI (PRZ-157.11a)' },
  'src/moduly/raporty/granice-start.js': { liczba: 1, powod: 'granice raportu Woo' },
  'src/moduly/raporty/modul.ts': { liczba: 1, powod: 'etykieta raportu Allegro' },
  'src/moduly/ustawienia/services/polaczenia-integracji.ts': { liczba: 6, powod: 'opisy połączeń integracji (Allegro/Woo: konto, szkic, WzA — PRZ-136.06)' },
  'src/moduly/wysylka/services/przesylki-allegro.js': { liczba: 1, powod: 'kod modułu Allegro (D4)' },
  'src/moduly/zamowienia/kontekst.js': { liczba: 1, powod: 'sekcje karty Allegro' },
  'src/moduly/zdrowie/bezpiecznik-kanalow.ts': { liczba: 1, powod: 'kontrola konfliktu kluczy kanałów' },
};

// Skan tekstowy obejmuje również szablony EJS i definicję predykatu.
const wzorzec = /\bczyKanalAllegro\s*(?:\(|=\s*\()|\btyp\s*(?:===|!==)\s*(['"])(?:allegro|woo|erli)\1|(['"])(?:allegro|woo|erli)\2\s*(?:===|!==)\s*(?:[\w$]+\s*(?:\?\.|\.)\s*)*typ\b/g;

export function sprawdz(korzen, lista = listaDozwolonych) {
  const trafienia = {};
  function odwiedz(katalog) {
    for (const wpis of fs.readdirSync(path.join(korzen, katalog), { withFileTypes: true })) {
      const plik = path.posix.join(katalog, wpis.name);
      if (wpis.isDirectory()) odwiedz(plik);
      else if (wpis.isFile() && /\.(?:js|ts|mjs|ejs)$/.test(wpis.name)) {
        const tekst = fs.readFileSync(path.join(korzen, plik), 'utf8');
        const linie = [...tekst.matchAll(wzorzec)].map(m => tekst.slice(0, m.index).split('\n').length);
        if (linie.length) trafienia[plik] = linie;
      }
    }
  }
  odwiedz('src');
  const bledy = [], podpowiedzi = [];
  for (const plik of new Set([...Object.keys(trafienia), ...Object.keys(lista)])) {
    const linie = trafienia[plik] ?? [];
    const limit = lista[plik]?.liczba ?? 0;
    if (linie.length > limit) bledy.push(...linie.map(linia => `${plik}:${linia}`));
    if (linie.length < limit) podpowiedzi.push(`${plik}: ${linie.length}/${limit} — zmniejsz liczbę na liście`);
  }
  return { kod: bledy.length ? 1 : 0, trafienia, bledy, podpowiedzi };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const korzen = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wynik = sprawdz(korzen);
  for (const komunikat of wynik.podpowiedzi) console.log(komunikat);
  if (wynik.kod) console.error('Nadmiar rozgałęzień po nazwie kanału:\n' + wynik.bledy.join('\n'));
  else console.log('Strażnik kanałów: OK');
  process.exitCode = wynik.kod;
}

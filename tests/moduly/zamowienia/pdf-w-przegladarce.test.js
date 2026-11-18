// Chrome ostrzega „Zablokowano pobieranie niebezpiecznego pliku” przy
// KAZDYM pobraniu po `http://` z adresu innego niz localhost — a OMS stoi w LAN bez HTTPS
// (typowa instalacja lokalna). Ostrzezenie dotyczy tylko POBRANIA:
// PDF otwarty w przegladarce (`Content-Disposition: inline`) go nie wywoluje.
//
// Dlatego kazda trasa, ktora oddaje PDF CZLOWIEKOWI, mowi `inline`, a kazdy odnosnik do PDF-a
// otwiera NOWA karte (inaczej operator wypada z OMS-u na podglad pliku).
// Wyjatek: kolejka druku faktur (`/kolejka-druku-faktur/:id/pdf`) — plik dla czuwacza drukarki,
// nie dla przegladarki; tam `attachment` zostaje.
//
// Strażnik czyta zrodla, a nie pojedyncze trasy, bo nowa trasa PDF dopisana za miesiac
// powinna zaczerwienic ten test bez pamietania o nim.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const KORZEN = join(import.meta.dirname, '..', '..', '..');

function pliki(katalog, rozszerzenia) {
  const wynik = [];
  for (const nazwa of readdirSync(katalog)) {
    const sciezka = join(katalog, nazwa);
    if (statSync(sciezka).isDirectory()) wynik.push(...pliki(sciezka, rozszerzenia));
    else if (rozszerzenia.some((r) => nazwa.endsWith(r))) wynik.push(sciezka);
  }
  return wynik;
}

const rel = (p) => relative(KORZEN, p).replaceAll('\\', '/');

describe('PDF otwiera sie w przegladarce, nie pobiera', () => {
  it('trasy PDF dla czlowieka mowia `inline`, nie `attachment`', () => {
    const naruszenia = [];
    let pdfow = 0;
    for (const plik of pliki(join(KORZEN, 'src'), ['.js', '.ts'])) {
      const tresc = readFileSync(plik, 'utf8');
      const wzor = /type\(\s*['"]application\/pdf['"]\s*\)([\s\S]{0,200}?)Content-Disposition['"]\s*,\s*[`'"](\w+)/gi;
      for (const m of tresc.matchAll(wzor)) {
        pdfow += 1;
        if (m[2].toLowerCase() === 'inline') continue;
        const przed = tresc.slice(0, m.index);
        const trasa = przed.slice(przed.lastIndexOf('app.'));
        if (trasa.includes('/kolejka-druku-faktur')) continue;
        const linia = przed.split('\n').length;
        naruszenia.push(`${rel(plik)}:${linia}`);
      }
    }
    // Bez tej liczby strażnik moglby byc zielony dlatego, ze wzor przestal cokolwiek lapac.
    expect(pdfow).toBeGreaterThanOrEqual(14);
    expect(naruszenia).toEqual([]);
  });

  it('odnosniki i przyciski do PDF-ow otwieraja nowa karte', () => {
    const naruszenia = [];
    let odnosnikow = 0;
    for (const plik of pliki(join(KORZEN, 'src'), ['.ejs'])) {
      const tresc = readFileSync(plik, 'utf8');
      // Caly znacznik `<a …>` albo `<button …>` (bywa w kilku liniach). `<%= … %>` w srodku
      // moze zawierac `>`, wiec najpierw maskujemy wstawki EJS.
      const zamaskowana = tresc.replace(/<%[\s\S]*?%>/g, (s) => s.replace(/[<>]/g, '_'));
      for (const m of zamaskowana.matchAll(/<(a|button)\b[^>]*>/g)) {
        const znacznik = m[0];
        const cel = /(?:href|formaction)="([^"]*)"/.exec(znacznik)?.[1] ?? '';
        const sciezka = cel.split('?')[0];
        if (
          !/(\.pdf|\/pdf|\/zestawienie-przychodow|\/zestawienie-zaznaczonych|\/koszty\/zestawienie|\/faktury\/paczka)$/.test(
            sciezka,
          )
        )
          continue;
        if (sciezka.includes('/kolejka-druku-faktur')) continue;
        odnosnikow += 1;
        const atrybut = m[1] === 'a' ? 'target' : 'formtarget';
        if (!new RegExp(`\\b${atrybut}="_blank"`).test(znacznik)) {
          naruszenia.push(`${rel(plik)}:${zamaskowana.slice(0, m.index).split('\n').length} ${cel}`);
        }
      }
    }
    expect(odnosnikow).toBeGreaterThanOrEqual(10);
    expect(naruszenia).toEqual([]);
  });
});

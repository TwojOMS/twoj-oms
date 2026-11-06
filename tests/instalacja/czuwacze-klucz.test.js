import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const czytaj = (plik) => readFileSync(new URL(`../../deploy/drukarka/${plik}`, import.meta.url), 'utf8');

describe.each(['etykiet', 'faktur'])('klucz czuwacza %s', (rodzaj) => {
  const skrypt = czytaj(`czuwacz-${rodzaj}.ps1`);

  it('wybiera Bearer dla klucza, a Basic dla hasła i zachowuje Origin', () => {
    expect(skrypt).toMatch(/if\s*\(\$k\.klucz\)\s*\{[\s\S]*?Authorization\s*=\s*'Bearer '\s*\+\s*\$k\.klucz[\s\S]*?\}\s*else\s*\{[\s\S]*?Authorization\s*=\s*'Basic '/);
    expect(skrypt).toMatch(/Origin\s*=\s*\$k\.url/);
    expect(skrypt).toMatch(/if\s*\(-not\s+\$k\.klucz\)[\s\S]*?'user'[\s\S]*?'pass'/);
    expect(skrypt).toContain('klucz API');
    expect(skrypt).toContain('haslo serwisowe');
  });

  it('rozpoznaje odmowę i pomija powtórzenia bez ujawniania klucza', () => {
    expect(skrypt).toMatch(/\$_.Exception.Response[\s\S]*?\$_.Exception.Response.StatusCode/);
    expect(skrypt).toMatch(/401[\s\S]*?403/);
    expect(skrypt).toContain('OMS odrzucil klucz czuwacza (401/403) - sprawdz pole klucz w konfiguracji.');
    expect(skrypt).toContain('OMS odrzucil haslo czuwacza (401/403) - sprawdz user/pass w konfiguracji.');
    expect(skrypt).toMatch(/\$tresc -ne \$ostatniBlad/);
    for (const linia of skrypt.split(/\r?\n/).filter((w) => /\b(Zapisz|Add-Content)\b/.test(w))) {
      expect(linia).not.toContain('$k.klucz');
    }
  });

  it('przykład konfiguracji ma pole klucz', () => {
    const plik = rodzaj === 'etykiet' ? 'config.przyklad.json' : 'config-faktury.przyklad.json';
    expect(JSON.parse(czytaj(plik))).toHaveProperty('klucz', '');
    expect(JSON.parse(czytaj(plik))).toHaveProperty('odstepPoOdmowieSekund', 300);
    expect(JSON.parse(czytaj(plik))._opis).toContain('odstepPoOdmowieSekund');
    expect(czytaj(plik)).toMatch(/^[\x00-\x7f]*$/);
  });

  it('po odmowie czeka dłużej, a w innych przypadkach zachowuje zwykły odstęp', () => {
    expect(skrypt).toMatch(/\$odstepPoOdmowie\s*=\s*300\b/);
    expect(skrypt).toMatch(/if\s*\(\$k\.odstepPoOdmowieSekund\)\s*\{\s*\$odstepPoOdmowie\s*=\s*\[int\]\$k\.odstepPoOdmowieSekund\s*\}/);
    expect(skrypt).toMatch(/while\s*\(\$true\)\s*\{\s*\$odstepBiezacy\s*=\s*\$odstep/);
    expect(skrypt).toMatch(/if\s*\(\$_.Exception.Response\s*-and\s*\(\$_.Exception.Response.StatusCode\s*-eq\s*401\s*-or\s*\$_.Exception.Response.StatusCode\s*-eq\s*403\)\)\s*\{\s*\$odstepBiezacy\s*=\s*\$odstepPoOdmowie/);
    expect(skrypt).toMatch(/ponowna proba za \{0\} s[\s\S]*?-f \$odstepPoOdmowie/);
    expect(skrypt).toMatch(/Start-Sleep\s+-Seconds\s+\$odstepBiezacy/);
    expect(skrypt).toMatch(/^[\x00-\x7f]*$/);
  });
});

it('nazywa wydruk faktury lub proformy dokumentem', () => {
  const skrypt = czytaj('czuwacz-faktur.ps1');
  expect(skrypt).not.toContain('Wydrukowano fakture');
  expect(skrypt).toContain('Wydrukowano dokument {0} (zamowienie {1})');
  expect(skrypt).toContain('Dokument {0}: {1}');
});

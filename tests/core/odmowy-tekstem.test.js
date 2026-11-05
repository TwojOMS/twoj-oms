import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

function pliki(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? pliki(join(dir, d.name)) : [join(dir, d.name)]);
}

function adresy(tekst) {
  const stale = new Map([...tekst.matchAll(/\bconst\s+(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g)].map(m => [m[1], m[2]]));
  const wynik = [];
  for (const m of tekst.matchAll(/(?:action|formaction|href|hx-get|hx-post)\s*=\s*["']([^"']+)["']/g)) {
    let adres = m[1].replace(/<%[=-]\s*(\w+)\s*%>/g, (_, nazwa) => stale.get(nazwa) ?? ':param');
    adres = adres.replace(/<%[\s\S]*?%>/g, ':param').replace(/\$\{[^}]+\}/g, ':param');
    if (adres.startsWith('/')) wynik.push(adres.split('?')[0]);
  }
  return wynik;
}

function pasuje(trasa, adres) {
  const segmenty = s => s.split('/').filter(Boolean);
  const a = segmenty(trasa), b = segmenty(adres);
  return a.length === b.length && a.every((s, i) => s.startsWith(':') || b[i].startsWith(':') || s === b[i]);
}

function adresyFetch(tekst) {
  const stale = new Map([...tekst.matchAll(/\bconst\s+(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g)].map(m => [m[1], m[2]]));
  return [...tekst.matchAll(/\bfetch\s*\(\s*(?:['"`]([^'"`]+)['"`]|(\w+)\b)/g)]
    .map(m => (m[1] ?? stale.get(m[2]) ?? '').replace(/\$\{[^}]+\}/g, ':param').split('?')[0])
    .filter(a => a.startsWith('/'));
}

function skanuj(plik, tekst) {
  const zrodlo = ts.createSourceFile(plik, tekst, ts.ScriptTarget.Latest, true, plik.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const wyniki = [];
  const stale = new Map();
  function adres(node) {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return stale.get(node.text);
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(s => (adres(s.expression) ?? ':param') + s.literal.text).join('');
    return undefined;
  }
  function zbierz(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const wartosc = adres(node.initializer);
      if (wartosc?.startsWith('/')) stale.set(node.name.text, wartosc);
    }
    ts.forEachChild(node, zbierz);
  }
  zbierz(zrodlo);
  function odwiedz(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'send' && node.arguments.length) {
      const tresc = node.arguments[0];
      if (!ts.isObjectLiteralExpression(tresc) && !ts.isArrayLiteralExpression(tresc)) {
        let lancuch = node.expression.expression, status;
        while (ts.isCallExpression(lancuch) && ts.isPropertyAccessExpression(lancuch.expression)) {
          const nazwa = lancuch.expression.name.text;
          if ((nazwa === 'code' || nazwa === 'status') && lancuch.arguments.length) {
            const arg = lancuch.arguments[0];
            if (!ts.isNumericLiteral(arg) || Number(arg.text) >= 400 && Number(arg.text) < 600) status = arg.getText(zrodlo);
          }
          lancuch = lancuch.expression.expression;
        }
        if (status) {
          let rodzic = node.parent, trasa = '(poza trasa)';
          while (rodzic) {
            if (ts.isCallExpression(rodzic) && ts.isPropertyAccessExpression(rodzic.expression) && /^(get|post|put|patch|delete)$/.test(rodzic.expression.name.text) && rodzic.arguments.length && adres(rodzic.arguments[0])?.startsWith('/')) {
              trasa = `${rodzic.expression.name.text.toUpperCase()} ${adres(rodzic.arguments[0])}`;
              break;
            }
            rodzic = rodzic.parent;
          }
          wyniki.push({ plik, trasa, status, poczatekTekstu: tresc.getText(zrodlo).slice(0, 80) });
        }
      }
    }
    ts.forEachChild(node, odwiedz);
  }
  odwiedz(zrodlo);
  return wyniki;
}

function wymagane(miejsce, wywolania, fetch = []) {
  const sciezka = miejsce.trasa.split(' ')[1];
  return miejsce.trasa === '(poza trasa)' || !sciezka.startsWith('/api/') && wywolania.some(a => pasuje(sciezka, a)) && !fetch.some(a => pasuje(sciezka, a));
}

describe('strażnik odmów tekstem', () => {
  it('rozpoznaje formularz, API i wielowierszowy łańcuch', () => {
    const widoki = adresy('<form action="/formularz"><form action="/api/test">');
    const formularz = skanuj('test.js', "app.post('/formularz', (req, reply) => reply.code(400).send('x'))");
    const api = skanuj('test.js', "app.post('/api/test', (req, reply) => reply.code(400).send('x'))");
    const wiele = skanuj('test.js', "app.post('/formularz', (req, reply) => reply\n.code(400)\n.type('text/plain')\n.send('x'))");
    expect(formularz.filter(m => wymagane(m, widoki))).toHaveLength(1);
    expect(api.filter(m => wymagane(m, widoki))).toHaveLength(0);
    expect(wiele.filter(m => wymagane(m, widoki))).toHaveLength(1);
  });

  it('ma dokładny rejestr istniejących odmów', () => {
    const wszystkie = pliki('src');
    const wywolania = wszystkie.filter(p => p.endsWith('.ejs')).flatMap(p => adresy(readFileSync(p, 'utf8')));
    const fetch = wszystkie.filter(p => p.startsWith('src/public/') && p.endsWith('.js')).flatMap(p => adresyFetch(readFileSync(p, 'utf8')));
    const miejsca = wszystkie.filter(p => /\.(js|ts)$/.test(p)).flatMap(p => skanuj(relative('.', p).replaceAll('\\', '/'), readFileSync(p, 'utf8')));
    const lista = JSON.parse(readFileSync('tests/core/odmowy-tekstem.wyjatki.json', 'utf8'));
    const klucz = m => JSON.stringify([m.plik, m.trasa, m.status, m.poczatekTekstu]);
    const pozostale = [...lista];
    const nowe = [];
    for (const miejsce of miejsca) {
      const i = pozostale.findIndex(w => klucz(w) === klucz(miejsce));
      if (i >= 0) pozostale.splice(i, 1);
      else if (wymagane(miejsce, wywolania, fetch)) nowe.push(miejsce);
    }
    expect({ nowe, przestarzale: pozostale }).toEqual({ nowe: [], przestarzale: [] });
  });
});

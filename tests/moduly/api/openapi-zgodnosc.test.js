import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const sciezka = new URL('../../../docs/api/openapi.json', import.meta.url);
const metody = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const wczytaj = () => JSON.parse(readFileSync(sciezka, 'utf8'));
const operacje = opis => Object.entries(opis.paths).flatMap(([url, sciezka]) =>
  Object.entries(sciezka).filter(([metoda]) => metody.has(metoda))
    .map(([metoda, operacja]) => ({ metoda, url, operacja })));

describe('OpenAPI API v1', () => {
  it('jest JSON-em OpenAPI 3.1 i opisuje błędy schematem Blad', () => {
    const opis = wczytaj();
    expect(opis.openapi).toMatch(/^3\.1/);
    for (const { operacja } of operacje(opis)) {
      expect(operacja.responses).toBeDefined();
      for (const [status, odpowiedz] of Object.entries(operacja.responses)) {
        if (!/^[45]/.test(status) && status !== 'default') continue;
        const tresc = odpowiedz.$ref
          ? opis.components.responses[odpowiedz.$ref.split('/').at(-1)]
          : odpowiedz;
        expect(tresc.content['application/json'].schema.$ref).toBe('#/components/schemas/Blad');
      }
    }
  });

  it('opisuje dokładnie zarejestrowane trasy API v1', async () => {
    const db = openOmsDb();
    const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } } });
    try {
      await app.ready();
      const trasy = new Set((await app.getDecorator('trasyOms'))
        .filter(({ metoda, url }) => (url === '/api/v1' || url.startsWith('/api/v1/')) && metoda !== 'HEAD' && !url.endsWith('/'))
        .map(({ metoda, url }) => `${metoda} ${url.replace(/:([^/]+)/g, '{$1}')}`));
      const opisane = new Set(operacje(wczytaj()).map(({ metoda, url }) => `${metoda.toUpperCase()} ${url}`));
      const bezOpisu = [...trasy].filter(trasa => !opisane.has(trasa)).sort();
      const bezTrasy = [...opisane].filter(trasa => !trasy.has(trasa)).sort();
      expect({ bezOpisu, bezTrasy }, `Brak opisu: ${bezOpisu.join(', ') || 'brak'}; brak trasy: ${bezTrasy.join(', ') || 'brak'}`)
        .toEqual({ bezOpisu: [], bezTrasy: [] });
    } finally {
      await app.close();
      db.close();
    }
  });
});

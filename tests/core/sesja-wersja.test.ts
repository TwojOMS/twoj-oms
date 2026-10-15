import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { sprawdz } from '../../src/core/bezpieczenstwo/sesja.js';
import { podpiszWersje as podpisz } from '../pomoc/bezpieczenstwo-prz-007.ts';

// Syntetyczny sekret wyłącznie tej próby. Surowy signer pozwala sprawdzić walidację
// również poprawnie podpisanej treści pochodzącej od starszego/innego wystawcy.
const sekret = 'syntetyczny-sekret-testowy';
const surowy = (v: unknown) => {
  const tresc = Buffer.from(JSON.stringify({ u: 'alfa', do: 7_776_000_001, v })).toString('base64url');
  return `${tresc}.${createHmac('sha256', sekret).update(tresc).digest('base64url')}`;
};

describe('wersja pod podpisem sesji', () => {
  it('dawne trzy argumenty zachowują dokładny payload i wynik', () => {
    const token = podpisz('alfa', sekret, 1);
    expect(Buffer.from(token.split('.')[0], 'base64url').toString()).toBe('{"u":"alfa","do":7776000001}');
    expect(sprawdz(token, sekret, 2)).toEqual({ uzytkownik: 'alfa', wygasa: 7_776_000_001 });
  });
  it('wersję zwraca i chroni HMAC — podmieniona wersja jest nieważna', () => {
    const token = podpisz('alfa', sekret, 1, 7);
    expect(sprawdz(token, sekret, 2)).toEqual({ uzytkownik: 'alfa', wygasa: 7_776_000_001, wersja_hasla: 7 });
    const [tresc, podpis] = token.split('.');
    const dane = JSON.parse(Buffer.from(tresc, 'base64url').toString());
    dane.v = 8;
    expect(sprawdz(`${Buffer.from(JSON.stringify(dane)).toString('base64url')}.${podpis}`, sekret, 2)).toBeNull();
  });
  it.each([-1, 0.5, '1', null, {}, Number.MAX_SAFE_INTEGER + 1])('odrzuca obecne nieprawidłowe pole wersji %j', (v) => {
    expect(sprawdz(surowy(v), sekret, 2)).toBeNull();
    expect(() => podpisz('alfa', sekret, 1, v as number)).toThrow();
  });
});

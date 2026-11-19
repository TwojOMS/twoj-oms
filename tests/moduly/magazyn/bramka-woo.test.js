import { describe, expect, it } from 'vitest';
import { bramkaZapisuWoo } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';

// Produkty Woo nie mają wiersza w rejestrze ofert — bramka patrzy na wiersz lustra `produkty_sklepowe`.
const KONTO = { klucz: 'polcien', tylkoOdczyt: () => false };
const PRODUKT = { kanal: 'polcien', produkt_id: 501, karta_id: 7, zniknal_at: null };

function bramka(zmiany = {}) {
  return bramkaZapisuWoo({
    konto: KONTO,
    klucze: ['polcien'],
    produkt: PRODUKT,
    kartaId: 7,
    zakres: 'cena',
    ...zmiany,
  });
}

describe('bramkaZapisuWoo — zgoda', () => {
  it.each(['cena', 'status'])('przepuszcza zakres %s dla produktu tej karty na tym koncie', (zakres) => {
    expect(bramka({ zakres })).toEqual({ wolno: true });
  });

  it('status wolno zmienić także produktowi, który zniknął z lustra (np. wrócił jako szkic)', () => {
    expect(bramka({ zakres: 'status', produkt: { ...PRODUKT, zniknal_at: '2026-11-01T10:00:00Z' } })).toEqual({
      wolno: true,
    });
  });
});

describe('bramkaZapisuWoo — odmowa z powodem', () => {
  it.each([
    ['obce konto (spoza listy kont Woo)', { klucze: ['inny-sklep'] }, 'konto spoza listy kont Woo'],
    ['brak konta', { konto: null }, 'konto spoza listy kont Woo'],
    ['konto tylko do odczytu', { konto: { ...KONTO, tylkoOdczyt: () => true } }, 'konto w trybie tylko odczyt'],
    ['produkt innego konta', { produkt: { ...PRODUKT, kanal: 'inny-sklep' } }, 'produkt nie należy do tego konta'],
    ['brak produktu w lustrze', { produkt: null }, 'produkt nie należy do tego konta'],
    ['cudza karta', { kartaId: 8 }, 'produkt nie jest powiązany z tą kartą'],
    [
      'produkt niepowiązany z kartą',
      { produkt: { ...PRODUKT, karta_id: null } },
      'produkt nie jest powiązany z tą kartą',
    ],
    ['zakres treści', { zakres: 'tresc' }, 'zakres zapisu poza ceną i statusem'],
    ['zakres ilości', { zakres: 'ilosc' }, 'zakres zapisu poza ceną i statusem'],
    ['brak zakresu (PATCH treści)', { zakres: null }, 'zakres zapisu poza ceną i statusem'],
    [
      'zniknięty produkt przy cenie',
      { produkt: { ...PRODUKT, zniknal_at: '2026-11-01T10:00:00Z' } },
      'produkt zniknął ze sklepu',
    ],
  ])('%s', (_, zmiany, powod) => {
    expect(bramka(zmiany)).toEqual({ wolno: false, powod });
  });

  it('karta z tekstu żądania („7”) nie myli się z kartą produktu, ale inna liczba już tak', () => {
    expect(bramka({ kartaId: '7' }).wolno).toBe(true);
    expect(bramka({ kartaId: '07x' }).wolno).toBe(false);
    expect(bramka({ kartaId: undefined }).wolno).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { atrybucjaZeSurowych, atrybucjaZWiersza, opisAtrybucji } from '../../src/domena/atrybucja.js';

// Skad przyszlo zamowienie — WooCommerce Order Attribution (Etap 3 kampanii, 2026-08-25).
// Ksztalt pol odwzorowany z PRAWDZIWYCH zamowien produkcyjnych (odczyt 25.08): #28224
// (kupon wrzesien30, typein/(direct), wejscie na karte produktu, iPhone) i #28029
// (referral z m.facebook.com).

const meta = (pary) => ({ meta_data: Object.entries(pary).map(([key, value]) => ({ key, value })) });

// Dokladnie zamowienie 28224 z produkcji.
const SUROWE_28224 = meta({
  _wc_order_attribution_source_type: 'typein',
  _wc_order_attribution_utm_source: '(direct)',
  _wc_order_attribution_session_entry: 'https://szkicownia.pl/produkt/szablon-malarski-liscie/',
  _wc_order_attribution_session_start_time: '2026-08-25 17:37:13',
  _wc_order_attribution_session_pages: '18',
  _wc_order_attribution_session_count: '1',
  _wc_order_attribution_device_type: 'Mobile',
  _wc_order_attribution_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X)',
});

describe('atrybucjaZeSurowych', () => {
  it('czyta komplet pól z prawdziwego zamówienia 28224', () => {
    expect(atrybucjaZeSurowych(SUROWE_28224)).toEqual({
      typ: 'typein',
      zrodlo: '(direct)',
      medium: null,
      kampania: null,
      odsylacz: null,
      wejscie: 'https://szkicownia.pl/produkt/szablon-malarski-liscie/',
      start: '2026-08-25 17:37:13',
      stron: 18,
      sesja: 1,
      urzadzenie: 'Mobile',
    });
  });

  it('czyta odsyłacz i medium (zamówienie z Facebooka)', () => {
    const a = atrybucjaZeSurowych(meta({
      _wc_order_attribution_source_type: 'referral',
      _wc_order_attribution_utm_source: 'm.facebook.com',
      _wc_order_attribution_utm_medium: 'referral',
      _wc_order_attribution_referrer: 'https://m.facebook.com/',
      _wc_order_attribution_device_type: 'Mobile',
    }));
    expect(a).toMatchObject({ typ: 'referral', zrodlo: 'm.facebook.com', medium: 'referral', odsylacz: 'https://m.facebook.com/' });
  });

  it('czyta kampanię UTM, gdy link był otagowany', () => {
    const a = atrybucjaZeSurowych(meta({
      _wc_order_attribution_source_type: 'utm',
      _wc_order_attribution_utm_source: 'instagram',
      _wc_order_attribution_utm_medium: 'social',
      _wc_order_attribution_utm_campaign: 'wrzesien30',
    }));
    expect(a).toMatchObject({ typ: 'utm', zrodlo: 'instagram', kampania: 'wrzesien30' });
  });

  // ⚠️ BRAK ATRYBUCJI TO CO INNEGO NIZ „bezposrednie": 21 zamowien w bazie powstalo PRZED
  // wlaczeniem tej funkcji w sklepie (na PRO dopiero 31.07). `null` znaczy „nie wiemy
  // i nigdy nie bedziemy wiedziec", a nie „klient wszedl wprost".
  it('brak pól atrybucji → null, a nie pusty obiekt', () => {
    expect(atrybucjaZeSurowych(meta({ _billing_nip: '1234567890' }))).toBeNull();
    expect(atrybucjaZeSurowych({})).toBeNull();
    expect(atrybucjaZeSurowych(null)).toBeNull();
  });

  it('sam typ źródła wystarczy, żeby atrybucja istniała', () => {
    expect(atrybucjaZeSurowych(meta({ _wc_order_attribution_source_type: 'organic' })))
      .toMatchObject({ typ: 'organic', zrodlo: null });
  });

  it('liczby sesji wychodzą liczbami, nie napisami', () => {
    const a = atrybucjaZeSurowych(SUROWE_28224);
    expect(a.stron).toBe(18);
    expect(a.sesja).toBe(1);
  });

  // ⚠️ User agent CELOWO NIE WCHODZI: to dana osobowa o znikomej wartosci operacyjnej
  // (urzadzenie mamy osobnym polem), a karta zamowienia jest ogladana przy kliencie.
  it('NIE przenosi user agenta', () => {
    expect(JSON.stringify(atrybucjaZeSurowych(SUROWE_28224))).not.toMatch(/Mozilla/);
  });
});

describe('atrybucjaZWiersza', () => {
  it('parsuje kolumnę', () => {
    expect(atrybucjaZWiersza('{"typ":"organic","zrodlo":"google"}')).toEqual({ typ: 'organic', zrodlo: 'google' });
  });

  it('NULL i uszkodzony JSON → null, bez wyjątku', () => {
    expect(atrybucjaZWiersza(null)).toBeNull();
    expect(atrybucjaZWiersza('{zepsute')).toBeNull();
  });
});

describe('opisAtrybucji', () => {
  const opis = (nad) => opisAtrybucji({ typ: 'typein', zrodlo: '(direct)', wejscie: null, ...nad });

  it('brak atrybucji ma własną etykietę — nie udaje bezpośredniego wejścia', () => {
    expect(opisAtrybucji(null).etykieta).toMatch(/nie wiadomo|brak/i);
  });

  it('wyszukiwarka, odsyłacz i link z tagiem mają czytelne etykiety', () => {
    expect(opis({ typ: 'organic', zrodlo: 'google' }).etykieta).toBe('Google — wyszukiwarka');
    expect(opis({ typ: 'referral', zrodlo: 'm.facebook.com' }).etykieta).toBe('m.facebook.com — odsyłacz');
    expect(opis({ typ: 'utm', zrodlo: 'instagram', kampania: 'wrzesien30' }).etykieta).toBe('instagram — link z tagiem');
  });

  it('kampania z UTM-u stoi w szczególe, bo to ona odpowiada na pytanie „która akcja"', () => {
    expect(opis({ typ: 'utm', zrodlo: 'instagram', kampania: 'wrzesien30' }).szczegol).toMatch(/wrzesien30/);
  });

  it('zamówienie wpisane w panelu sklepu nazywa się po imieniu', () => {
    expect(opis({ typ: 'admin', zrodlo: null }).etykieta).toMatch(/panel sklepu/i);
  });

  // ⚠️⚠️ SEDNO WSKAZOWKI: „(direct)" z wejsciem PROSTO na podstrone to typowy podpis linku
  // otwartego w aplikacji (Instagram i Facebook gubia odsylacz). Bez tego zdania operator
  // czyta „bezposrednie" jako „klientka wpisala adres z palca" — i odklada kampanie do szuflady
  // „nic nie dala". Zdanie jest OSTROZNE: mowi „bywa", nie „to na pewno stamtad".
  it('bezpośrednie wejście w głąb sklepu dostaje wskazówkę o linku z aplikacji', () => {
    const w = opis({ wejscie: 'https://szkicownia.pl/produkt/szablon-malarski-liscie/' }).wskazowka;
    expect(w).toMatch(/aplikacj/i);
  });

  it('bezpośrednie wejście na stronę główną wskazówki NIE dostaje', () => {
    expect(opis({ wejscie: 'https://szkicownia.pl/' }).wskazowka).toBeNull();
    expect(opis({ wejscie: null }).wskazowka).toBeNull();
  });

  it('wejście z wyszukiwarki wskazówki nie dostaje, choćby było w głąb sklepu', () => {
    expect(opis({ typ: 'organic', zrodlo: 'google', wejscie: 'https://szkicownia.pl/produkt/x/' }).wskazowka).toBeNull();
  });

  // Grupowanie na zakladce kampanii idzie po KLUCZU, nie po etykiecie — etykieta jest
  // tekstem dla czlowieka i wolno ja poprawic bez rozsypania historycznych zestawien.
  it('klucz grupowania jest stabilny i wspólny dla tego samego źródła', () => {
    const a = opis({ typ: 'organic', zrodlo: 'google' });
    const b = opis({ typ: 'organic', zrodlo: 'Google' });
    expect(a.klucz).toBe(b.klucz);
    expect(a.klucz).not.toBe(opis({ typ: 'referral', zrodlo: 'google' }).klucz);
  });
});

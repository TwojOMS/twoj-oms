import { describe, it, expect } from 'vitest';
import {
  wolnoWyslacDoAllegro, poZamianieNipWAllegro, zdanieKartyPoZamianieNip, ODMOWA_ALLEGRO_PO_ZAMIANIE_NIP,
} from '../../src/domena/allegro-faktura.js';

// PRZ-126 C09e — znacznik D (plan C09, Z10): zamówienie przepięte na fakturę zastępczą, gdy poprzednia faktura była
// już u kupującego w Allegro. Wiersz `faktury`: `allegro_wyslana_at` niepuste, `allegro_invoice_id` puste,
// `program = 'twojefaktury'`, stan ≠ REJECTED. Bariera odmawia prawdziwym zdaniem — bez „Faktura <nowa> została już
// wysłana” (to byłoby kłamstwo: wysłana była STARA). Dane zmyślone (Pracownia Półcień).

const zamowienie = (faktura) => ({
  sklep: 'allegro_polcien', chce_fakture: 1,
  faktura: {
    program: 'twojefaktury', dokument_id: '17', numer: 'FV/2/11/2026', ksef_numer: '1234563218-20261102-0A1B2C3D4E5F-02',
    allegro_invoice_id: null, allegro_wyslana_at: '2026-10-20T11:00:00.000Z', allegro_weryfikacja: 'ACCEPTED',
    ...faktura,
  },
});

describe('PRZ-126 C09e — wolnoWyslacDoAllegro przy znaczniku D', () => {
  it.each(['ACCEPTED', 'WAITING', null, 'NOWY_STATUS'])('stan %s: odmowa z nowym zdaniem, bez numeru nowej faktury', (stan) => {
    const w = wolnoWyslacDoAllegro(zamowienie({ allegro_weryfikacja: stan }));
    expect(w.wolno).toBe(false);
    expect(w.powod).toBe(ODMOWA_ALLEGRO_PO_ZAMIANIE_NIP);
    expect(w.powod).not.toMatch(/została już wysłana/);
    expect(w.powod).not.toContain('FV/2/11/2026');
  });

  it('brzmienie odmowy jak w planie (do akceptacji właściciela, §7)', () => {
    expect(ODMOWA_ALLEGRO_PO_ZAMIANIE_NIP).toBe(
      'Kupujący ma w Allegro poprzednią fakturę (sprzed zamiany NIP-u) — nowej panel nie wysyła sam; '
      + 'wyślij ją z panelu Allegro albo zakładką Wiadomości.',
    );
  });

  it('znacznik D odmawia także bez numeru KSeF nowej (gałąź stoi przed sprawdzeniem KSeF)', () => {
    const w = wolnoWyslacDoAllegro(zamowienie({ ksef_numer: null }));
    expect(w.powod).toBe(ODMOWA_ALLEGRO_PO_ZAMIANIE_NIP);
  });

  it('zwykły wiersz wysłany (z id zgłoszenia) → dzisiejszy tekst „została już wysłana”', () => {
    const w = wolnoWyslacDoAllegro(zamowienie({ allegro_invoice_id: 'INV-7' }));
    expect(w.wolno).toBe(false);
    expect(w.powod).toMatch(/^Faktura FV\/2\/11\/2026 została już wysłana do Allegro 2026-10-20T11:00:00.000Z — kupujący ma ją na koncie\./);
  });

  it('REJECTED z id → przepuszcza jak dziś (ponowienie podmienia plik)', () => {
    const w = wolnoWyslacDoAllegro(zamowienie({ allegro_invoice_id: 'INV-7', allegro_weryfikacja: 'REJECTED' }));
    expect(w).toEqual({ wolno: true, powod: null });
  });

  it('wiersz inFaktu bez id zgłoszenia → dzisiejszy tekst, nie zdanie o zamianie NIP-u', () => {
    const w = wolnoWyslacDoAllegro(zamowienie({ program: 'infakt', dokument_id: null, infakt_uuid: 'u-1' }));
    expect(w.powod).toMatch(/została już wysłana/);
    expect(w.powod).not.toBe(ODMOWA_ALLEGRO_PO_ZAMIANIE_NIP);
  });

  it('stary wiersz bez kolumny program (sprzed PRZ-118, inFakt) → dzisiejszy tekst', () => {
    const w = wolnoWyslacDoAllegro(zamowienie({ program: undefined, dokument_id: null, infakt_uuid: 'u-1' }));
    expect(w.powod).toMatch(/została już wysłana/);
  });

  // Recenzja planu: czuwacz może zapisać REJECTED (po `faktury.id`) już po przepięciu w stanie D. Wiersz to wtedy
  // „wysłana, REJECTED, bez id” — kupujący starego pliku nie ma, więc wolno zgłosić NOWĄ fakturę nowym numerem.
  it('spóźnione REJECTED po przepięciu w D (bez id) NIE dostaje odmowy D — przechodzi jak C', () => {
    const f = { allegro_weryfikacja: 'REJECTED' };
    expect(poZamianieNipWAllegro(zamowienie(f).faktura)).toBe(false);
    expect(wolnoWyslacDoAllegro(zamowienie(f))).toEqual({ wolno: true, powod: null });
  });
});

describe('PRZ-126 C09e — zdanie karty przy znaczniku D', () => {
  it('znacznik D → zdanie z dniem wysyłki (czas Warszawy) i numerem nowej faktury', () => {
    expect(zdanieKartyPoZamianieNip(zamowienie({ allegro_wyslana_at: '2026-10-20T22:30:00.000Z' }).faktura)).toBe(
      'Kupujący ma w Allegro poprzednią fakturę (sprzed zamiany NIP-u), wysłaną 21.10. Nowej FV/2/11/2026 panel nie wysyła sam.',
    );
  });

  it('bez znacznika D → null (zwykła wysłana, REJECTED bez id, inFakt)', () => {
    expect(zdanieKartyPoZamianieNip(zamowienie({ allegro_invoice_id: 'INV-7' }).faktura)).toBeNull();
    expect(zdanieKartyPoZamianieNip(zamowienie({ allegro_weryfikacja: 'REJECTED' }).faktura)).toBeNull();
    expect(zdanieKartyPoZamianieNip(zamowienie({ program: 'infakt' }).faktura)).toBeNull();
    expect(zdanieKartyPoZamianieNip(null)).toBeNull();
  });
});

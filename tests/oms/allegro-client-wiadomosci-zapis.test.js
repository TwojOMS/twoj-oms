import { describe, it, expect } from 'vitest';
import { createAllegroClient } from '../../src/oms/allegro/client.js';
import { MAKS_ZNAKOW_WIADOMOSCI } from '../../src/domena/ustawienia-formulki.js';

// ⚠️⚠️ TO JEST WYWOLANIE NIEODWRACALNE — po drugiej stronie jest czlowiek, ktory dostaje
// powiadomienie na telefon. Walidacja idzie PRZED wyjsciem do sieci, bo Allegro odbilo by
// przekroczenie limitu jako „HTTP 400", a z tego komunikatu nikt nie wyczyta, ze formulka
// jest za dluga.

const tokeny = { waznyToken: async () => 'TOKEN' };
const ustawienia = { api: 'https://api.przyklad', userAgent: 'Panel/0.0.0 (+https://przyklad.invalid)' };

describe('klient Allegro — wysylka wiadomosci', () => {
  it('POST-uje tekst do wskazanego wątku z wymaganymi nagłówkami', async () => {
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return { ok: true, status: 201, json: async () => ({ id: 'm9' }) };
    };
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.wyslijWiadomosc('t1', 'Dzień dobry');

    expect(wywolania[0].url).toContain('/messaging/threads/t1/messages');
    expect(wywolania[0].opcje.method).toBe('POST');
    expect(JSON.parse(wywolania[0].opcje.body)).toEqual({ text: 'Dzień dobry' });
    expect(wywolania[0].opcje.headers['Content-Type']).toBe('application/vnd.allegro.public.v1+json');
    expect(wywolania[0].opcje.headers['User-Agent']).toBe(ustawienia.userAgent);
  });

  it('ODMAWIA przed wyjściem do sieci, gdy tekst przekracza 2000 znaków', async () => {
    let dzwoniono = false;
    const fetchImpl = async () => { dzwoniono = true; return { ok: true, json: async () => ({}) }; };
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await expect(k.wyslijWiadomosc('t1', 'x'.repeat(MAKS_ZNAKOW_WIADOMOSCI + 1)))
      .rejects.toThrow(/2000/);
    expect(dzwoniono).toBe(false);
  });

  it('tekst DOKŁADNIE na limicie przechodzi', async () => {
    const fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({ id: 'm1' }) });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    await expect(k.wyslijWiadomosc('t1', 'x'.repeat(MAKS_ZNAKOW_WIADOMOSCI))).resolves.toBeTruthy();
  });

  it('ODMAWIA wysłania pustego tekstu', async () => {
    let dzwoniono = false;
    const fetchImpl = async () => { dzwoniono = true; return { ok: true, json: async () => ({}) }; };
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await expect(k.wyslijWiadomosc('t1', '   ')).rejects.toThrow(/pust/i);
    expect(dzwoniono).toBe(false);
  });

  it('identyfikator wątku jest KODOWANY do adresu', async () => {
    const wywolania = [];
    const fetchImpl = async (url, opcje) => {
      wywolania.push({ url, opcje });
      return { ok: true, status: 201, json: async () => ({}) };
    };
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    await k.wyslijWiadomosc('a/b c', 'tekst');
    expect(wywolania[0].url).toContain('/messaging/threads/a%2Fb%20c/messages');
  });

  it('błąd HTTP niesie kod, a NIGDY tokenu', async () => {
    const fetchImpl = async () => ({ ok: false, status: 422, json: async () => ({}) });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    await expect(k.wyslijWiadomosc('t1', 'ok')).rejects.toThrow(/HTTP 422/);
    await expect(k.wyslijWiadomosc('t1', 'ok')).rejects.not.toThrow(/TOKEN/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';

const odpowiedz = (status, dane) => ({ status, ok: status >= 200 && status < 300, json: async () => dane });
const klient = (http) => createWooClient({ baseUrl: 'http://sklep.example', ck: 'ck_test', cs: 'cs_test', http });
const bramki = [
  { id: 'cod', title: 'Płatność przy odbiorze', method_title: 'Pobranie', enabled: true },
  { id: 'bacs', title: 'Przelew bankowy', method_title: 'Przelew', enabled: true },
  { id: 'polcien_raty', title: 'Raty Półcień', method_title: 'Raty', enabled: false },
].map((b) => ({ ...b, description: 'opis', settings: { api_key: { value: 'sekret_bramki_polcien' } } }));

describe('bramki płatności Woo', () => {
  it('pobiera wyłącznie dozwolone pola i prosi o nie w adresie', async () => {
    const http = vi.fn().mockResolvedValue(odpowiedz(200, bramki));
    const wynik = await klient(http).pobierzBramkiPlatnosci();
    expect(JSON.stringify(wynik)).not.toContain('sekret_bramki_polcien');
    expect(JSON.stringify(wynik)).not.toContain('settings');
    expect(wynik).toEqual([
      { id: 'cod', tytul: 'Płatność przy odbiorze', nazwaWoo: 'Pobranie', wlaczona: true },
      { id: 'bacs', tytul: 'Przelew bankowy', nazwaWoo: 'Przelew', wlaczona: true },
      { id: 'polcien_raty', tytul: 'Raty Półcień', nazwaWoo: 'Raty', wlaczona: false },
    ]);
    expect(http.mock.calls[0][0]).toContain('/payment_gateways?_fields=id,title,method_title,enabled');
  });
  it('zgłasza błąd 403', async () => {
    await expect(klient(async () => odpowiedz(403, {})).pobierzBramkiPlatnosci()).rejects.toThrow('403');
  });
  it('odrzuca odpowiedź, która nie jest tablicą', async () => {
    await expect(klient(async () => odpowiedz(200, {})).pobierzBramkiPlatnosci()).rejects.toThrow('nieprawidłową listę bramek');
  });
  it('nie przepuszcza obiektów w polach tekstowych ani elementów niebędących obiektem', async () => {
    const dane = [null, 'cod', { id: 'cod', title: { settings: 'sekret_bramki_polcien' }, method_title: 7, enabled: 'yes' }];
    const wynik = await klient(async () => odpowiedz(200, dane)).pobierzBramkiPlatnosci();
    expect(wynik).toEqual([{ id: 'cod', tytul: '', nazwaWoo: '', wlaczona: false }]);
  });
});

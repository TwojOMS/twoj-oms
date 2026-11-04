import { createServer } from 'node:http';

const auth = 'Basic ' + Buffer.from('ck_test_polcien:cs_test_polcien').toString('base64');
const strefy = [{ id: 1, name: 'Kraj' }, { id: 2, name: 'Europa' }, { id: 0, name: 'Pozostałe lokalizacje' }];
const metody = {
  1: [{ instance_id: 3, title: 'Przesyłka', method_id: 'flat_rate', enabled: true }],
  2: [{ instance_id: 5, title: 'Odbiór osobisty', method_id: 'local_pickup', enabled: true }],
  0: [{ instance_id: 7, title: 'Dostawa pozostała', method_id: 'flexible_shipping', enabled: true }],
};
const bramki = [
  { id: 'cod', title: 'Płatność przy odbiorze', method_title: 'Pobranie', enabled: true },
  { id: 'bacs', title: 'Przelew bankowy', method_title: 'Przelew', enabled: true },
  { id: 'polcien_raty', title: 'Raty Półcień', method_title: 'Raty', enabled: false },
].map((b) => ({ ...b, settings: { api_key: { value: 'sekret_bramki_polcien' } } }));
const zamowienia = [1, 2, 3].map((id) => ({ id, status: 'processing', billing: { company: 'Pracownia Półcień' },
  total: '100.00', payment_method: ['cod', 'bacs', ''][id - 1], shipping_lines: [{ instance_id: [3, 3, 5][id - 1] }] }));

export function createAtrapaWooHttp({ tryb, przekierowanie } = {}) {
  return createServer((req, res) => {
    const odpowiedz = (status, dane) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(dane)); };
    if (Number(tryb) === 301) { res.writeHead(301, { Location: przekierowanie || 'http://127.0.0.1:1/' }); res.end(); return; }
    if (Number(tryb) === 401 || req.headers.authorization !== auth) return odpowiedz(401, { message: 'Niepoprawne klucze' });
    if (Number(tryb) === 404) return odpowiedz(404, { message: 'Brak API' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') return odpowiedz(405, { message: 'Niedozwolona metoda' });
    const prefix = '/wp-json/wc/v3';
    if (url.pathname === `${prefix}/payment_gateways`) {
      return tryb === 'bramki403' ? odpowiedz(403, { message: 'Brak dostępu' }) : odpowiedz(200, bramki);
    }
    if (url.pathname === `${prefix}/orders`) {
      const limit = Number(url.searchParams.get('per_page')) || zamowienia.length;
      return odpowiedz(200, zamowienia.slice(0, Math.max(0, limit)));
    }
    if (url.pathname === `${prefix}/shipping/zones`) return odpowiedz(200, strefy);
    const dopasowanie = /^\/wp-json\/wc\/v3\/shipping\/zones\/(\d+)\/methods$/.exec(url.pathname);
    if (dopasowanie && metody[dopasowanie[1]]) return odpowiedz(200, metody[dopasowanie[1]]);
    return odpowiedz(404, { message: 'Brak zasobu' });
  });
}

// PRZ-060: znak w belce panelu z konfiguracji instalacji (OMS_LOGO_PLIK, OMS_LOGO_ALT).
// Bez zmiennych — neutralny znak z paczki i pusty alt; z wartościami produkcji właściciela — jego PNG
// pod tym samym adresem i alt „Szkicownia”, czyli belka bajt w bajt jak przed PRZ-060.
import { it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { modulWeb } from '../../src/core/web/modul.ts';

const env = { OMS_USER:'operator', OMS_PASS:'fixture', OMS_SPRZEDAWCA_NIP:'1234563218',
  OMS_RACHUNEK:'34109010140000000000000000', OMS_PROFORMY_KATALOG:tmpdir(), OMS_ETYKIETY_KATALOG:tmpdir() };
const headers = { authorization:`Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const neutralny = readFileSync(new URL('../../src/public/favicon-192.png', import.meta.url));
// Prawdziwy PNG (1×1), inny niż neutralny znak — tylko po to, żeby odróżnić źródło bajtów.
const wlasny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/zW3mEwAAAABJRU5ErkJggg==', 'base64');

async function belkaIZnak(extra: Record<string,string>) {
  const siec = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  let a: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try {
    a = await zbudujOms({ env: { ...env, ...extra } });
    const strona = await a.app.inject({ method:'GET', url:'/', headers });
    const znak = await a.app.inject({ method:'GET', url:'/public/favicon-192.png' });
    expect(siec).not.toHaveBeenCalled();
    return { img: strona.body.match(/<img class="pas-logo"[^>]*>/)?.[0], status: znak.statusCode, typ: znak.headers['content-type'], bajty: znak.rawPayload };
  } finally {
    try { await a?.app.close(); } finally { a?.db.close(); siec.mockRestore(); }
  }
}

it('konfiguracja modułu web: bez zmiennych brak pliku i pusty alt', () => {
  expect(modulWeb.konfiguracja!(env as any).marka).toEqual({ logoPlik: null, logoAlt: '' });
  expect(modulWeb.konfiguracja!({ ...env, OMS_LOGO_PLIK: '  ', OMS_LOGO_ALT: ' Sklep ' } as any).marka).toEqual({ logoPlik: null, logoAlt: 'Sklep' });
});

it('bez zmiennych: neutralny znak z paczki i pusty alt', async () => {
  const w = await belkaIZnak({});
  expect(w.img).toBe('<img class="pas-logo" src="/public/favicon-192.png" alt="">');
  expect(w.status).toBe(200);
  expect(w.bajty.equals(neutralny)).toBe(true);
}, 30000);

it('z OMS_LOGO_PLIK i OMS_LOGO_ALT: własny PNG pod tym samym adresem i dzisiejszy alt', async () => {
  const k = mkdtempSync(join(tmpdir(), 'oms-logo-'));
  try {
    const plik = join(k, 'logo.png'); writeFileSync(plik, wlasny);
    const w = await belkaIZnak({ OMS_LOGO_PLIK: plik, OMS_LOGO_ALT: 'Szkicownia' });
    expect(w.img).toBe('<img class="pas-logo" src="/public/favicon-192.png" alt="Szkicownia">');
    expect([w.status, w.typ]).toEqual([200, 'image/png']);
    expect(w.bajty.equals(wlasny)).toBe(true);
  } finally { rmSync(k, { recursive: true, force: true }); }
}, 30000);

it('alt jest escapowany jak każdy tekst w szablonie', async () => {
  const w = await belkaIZnak({ OMS_LOGO_ALT: 'A"<b>' });
  expect(w.img).toBe('<img class="pas-logo" src="/public/favicon-192.png" alt="A&#34;&lt;b&gt;">');
}, 30000);

it('brakujący plik albo nie-PNG odmawia startu', async () => {
  const k = mkdtempSync(join(tmpdir(), 'oms-logo-'));
  try {
    await expect(zbudujOms({ env: { ...env, OMS_LOGO_PLIK: join(k, 'brak.png') } })).rejects.toThrow('OMS_LOGO_PLIK: nie da się odczytać pliku');
    const zly = join(k, 'logo.png'); writeFileSync(zly, 'to nie jest obraz');
    await expect(zbudujOms({ env: { ...env, OMS_LOGO_PLIK: zly } })).rejects.toThrow('OMS_LOGO_PLIK: plik nie jest obrazem PNG');
  } finally { rmSync(k, { recursive: true, force: true }); }
}, 30000);

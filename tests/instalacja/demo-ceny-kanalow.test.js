// Demo pokazuje „Ceny w kanałach”: powiązany szkic w sklepie, produkt z trwającą promocją i narzut 10% konta
// sklepu. Dwa resety dają to samo, a promocja trwa względem dnia uruchomienia, nie stałej daty.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { katalogWoo } from '../../scripts/demo-dane-katalog.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const katalogi = [];
afterAll(() => {
  for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function reset() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-ceny-'));
  katalogi.push(k);
  const baza = path.join(k, 'oms.sqlite');
  await utworzBazeDemo({ baza, dzis: '2026-10-14' });
  const db = new DatabaseSync(baza);
  try {
    return {
      narzut: {
        ...db
          .prepare("SELECT narzut_bp, prog_potwierdzenia_bp FROM oferty_ustawienia_kont WHERE klucz = 'polcien'")
          .get(),
      },
      szkic: db
        .prepare(
          `SELECT p.nazwa, p.status_publikacji, p.karta_id, p.zniknal_at, k.nazwa AS karta, k.cena_gr
          FROM produkty_sklepowe p LEFT JOIN karty_produktow k ON k.id = p.karta_id
          WHERE p.kanal = 'polcien' AND p.status_publikacji = 'draft'`,
        )
        .all()
        .map((w) => ({ ...w })),
    };
  } finally {
    db.close();
  }
}

describe('demo: ceny w kanałach', () => {
  it('narzut 10% na koncie polcien, powiązany szkic na karcie; drugi reset daje to samo', async () => {
    const a = await reset();
    const b = await reset();
    expect(a.narzut).toEqual({ narzut_bp: 1000, prog_potwierdzenia_bp: 5000 });
    expect(a.szkic).toHaveLength(1);
    expect(a.szkic[0]).toMatchObject({
      nazwa: 'Lampa Półcień 40 — szkic',
      karta: 'Lampa Półcień 40 — szkic',
      zniknal_at: null,
    });
    expect(a.szkic[0].karta_id).toBeGreaterThan(0);
    expect(b).toEqual(a);
  }, 120000);

  it('katalog Woo ma produkt z trwającą promocją (data końca w przyszłości) i szkic poza listą opublikowanych', () => {
    const { produkty } = katalogWoo('polcien');
    const wPromocji = produkty.filter((p) => p.sale_price);
    expect(wPromocji).toHaveLength(1);
    const [p] = wPromocji;
    expect(Number(p.sale_price)).toBeLessThan(Number(p.regular_price));
    expect(Date.parse(`${p.date_on_sale_to}Z`)).toBeGreaterThan(Date.now() + 7 * 86400000);
    expect(p.date_on_sale_from).toBe('');
    const szkice = produkty.filter((x) => x.status === 'draft');
    expect(szkice.map((x) => x.name)).toEqual(['Lampa Półcień 40 — szkic']);
  });
});

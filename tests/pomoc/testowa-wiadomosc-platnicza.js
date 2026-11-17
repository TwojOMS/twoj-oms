import * as real from '../../src/domena/wiadomosc-platnicza.js';
import { MARKA_HISTORYCZNA as m } from './marka-poczty-fixture.js';
export * from '../../src/domena/wiadomosc-platnicza.js';
export const modelWiadomosci = (z, o = {}) => real.modelWiadomosci(z, { podpis: m.podpis, ...o });

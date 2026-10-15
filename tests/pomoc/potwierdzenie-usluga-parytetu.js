import { createPotwierdzenie as real } from '../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { MARKA_HISTORYCZNA as m } from './marka-poczty-fixture.js';
export const createPotwierdzenie = o => real({ ...o, oprawaPoczty: { ...m, ...o.oprawaPoczty } });

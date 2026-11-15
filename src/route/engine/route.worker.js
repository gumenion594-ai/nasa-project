// Web Worker for the precise route search (engine.js + provider.js), so the map never freezes.
// Messages in:  { type: 'search', id, a, b, settings, base, world }   { type: 'cancel', id }
// Messages out: { type: 'progress', id, level, mode, fraction }  { type: 'result', id, result }
//               { type: 'unavailable-data', id }  (precise grids not built)  { type: 'error', id, message }
import { findRoute } from './engine.js';
import { createLevels } from './provider.js';

const ladders = new Map(); // world -> its resolution ladder (or null: grids not built)
let current = null; // id of the running search; a newer one cancels it

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { if (current === data.id) current = null; return; }
  if (data.type !== 'search') return;
  const { id, a, b, settings, base, world = 'mars' } = data;
  current = id;
  try {
    if (!ladders.has(world)) ladders.set(world, await createLevels(base, world));
    const ladder = ladders.get(world);
    if (!ladder) { self.postMessage({ type: 'unavailable-data', id }); return; }
    let last = 0;
    const result = await findRoute(a, b, ladder.levels, settings, {
      onProgress: (p) => {
        const now = Date.now();
        if (now - last > 100) { last = now; self.postMessage({ type: 'progress', id, ...p }); }
      },
      shouldStop: () => current !== id,
    });
    if (current !== id || result.status === 'cancelled') return;
    self.postMessage({ type: 'result', id, result });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message ?? err) });
  }
};

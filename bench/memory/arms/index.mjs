// Arm registry — the runner addresses arms by name. Adding an arm means adding
// a factory here and nowhere else. `mem0` (task 169) additionally needs its
// sidecar started before the regime is built — run.mjs handles that.

import { createArmNone } from './arm_none.mjs';
import { createArmMycelium } from './arm_mycelium.mjs';
import { createArmMem0 } from './arm_mem0.mjs';

export const ARM_FACTORIES = {
  none: createArmNone,
  mycelium: createArmMycelium,
  mem0: createArmMem0,
};

export function resolveArms(names) {
  const unknown = names.filter((n) => !ARM_FACTORIES[n]);
  if (unknown.length) throw new Error(`Unknown arm(s): ${unknown.join(', ')}. Known: ${Object.keys(ARM_FACTORIES).join(', ')}`);
  return names;
}

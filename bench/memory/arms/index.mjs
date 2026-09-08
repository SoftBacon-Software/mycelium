// Arm registry — the runner addresses arms by name. Adding a third arm later
// (Mem0/Zep/Letta, task 165+) means adding a factory here and nowhere else.

import { createArmNone } from './arm_none.mjs';
import { createArmMycelium } from './arm_mycelium.mjs';

export const ARM_FACTORIES = {
  none: createArmNone,
  mycelium: createArmMycelium,
};

export function resolveArms(names) {
  const unknown = names.filter((n) => !ARM_FACTORIES[n]);
  if (unknown.length) throw new Error(`Unknown arm(s): ${unknown.join(', ')}. Known: ${Object.keys(ARM_FACTORIES).join(', ')}`);
  return names;
}

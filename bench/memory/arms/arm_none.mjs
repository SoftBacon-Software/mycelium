// arm_none — the no-memory control. Answers from the question alone.
// It never writes anything and never sees any haystack content.
//
// task 207: rows stamp the shared retrieval provenance anyway — read_hits
// null + read_hits_available FALSE (this arm has no retrieval surface at all),
// never an empty array pretending a search ran and returned nothing.

import { recordHits } from '../retrieval_stamp.mjs';

export const NO_MEMORY_SYSTEM =
  'You are a personal assistant. Answer the question directly and concisely ' +
  '(at most two sentences). If you do not know the answer, say that you do not know.';

export function createArmNone({ answerChat, retrievalBudget = null, recordHits: stampHits = recordHits }) {
  return {
    name: 'none',
    async write() { /* no memory: nothing to write */ },
    async answer(question) {
      const r = await answerChat({ system: NO_MEMORY_SYSTEM, user: question });
      const meta = stampHits({ had_think: !!r.hadThink }, null, retrievalBudget);
      return { text: r.text, meta };
    },
  };
}

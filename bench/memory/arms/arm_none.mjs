// arm_none — the no-memory control. Answers from the question alone.
// It never writes anything and never sees any haystack content.

export const NO_MEMORY_SYSTEM =
  'You are a personal assistant. Answer the question directly and concisely ' +
  '(at most two sentences). If you do not know the answer, say that you do not know.';

export function createArmNone({ answerChat }) {
  return {
    name: 'none',
    async write() { /* no memory: nothing to write */ },
    async answer(question) {
      const r = await answerChat({ system: NO_MEMORY_SYSTEM, user: question });
      return { text: r.text, meta: { had_think: !!r.hadThink } };
    },
  };
}

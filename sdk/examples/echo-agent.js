// Example: Simple echo agent that responds to messages
//
// Run with:
//   MYCELIUM_AGENT_ID=echo-bot MYCELIUM_API_KEY=dvk_xxx \
//   MYCELIUM_HANDLER=./examples/echo-agent.js mycelium-agent

export async function onWork(item) {
  console.log('Got work:', item.type, item.title)
  // In a real agent, you'd do something useful here
}

export function onMessage(msg) {
  console.log('Message from %s: %s', msg.from_agent, msg.content)
}

export async function onRequest(req, type) {
  console.log('%s from %s: %s', type, req.from_agent, req.content)
  // Auto-respond to requests (a real agent would process and respond via API)
}

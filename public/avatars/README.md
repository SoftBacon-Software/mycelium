# Agent avatars (deployment-local)

Drop `<agent-id>.png` files here and set the agent record's `avatar_url`
to `/avatars/<agent-id>.png` (server-relative; clients resolve against
their instance base URL):

    PUT /api/mycelium/agents/<id>  {"avatar_url": "/avatars/<id>.png"}

Files in this directory are **gitignored by design** — faces are instance
data, like the SQLite DB. The mechanism is public; your crew is yours.

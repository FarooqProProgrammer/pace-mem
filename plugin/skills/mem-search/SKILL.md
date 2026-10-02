---
name: mem-search
description: Search pace-mem's record of past Claude Code sessions. Use when the user asks what was done before ("did we already fix…", "how did we decide…", "last time we…"), or before re-investigating a bug, decision or subsystem that earlier sessions may have covered.
---

# Searching past sessions with pace-mem

pace-mem stores compressed observations of earlier sessions (decisions, bug fixes, discoveries, changes) and exposes them through three MCP tools. Use them in this order to keep token use low:

1. **`search`**: `query` with a few distinctive words, optionally `project`, `type` (`decision`, `bugfix`, `feature`, `refactor`, `discovery`, `change`) or `dateStart`/`dateEnd`. Returns IDs and titles only.
2. **`timeline`**: `anchor` set to a promising ID, to see what happened just before and after it.
3. **`get_observations`**: `ids` for the few observations you actually need. Returns narrative, facts and files.

Do not fetch full details for every search hit. If a search returns nothing, try synonyms or drop the `project` filter before concluding there is no history.

Memory reflects what was true when it was recorded. If an observation names a file, function or flag, confirm it still exists before relying on it.

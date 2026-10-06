---
name: mem-search
description: Search and update pace-mem's record of past sessions. Use when the user asks what was done before, before re-investigating something earlier sessions may have covered, or when you learn a durable decision, bug fix, or discovery that a future session should know.
---

# Searching and saving with pace-mem

pace-mem stores compressed observations of earlier sessions. Nothing is written automatically: you must save durable knowledge yourself. Use the MCP tools in this order:

1. **`search`**: `query` with a few distinctive words, optionally `project`, `type` (`decision`, `bugfix`, `feature`, `refactor`, `discovery`, `change`) or `dateStart`/`dateEnd`. Returns IDs and titles only.
2. **`timeline`**: `anchor` set to a promising ID, to see what happened just before and after it.
3. **`get_observations`**: `ids` for the few observations you actually need. Returns narrative, facts and files.
4. **`save_memory`**: persist a decision, bug fix, discovery, or change from this session. Call it when you learn something a future session should rely on. Do not save trivia or secrets.
5. **`save_summary`**: after a substantial request, record what was asked, learned, completed, and what remains.

Do not fetch full details for every search hit. If a search returns nothing, try synonyms or drop the `project` filter before concluding there is no history.

Memory reflects what was true when it was recorded. If an observation names a file, function or flag, confirm it still exists before relying on it.

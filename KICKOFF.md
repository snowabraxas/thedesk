# Kickoff: start Sprint 1 on the Mac mini

1. **Put the repo in place.** The project lives in `~/Documents/Projects/the-desk`. If that folder isn't a git clone yet, link it to GitHub once. In Terminal:

   ```
   cd ~/Documents/Projects/the-desk
   git init -b main
   git remote add origin https://github.com/snowabraxas/thedesk.git
   git fetch origin
   git reset --mixed origin/main
   git branch -u origin/main
   git status
   mkdir -p ~/agent-house/desks/product-feed/editions
   ```

   `reset --mixed` keeps every file in the folder as it is. `git status` then shows the lead PM's latest edits as changes, and the room images and PDFs as untracked files.

2. **Start Claude Code** in that folder:

   ```
   claude
   ```

3. **Paste this as your first message:**

   > Read CLAUDE.md and docs/sprints/sprint-1.md. You're the lead dev. Give me a short plan for Sprint 1 in plain words, then build S1 to S4 with the designer, developer and tester subagents. Show me The Desk running after S2. Ask me before installing anything that runs on its own, and stop before S5 so we can set up the Product Feed agent together.

4. **Before S5**, finish the Fix first list on the Plan tab, especially the Anthropic API key with a monthly cap for OpenClaw. Then review `agents/product-feed/sources.yaml`.

5. **Bring any questions back** to the lead PM chat in claude.ai. The plan is updated there.

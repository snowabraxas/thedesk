# Kickoff: start Sprint 1 on the Mac mini

1. **Put the repo in place.** In Terminal:

   ```
   mkdir -p ~/Code && cd ~/Code
   git clone https://github.com/snowabraxas/thedesk.git the-desk
   cd the-desk
   mkdir -p ~/agent-house/desks/product-feed/editions
   ```

2. **Start Claude Code** in that folder:

   ```
   claude
   ```

3. **Paste this as your first message:**

   > Read CLAUDE.md and docs/sprints/sprint-1.md. You're the lead dev. Give me a short plan for Sprint 1 in plain words, then build S1 to S4 with the designer, developer and tester subagents. Show me The Desk running after S2. Ask me before installing anything that runs on its own, and stop before S5 so we can set up the Product Feed agent together.

4. **Before S5**, finish the Fix first list on the Plan tab, especially the Anthropic API key with a monthly cap for OpenClaw. Then review `agents/product-feed/sources.yaml`.

5. **Bring any questions back** to the lead PM chat in claude.ai. The plan is updated there.

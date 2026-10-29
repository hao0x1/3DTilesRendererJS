# A five-minute review of MOONDA

Open the local preview at http://127.0.0.1:5183/. The play icon in the header starts the optional four-step guided story.

1. Open **Mission**. Start with **Connecting ridge** and a **48 h** mission. A and B are alternative mission scenarios.
2. Select **A → Pick a nearby point**. Click terrain near the markers, inspect the candidate and choose **Lock point**. Wait for **Scenario ready**. Dragging the camera alone never moves this analysis point.
3. Choose **B = A +72h**. This copies A’s point and equipment heights into B and delays arrival by exactly three UTC days.
4. Open **Compare**. Read the changed sunlight, Earth visibility, obstruction gaps, generation and battery results. A failed visibility requirement is a result to explain, not an application error.
5. Open **Results → Power & battery → Model assumptions**. Try changing panel area from 2 to 4 m². Panel, battery and load assumptions are shared by both cases. Generation, stored energy and unmet load are different quantities.
6. Scrub the bottom timeline or press Play. Both cases advance by the same elapsed mission time while retaining their different UTC arrival dates. The chart and 3D view follow the active case.
7. Use **Horizon** to look toward the Sun or Earth from the panel or antenna. Use **Terrain** to explore freely. **Inspection light** helps reveal detail; the visibility calculation still uses the terrain profiles and NASA geometry.
8. Collapse the panels or choose **Present** for the demonstration. Check **OFFLINE READY** before disconnecting from the network. Sources, assumptions and the original reference explorer are available from **Sources**.

**Remember:** W measures power at a moment; Wh and kWh measure energy over time. A visible Earth means modeled geometric line of sight, not a complete radio-link assessment. The energy model is an educational estimate with explicit equipment assumptions, not a flight-qualified design.

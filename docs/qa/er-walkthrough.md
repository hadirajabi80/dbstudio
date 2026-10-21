# ER diagram walkthrough (M2-ER, docs/PLAN-M2.md section 3)

Pass/fail per step. Run in both themes (View → Toggle light / dark theme) and at 150 % app zoom and 1024 × 680.

## Setup
- Sample database: File → Open the sample database (SQLite shop, 7 tables, 5 FKs).
- SQL Server / Oracle / PostgreSQL: the Docker fixtures (`engine/tests/docker/compose.yml`), shop schema seeded.
- Dev build only: Ctrl+Shift+P → "Open synthetic 500-table ER diagram (dev)" (500 tables × 20 columns × 700 FKs).

## Open
1. Explorer: right-click the connection → **ER diagram** opens `ER: Sample: Shop` (SQLite main) / `ER: <db>.<schema>`.
2. Right-click a database or schema node → **ER diagram** opens that schema.
3. With nothing selected, Ctrl+Alt+E opens the diagram of the active tab's connection (else the first relational one).
4. Right-click a table → **Diagram of related tables**: the table and every table one FK hop away (both directions);
   tables one more hop away are greyed dashed "ghost" cards; clicking a ghost adds it.
5. Select two or more tables in the explorer → right-click → **Diagram of selected tables**.
6. Opening the same scope again activates the existing tab.

## Cards and edges
7. Headers show the type strip (table blue, view purple), the name (schema-qualified outside the main schema), the column count.
8. Rows: PK key badge, FK link badge, nullable `?`, type text (toggle **Types**). More than 25 columns → `+N more` (click expands, "Show fewer" collapses).
9. **Columns ▾**: All / Keys only / Names only.
10. Edges run from the FK column row to the referenced key row; many side crow's foot, one side bars; dashed when the
    FK columns are nullable; self references loop on the right; cross-schema references go to ghost cards.
11. Hover an edge: tooltip with constraint name and column pairs. Hover a card: its edges and neighbours highlight, the rest fade.
12. Drag a card: its edges follow and stay anchored at the right rows.

## Navigation
13. Wheel zooms at the cursor (10 %–300 %), pinch zooms, two-finger scroll pans; background drag, Space+drag and middle drag pan.
14. Below 45 % cards show headers only, below 20 % coloured boxes (name on hover).
15. Minimap (bottom right): click/drag moves the view. Zoom box: −, %, +, Fit.
16. Shift+drag on the background marquee-selects; Ctrl+click toggles; drag moves the whole selection.

## Keyboard only (no mouse)
17. Ctrl+Alt+E → Tab reaches the canvas → Tab moves card to card in reading order (focus ring, view follows), Shift+Tab back;
    after the last card Tab leaves the canvas.
18. Arrows move the focused/selected cards by 8 px; F fits; 0 = 100 %; = / − zoom; Ctrl+A selects all; Esc clears.
19. Enter opens the table's data tab; F4 opens its designer; Shift+F10 opens the card menu.
20. Delete removes the selection from the diagram (not from the database); Ctrl+F focuses search, Enter / Shift+Enter
    zoom to and pulse the next / previous match (tables first, then tables with a matching column).

## Card menu
21. Open data, Design, Open DDL, Copy table name, Show related tables, Create foreign key…, Pin / unpin card position, Remove from diagram.

## Layout and persistence
22. Layout ▾: layered left→right, layered top→bottom, grid, Reset layout. Pinned cards keep their place on auto layout.
23. Move cards, remove one, change options, pan/zoom: status shows "unsaved changes" → "layout saved" (800 ms debounce).
24. Close and reopen the tab (and restart the app): positions, hidden tables, options and viewport come back.
25. A table created since the layout was saved appears below the diagram (ghosts next to their neighbour).

## Foreign keys
26. SQL Server / PostgreSQL / Oracle (Docker): drag a column's handle (dot at the row's right edge) onto a column of another
    table → dialog with name `FK_<table>_<referenced>`, column pairs, ON DELETE / ON UPDATE (Oracle: ON UPDATE fixed) and the
    DDL preview → Create foreign key: the constraint exists and the new edge appears after the catalog refresh.
27. SQLite: handles are grey with the tooltip "SQLite cannot add a foreign key to an existing table"; the command is disabled.
28. Read-only connection: handles disabled with "<name> is read-only".

## Export
29. ⤓ PNG and ⤓ SVG export the whole diagram (not the viewport) in the current theme; PNG at 2× (less for huge
    diagrams); both open in a browser / image viewer, text is real text in the SVG.

## Performance (500-table synthetic diagram)
30. Layout < 4 s with progress text, the UI stays responsive.
31. Pan and zoom stay smooth (≥ 50 fps; DevTools Performance → frames) at 100 % and at fit (box LOD).
32. Automated: `npx vitest run src/components/ErDiagram` (perf.test.ts: culling per frame < 2 ms over 120 scripted frames,
    layout < 4 s, 700 edges routed < 16 ms).

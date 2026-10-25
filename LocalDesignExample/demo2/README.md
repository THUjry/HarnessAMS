# demo2 — placeholder

Planned content: the 6-bit symmetric ATT cascade demo (the netlist-assembly showcase) — a
sky130 rebuild (topology rebuilt on sky130; no carry-over of any other PDK's circuit
conclusions) of a 6-section switched attenuator cascade swept over switch words and
temperatures.

Planned sweep composition (to be confirmed when the demo lands): 6-bit control words
(64 raw states) with left-right mirror-equivalent words collapsed into 36 unique
configurations x 10 temperature points = 360 simulations per round; per-point
adjudication via a `process_*.py` script and reporting via `../tools/gen_sweep_report.py`.

Directory convention once built: `cascade/Round*/` (run directories), `Results/Round*/`
(adjudication), `Analysis/` (reports) — all generated run outputs, gitignored.

Status: directory reserved; content lands with the demo2 milestone.

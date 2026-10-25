# demo1 — placeholder

Planned content: the OTA5T PVT sweep demo (27 points = 3 corners x 3 supply voltages x 3
temperatures), assembled from `cells/ota5t/script/design_params.json` by
`script/analysis/gen_ota5t.py`, simulated with the bundled ngspice + sky130 through
`../tools/sweep_worker_ngspice.py`, and reported via `../tools/gen_sweep_report.py`
(offline Plotly from the repo-level shared copy).

Reference values from the verified development run (zero deviation against the
ngspiceTest benchmark): best `dc_gain_db` = 43.32 at (ss, 1.98 V, -40 C); gain range
41.5-43.3 dB across PVT; worst phase margin about 66.8 degrees; unity-gain bandwidth
about 161 MHz. 27/27 points succeeded.

Status: directory reserved; content lands with the demo1 milestone.

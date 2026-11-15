Goal

Find a drivable / walkable, energy-efficient route on Mars between two points A and B, using
elevation and slope as the main inputs. A few other characteristics (dusty or rocky ground,
temperature) may adjust the route a little, but must never push it far from the best terrain route.
If neither a rover nor astronauts on foot can get from A to B, report "Path unavailable".

This issue defines the algorithm and its inputs/outputs only. Drawing the route, panels and
other design are done separately (see the companion issue for "Zoom to route"); the output format
below is the contract between the two.

1. Travel modes and hard limits

Mode	Max slope along the route	Max sideways (cross) slope	Notes
Rover	20° (setting: 10–30°)	20°	Curiosity/Perseverance: tip-over limit ~45°, safety stop ~30°, normal driving ≲ 15–20°
On foot (suited astronauts)	15° (setting: 10–25°)	15°	Apollo crews walked ~10–20°; loose regolith slides at ~30–35° anyway
A step between two cells is impossible if the slope along the step, or the steepest slope
inside either cell, is above the mode's limit.

Order of search:

Search for a rover route.
If none exists, search on foot.
If neither exists, the result is unavailable and the UI shows "Path unavailable", plus the
steepest unavoidable stretch, so the user knows why.
2. Data

Elevation: precise, at least 1 m vertical resolution. The map's elevation tiles
(public/overlays/mars/elevation) are 8-bit (~115 m steps) and must not be used for climbs.
Build route grids from the raw MOLA data used in tools/build_layers.py (load_dem('mars')).
Pack them as lossless WebP blocks: R,G = elevation in m + 10000 (16 bit); B = steepest slope
inside the cell in 0.25° steps, taken from the next finer level. Load only the blocks a search needs.

Resolution ladder for the iterations (section 4):

Level	Cell size	Source	Coverage
L0	~7.4 km (8 px/deg)	MOLA, block-averaged	Global
L1	~1.85 km (32 px/deg)	MOLA MEGDR	Global
L2	~463 m (128 px/deg)	MOLA MEGDR 128 px/deg	Global (gaps filled between laser tracks)
L3 (optional)	~50–20 m	HRSC / CTX terrain models	Only where available
Secondary layers (already built for the map, read like src/areastats.js does):

"Dusty or rocky terrain": thermal inertia, public/overlays/mars/surface, TIU, 70°S–70°N.
"Min. temperature": public/overlays/mars/temp_min, °C.
3. Cost of a step (energy-like, in "km of flat driving")

cost = d · m_cell + k_up · climb + k_down · descent
d: real distance on the sphere (east-west spacing shrinks with cos(latitude)), radius 3389.5 km.
climb / descent: metres up/down, converted to km.
k_up: climbing penalty. Lifting the rover 1 m costs about as much energy as driving 1/μ m on
the flat (μ = rolling resistance ≈ 0.1–0.2 on Mars soil). Default 8; settings 3 / 8 / 20.
On foot, default 10 (climbing in a suit is very tiring).
k_down: default 1 (braking, caution; no energy recovered).
m_cell: multiplier from the secondary layers, capped so they can't skew the route much:
m_cell = 1 + min(CAP, w_dust·f_dust + w_rock·f_rock + w_cold·f_cold)    CAP = 0.25
 f_dust = 0..1, rising as thermal inertia falls below ~150 TIU (deep fine dust: wheel sinkage,
as when Spirit got stuck).
f_rock = 0..1, rising above ~600 TIU (boulder fields: wheel damage, slow driving).
f_cold = 0..1, rising as the min. temperature falls below −90 °C (heating energy at night).
Weights default 1 / 1 / 0.5; user-adjustable 0–2.
With CAP = 0.25 a cell is at most 25% more expensive, so these factors can choose between
nearly equal routes but can never force a detour more than ~25% longer than the pure terrain
route. Where a layer has no data (e.g. beyond 70° for thermal inertia), its f = 0.
Heuristic for A* (admissible, so routes stay optimal):
h = great_circle_km(here, B) + k_up · max(0, elev_B − elev_here). This never overestimates,
because m_cell ≥ 1 and the climb to B's height is unavoidable.
4. Iterations: coarse to fine ("adjusting the curve on smaller and smaller terrain")

L0, whole window: A* on the bounding box of A–B plus a 30% margin (min 300 km), wrapping
in longitude. 16-neighbour moves (8 + knight moves) for less zig-zag. Keep the 3 best distinct
corridors: after finding the best route, penalise cells near it ×3 and search again, twice.
This avoids committing early to the wrong valley.
L1: for each corridor, A* only inside a band of ±30 km around it. Keep the best 2.
L2: ±8 km band around the best L1 route(s). Keep the best one.
L3 (optional): ±1 km band, only where finer terrain models exist; skip elsewhere.
Stop early when a level changes the route's cost by < 1% and moves it < 1 cell.
Re-check the limits at every level. A corridor that becomes impassable at finer resolution
(a cliff hidden at coarser scale) is dropped. If all are dropped, widen the band ×2 once; if
still none, fall back to the next corridor, or report the mode as unavailable.
Smoothing:
String-pull: remove a point while the straight segment between its neighbours stays within the
limits, sampled every half cell.
Optionally fit a Catmull-Rom curve; keep it only if it also passes the limit check.
The final polyline must still respect every hard limit.
5. Performance

Run in a Web Worker (no UI freeze); cancel a running search when A, B or settings change.
Typed arrays (Float32 cost, Int32 parent, Uint8 closed), binary heap with lazy deletion.
Targets on a mid-range laptop:
< 0.5 s for routes up to ~500 km;
< 2 s for Gale → Jezero (~3,700 km), thanks to the corridor bands.
Report progress (level, % explored) so the UI can show it.
6. Output contract (for the UI)

{
  status: 'ok' | 'foot-only' | 'unavailable',
  mode: 'rover' | 'foot' | null,
  points: [[lat, lon, elev_m], ...],      // smoothed route, A to B
  bounds: [[south, west], [north, east]], // for "Zoom to route"
  totals: { length_km, straight_km, climb_m, descent_m, max_slope_deg, energy_km_equiv,
            extra_cost_from_secondary_pct },
  segments: [{ from, to, length_km, slope_deg, terrain: 'dusty'|'normal'|'rocky' }],
  blocked: { where: [lat, lon], slope_deg } | null,   // why, when unavailable
  levels: [{ level: 'L0', cost, ms }, ...]           // for debugging
}
7. Acceptance tests

Synthetic grids (Node unit tests):
flat → straight line;
a wall above the limit with one gap → route goes through the gap;
a hill → around it with high k_up, over it with k_up = 0;
closed wall → unavailable;
A* result equals Dijkstra's (admissible heuristic).
Secondary-layer cap: with all secondary weights at maximum, the route is never more than 25%
longer than with them off.
Real terrain:
Jezero floor → rim takes a gentle breach, not the steep wall;
crossing Valles Marineris either finds a ramp or reports foot-only / unavailable at 20°;
Gale → Jezero completes within the time target.
Coarse → fine: each level's route lies inside the previous level's band, and the final route
respects the limits at L2.
Known limits

Even at ~463 m, boulders, dunes and metre-scale slopes are invisible. Real teams use HiRISE terrain
models (~1 m) and the rover's own cameras for the final stretch.
Temperature and dust are long-term averages; dust storms and seasons are not modelled.
Generated by Claude Code
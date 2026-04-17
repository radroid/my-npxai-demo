-- Seed: Bruce Power simulated plant data — Appendix F fixtures for the Generator.
--
-- This is a DATA-ONLY migration (no schema changes) applied via
-- `supabase db push`. Supabase CLI records it in
-- supabase_migrations.schema_migrations once applied, so it will not
-- re-run on subsequent pushes. To refresh fixtures later, create a new
-- timestamped migration with the same TRUNCATE + INSERT body, or run
-- this file directly via `supabase db psql < <path>`.
--
-- Scope: Bruce A Units 1-4 plus Unit 0 (common services). Operating states
-- chosen per F.1 so the Generator produces varied, demo-worthy output:
--   Unit 1 — 100% FP steady-state (baseline)
--   Unit 2 — 100% FP, quiet shift with one O2-cover-gas attention item
--   Unit 3 — Planned refueling outage (0% FP), 3 active clearances (busy)
--   Unit 4 — 78% FP ramping up after a Channel-D reactor trip yesterday
--   Unit 0 — Common systems (EDGs, D2O upgraders, service water)
--
-- Rerun semantics: truncating + RESTART IDENTITY is safe — these are
-- fixtures, not user data. regdoc_chunks is deliberately NOT truncated
-- (that's real ingested data owned by scripts/ingest.ts). Do not run this
-- against any database that holds real operator data.
--
-- Timestamps use now() - interval so the data always looks fresh at demo
-- time. The Generator reads the most recent plant_status rows per unit,
-- so the 2-7 minute offsets here represent "readings from a few minutes
-- ago" — consistent with a running control room.
--
-- Operator roles match CNSC REGDOC-2.2.5 staffing model:
--   SM  = Shift Manager          CRSS = Control Room Shift Supervisor
--   ANO = Authorized Nuclear Op  Field Operator

BEGIN;

TRUNCATE plant_status, work_orders, shift_log_entries RESTART IDENTITY;

-- =========================================================================
-- plant_status (50 rows)
-- =========================================================================

INSERT INTO plant_status (unit_id, parameter, value, unit_of_measure, status, timestamp) VALUES
-- Unit 1 — 100% FP steady-state (all normal)
('Unit 1', 'Reactor Power',           '100.0',     '% FP',  'normal',    now() - interval '2 minutes'),
('Unit 1', 'PHT Pressure',            '10.03',     'MPa',   'normal',    now() - interval '2 minutes'),
('Unit 1', 'PHT Outlet Temp',         '310.2',     '°C',    'normal',    now() - interval '2 minutes'),
('Unit 1', 'Moderator Temp',          '69.8',      '°C',    'normal',    now() - interval '3 minutes'),
('Unit 1', 'Moderator Cover Gas O2',  '0.6',       '%',     'normal',    now() - interval '3 minutes'),
('Unit 1', 'Steam Pressure',          '4.69',      'MPa',   'normal',    now() - interval '2 minutes'),
('Unit 1', 'Turbine Load',            '867',       'MW',    'normal',    now() - interval '2 minutes'),
('Unit 1', 'SDS-1',                   'Available', NULL,    'normal',    now() - interval '5 minutes'),
('Unit 1', 'SDS-2',                   'Available', NULL,    'normal',    now() - interval '5 minutes'),
('Unit 1', 'ECC',                     'Available', NULL,    'normal',    now() - interval '5 minutes'),

-- Unit 2 — 100% FP, quiet shift with cover-gas O2 attention
('Unit 2', 'Reactor Power',           '100.0',                '% FP', 'normal',    now() - interval '2 minutes'),
('Unit 2', 'PHT Pressure',            '10.05',                'MPa',  'normal',    now() - interval '2 minutes'),
('Unit 2', 'PHT Outlet Temp',         '310.5',                '°C',   'normal',    now() - interval '2 minutes'),
('Unit 2', 'Moderator Temp',          '70.1',                 '°C',   'normal',    now() - interval '3 minutes'),
('Unit 2', 'Moderator Cover Gas O2',  '1.8',                  '%',    'attention', now() - interval '3 minutes'),
('Unit 2', 'Steam Pressure',          '4.71',                 'MPa',  'normal',    now() - interval '2 minutes'),
('Unit 2', 'Turbine Load',            '865',                  'MW',   'normal',    now() - interval '2 minutes'),
('Unit 2', 'SDS-1',                   'Available',            NULL,   'normal',    now() - interval '5 minutes'),
('Unit 2', 'SDS-2',                   'Available',            NULL,   'normal',    now() - interval '5 minutes'),
('Unit 2', 'ECC',                     'Available',            NULL,   'normal',    now() - interval '5 minutes'),

-- Unit 3 — Planned refueling outage, 3 active clearances (busy shift)
('Unit 3', 'Reactor Power',           '0.0',                         '% FP', 'normal',    now() - interval '2 minutes'),
('Unit 3', 'PHT Pressure',            '0.15',                        'MPa',  'normal',    now() - interval '2 minutes'),
('Unit 3', 'PHT Outlet Temp',         '54.2',                        '°C',   'normal',    now() - interval '2 minutes'),
('Unit 3', 'Moderator Temp',          '42.5',                        '°C',   'normal',    now() - interval '3 minutes'),
('Unit 3', 'Moderator Cover Gas O2',  '0.8',                         '%',    'normal',    now() - interval '3 minutes'),
('Unit 3', 'Shutdown Cooling',        'In Service',                  NULL,   'normal',    now() - interval '4 minutes'),
('Unit 3', 'Fuel Handling',           'In Progress',                 NULL,   'attention', now() - interval '4 minutes'),
('Unit 3', 'SDS-1',                   'Unavailable (outage)',        NULL,   'attention', now() - interval '6 minutes'),
('Unit 3', 'SDS-2',                   'Available',                   NULL,   'normal',    now() - interval '5 minutes'),
('Unit 3', 'ECC',                     'Isolated (MV-3421 clearance)', NULL,  'attention', now() - interval '6 minutes'),
('Unit 3', 'Containment',             'Open for Fuel Handling',      NULL,   'attention', now() - interval '5 minutes'),
('Unit 3', 'Active Clearances',       '3',                           NULL,   'attention', now() - interval '7 minutes'),

-- Unit 4 — 78% FP ramping up after yesterday's Channel-D trip
('Unit 4', 'Reactor Power',           '78.2',      '% FP', 'attention', now() - interval '2 minutes'),
('Unit 4', 'PHT Pressure',            '10.01',     'MPa',  'normal',    now() - interval '2 minutes'),
('Unit 4', 'PHT Outlet Temp',         '308.9',     '°C',   'normal',    now() - interval '2 minutes'),
('Unit 4', 'Moderator Temp',          '68.4',      '°C',   'normal',    now() - interval '3 minutes'),
('Unit 4', 'Moderator Cover Gas O2',  '0.7',       '%',    'normal',    now() - interval '3 minutes'),
('Unit 4', 'Steam Pressure',          '4.62',      'MPa',  'normal',    now() - interval '2 minutes'),
('Unit 4', 'SG #1 Level',             '48',        '%',    'attention', now() - interval '3 minutes'),
('Unit 4', 'Turbine Load',            '678',       'MW',   'attention', now() - interval '2 minutes'),
('Unit 4', 'SDS-1',                   'Available', NULL,   'normal',    now() - interval '5 minutes'),
('Unit 4', 'SDS-2',                   'Available', NULL,   'normal',    now() - interval '5 minutes'),

-- Unit 0 — Common services / station systems
('Unit 0', 'Emergency Power Gen 1',         'Available',           NULL,   'normal',    now() - interval '6 minutes'),
('Unit 0', 'Emergency Power Gen 2',         'Available',           NULL,   'normal',    now() - interval '6 minutes'),
('Unit 0', 'D2O Upgrader',                  'In Service',          NULL,   'normal',    now() - interval '5 minutes'),
('Unit 0', 'Service Water Pump A',          'Out for Maintenance', NULL,   'attention', now() - interval '4 minutes'),
('Unit 0', 'Service Water Pump B',          'In Service',          NULL,   'normal',    now() - interval '4 minutes'),
('Unit 0', 'Service Water Pump C',          'Standby',             NULL,   'normal',    now() - interval '4 minutes'),
('Unit 0', 'Instrument Air Header Pressure','685',                 'kPa',  'normal',    now() - interval '3 minutes'),
('Unit 0', 'Class IV Power',                'Available',           NULL,   'normal',    now() - interval '6 minutes');

-- =========================================================================
-- work_orders (12 rows)
-- =========================================================================

INSERT INTO work_orders (wo_number, unit, description, status, priority, assigned_to, clearance_required, shift) VALUES
('WO-2026-04-1138', 'Unit 1', 'Q/A inspection — feeder SG-1 A-row',           'Pending',     'Routine', 'Maintenance',     FALSE, 'Day'),
('WO-2026-04-1142', 'Unit 2', 'Cover gas O2 analyzer calibration',            'In Progress', 'High',    'I&C',             FALSE, 'Day'),
('WO-2026-04-1155', 'Unit 3', 'Fuel channel F07 — reload sequence',           'In Progress', 'Urgent',  'Fuel Handling',   TRUE,  'Day'),
('WO-2026-04-1156', 'Unit 3', 'SDS-1 trip channel D testing',                 'In Progress', 'Urgent',  'I&C',             TRUE,  'Day'),
('WO-2026-04-1158', 'Unit 3', 'ECC header valve MV-3421 disassembly',         'In Progress', 'High',    'Mech Maint',      TRUE,  'Day'),
('WO-2026-04-1163', 'Unit 4', 'Reactor trip investigation — Channel D',       'In Progress', 'Urgent',  'Ops Engineering', FALSE, 'Day'),
('WO-2026-04-1164', 'Unit 4', 'Steam generator level controller tuning',      'Pending',     'High',    'I&C',             FALSE, 'Evening'),
('WO-2026-04-1170', 'Unit 0', 'Service Water Pump A — bearing replacement',   'In Progress', 'High',    'Mech Maint',      TRUE,  'Day'),
('WO-2026-04-1171', 'Unit 0', 'EDG 1 monthly run',                            'Complete',    'Routine', 'Ops',             FALSE, 'Day'),
('WO-2026-04-1173', 'Unit 1', 'Moderator inventory sample',                   'Pending',     'Routine', 'Chemistry',       FALSE, 'Evening'),
('WO-2026-04-1175', 'Unit 3', 'Fuel channel F08 — reload preparation',        'Pending',     'Urgent',  'Fuel Handling',   TRUE,  'Evening'),
('WO-2026-04-1178', 'Unit 4', 'Turbine generator vibration survey',           'Pending',     'High',    'Mech Maint',      FALSE, 'Evening');

-- =========================================================================
-- shift_log_entries (15 rows — most recent first for easy review)
-- =========================================================================

INSERT INTO shift_log_entries (unit, timestamp, operator_role, entry, category, severity) VALUES
('Unit 4', now() - interval '15 minutes',  'SM',             'Reactor power ramp continues; currently 78% FP, target 95% by end of shift',                   'Equipment',      'routine'),
('Unit 3', now() - interval '20 minutes',  'ANO',            'Clearance 2026-C-0141 (fuel handling) refreshed; start times validated',                      'Administrative', 'routine'),
('Unit 3', now() - interval '40 minutes',  'CRSS',           'Fuel channel F07 reload 60% complete; no anomalies',                                          'Equipment',      'routine'),
('Unit 1', now() - interval '60 minutes',  'Field Operator', 'Routine field patrol complete — no leaks or abnormal noise on feeders A–D',                   'Equipment',      'routine'),
('Unit 3', now() - interval '85 minutes',  'CRSS',           'SDS-1 trip channel D retest passed after relay replacement',                                  'Safety System',  'significant'),
('Unit 2', now() - interval '110 minutes', 'ANO',            'Cover gas O2 at 1.8% — trending up from 1.4% over last 12 hours; WO-1142 dispatched',         'Safety System',  'attention'),
('Unit 0', now() - interval '140 minutes', 'Field Operator', 'Service Water Pump A bearings replaced; awaiting oil fill and run-in',                        'Equipment',      'routine'),
('Unit 4', now() - interval '180 minutes', 'SM',             'Post-trip review meeting held with Ops Engineering; primary cause = Channel D false trip',    'Administrative', 'significant'),
('Unit 1', now() - interval '210 minutes', 'ANO',            'All parameters nominal; quiet shift',                                                         'Equipment',      'routine'),
('Unit 0', now() - interval '240 minutes', 'SM',             'EDG 1 monthly run complete; diesel performed to spec',                                        'Safety System',  'routine'),
('Unit 3', now() - interval '270 minutes', 'CRSS',           'ECC header MV-3421 disassembly started under clearance 2026-C-0143',                          'Safety System',  'attention'),
('Unit 4', now() - interval '300 minutes', 'CRSS',           'SG #1 level oscillation ±3% observed during ramp; monitoring',                                'Equipment',      'attention'),
('Unit 2', now() - interval '320 minutes', 'Field Operator', 'Walkdown of turbine building complete; no leaks',                                             'Equipment',      'routine'),
('Unit 4', now() - interval '360 minutes', 'SM',             'Reactor crit achieved at 03:17; approach to power on schedule',                               'Equipment',      'significant'),
('Unit 3', now() - interval '420 minutes', 'ANO',            'Shift turnover: 3 active clearances, fuel handling in progress',                              'Administrative', 'routine');

COMMIT;

-- Post-apply verification (run via `supabase db psql`):
--   SELECT count(*) FROM plant_status;      -- expect 50
--   SELECT count(*) FROM work_orders;       -- expect 12
--   SELECT count(*) FROM shift_log_entries; -- expect 15
--   SELECT unit_id, count(*) FROM plant_status GROUP BY unit_id ORDER BY unit_id;

-- Augment Bruce Power seed (2026-04-17): alarm coverage + night-shift narrative.
--
-- Addresses three gaps raised in seed-review feedback:
--   1. plant_status had zero 'alarm' rows — Generator/UI alarm branch was
--      never exercised. Adds one LIVE latched alarm (Unit 4 SG #1 hi-hi)
--      plus one CLEARED alarm with a full 3-entry log thread (Unit 0 IA dip).
--   2. work_orders + shift_log_entries were clustered in Day/Evening, reading
--      "single-shift staged." Adds 3 Night WOs, 3 Night log entries, and an
--      explicit night→day handover entry.
--   3. Unit 3 SDS-1 log wording could read ambiguously against the "SDS-1
--      Unavailable (outage)" plant_status. Updates the wording to clarify
--      that retest passed but the channel remains tagged out under outage
--      clearance.
--
-- Additive migration — does NOT TRUNCATE (builds on 20260417015131). Safe
-- to re-run logically: an UPDATE with a specific WHERE clause is idempotent,
-- and the INSERTs use natural keys that don't collide with existing rows
-- (new parameter names; new WO numbers; new log categories/timestamps).

BEGIN;

-- =========================================================================
-- 1. plant_status — alarm coverage
-- =========================================================================

-- LIVE alarm: Unit 4 SG #1 high-high level. Transient during ramp to 95% FP;
-- reset is pending per SWP-03 so the alarm is latched. Demonstrates the
-- alarm-severity branch in Generator + UI right now.
INSERT INTO plant_status
  (unit_id, parameter, value, unit_of_measure, status, timestamp)
VALUES
  ('Unit 4', 'SG #1 Hi-Hi Level Alarm', 'Latched — Reset Pending',
   NULL, 'alarm', now() - interval '5 minutes');

-- CLEARED alarm (for the log-thread narrative): Unit 0 instrument air dip.
-- The header itself is back to nominal (existing row stays 685 kPa normal);
-- this row records that the alarm annunciator was latched and has now been
-- cleared/acknowledged.
INSERT INTO plant_status
  (unit_id, parameter, value, unit_of_measure, status, timestamp)
VALUES
  ('Unit 0', 'Instrument Air Low-Press Alarm', 'Cleared (13:23)',
   NULL, 'normal', now() - interval '45 minutes');

-- =========================================================================
-- 2. shift_log_entries — alarm threads + night shift + handover
-- =========================================================================

-- Unit 4 SG #1 alarm thread (active → under investigation)
INSERT INTO shift_log_entries (unit, timestamp, operator_role, entry, category, severity) VALUES
  ('Unit 4', now() - interval '5 minutes',   'CRSS',
   'SG #1 hi-hi level alarm actuated during ramp (level briefly peaked 52%); alarm latched per SWP-03 — reset pending after level stabilization',
   'Safety System', 'significant'),
  ('Unit 4', now() - interval '3 minutes',   'ANO',
   'SG #1 level trending back to 48% setpoint; preparing to reset hi-hi alarm and resume ramp once stable for 5 min',
   'Safety System', 'attention');

-- Unit 0 instrument air dip thread (actuation → recovery → cleared)
INSERT INTO shift_log_entries (unit, timestamp, operator_role, entry, category, severity) VALUES
  ('Unit 0', now() - interval '65 minutes',  'CRSS',
   'Instrument air header transient — pressure dipped to 620 kPa at 13:20; low-pressure alarm annunciated station-wide',
   'Equipment', 'significant'),
  ('Unit 0', now() - interval '55 minutes',  'Field Operator',
   'IA compressor B auto-started at 13:22; header recovered to 685 kPa by 13:23; no actuation on any connected equipment',
   'Equipment', 'routine'),
  ('Unit 0', now() - interval '45 minutes',  'SM',
   'IA low-pressure alarm cleared and acknowledged at 13:23; WO dispatched to investigate IA compressor A starting logic',
   'Equipment', 'routine');

-- Night shift log entries (Day shift began ~7h ago in sim time; Night is t-9 to t-12h)
INSERT INTO shift_log_entries (unit, timestamp, operator_role, entry, category, severity) VALUES
  ('Unit 3', now() - interval '9 hours',     'CRSS',
   'Night shift: Fuel channel F06 reload completed at 02:42; paused handling for routine reactor-pool chemistry sample',
   'Equipment', 'routine'),
  ('Unit 4', now() - interval '10 hours',    'SM',
   'Night shift: Ramp held at 42% FP overnight per Post-Trip Recovery Plan; Channel D instrumentation logs downloaded for Day-shift Ops Engineering review',
   'Equipment', 'routine'),
  ('Unit 0', now() - interval '11 hours',    'Field Operator',
   'Night shift: EDG 2 routine crank-and-run test complete (36 min run, full rated load); diesel within all parameters — see WO-2026-04-1184',
   'Safety System', 'routine');

-- Explicit night → day handover note (sits between night entries and Day-shift activity)
INSERT INTO shift_log_entries (unit, timestamp, operator_role, entry, category, severity) VALUES
  ('Unit 0', now() - interval '7 hours 30 minutes', 'SM',
   'Night→Day handover: 3 active clearances held over on Unit 3 (fuel handling, SDS-1 ch-D testing, ECC MV-3421); Unit 4 held at 42% FP ready to resume ramp; no outstanding deficiencies from night; weather stable',
   'Administrative', 'significant');

-- =========================================================================
-- 3. work_orders — night shift coverage
-- =========================================================================

INSERT INTO work_orders (wo_number, unit, description, status, priority, assigned_to, clearance_required, shift) VALUES
  ('WO-2026-04-1180', 'Unit 3', 'Reactor pool chemistry sample — pre-F07 reload',
   'Complete', 'Routine', 'Chemistry', FALSE, 'Night'),
  ('WO-2026-04-1182', 'Unit 4', 'Channel D false-trip data capture & instrument log review',
   'Complete', 'High', 'I&C', FALSE, 'Night'),
  ('WO-2026-04-1184', 'Unit 0', 'EDG 2 routine crank-and-run monthly test',
   'Complete', 'Routine', 'Ops', FALSE, 'Night');

-- =========================================================================
-- 4. Unit 3 SDS-1 log wording clarification
-- =========================================================================

-- Narrative reads ambiguously when the plant_status shows "SDS-1 Unavailable
-- (outage)" at the same time a log entry says "SDS-1 trip channel D retest
-- passed." Clarify that retest passed but the channel remains tagged out
-- under the outage clearance — both statements true, no ambiguity.
UPDATE shift_log_entries
SET entry = 'SDS-1 trip channel D retest passed after relay replacement; channel remains tagged out under outage clearance 2026-C-0142 (no change to SDS-1 overall availability)'
WHERE unit = 'Unit 3'
  AND entry = 'SDS-1 trip channel D retest passed after relay replacement';

COMMIT;

-- Post-apply verification (run via `supabase db psql`):
--   SELECT count(*) FROM plant_status;      -- expect 52 (50 + 2 alarm-related rows)
--   SELECT count(*) FROM work_orders;       -- expect 15 (12 + 3 night WOs)
--   SELECT count(*) FROM shift_log_entries; -- expect 24 (15 + 9 new)
--   SELECT unit_id, status, parameter FROM plant_status WHERE status = 'alarm';
--     -- expect 1 row: Unit 4 / SG #1 Hi-Hi Level Alarm
--   SELECT count(*) FROM shift_log_entries WHERE entry LIKE '%Night shift%' OR entry LIKE '%Night→Day%';
--     -- expect 4

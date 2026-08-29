-- Phase 1/2 never accepted real financial events. Unrecognized legacy financial
-- records must be reviewed and archived outside the live database, not relabeled
-- as real money. Known fixed-ID demo records were removed by migration 0003.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM transactions) OR EXISTS (SELECT 1 FROM ledger_entries) OR EXISTS (SELECT 1 FROM ledger_postings) THEN
    RAISE EXCEPTION 'Phase 3 requires an empty financial history: archive and review legacy simulated data before migrating the live database';
  END IF;
  IF EXISTS (SELECT 1 FROM treasuries WHERE balance_cents<>0 OR assets_cents<>0 OR liabilities_cents<>0) THEN
    RAISE EXCEPTION 'Legacy treasury projections must not be exposed as live financial state';
  END IF;
END;
$$;

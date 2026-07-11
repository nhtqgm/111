-- Run only after 20260711_normalized_predictions.sql has completed successfully.
-- The normalized prediction, preference, and forecast-history tables are now
-- the only cloud storage used by the application.

drop function if exists public.get_my_workspace();
drop function if exists public.save_my_workspace(jsonb, bigint);
drop function if exists public.admin_workspace_count();
drop table if exists public.user_workspaces;

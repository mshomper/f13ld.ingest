-- F13LD.vault — read-only check #2: the other tables and the view.
-- Changes nothing. Paste into the Supabase SQL editor, press Run,
-- then copy the single "report" cell and paste it back into the chat.

select json_build_object(
  'tables', (
    select json_agg(json_build_object(
      'table', c.relname,
      'row_level_security_on', c.relrowsecurity,
      'rows_estimate', c.reltuples::bigint,
      'has_contact_column', exists (
        select 1 from information_schema.columns ic
        where ic.table_schema = 'public' and ic.table_name = c.relname
          and ic.column_name = 'contributor_contact'),
      'anon_permissions', (
        select json_agg(privilege_type) from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'anon'),
      'policies', (
        select json_agg(json_build_object('name', p.policyname, 'command', p.cmd, 'roles', p.roles))
        from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
    ) order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),

  'view', (
    select json_build_object(
      'name', c.relname,
      'options', c.reloptions,
      'has_contact_column', exists (
        select 1 from information_schema.columns ic
        where ic.table_schema = 'public' and ic.table_name = c.relname
          and ic.column_name = 'contributor_contact'),
      'anon_permissions', (
        select json_agg(privilege_type) from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'anon'),
      'definition', pg_get_viewdef(c.oid, true))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'f13ld_designs_dimensional'),

  'functions_callable_by_anon', (
    select json_agg(p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute'))
) as report;

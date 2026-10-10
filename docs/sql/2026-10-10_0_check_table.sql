-- F13LD.vault — read-only check of the live f13ld_designs table.
-- Changes nothing. Paste into the Supabase SQL editor, press Run,
-- then copy the single "report" cell and paste it back into the chat.

select json_build_object(
  'columns', (
    select json_agg(json_build_object(
      'name', column_name, 'type', data_type,
      'nullable', is_nullable, 'default', column_default)
      order by ordinal_position)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'f13ld_designs'),

  'row_level_security_on', (
    select relrowsecurity from pg_class
    where oid = 'public.f13ld_designs'::regclass),

  'policies', (
    select json_agg(json_build_object(
      'name', policyname, 'command', cmd, 'roles', roles,
      'using', qual, 'with_check', with_check))
    from pg_policies
    where schemaname = 'public' and tablename = 'f13ld_designs'),

  'table_permissions', (
    select json_agg(json_build_object('role', grantee, 'permission', privilege_type))
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'f13ld_designs'
      and grantee in ('anon', 'authenticated')),

  'column_permissions_on_contact', (
    select json_agg(json_build_object('role', grantee, 'permission', privilege_type))
    from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'f13ld_designs'
      and column_name = 'contributor_contact'
      and grantee in ('anon', 'authenticated')),

  'indexes', (
    select json_agg(json_build_object('name', indexname, 'definition', indexdef))
    from pg_indexes
    where schemaname = 'public' and tablename = 'f13ld_designs'),

  'other_tables_and_views', (
    select json_agg(table_name || ' (' || table_type || ')')
    from information_schema.tables
    where table_schema = 'public'),

  'row_count', (select count(*) from public.f13ld_designs)
) as report;
